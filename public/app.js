const state = { user: null, classes: [], classId: '', page: 'dashboard', events: null, scan: null };
const $ = (selector) => document.querySelector(selector);
const pageContent = $('#page-content');
const notice = $('#notice');

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    if (contentType.includes('application/json')) {
      const data = await response.json();
      message = data.error || message;
    }
    throw new Error(message);
  }
  if (contentType.includes('application/json')) return response.json();
  return response;
}

function notify(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle('error-notice', error);
  notice.classList.remove('hidden');
  window.clearTimeout(notify.timeout);
  notify.timeout = window.setTimeout(() => notice.classList.add('hidden'), 5000);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function dateInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function scheduleInputValue(schedule) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(schedule || '') ? schedule : '';
}

function formatSchedule(schedule) {
  if (!schedule) return 'No schedule selected';
  const date = new Date(schedule);
  return Number.isNaN(date.getTime()) ? schedule : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function button(text, action, className = 'secondary') {
  return `<button type="button" class="${className}" data-action="${action}">${escapeHtml(text)}</button>`;
}

function closeEvents() {
  if (state.events) state.events.close();
  state.events = null;
}

function setupNavigation() {
  const items = state.user.role === 'admin'
    ? [['dashboard', 'Overview'], ['sessions', 'QR attendance'], ['reports', 'Reports'], ['classes', 'Classes'], ['users', 'Users'], ['devices', 'Devices']]
    : state.user.role === 'teacher'
      ? [['dashboard', 'Overview'], ['sessions', 'QR attendance'], ['reports', 'Reports'], ['classes', 'Classes']]
      : [['dashboard', 'My attendance'], ['scan', 'Scan QR code'], ['reports', 'My reports']];
  $('#navigation').innerHTML = items.map(([id, label]) => `<button type="button" data-page="${id}" class="${state.page === id ? 'active' : ''}">${label}</button>`).join('');
}

function fillClassSelect() {
  const select = $('#class-select');
  select.innerHTML = '<option value="">Select a class</option>' + state.classes.map((classroom) =>
    `<option value="${classroom.id}">${escapeHtml(classroom.name)}</option>`
  ).join('');
  select.value = state.classId;
  select.disabled = state.classes.length === 0;
}

async function enterApp(user) {
  state.user = user;
  state.page = user.role === 'student' ? 'dashboard' : 'dashboard';
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#current-user').textContent = `${user.full_name} · ${user.role}`;
  state.classes = (await api('/api/classes')).classes;
  if (state.classes.length) state.classId = String(state.classes[0].id);
  fillClassSelect();
  setupNavigation();
  await renderPage();
  const token = new URLSearchParams(location.search).get('token');
  if (token && user.role === 'student') {
    history.replaceState(null, '', '/');
    submitAttendance(token);
  }
}

async function loadCurrentUser() {
  try {
    const { user } = await api('/api/me');
    await enterApp(user);
  } catch {
    $('#login-view').classList.remove('hidden');
    $('#app-view').classList.add('hidden');
  }
}

async function renderPage() {
  closeEvents();
  if (state.scan) {
    try { await state.scan.stop(); } catch {}
    try { await state.scan.clear(); } catch {}
    state.scan = null;
  }
  setupNavigation();
  const title = {
    dashboard: state.user.role === 'student' ? 'My attendance' : 'Attendance overview',
    sessions: 'QR attendance',
    reports: 'Attendance reports',
    classes: 'Class management',
    users: 'User accounts',
    devices: 'Attendance devices',
    scan: 'Scan attendance QR'
  }[state.page];
  if (state.page === 'dashboard') return renderDashboard(title);
  if (state.page === 'sessions') return renderSessions(title);
  if (state.page === 'reports') return renderReports(title);
  if (state.page === 'classes') return renderClasses(title);
  if (state.page === 'users') return renderUsers(title);
  if (state.page === 'devices') return renderDevices(title);
  if (state.page === 'scan') return renderScanner(title);
}

function heading(title, description = '') {
  return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div></div>`;
}

function renderDashboard(title) {
  if (!state.classId) {
    pageContent.innerHTML = `${heading(title, 'Set up a class to get started.')}<div class="card empty">No class is available for this account yet.</div>`;
    return;
  }
  if (state.user.role === 'student') {
    pageContent.innerHTML = `${heading(title, 'Your enrolled classes and latest attendance records.')}<div id="student-attendance" class="grid two-col"></div>`;
    loadStudentHistory();
    return;
  }
  pageContent.innerHTML = `${heading(title, 'Live attendance status for the selected class.')}
    <div id="dashboard-data"></div>`;
  loadDashboard();
  const events = new EventSource(`/api/events?class_id=${encodeURIComponent(state.classId)}`);
  events.addEventListener('attendance', () => loadDashboard());
  state.events = events;
}

async function loadDashboard() {
  try {
    const data = await api(`/api/dashboard?class_id=${encodeURIComponent(state.classId)}`);
    const target = $('#dashboard-data');
    if (!target) return;
    if (!data.session) {
      target.innerHTML = '<div class="card empty">No attendance session has been started for this class today.</div>';
      return;
    }
    target.innerHTML = `
      <div class="grid stats">
        <div class="card"><span class="stat-label">Present</span><strong class="stat-value">${data.totals.present}</strong></div>
        <div class="card"><span class="stat-label">Late</span><strong class="stat-value">${data.totals.late}</strong></div>
        <div class="card"><span class="stat-label">Absent</span><strong class="stat-value">${data.totals.absent}</strong></div>
      </div>
      <div class="card"><div class="section-title"><h2>${escapeHtml(data.class.name)}</h2><span class="muted">Live session</span></div>
        ${studentTable(data.students, true)}
      </div>`;
  } catch (error) { notify(error.message, true); }
}

async function loadStudentHistory() {
  const target = $('#student-attendance');
  if (!target) return;
  const reports = await Promise.all(state.classes.map(async (classroom) => {
    const data = await api(`/api/reports?class_id=${classroom.id}&period=monthly`);
    return { classroom, student: data.students.find((row) => row.student_id === state.user.id), sessions: data.session_count };
  })).catch((error) => { notify(error.message, true); return []; });
  if (!target.isConnected) return;
  target.innerHTML = reports.map(({ classroom, student, sessions }) => `
    <div class="card"><p class="muted">${escapeHtml(classroom.subject || 'Class')}</p><h2>${escapeHtml(classroom.name)}</h2>
      <p>Sessions this month: <strong>${sessions}</strong></p>
      <p>Attended: <strong>${student?.attended || 0}</strong> · Late: <strong>${student?.late || 0}</strong> · Absent: <strong>${student?.absent || 0}</strong></p>
      <p class="footer-note">${escapeHtml(classroom.teacher_name || '')}</p>
    </div>`).join('') || '<div class="card empty">No attendance data to show.</div>';
}

function studentTable(students, showEmail = false) {
  if (!students.length) return '<div class="empty">No students are enrolled in this class.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Student</th>${showEmail ? '<th>Email</th>' : ''}<th>Status</th><th>Recorded</th></tr></thead><tbody>
    ${students.map((student) => `<tr><td>${escapeHtml(student.full_name)}</td>${showEmail ? `<td>${escapeHtml(student.email)}</td>` : ''}<td><span class="badge ${escapeHtml(student.status)}">${escapeHtml(student.status)}</span></td><td>${escapeHtml(formatDate(student.recorded_at))}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function renderSessions(title) {
  if (!state.classId) {
    pageContent.innerHTML = `${heading(title, 'Select a class before creating an attendance QR code.')}<div class="card empty">Create or join a class first.</div>`;
    return;
  }
  pageContent.innerHTML = `${heading(title, 'Create a QR session for students to check in from any connected device.')}
    <div class="qr-layout">
      <form id="session-form" class="card stack">
        <h2>Start a session</h2>
        <label>Late after (minutes)<input name="late_after_minutes" type="number" min="0" max="180" value="10" required></label>
        <label>Session duration (minutes)<input name="duration_minutes" type="number" min="1" max="720" value="240" required></label>
        <button class="primary">Generate QR code</button>
      </form>
      <div id="qr-output" class="card qr-preview"><p class="muted">Your session QR code will appear here.</p></div>
    </div>`;
}

function renderScanner(title) {
  pageContent.innerHTML = `${heading(title, 'Allow camera access to scan the class QR code, or enter its check-in link.')}
    <div class="grid two-col">
      <div class="card"><div id="qr-reader"></div><p id="scan-message" class="helper"></p></div>
      <form id="manual-checkin" class="card stack">
        <label>QR code or check-in link<input name="token" autocomplete="off" required></label>
        <button class="primary">Record my attendance</button>
      </form>
    </div>`;
  $('#manual-checkin').addEventListener('submit', (event) => {
    event.preventDefault();
    submitAttendance($('#manual-checkin [name="token"]').value);
  });
  if (window.Html5Qrcode) {
    state.scan = new Html5Qrcode('qr-reader');
    state.scan.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } }, (text) => {
      submitAttendance(text);
    }).catch((error) => {
      const message = $('#scan-message');
      if (message) message.textContent = `Camera unavailable. Use the check-in link field instead. ${error}`;
    });
  } else {
    $('#scan-message').textContent = 'QR camera scanner could not be loaded. Use the check-in link field instead.';
  }
}

