const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { Worker } = require('node:worker_threads');
const { availableParallelism, cpus } = require('node:os');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.resolve(process.env.DATA_DIRECTORY || path.join(__dirname, '..', 'data'));
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new Database(path.join(dataDirectory, 'attendance.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '',
    teacher_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS enrollments (
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (class_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    key_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS attendance_sessions (
    id INTEGER PRIMARY KEY,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    starts_at INTEGER NOT NULL,
    late_after INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('present', 'late')),
    recorded_at TEXT NOT NULL,
    UNIQUE (session_id, student_id)
  );
  CREATE INDEX IF NOT EXISTS attendance_class_recorded_idx ON attendance(class_id, recorded_at);
  CREATE INDEX IF NOT EXISTS attendance_sessions_class_start_idx ON attendance_sessions(class_id, starts_at);
`);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isValidSchedule(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute;
}

function cleanUser(user) {
  return { id: user.id, full_name: user.full_name, email: user.email, role: user.role, active: Boolean(user.active) };
}

const userById = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');
const classById = db.prepare('SELECT * FROM classes WHERE id = ?');

function canAccessClass(user, classId) {
  if (user.role === 'admin') return true;
  const classroom = classById.get(classId);
  if (!classroom) return false;
  if (user.role === 'teacher') return classroom.teacher_id === user.id;
  return Boolean(db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?').get(classId, user.id));
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'Please sign in.'));
    if (!roles.includes(req.user.role)) return next(httpError(403, 'You do not have permission to perform this action.'));
    next();
  };
}

function authenticate(req, res, next) {
  const token = req.cookies && req.cookies.attendance_session;
  if (!token) return next();
  const row = db.prepare('SELECT user_id, expires_at FROM web_sessions WHERE token_hash = ?').get(sha256(token));
  if (!row || row.expires_at <= Date.now()) {
    if (row) db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha256(token));
    res.clearCookie('attendance_session');
    return next();
  }
  const user = userById.get(row.user_id);
  if (user) req.user = cleanUser(user);
  next();
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const header = req.headers.cookie || '';
  const match = header.match(/(?:^|;\s*)attendance_session=([^;]+)/);
  req.cookies = match ? { attendance_session: match[1] } : {};
  next();
});
app.use(authenticate);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, '..', 'node_modules', 'html5-qrcode')));
app.use(express.static(path.join(__dirname, '..', 'public')));

function runWorker(records, sessions, enrollments) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'attendance-worker.js'), {
      workerData: { records, sessions, enrollments }
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Attendance worker exited with code ${code}.`));
    });
  });
}

async function validateInParallel(records) {
  const now = Date.now();
  const sessions = db.prepare(`
    SELECT id, class_id AS classId, token_hash AS tokenHash, starts_at AS startsAt,
           late_after AS lateAfter, ends_at AS endsAt
    FROM attendance_sessions WHERE ends_at >= ?
  `).all(now);
  const enrollments = db.prepare(`
    SELECT e.class_id AS classId, e.student_id AS studentId
    FROM enrollments e JOIN users u ON u.id = e.student_id AND u.active = 1
  `).all().map(({ classId, studentId }) => `${classId}:${studentId}`);

  const workerCount = Math.min(records.length, Math.max(1, Math.min(availableParallelism ? availableParallelism() : cpus().length, 4)));
  const chunkSize = Math.ceil(records.length / workerCount);
  const batches = [];
  for (let offset = 0; offset < records.length; offset += chunkSize) {
    batches.push(records.slice(offset, offset + chunkSize));
  }
  const results = await Promise.all(batches.map((batch) => runWorker(batch, sessions, enrollments)));
  return results.flat().sort((a, b) => a.index - b.index);
}

const listeners = new Map();
function publishAttendance(classId, record) {
  const classListeners = listeners.get(classId);
  if (!classListeners) return;
  for (const response of classListeners) response.write(`event: attendance\ndata: ${JSON.stringify(record)}\n\n`);
}

