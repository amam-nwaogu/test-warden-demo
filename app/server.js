// CareShift: a tiny, zero-dependency mock home-care scheduling app.
// It exists so the AI-generated tests and the Test Warden have something real
// to run against: roles, access rules, an audit log, and switchable failures.
//
// Run:  node app/server.js            (http://localhost:3000)
// Chaos switches (combine with commas):
//   CHAOS=slow    confirm takes CHAOS_DELAY_MS (default 6000 ms)  -> timing
//   CHAOS=reseed  all shift and client IDs change                 -> data drift
//   CHAOS=broken  confirm shows success and "Confirmed", but saves nothing
//                 and writes no audit entry; a reload reveals it   -> real regression

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildSeed, DEMO_PASSWORD } from './data.js';

const PORT = Number(process.env.PORT || 3000);
const CHAOS = new Set((process.env.CHAOS || '').split(',').map((s) => s.trim()).filter(Boolean));
const DELAY_MS = Number(process.env.CHAOS_DELAY_MS || 6000);
const TEST_HOOKS = process.env.TEST_HOOKS !== 'off';

let db = buildSeed({ reseed: CHAOS.has('reseed') });
const sessions = new Map(); // session id -> username
const flashes = new Map(); // session id -> shift id just confirmed (shown once, like a real flash message)

// Request log for the Test Warden: who asked for what, how they relate to the
// record, what the server answered, and which audit entries it wrote. Cleared on
// reset. The epoch makes a request still in flight from an earlier test (for
// example, a slow confirm) unable to write into the next test's data.
const requestContext = new AsyncLocalStorage();
let requestLog = [];
let epoch = 0;

// ---------- helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  const username = sid && sessions.get(sid);
  return username ? db.users.find((u) => u.username === username) : null;
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return Object.fromEntries(new URLSearchParams(body));
}

