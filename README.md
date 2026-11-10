# Multi-Device Attendance Monitoring System

A browser-based attendance system built with Node.js, Express, and SQLite. It supports administrator, teacher, and student accounts; class rosters; QR check-in; device synchronization; live monitoring; reports; and PDF/Excel exports.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

```powershell
npm install
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "choose-a-strong-password"
npm start
```

Open `http://localhost:3000`. If `ADMIN_PASSWORD` is omitted on the first run, the server creates a random one-time administrator password and prints it to the terminal. The initial administrator email defaults to `admin@example.com`. The SQLite database is created in `data\attendance.sqlite`; set `DATA_DIRECTORY` to store it elsewhere.

## First use

1. Sign in as the initial administrator.
2. Create teacher and student accounts under **Users**.
3. Create classes using a subject code and the date/time picker, edit class details or schedules, then enroll students under **Classes**.
4. A teacher or administrator starts a QR attendance session under **QR attendance**. Set a late threshold and session duration.
5. Students sign in and open **Scan QR code**, or scan the generated link with their phone. Camera scanning requires a secure context (HTTPS, or localhost) and camera permission.
6. Monitor counts on **Overview**. The attendance table refreshes in real time as check-ins are recorded.
7. Generate daily, weekly, or monthly reports and export them as PDF or Excel.
8. Administrators can register connected devices under **Devices**. The key is displayed only once; store it securely.

## Device synchronization API

Send a batch to `POST /api/device/sync` with `Content-Type: application/json`, `X-Device-ID`, and `X-Device-Key` headers:

```json
{
  "records": [
    { "token": "attendance-session-token", "student_id": 12 },
    { "token": "attendance-session-token", "student_id": 13, "recorded_at": "2026-11-10T09:05:00.000Z" }
  ]
}
```

The endpoint accepts up to 1,000 records, validates independent records in worker threads, returns a result per submitted record, and synchronizes them to the central SQLite database. A unique constraint on `(session_id, student_id)` prevents duplicate attendance, including concurrent submissions.

## Notes

- Run behind HTTPS in deployments accessible over a network. Set `NODE_ENV=production` so authentication cookies are marked secure.
- Device keys and passwords should be handled as credentials; rotate/revoke compromised device keys by revoking and registering a replacement.
- SQLite is suitable for a local prototype or modest single-server deployment. For high write concurrency or multiple server instances, migrate to a network database and shared session/event infrastructure.
- Class schedules are saved as a selected local date and time; administrators can review attendance sessions and exports for daily, weekly, and monthly periods.