const insertAttendance = db.prepare(`
  INSERT OR IGNORE INTO attendance (session_id, class_id, student_id, device_id, status, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

async function saveAttendance(records, deviceId = null) {
  const validated = await validateInParallel(records.map((record, index) => ({ ...record, index })));
  const results = [];
  const save = db.transaction(() => {
    for (const item of validated) {
      if (item.error) {
        results[item.index] = { success: false, error: item.error };
        continue;
      }
      const saved = insertAttendance.run(
        item.sessionId,
        item.classId,
        item.studentId,
        deviceId,
        item.status,
        new Date(item.recordedAt).toISOString()
      );
      if (!saved.changes) {
        results[item.index] = { success: false, duplicate: true, error: 'Attendance has already been recorded for this session.' };
        continue;
      }
      const student = db.prepare('SELECT full_name FROM users WHERE id = ?').get(item.studentId);
      const response = {
        class_id: item.classId,
        session_id: item.sessionId,
        student_id: item.studentId,
        student_name: student.full_name,
        status: item.status,
        recorded_at: new Date(item.recordedAt).toISOString()
      };
      results[item.index] = { success: true, record: response };
      publishAttendance(item.classId, response);
    }
  });
  save();
  return results;
}

function deviceAuth(req, res, next) {
  const id = Number(req.get('x-device-id'));
  const key = req.get('x-device-key');
  if (!Number.isSafeInteger(id) || id <= 0 || !key) return next(httpError(401, 'Valid X-Device-ID and X-Device-Key headers are required.'));
  const device = db.prepare('SELECT id, key_hash FROM devices WHERE id = ? AND active = 1').get(id);
  if (!device || !safeEqual(device.key_hash, sha256(key))) return next(httpError(401, 'Device credentials are invalid or revoked.'));
  req.device = device;
  next();
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) throw httpError(401, 'Email or password is incorrect.');

    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO web_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, Date.now() + 7 * 24 * 60 * 60 * 1000);
    res.cookie('attendance_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });
    res.json({ user: cleanUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.attendance_session;
  if (token) db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie('attendance_session', { path: '/' });
  res.json({ success: true });
});

app.get('/api/me', (req, res, next) => {
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  res.json({ user: req.user });
});

app.get('/api/classes', (req, res, next) => {
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT c.*, u.full_name AS teacher_name FROM classes c JOIN users u ON u.id = c.teacher_id ORDER BY c.name').all()
    : req.user.role === 'teacher'
      ? db.prepare('SELECT c.*, u.full_name AS teacher_name FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.teacher_id = ? ORDER BY c.name').all(req.user.id)
      : db.prepare('SELECT c.*, u.full_name AS teacher_name FROM classes c JOIN users u ON u.id = c.teacher_id JOIN enrollments e ON e.class_id = c.id WHERE e.student_id = ? ORDER BY c.name').all(req.user.id);
  res.json({ classes: rows });
});

app.post('/api/classes', requireRole('admin', 'teacher'), (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw httpError(400, 'Class name is required.');
    const schedule = String(req.body.schedule || '').trim();
    if (!isValidSchedule(schedule)) throw httpError(400, 'Choose a valid schedule date and time.');
    const teacherId = req.user.role === 'admin' && req.body.teacher_id ? Number(req.body.teacher_id) : req.user.id;
    const teacher = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'teacher' AND active = 1").get(teacherId);
    if (!teacher) throw httpError(400, 'Select an active teacher for this class.');
    const result = db.prepare('INSERT INTO classes (name, subject, schedule, teacher_id) VALUES (?, ?, ?, ?)').run(
      name, String(req.body.subject || '').trim(), schedule, teacherId
    );
    res.status(201).json({ class: classById.get(result.lastInsertRowid) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/classes/:id', requireRole('admin', 'teacher'), (req, res, next) => {
  const classId = Number(req.params.id);
  const classroom = classById.get(classId);
  if (!classroom) return next(httpError(404, 'Class not found.'));
  if (!canAccessClass(req.user, classId)) return next(httpError(403, 'You do not manage this class.'));
  const name = String(req.body.name ?? classroom.name).trim();
  if (!name) return next(httpError(400, 'Class name is required.'));
  const schedule = String(req.body.schedule ?? classroom.schedule).trim();
  if (req.body.schedule !== undefined && !isValidSchedule(schedule)) return next(httpError(400, 'Choose a valid schedule date and time.'));
  db.prepare('UPDATE classes SET name = ?, subject = ?, schedule = ? WHERE id = ?').run(
    name,
    String(req.body.subject ?? classroom.subject).trim(),
    schedule,
    classId
  );
  res.json({ class: classById.get(classId) });
});

app.get('/api/classes/:id/students', (req, res, next) => {
  const classId = Number(req.params.id);
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  if (!canAccessClass(req.user, classId) || req.user.role === 'student') return next(httpError(403, 'You do not have permission to view this class roster.'));
  const students = db.prepare(`
    SELECT u.id, u.full_name, u.email FROM enrollments e
    JOIN users u ON u.id = e.student_id
    WHERE e.class_id = ? AND u.active = 1 ORDER BY u.full_name
  `).all(classId);
  res.json({ students });
});

app.get('/api/students', requireRole('admin', 'teacher'), (req, res) => {
  const students = db.prepare(`
    SELECT id, full_name, email FROM users
    WHERE role = 'student' AND active = 1 ORDER BY full_name
  `).all();
  res.json({ students });
});

app.post('/api/classes/:id/enroll', requireRole('admin', 'teacher'), (req, res, next) => {
  try {
    const classId = Number(req.params.id);
    if (!canAccessClass(req.user, classId)) throw httpError(403, 'You do not manage this class.');
    const student = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student' AND active = 1").get(Number(req.body.student_id));
    if (!student) throw httpError(400, 'Select an active student.');
    db.prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?, ?)').run(classId, student.id);
    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/classes/:id/enroll/:studentId', requireRole('admin', 'teacher'), (req, res, next) => {
  const classId = Number(req.params.id);
  if (!canAccessClass(req.user, classId)) return next(httpError(403, 'You do not manage this class.'));
  db.prepare('DELETE FROM enrollments WHERE class_id = ? AND student_id = ?').run(classId, Number(req.params.studentId));
  res.json({ success: true });
});

app.get('/api/users', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, full_name, email, role, active FROM users ORDER BY role, full_name').all()
    .map((user) => ({ ...user, active: Boolean(user.active) }));
  res.json({ users });
});

app.post('/api/users', requireRole('admin'), async (req, res, next) => {
  try {
    const fullName = String(req.body.full_name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = String(req.body.role || '');
    if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a name and a valid email address.');
    if (!['admin', 'teacher', 'student'].includes(role)) throw httpError(400, 'Select a valid role.');
    if (password.length < 10) throw httpError(400, 'Password must be at least 10 characters.');
    const result = db.prepare('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
      fullName, email, await bcrypt.hash(password, 12), role
    );
    res.status(201).json({ user: cleanUser(userById.get(result.lastInsertRowid)) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(httpError(409, 'An account with that email already exists.'));
    next(error);
  }
});

app.get('/api/devices', requireRole('admin'), (req, res) => {
  const devices = db.prepare('SELECT id, name, location, active, last_seen_at FROM devices ORDER BY name').all()
    .map((device) => ({ ...device, active: Boolean(device.active) }));
  res.json({ devices });
});

app.post('/api/devices', requireRole('admin'), (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw httpError(400, 'Device name is required.');
    const key = randomBytes(32).toString('hex');
    const result = db.prepare('INSERT INTO devices (name, location, key_hash) VALUES (?, ?, ?)').run(
      name, String(req.body.location || '').trim(), sha256(key)
    );
    res.status(201).json({ device: { id: result.lastInsertRowid, name, location: String(req.body.location || '').trim() }, device_key: key });
  } catch (error) {
    next(error);
  }
});

app.post('/api/devices/:id/revoke', requireRole('admin'), (req, res) => {
  db.prepare('UPDATE devices SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

app.post('/api/device/sync', deviceAuth, async (req, res, next) => {
  try {
    const records = req.body.records;
    if (!Array.isArray(records) || records.length === 0 || records.length > 1000) throw httpError(400, 'Provide between 1 and 1000 attendance records.');
    const results = await saveAttendance(records, req.device.id);
    db.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?").run(req.device.id);
    res.json({
      processed: results.length,
      accepted: results.filter((result) => result && result.success).length,
      rejected: results.filter((result) => !result || !result.success).length,
      results
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions', requireRole('admin', 'teacher'), async (req, res, next) => {
  try {
    const classId = Number(req.body.class_id);
    if (!canAccessClass(req.user, classId)) throw httpError(403, 'You do not manage this class.');
    const lateMinutes = Number(req.body.late_after_minutes ?? 10);
    const durationMinutes = Number(req.body.duration_minutes ?? 240);
    if (!Number.isInteger(lateMinutes) || lateMinutes < 0 || lateMinutes > 180) throw httpError(400, 'Late threshold must be between 0 and 180 minutes.');
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) throw httpError(400, 'Session duration must be between 1 and 720 minutes.');
    const now = Date.now();
    const token = randomBytes(24).toString('base64url');
    const result = db.prepare(`
      INSERT INTO attendance_sessions (class_id, token_hash, starts_at, late_after, ends_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(classId, sha256(token), now, now + lateMinutes * 60_000, now + durationMinutes * 60_000, req.user.id);
    const origin = `${req.protocol}://${req.get('host')}`;
    const checkinUrl = `${origin}/?token=${encodeURIComponent(token)}`;
    const qr = await QRCode.toDataURL(checkinUrl, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
    res.status(201).json({ session: { id: result.lastInsertRowid, class_id: classId, starts_at: now, late_after: now + lateMinutes * 60_000, ends_at: now + durationMinutes * 60_000 }, checkin_url: checkinUrl, qr });
  } catch (error) {
    next(error);
  }
});