async function submitAttendance(value) {
  const match = String(value).match(/[?&]token=([^&]+)/);
  const token = match ? decodeURIComponent(match[1]) : String(value).trim();
  if (!token) return notify('Scan or enter a valid attendance QR code.', true);
  try {
    const result = await api('/api/attendance', { method: 'POST', body: JSON.stringify({ token }) });
    notify(`Attendance recorded as ${result.record.status}.`);
    if (state.scan) {
      try { await state.scan.stop(); } catch {}
    }
    if (state.page === 'dashboard') renderDashboard('My attendance');
  } catch (error) { notify(error.message, true); }
}

function renderReports(title) {
  pageContent.innerHTML = `${heading(title, 'Review daily, weekly, or monthly attendance and export a copy.')}
    <div class="card">
      <form id="report-form" class="report-controls">
        ${state.user.role !== 'student' ? '<label>Class<select name="class_id" required></select></label>' : ''}
        <label>Period<select name="period"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label>Anchor date<input name="date" type="date" value="${dateInputValue()}" required></label>
        <button class="primary">Run report</button>
        <button type="button" class="secondary" data-export="pdf">Export PDF</button>
        <button type="button" class="secondary" data-export="xlsx">Export Excel</button>
      </form>
    </div>
    <div id="report-output" class="card" style="margin-top:16px"><div class="empty">Choose report filters and run the report.</div></div>`;
  const classSelect = $('#report-form [name="class_id"]');
  if (classSelect) {
    classSelect.innerHTML = state.classes.map((classroom) => `<option value="${classroom.id}">${escapeHtml(classroom.name)}</option>`).join('');
    classSelect.value = state.classId;
  }
  $('#report-form').addEventListener('submit', (event) => { event.preventDefault(); runReport(); });
  $('#report-form').addEventListener('click', (event) => {
    const format = event.target.dataset.export;
    if (!format) return;
    const params = reportParams();
    window.location.href = `/api/reports/export?${params}&format=${format}`;
  });
}