// Audit entries record IDs only, never client names or notes (spec AC-7).
function audit(user, action, target, outcome, detail = '') {
  const ctx = requestContext.getStore();
  if (ctx && ctx.epoch !== epoch) return; // request began before the last reset
  if (ctx) ctx.audits.push({ action, outcome });
  db.audit.push({
    id: db.audit.length + 1,
    at: new Date().toISOString(),
    actor: user ? user.username : 'anonymous',
    role: user ? user.role : 'none',
    action,
    target,
    outcome,
    detail,
  });
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const redirect = (res, location, headers = {}) => {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
};

function page(title, user, body) {
  const nav = user
    ? `<nav aria-label="Main">
         <a href="/shifts">${user.role === 'scheduler' ? 'All shifts' : 'My shifts'}</a>
         ${user.role === 'scheduler' ? '<a href="/audit">Audit log</a>' : ''}
         <span class="who" data-testid="signed-in-as">Signed in as ${esc(user.name)} (${esc(user.role)})</span>
         <form method="post" action="/logout" class="inline"><button type="submit">Sign out</button></form>
       </nav>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · CareShift</title>
<style>
  :root { --ink:#1d2433; --muted:#5b6475; --line:#d9dee7; --brand:#2f6f5e; --bg:#f7f8fa; --warn:#8a2d2d; }
  * { box-sizing: border-box; }
  body { margin:0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color:var(--ink); background:var(--bg); }
  header { background:var(--brand); color:#fff; padding:12px 24px; display:flex; justify-content:space-between; align-items:center; }
  header strong { font-size:17px; }
  .demo { font-size:12px; opacity:.85; }
  nav { display:flex; gap:16px; align-items:center; padding:10px 24px; background:#fff; border-bottom:1px solid var(--line); }
  nav .who { margin-left:auto; color:var(--muted); font-size:13px; }
  main { max-width:920px; margin:24px auto; padding:0 24px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); }
  th { font-size:13px; color:var(--muted); font-weight:600; }
  button { font:inherit; padding:6px 12px; border:1px solid var(--brand); background:var(--brand); color:#fff; border-radius:6px; cursor:pointer; }
  nav button { background:#fff; color:var(--brand); }
  .inline { display:inline; margin:0; }
  .banner { padding:10px 14px; border-radius:6px; margin-bottom:16px; }
  .ok { background:#e5f3ee; border:1px solid #9cc9b9; }
  .err { background:#f8e8e8; border:1px solid #d9a3a3; color:var(--warn); }
  .card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px 20px; }
  label { display:block; margin:12px 0 4px; font-weight:600; }
  input { font:inherit; padding:8px; width:280px; border:1px solid var(--line); border-radius:6px; }
  .status { font-weight:600; }
  .muted { color:var(--muted); }
</style></head>
<body>
<header><strong>CareShift</strong><span class="demo">Demo app · all data is synthetic</span></header>
${nav}
<main>${body}</main>
</body></html>`;
}

function forbidden(res, user, message) {
  send(res, 403, page('Access denied', user, `<h1>Access denied</h1><div class="banner err" role="alert" data-testid="error-message">${esc(message)}</div><p><a href="/shifts">Back to shifts</a></p>`));
}

function notFound(res, user, message = 'Not found.') {
  send(res, 404, page('Not found', user, `<h1>Not found</h1><div class="banner err" role="alert" data-testid="error-message">${esc(message)}</div>`));
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const user = currentUser(req);
  const ctx = requestContext.getStore();
  ctx.actor = user ? user.username : 'anonymous';
  ctx.role = user ? user.role : 'none';

  // --- test hooks: reset state and read the seed, so tests never hard-code IDs ---
  if (TEST_HOOKS && path.startsWith('/__test/')) {
    if (req.method === 'POST' && path === '/__test/reset') {
      db = buildSeed({ reseed: CHAOS.has('reseed') });
      sessions.clear();
      flashes.clear();
      requestLog = [];
      epoch += 1;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/__test/seed') {
      return json(res, 200, { password: DEMO_PASSWORD, users: db.users, clients: db.clients, shifts: db.shifts });
    }
    if (req.method === 'GET' && path === '/__test/audit') return json(res, 200, db.audit);
    if (req.method === 'GET' && path === '/__test/requests') return json(res, 200, requestLog);
    return json(res, 404, { error: 'unknown test hook' });
  }

  if (path === '/') return redirect(res, user ? '/shifts' : '/login');

  // --- sign in / out ---
  if (path === '/login' && req.method === 'GET') {
    const error = url.searchParams.get('error');
    return send(res, 200, page('Sign in', null, `
      <h1>Sign in</h1>
      ${error ? '<div class="banner err" role="alert" data-testid="error-message">Incorrect username or password.</div>' : ''}
      <form method="post" action="/login" class="card">
        <label for="username">Username</label><input id="username" name="username" autocomplete="username">
        <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
        <p><button type="submit">Sign in</button></p>
      </form>
      <p class="muted">Demo users: sam.scheduler, cara.caregiver, ben.caregiver · password: ${DEMO_PASSWORD}</p>`));
  }

  if (path === '/login' && req.method === 'POST') {
    ctx.kind = 'sign-in';
    const form = await readForm(req);
    const u = db.users.find((x) => x.username === form.username);
    if (!u || form.password !== DEMO_PASSWORD) {
      audit(null, 'SIGN_IN', form.username || '(blank)', 'DENIED');
      return redirect(res, '/login?error=1');
    }
    const sid = randomUUID();
    sessions.set(sid, u.username);
    audit(u, 'SIGN_IN', u.username, 'ALLOWED');
    return redirect(res, '/shifts', { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
  }

  if (path === '/logout' && req.method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) sessions.delete(sid);
    return redirect(res, '/login', { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }

  // everything below requires a session
  if (!user) return redirect(res, '/login');

  // --- shifts list (AC-1, AC-4) ---
  if (path === '/shifts' && req.method === 'GET') {
    ctx.kind = 'list';
    ctx.relation = user.role;
    const isScheduler = user.role === 'scheduler';
    const visible = isScheduler ? db.shifts : db.shifts.filter((s) => s.caregiver === user.username);
    const sid = parseCookies(req).sid;
    const confirmed = flashes.get(sid) || null;
    flashes.delete(sid);
    const rows = visible.map((s) => {
      const client = db.clients.find((c) => c.id === s.clientId);
      // CHAOS=broken: the page shows the just-confirmed shift as Confirmed (an
      // optimistic display) even though nothing was saved. Only a reload shows the truth.
      const shownStatus = CHAOS.has('broken') && confirmed === s.id ? 'Confirmed' : s.status;
      const canConfirm = !isScheduler && shownStatus === 'Assigned';
      return `<tr data-testid="shift-row-${esc(s.id)}">
        <td>${esc(s.id)}</td>
        <td>${esc(s.date)}</td>
        <td>${esc(s.start)}–${esc(s.end)}</td>
        <td><a href="/clients/${esc(s.clientId)}">${esc(client?.name)}</a></td>
        ${isScheduler ? `<td>${esc(s.caregiver)}</td>` : ''}
        <td class="status" data-testid="shift-status">${esc(shownStatus)}</td>
        <td>${canConfirm ? `<form method="post" action="/shifts/${esc(s.id)}/confirm" class="inline"><button type="submit">Confirm shift</button></form>` : ''}</td>
      </tr>`;
    }).join('');
    return send(res, 200, page('Shifts', user, `
      <h1>${isScheduler ? 'All shifts' : 'My shifts'}</h1>
      ${confirmed ? `<div class="banner ok" role="status" data-testid="success-message">Shift ${esc(confirmed)} confirmed.</div>` : ''}
      <table aria-label="Shifts">
        <thead><tr><th>Shift</th><th>Date</th><th>Time</th><th>Client</th>${isScheduler ? '<th>Caregiver</th>' : ''}<th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">No shifts.</td></tr>'}</tbody>
      </table>`));
  }

  // --- confirm a shift (AC-2, AC-3, AC-4, AC-5, AC-7) ---
  const confirmMatch = path.match(/^\/shifts\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === 'POST') {
    ctx.kind = 'confirm';
    const shift = db.shifts.find((s) => s.id === confirmMatch[1]);
    if (!shift) return notFound(res, user, 'Shift not found.');
    ctx.target = shift.id;
    ctx.relation = user.role === 'scheduler' ? 'scheduler' : shift.caregiver === user.username ? 'owner' : 'other-caregiver';

    if (user.role !== 'caregiver' || shift.caregiver !== user.username) {
      audit(user, 'SHIFT_CONFIRM', shift.id, 'DENIED', 'not the assigned caregiver');
      return forbidden(res, user, 'You can only confirm shifts assigned to you.');
    }
    if (shift.status !== 'Assigned') {
      audit(user, 'SHIFT_CONFIRM', shift.id, 'DENIED', `status is ${shift.status}`);
      return send(res, 409, page('Cannot confirm', user, `<h1>Cannot confirm</h1><div class="banner err" role="alert" data-testid="error-message">This shift can't be confirmed because its status is ${esc(shift.status)}.</div><p><a href="/shifts">Back to shifts</a></p>`));
    }

    if (CHAOS.has('slow')) await sleep(DELAY_MS);
    if (ctx.epoch !== epoch) return send(res, 409, 'The app was reset while this request was in flight.');

    if (!CHAOS.has('broken')) {
      shift.status = 'Confirmed';
      shift.confirmedAt = new Date().toISOString();
      audit(user, 'SHIFT_CONFIRM', shift.id, 'ALLOWED');
    }
    // With CHAOS=broken we still show success once: the silent failure a message-only test misses.
    flashes.set(parseCookies(req).sid, shift.id);
    return redirect(res, '/shifts');
  }

  // --- client details (AC-6, AC-7) ---
  const clientMatch = path.match(/^\/clients\/([^/]+)$/);
  if (clientMatch && req.method === 'GET') {
    ctx.kind = 'client';
    const client = db.clients.find((c) => c.id === clientMatch[1]);
    if (!client) return notFound(res, user, 'Client not found.');
    ctx.target = client.id;
    const serves = db.shifts.some((s) => s.clientId === client.id && s.caregiver === user.username);
    ctx.relation = user.role === 'scheduler' ? 'scheduler' : serves ? 'assigned' : 'other-caregiver';
    const allowed = user.role === 'scheduler' || serves;
    if (!allowed) {
      audit(user, 'CLIENT_VIEW', client.id, 'DENIED', 'no shift with this client');
      return forbidden(res, user, "You don't have access to this client.");
    }
    audit(user, 'CLIENT_VIEW', client.id, 'ALLOWED');
    return send(res, 200, page(client.name, user, `
      <h1 data-testid="client-name">${esc(client.name)}</h1>
      <div class="card" data-testid="client-card">
        <p><strong>Client ID:</strong> ${esc(client.id)}</p>
        <p><strong>Address:</strong> ${esc(client.address)}</p>
        <p><strong>Phone:</strong> ${esc(client.phone)}</p>
        <p><strong>Care notes:</strong> ${esc(client.careNotes)}</p>
      </div>
      <p><a href="/shifts">Back to shifts</a></p>`));
  }

  // --- audit log (AC-7): read-only, schedulers only ---
  if (path === '/audit' && req.method === 'GET') {
    ctx.kind = 'audit';
    ctx.relation = user.role;
    if (user.role !== 'scheduler') {
      audit(user, 'AUDIT_VIEW', 'audit-log', 'DENIED');
      return forbidden(res, user, 'Only schedulers can view the audit log.');
    }
    const rows = [...db.audit].reverse().map((a) => `<tr data-testid="audit-row">
      <td>${esc(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.role)}</td><td>${esc(a.action)}</td>
      <td>${esc(a.target)}</td><td data-testid="audit-outcome">${esc(a.outcome)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('');
    return send(res, 200, page('Audit log', user, `
      <h1>Audit log</h1>
      <p class="muted">Read-only. Entries record IDs, never client details.</p>
      <table aria-label="Audit log">
        <thead><tr><th>Time (UTC)</th><th>Actor</th><th>Role</th><th>Action</th><th>Target</th><th>Outcome</th><th>Detail</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">No entries.</td></tr>'}</tbody>
      </table>`));
  }

  return notFound(res, user);
}

http.createServer((req, res) => {
  const ctx = { epoch, method: req.method, path: req.url.split('?')[0], audits: [] };
  res.on('finish', () => {
    if (ctx.path.startsWith('/__test/') || ctx.epoch !== epoch) return;
    requestLog.push({
      method: ctx.method, path: ctx.path, status: res.statusCode, location: res.getHeader('Location') ?? null,
      actor: ctx.actor ?? 'anonymous', role: ctx.role ?? 'none',
      kind: ctx.kind ?? 'other', relation: ctx.relation ?? null, target: ctx.target ?? null, audits: ctx.audits,
    });
  });
  requestContext.run(ctx, () => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'Internal error');
    });
  });
}).listen(PORT, () => {
  console.log(`CareShift demo running at http://localhost:${PORT}${CHAOS.size ? `  (chaos: ${[...CHAOS].join(', ')})` : ''}`);
});