app.post('/api/attendance', requireRole('student'), async (req, res, next) => {
  try {
    if (typeof req.body.token !== 'string') throw httpError(400, 'QR attendance token is required.');
    const results = await saveAttendance([{ token: req.body.token, student_id: req.user.id }]);
    if (!results[0].success) throw httpError(results[0].duplicate ? 409 : 400, results[0].error);
    res.status(201).json(results[0]);
  } catch (error) {
    next(error);
  }
});

app.get('/api/dashboard', (req, res, next) => {
  try {
    if (!req.user) throw httpError(401, 'Please sign in.');
    if (req.user.role === 'student') throw httpError(403, 'Only administrators and teachers can monitor a class dashboard.');
    const classId = Number(req.query.class_id);
    if (!Number.isSafeInteger(classId) || !canAccessClass(req.user, classId)) throw httpError(403, 'Select a class you are allowed to view.');
    const classroom = classById.get(classId);
    const session = db.prepare(`
      SELECT id, starts_at, late_after, ends_at FROM attendance_sessions
      WHERE class_id = ? AND date(starts_at / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')
      ORDER BY starts_at DESC LIMIT 1
    `).get(classId);
    if (!session) return res.json({ class: classroom, session: null, totals: { present: 0, late: 0, absent: 0 }, students: [] });
    const students = db.prepare(`
      SELECT u.id, u.full_name, u.email, a.status, a.recorded_at
      FROM enrollments e JOIN users u ON u.id = e.student_id AND u.active = 1
      LEFT JOIN attendance a ON a.student_id = u.id AND a.session_id = ?
      WHERE e.class_id = ? ORDER BY u.full_name
    `).all(session.id, classId).map((student) => ({
      ...student,
      status: student.status || 'absent'
    }));
    const totals = {
      present: students.filter((student) => student.status === 'present').length,
      late: students.filter((student) => student.status === 'late').length,
      absent: students.filter((student) => student.status === 'absent').length
    };
    res.json({ class: classroom, session, totals, students });
  } catch (error) {
    next(error);
  }
});