function reportParams() {
  const form = new FormData($('#report-form'));
  const query = new URLSearchParams();
  if (state.user.role === 'student') query.set('class_id', state.classId);
  else query.set('class_id', form.get('class_id'));
  query.set('period', form.get('period'));
  query.set('date', form.get('date'));
  return query.toString();
}

async function runReport() {
  try {
    const data = await api(`/api/reports?${reportParams()}`);
    const output = $('#report-output');
    if (!output) return;
    output.innerHTML = `<div class="section-title"><h2>${escapeHtml(data.class.name)}</h2><span class="muted">${data.session_count} sessions</span></div>
      <div class="table-wrap"><table><thead><tr><th>Student</th><th>Attended</th><th>Late</th><th>Absent</th></tr></thead><tbody>
      ${data.students.map((student) => `<tr><td>${escapeHtml(student.full_name)}</td><td>${student.attended}</td><td>${student.late}</td><td>${student.absent}</td></tr>`).join('') || '<tr><td colspan="4">No enrolled students.</td></tr>'}
      </tbody></table></div>`;
  } catch (error) { notify(error.message, true); }
}

async function renderClasses(title) {
  const classroomOptions = state.user.role === 'admin'
    ? `<label>Teacher<select name="teacher_id" required></select></label>`
    : '';
  pageContent.innerHTML = `${heading(title, 'Create classes and enroll students into their rosters.')}
    <div class="grid two-col">
      <form id="class-form" class="card stack"><h2>Create class</h2>
        <div class="form-grid">
          <label>Subject Code<input name="name" placeholder="e.g. CS101" required></label>
          <label>Subject<input name="subject"></label>
          <label class="wide">Schedule date and time<input name="schedule" type="datetime-local" required></label>
          ${classroomOptions}
        </div><button class="primary">Create class</button>
      </form>
      <form id="enroll-form" class="card stack"><h2>Enroll student</h2>
        <label>Class<select name="class_id" required></select></label>
        <label>Student<select name="student_id" required></select></label>
        <button class="primary">Enroll</button>
      </form>
    </div>
    <div id="class-list" class="grid two-col" style="margin-top:16px"></div>`;
  const classOptions = state.classes.map((classroom) => `<option value="${classroom.id}">${escapeHtml(classroom.name)}</option>`).join('');
  $('#enroll-form [name="class_id"]').innerHTML = classOptions;
  if (state.user.role === 'admin') {
    const users = (await api('/api/users')).users;
    if (!$('#class-form')) return;
    const teachers = users.filter((user) => user.role === 'teacher' && user.active);
    const students = users.filter((user) => user.role === 'student' && user.active);
    $('#class-form [name="teacher_id"]').innerHTML = teachers.map((user) => `<option value="${user.id}">${escapeHtml(user.full_name)}</option>`).join('');
    $('#enroll-form [name="student_id"]').innerHTML = students.map((user) => `<option value="${user.id}">${escapeHtml(user.full_name)} · ${escapeHtml(user.email)}</option>`).join('');
  } else {
    const students = await api('/api/students');
    $('#enroll-form [name="student_id"]').innerHTML = students.students
      .map((user) => `<option value="${user.id}">${escapeHtml(user.full_name)} · ${escapeHtml(user.email)}</option>`).join('');
    if (state.classes.length === 0 || students.students.length === 0) $('#enroll-form').classList.add('hidden');
  }
  $('#class-form').addEventListener('submit', createClass);
  $('#enroll-form').addEventListener('submit', enrollStudent);
  await loadClassCards();
}

