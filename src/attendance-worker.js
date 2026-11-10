const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

const sessions = new Map(workerData.sessions.map((session) => [session.tokenHash, session]));
const enrollments = new Set(workerData.enrollments);
const results = [];

for (const record of workerData.records) {
  const index = record.index;
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  const studentId = Number(record.student_id);
  const session = token ? sessions.get(hashToken(token)) : null;

  if (!Number.isSafeInteger(studentId) || studentId <= 0) {
    results.push({ index, error: 'A valid student_id is required.' });
    continue;
  }
  if (!session) {
    results.push({ index, error: 'The attendance QR code is invalid or expired.' });
    continue;
  }
  if (!enrollments.has(`${session.classId}:${studentId}`)) {
    results.push({ index, error: 'The student is not enrolled in this class.' });
    continue;
  }

  const recordedAt = record.recorded_at ? Date.parse(record.recorded_at) : Date.now();
  if (!Number.isFinite(recordedAt) || recordedAt < session.startsAt || recordedAt > session.endsAt) {
    results.push({ index, error: 'The attendance time is outside the session window.' });
    continue;
  }

  results.push({
    index,
    sessionId: session.id,
    classId: session.classId,
    studentId,
    recordedAt,
    status: recordedAt > session.lateAfter ? 'late' : 'present'
  });
}

parentPort.postMessage(results);
