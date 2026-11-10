const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const net = require('node:net');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('role-based attendance workflow, batch synchronization, reports, and exports', { timeout: 45_000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-system-'));
  const port = await unusedPort();
  const password = 'Test-admin-password-2026';
  const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIRECTORY: directory,
      ADMIN_EMAIL: 'admin@example.test',
      ADMIN_PASSWORD: password,
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const request = async (url, options = {}) => fetch(`${base}${url}`, options);
  const json = (method, body, cookie, headers = {}) => ({
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Server exited during startup:\n${output}`);
      try {
        const response = await request('/api/health');
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(ready, true, `Server did not become ready:\n${output}`);
    const scannerScript = await request('/vendor/html5-qrcode/html5-qrcode.min.js');
    assert.equal(scannerScript.status, 200);
    assert.match(scannerScript.headers.get('content-type'), /javascript/);

    const login = await request('/api/login', json('POST', { email: 'admin@example.test', password }));
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const teacherResponse = await request('/api/users', json('POST', {
      full_name: 'Teacher One',
      email: 'teacher@example.test',
      password: 'Teacher-password-2026',
      role: 'teacher'
    }, cookie));
    assert.equal(teacherResponse.status, 201);
    const teacher = (await teacherResponse.json()).user;

    const studentResponse = await request('/api/users', json('POST', {
      full_name: 'Student One',
      email: 'student@example.test',
      password: 'Student-password-2026',
      role: 'student'
    }, cookie));
    assert.equal(studentResponse.status, 201);
    const student = (await studentResponse.json()).user;

    const secondStudentResponse = await request('/api/users', json('POST', {
      full_name: 'Student Two',
      email: 'student-two@example.test',
      password: 'Student-password-2026',
      role: 'student'
    }, cookie));
    assert.equal(secondStudentResponse.status, 201);
    const secondStudent = (await secondStudentResponse.json()).user;

    const invalidSchedule = await request('/api/classes', json('POST', {
      name: 'Invalid Schedule',
      schedule: 'Monday 9:00 AM',
      teacher_id: teacher.id
    }, cookie));
    assert.equal(invalidSchedule.status, 400);

    const classResponse = await request('/api/classes', json('POST', {
      name: 'Parallel Computing',
      subject: 'Computer Science',
      schedule: '2026-11-10T09:00',
      teacher_id: teacher.id
    }, cookie));
    assert.equal(classResponse.status, 201);
    const classroom = (await classResponse.json()).class;
    const classUpdateResponse = await request(`/api/classes/${classroom.id}`, json('PATCH', {
      name: classroom.name,
      subject: classroom.subject,
      schedule: '2026-11-11T10:00'
    }, cookie));
    assert.equal(classUpdateResponse.status, 200);
    assert.equal((await classUpdateResponse.json()).class.schedule, '2026-11-11T10:00');

    const enrolled = await request(`/api/classes/${classroom.id}/enroll`, json('POST', { student_id: student.id }, cookie));
    assert.equal(enrolled.status, 201);
    const secondEnrolled = await request(`/api/classes/${classroom.id}/enroll`, json('POST', { student_id: secondStudent.id }, cookie));
    assert.equal(secondEnrolled.status, 201);

    const deviceResponse = await request('/api/devices', json('POST', { name: 'Room A tablet', location: 'Room A' }, cookie));
    assert.equal(deviceResponse.status, 201);
    const { device, device_key: deviceKey } = await deviceResponse.json();

    const sessionResponse = await request('/api/sessions', json('POST', {
      class_id: classroom.id,
      late_after_minutes: 0,
      duration_minutes: 240
    }, cookie));
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();
    const token = new URL(session.checkin_url).searchParams.get('token');

    const sync = await request('/api/device/sync', json('POST', {
      records: [
        { token, student_id: student.id, recorded_at: new Date(session.session.starts_at + 1000).toISOString() },
        { token, student_id: student.id, recorded_at: new Date(session.session.starts_at + 1000).toISOString() },
        { token: 'not-a-valid-token', student_id: student.id }
      ]
    }, null, { 'X-Device-ID': String(device.id), 'X-Device-Key': deviceKey }));
    assert.equal(sync.status, 200);
    const syncResult = await sync.json();
    assert.equal(syncResult.accepted, 1);
    assert.equal(syncResult.rejected, 2);
    assert.equal(syncResult.results[0].record.status, 'late');
    assert.equal(syncResult.results[1].duplicate, true);

    const dashboardResponse = await request(`/api/dashboard?class_id=${classroom.id}`, { headers: { Cookie: cookie } });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.deepEqual(dashboard.totals, { present: 0, late: 1, absent: 1 });

    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const reportResponse = await request(`/api/reports?class_id=${classroom.id}&period=daily&date=${today}`, { headers: { Cookie: cookie } });
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.equal(report.session_count, 1);
    assert.equal(report.students[0].attended, 1);
    assert.equal(report.students[0].late, 1);
    assert.equal(report.students[1].absent, 1);

    const weeklyResponse = await request(`/api/reports?class_id=${classroom.id}&period=weekly&date=${today}`, { headers: { Cookie: cookie } });
    assert.equal((await weeklyResponse.json()).session_count, 1);

    const pdf = await request(`/api/reports/export?class_id=${classroom.id}&period=daily&date=${today}&format=pdf`, { headers: { Cookie: cookie } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    const excel = await request(`/api/reports/export?class_id=${classroom.id}&period=daily&date=${today}&format=xlsx`, { headers: { Cookie: cookie } });
    assert.equal(excel.status, 200);
    assert.match(excel.headers.get('content-type'), /spreadsheetml/);

    const teacherLogin = await request('/api/login', json('POST', { email: 'teacher@example.test', password: 'Teacher-password-2026' }));
    const teacherCookie = teacherLogin.headers.get('set-cookie').split(';')[0];
    const studentDirectory = await request('/api/students', { headers: { Cookie: teacherCookie } });
    assert.equal(studentDirectory.status, 200);
    assert.equal((await studentDirectory.json()).students.length, 2);

    const studentLogin = await request('/api/login', json('POST', { email: 'student-two@example.test', password: 'Student-password-2026' }));
    const studentCookie = studentLogin.headers.get('set-cookie').split(';')[0];
    const checkin = await request('/api/attendance', json('POST', { token }, studentCookie));
    assert.equal(checkin.status, 201);
    assert.equal((await checkin.json()).record.student_id, secondStudent.id);
    const duplicateCheckin = await request('/api/attendance', json('POST', { token }, studentCookie));
    assert.equal(duplicateCheckin.status, 409);

    const privateReport = await request(`/api/reports?class_id=${classroom.id}&period=daily&date=${today}`, { headers: { Cookie: studentCookie } });
    const visibleStudents = (await privateReport.json()).students;
    assert.equal(visibleStudents.length, 1);
    assert.equal(visibleStudents[0].student_id, secondStudent.id);
    const privateDashboard = await request(`/api/dashboard?class_id=${classroom.id}`, { headers: { Cookie: studentCookie } });
    assert.equal(privateDashboard.status, 403);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