async function createClass(event) {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    if (payload.teacher_id) payload.teacher_id = Number(payload.teacher_id);
    await api('/api/classes', { method: 'POST', body: JSON.stringify(payload) });
    await refreshClasses();
    notify('Class created.');
    await renderClasses('Class management');
  } catch (error) { notify(error.message, true); }
}

async function refreshClasses() {
  state.classes = (await api('/api/classes')).classes;
  if (!state.classes.some((classroom) => String(classroom.id) === state.classId)) state.classId = state.classes.length ? String(state.classes[0].id) : '';
  fillClassSelect();
}

async function enrollStudent(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/classes/${form.get('class_id')}/enroll`, { method: 'POST', body: JSON.stringify({ student_id: Number(form.get('student_id')) }) });
    notify('Student enrolled.');
  } catch (error) { notify(error.message, true); }
}

async function loadClassCards() {
  const cards = await Promise.all(state.classes.map(async (classroom) => {
    const data = await api(`/api/classes/${classroom.id}/students`);
    return `<article class="card"><form class="class-edit stack" data-class-id="${classroom.id}">
      <div class="form-grid">
        <label>Subject Code<input name="name" value="${escapeHtml(classroom.name)}" placeholder="e.g. CS101" required></label>
        <label>Subject<input name="subject" value="${escapeHtml(classroom.subject || '')}"></label>
        <label class="wide">Schedule date and time<input name="schedule" type="datetime-local" value="${escapeHtml(scheduleInputValue(classroom.schedule))}" required></label>
      </div><button class="secondary">Save class details</button>
    </form>
      <p class="muted">${escapeHtml(classroom.subject || 'Subject not set')} · ${escapeHtml(formatSchedule(classroom.schedule))} · ${data.students.length} enrolled</p>${data.students.map((student) => `<div class="section-title"><span>${escapeHtml(student.full_name)}</span><button class="danger" data-remove="${classroom.id}:${student.id}">Remove</button></div>`).join('') || '<p class="empty">No students enrolled.</p>'}
    </article>`;
  }));
  const list = $('#class-list');
  if (!list) return;
  list.innerHTML = cards.join('') || '<div class="card empty">No classes have been created.</div>';
  list.onsubmit = async (event) => {
    if (!event.target.matches('.class-edit')) return;
    event.preventDefault();
    const formData = new FormData(event.target);
    try {
      await api(`/api/classes/${event.target.dataset.classId}`, {
        method: 'PATCH',
        body: JSON.stringify(Object.fromEntries(formData.entries()))
      });
      await refreshClasses();
      notify('Class details updated.');
      await renderClasses('Class management');
    } catch (error) { notify(error.message, true); }
  };
  list.onclick = async (event) => {
    const [classId, studentId] = (event.target.dataset.remove || '').split(':').map(Number);
    if (!classId || !studentId) return;
    try {
      await api(`/api/classes/${classId}/enroll/${studentId}`, { method: 'DELETE' });
      await loadClassCards();
    } catch (error) { notify(error.message, true); }
  };
}

async function renderUsers(title) {
  pageContent.innerHTML = `${heading(title, 'Create separate administrator, teacher, and student accounts.')}
    <div class="grid two-col">
      <form id="user-form" class="card stack"><h2>Create account</h2>
        <label>Full name<input name="full_name" required></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Temporary password<input name="password" type="password" minlength="10" required></label>
        <label>Role<select name="role"><option value="student">Student</option><option value="teacher">Teacher</option><option value="admin">Administrator</option></select></label>
        <button class="primary">Create account</button>
      </form>
      <div id="users-list" class="card"><div class="empty">Loading accounts…</div></div>
    </div>`;
  $('#user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      notify('Account created.');
      renderUsers('User accounts');
    } catch (error) { notify(error.message, true); }
  });
  const users = (await api('/api/users')).users;
  const list = $('#users-list');
  if (!list) return;
  list.innerHTML = `<div class="section-title"><h2>Accounts</h2></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>
    ${users.map((user) => `<tr><td>${escapeHtml(user.full_name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.role)}</td><td><span class="badge ${user.active ? 'active' : 'inactive'}">${user.active ? 'active' : 'inactive'}</span></td></tr>`).join('')}
  </tbody></table></div>`;
}

async function renderDevices(title) {
  pageContent.innerHTML = `${heading(title, 'Register connected attendance devices and manage their access keys.')}
    <div class="grid two-col">
      <form id="device-form" class="card stack"><h2>Register device</h2>
        <label>Device name<input name="name" required></label>
        <label>Location<input name="location" placeholder="Room or site"></label>
        <button class="primary">Register device</button>
        <div id="device-key-output" class="hidden"></div>
      </form>
      <div id="devices-list" class="card"></div>
    </div>
    <p class="footer-note">A device key is shown once at registration. Store it securely and send records to <code>/api/device/sync</code> using <code>X-Device-ID</code> and <code>X-Device-Key</code> headers.</p>`;
  $('#device-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const result = await api('/api/devices', { method: 'POST', body: JSON.stringify(payload) });
      $('#device-key-output').classList.remove('hidden');
      $('#device-key-output').innerHTML = `<p><strong>Save this key now; it will not be shown again.</strong></p><code>${escapeHtml(result.device_key)}</code><p>Device ID: ${result.device.id}</p>`;
      form.reset();
      await loadDevices();
    } catch (error) { notify(error.message, true); }
  });
  await loadDevices();
}

async function loadDevices() {
  const { devices } = await api('/api/devices');
  const list = $('#devices-list');
  if (!list) return;
  list.innerHTML = `<div class="section-title"><h2>Registered devices</h2></div>${devices.map((device) => `
    <div class="section-title"><div><strong>${escapeHtml(device.name)}</strong><div class="muted">${escapeHtml(device.location || 'No location')} · Last sync: ${escapeHtml(formatDate(device.last_seen_at))}</div></div>
      ${device.active ? `<button class="danger" data-revoke="${device.id}">Revoke</button>` : '<span class="badge inactive">revoked</span>'}</div>`).join('') || '<div class="empty">No devices registered.</div>'}`;
  $('#devices-list').onclick = async (event) => {
    const id = event.target.dataset.revoke;
    if (!id) return;
    try {
      await api(`/api/devices/${id}/revoke`, { method: 'POST' });
      await loadDevices();
      notify('Device access revoked.');
    } catch (error) { notify(error.message, true); }
  };
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#login-error');
  error.textContent = '';
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify(payload) });
    await enterApp(result.user);
  } catch (failure) { error.textContent = failure.message; }
});

$('#logout-button').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  closeEvents();
  state.user = null;
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
});

$('#navigation').addEventListener('click', (event) => {
  const page = event.target.dataset.page;
  if (!page) return;
  state.page = page;
  renderPage();
});

$('#class-select').addEventListener('change', (event) => {
  state.classId = event.target.value;
  renderPage();
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'session-form') return;
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    payload.class_id = Number(state.classId);
    const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
    $('#qr-output').innerHTML = `<img src="${result.qr}" alt="Attendance QR code"><h3>Scan to check in</h3><a href="${escapeHtml(result.checkin_url)}">${escapeHtml(result.checkin_url)}</a><p class="footer-note">Late threshold: ${new Date(result.session.late_after).toLocaleTimeString()} · Expires: ${new Date(result.session.ends_at).toLocaleTimeString()}</p>`;
    notify('QR attendance session created.');
  } catch (error) { notify(error.message, true); }
});

loadCurrentUser();