function reportRange(period, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, 'Provide a valid report date.');
  const anchor = new Date(`${date}T00:00:00`);
  const normalizedDate = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`;
  if (!Number.isFinite(anchor.getTime()) || normalizedDate !== date) throw httpError(400, 'Provide a valid report date.');
  const start = new Date(anchor);
  const end = new Date(anchor);
  if (period === 'weekly') {
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 7);
  } else if (period === 'monthly') {
    start.setDate(1);
    end.setMonth(start.getMonth() + 1, 1);
  } else if (period === 'daily') {
    end.setDate(end.getDate() + 1);
  } else {
    throw httpError(400, 'Period must be daily, weekly, or monthly.');
  }
  return { start: start.getTime(), end: end.getTime() };
}

function buildReport(req) {
  const classId = Number(req.query.class_id);
  if (!Number.isSafeInteger(classId) || !canAccessClass(req.user, classId)) throw httpError(403, 'Select a class you are allowed to view.');
  const localToday = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const date = String(req.query.date || localToday);
  const period = String(req.query.period || 'daily');
  const { start, end } = reportRange(period, date);
  const classroom = classById.get(classId);
  const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM attendance_sessions WHERE class_id = ? AND starts_at >= ? AND starts_at < ?').get(classId, start, end).count;
  const rows = db.prepare(`
    SELECT u.id AS student_id, u.full_name, u.email,
      COUNT(a.id) AS attended,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
    FROM enrollments e JOIN users u ON u.id = e.student_id AND u.active = 1
    LEFT JOIN attendance a ON a.student_id = u.id
      AND a.class_id = e.class_id AND CAST(strftime('%s', a.recorded_at) AS INTEGER) >= ?
      AND CAST(strftime('%s', a.recorded_at) AS INTEGER) < ?
    WHERE e.class_id = ? GROUP BY u.id ORDER BY u.full_name
  `).all(start / 1000, end / 1000, classId)
    .filter((row) => req.user.role !== 'student' || row.student_id === req.user.id)
    .map((row) => ({
    ...row,
    attended: Number(row.attended || 0),
    late: Number(row.late || 0),
    absent: Math.max(0, sessionCount - Number(row.attended || 0))
  }));
  return { class: classroom, period, date, session_count: sessionCount, students: rows };
}

app.get('/api/reports', (req, res, next) => {
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  try {
    res.json(buildReport(req));
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports/export', async (req, res, next) => {
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  try {
    const report = buildReport(req);
    const baseName = `attendance-${report.class.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${report.period}-${report.date}`;
    if (req.query.format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Attendance');
      worksheet.columns = [
        { header: 'Student', key: 'full_name', width: 30 },
        { header: 'Email', key: 'email', width: 32 },
        { header: 'Sessions Held', key: 'sessions', width: 16 },
        { header: 'Attended', key: 'attended', width: 12 },
        { header: 'Late', key: 'late', width: 10 },
        { header: 'Absent', key: 'absent', width: 10 }
      ];
      worksheet.addRows(report.students.map((student) => ({ ...student, sessions: report.session_count })));
      worksheet.getRow(1).font = { bold: true };
      const output = await workbook.xlsx.writeBuffer();
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`)
        .send(Buffer.from(output));
      return;
    }
    if (req.query.format !== 'pdf') throw httpError(400, 'Export format must be pdf or xlsx.');
    res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
    const pdf = new PDFDocument({ margin: 40, size: 'A4' });
    pdf.pipe(res);
    pdf.fontSize(18).text('Attendance report');
    pdf.moveDown(0.4).fontSize(11).text(`${report.class.name} | ${report.period} | ${report.date}`);
    pdf.text(`Sessions held: ${report.session_count}`).moveDown();
    pdf.font('Helvetica-Bold').text('Student                              Attended   Late   Absent');
    pdf.font('Helvetica');
    for (const student of report.students) {
      pdf.text(`${student.full_name.slice(0, 32).padEnd(34)} ${String(student.attended).padStart(6)} ${String(student.late).padStart(7)} ${String(student.absent).padStart(8)}`);
      if (pdf.y > 740) pdf.addPage();
    }
    pdf.end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/events', (req, res, next) => {
  const classId = Number(req.query.class_id);
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  if (req.user.role === 'student') return next(httpError(403, 'Students cannot monitor class-wide attendance events.'));
  if (!Number.isSafeInteger(classId) || !canAccessClass(req.user, classId)) return next(httpError(403, 'Select a class you are allowed to monitor.'));
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache'
  });
  res.flushHeaders();
  res.write('event: ready\ndata: {}\n\n');
  if (!listeners.has(classId)) listeners.set(classId, new Set());
  listeners.get(classId).add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    listeners.get(classId)?.delete(res);
    if (listeners.get(classId)?.size === 0) listeners.delete(classId);
  });
});

app.use('/api', (req, res, next) => next(httpError(404, 'API endpoint not found.')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'An unexpected server error occurred.' : error.message });
});

async function bootstrapAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return;
  const email = String(process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || randomBytes(18).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare("INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run('System Administrator', email, passwordHash);
  console.log(`Initial administrator: ${email}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`One-time administrator password: ${password}`);
}

bootstrapAdmin().then(() => {
  db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(Date.now());
  app.listen(port, '0.0.0.0', () => console.log(`Attendance system listening on http://localhost:${port}`));
}).catch((error) => {
  console.error('Unable to initialize the attendance system:', error);
  process.exitCode = 1;
});

module.exports = { app, db };
