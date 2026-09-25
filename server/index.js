import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ROOT } from './db.js';
import { loadConfig, redactedConfig, CONFIG_PATH } from './config.js';
import * as T from './tasks.js';
import { syncAll, status as integrationStatus, providers, mailAccounts, trackedExternalIds } from './integrations/index.js';

const PUBLIC = join(ROOT, 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || loadConfig().port || 4444);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const send = (res, code, body, headers = {}) => {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new T.HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new T.HttpError(400, 'request body must be valid JSON');
  }
}

/** This server binds to loopback; also refuse non-local Host/Origin (DNS rebinding). */
function localOnly(req) {
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return false;
  return true;
}

/* ---------- routes ---------- */

const routes = [
  ['GET', /^\/api\/state$/, () => ({
    tasks: T.snapshot(),
    tags: T.tagSummary(),
    integrations: integrationStatus(),
    config: redactedConfig(),
    config_path: CONFIG_PATH,
    server_date: new Date().toLocaleDateString('en-CA'),
    meta: { statuses: T.STATUSES, priorities: T.PRIORITIES, sources: T.SOURCES },
  })],

  ['GET', /^\/api\/tasks\/(\d+)\/description$/, (m) => T.description(Number(m[1]))],
  ['GET', /^\/api\/search$/, (m, body, query) => ({ ids: T.idsMatchingDescription(query.get('q')) })],

  ['GET', /^\/api\/tags$/, () => T.tagSummary()],
  ['PUT', /^\/api\/tags\/([A-Za-z][A-Za-z0-9_-]*)$/, (m, body) => T.setTagColor(m[1], body.color)],

  ['POST', /^\/api\/tasks$/, (m, body) => T.createTask(body)],
  ['PATCH', /^\/api\/tasks\/(\d+)$/, (m, body) => T.updateTask(Number(m[1]), body)],
  ['DELETE', /^\/api\/tasks\/(\d+)$/, (m) => T.deleteTask(Number(m[1]))],
  ['POST', /^\/api\/tasks\/(\d+)\/move$/, (m, body) => T.reorder(Number(m[1]), body)],

  ['POST', /^\/api\/tasks\/(\d+)\/notes$/, (m, body) => T.addNote(Number(m[1]), body.body)],
  ['DELETE', /^\/api\/notes\/(\d+)$/, (m) => T.deleteNote(Number(m[1]))],

  ['POST', /^\/api\/tasks\/(\d+)\/deps$/, (m, body) => T.addDep(Number(m[1]), body.depends_on_id)],
  ['DELETE', /^\/api\/tasks\/(\d+)\/deps\/(\d+)$/, (m) => T.removeDep(Number(m[1]), Number(m[2]))],

  ['GET', /^\/api\/integrations$/, () => integrationStatus()],
  ['POST', /^\/api\/sync$/, (m, body) => syncAll({ only: body.only })],

  ['POST', /^\/api\/integrations\/(outlook2?)\/login$/, (m) =>
    mailAccount(m[1]).startLogin(loadConfig()[m[1]])],
  ['POST', /^\/api\/integrations\/(outlook2?)\/poll$/, (m) => mailAccount(m[1]).pollLogin()],
  ['POST', /^\/api\/integrations\/(outlook2?)\/signout$/, (m) => mailAccount(m[1]).signOut()],

  ['GET', /^\/api\/recap\/meetings$/, (m, body, query) => meetingsForDay(query.get('day'))],
  ['GET', /^\/api\/unread$/, () => unreadMail()],
  ['POST', /^\/api\/unread\/task$/, (m, body) => mailToTask(body)],

  ['GET', /^\/api\/export$/, () => ({ exported_at: new Date().toISOString(), tasks: T.snapshot() })],
];

function mailAccount(id) {
  const account = mailAccounts.find((a) => a.id === id);
  if (!account) throw new T.HttpError(404, `no such mail account: ${id}`);
  return account;
}

/**
 * Unread mail for the strip above the task list, read live on every request.
 *
 * Same shape as the recap's meetings, and for the same reason: `available: false`
 * means rodeo couldn't ask, which is a different answer from an empty inbox.
 *
 * `configured` is what the strip needs on top of that. Nobody with one mailbox
 * wants a permanent bar explaining that they haven't set up a second one, so a
 * turned-off account is silent — but an account that is set up and broken has to
 * say so, or the strip would just sit there looking empty.
 */
async function unreadMail() {
  const account = providers.outlook2;
  const cfg = loadConfig().outlook2;
  const off = (detail, configured = true) => ({ available: false, configured, detail });

  if (!account.configured(cfg)) return off(account.describe(cfg), false);
  if (cfg.unread === false) return off('unread is switched off in config.json', false);
  if (!account.hasToken()) return off('not signed in — \u2699 \u2192 Connect');
  try {
    const tracked = trackedExternalIds(account.sourceType);
    return {
      available: true,
      configured: true,
      account: cfg.label || account.label,
      messages: await account.fetchUnread(cfg, { tracked }),
    };
  } catch (err) {
    return off(err.message);
  }
}

/**
 * Turn one unread message into a task, because someone dragged it onto the list.
 *
 * Mail from this account is never imported on a sync — dragging is the whole act
 * of deciding it is work, and a list that fills itself is one you stop reading.
 * The wording is built here rather than in the browser so the account's taskLabel
 * stays the one source of truth for what its mail is called.
 */
async function mailToTask(msg) {
  const account = providers.outlook2;
  const cfg = loadConfig().outlook2;
  if (!account.configured(cfg)) throw new T.HttpError(400, account.describe(cfg));
  if (!msg?.id) throw new T.HttpError(400, 'message id is required');

  const externalId = `mail:${msg.id}`;
  // The unique index would catch this anyway, but as a 500 reading like a crash.
  if (trackedExternalIds(account.sourceType).has(externalId)) {
    throw new T.HttpError(409, 'that email is already on the list');
  }

  let from = String(msg.from || 'unknown sender').trim() || 'unknown sender';
  let title = String(msg.subject || '(no subject)');
  // The card only ever had Graph's bodyPreview, which stops after a couple of
  // hundred characters. Now that this is becoming work, go and get the thread.
  let body = String(msg.preview || '').trim();
  try {
    const full = await account.fetchMessage(cfg, msg.id);
    if (full.body) body = full.body;
    if (full.subject) title = full.subject;
    if (full.from) from = full.from;
  } catch (err) {
    // Losing the long body is a shame; losing the drop would be worse.
    console.error("[dont-get-fired] couldn't read the full message body:", err.message);
  }

  return T.createTask({
    title,
    description: `From ${from}\n\n${body}`.slice(0, T.MAX_DESCRIPTION),
    source_type: account.sourceType,
    source_ref: cfg.taskLabel ? `${cfg.taskLabel} · ${from}` : `Email from ${from}`,
    source_url: msg.url || null,
    external_id: externalId,
  });
}

/**
 * The recap reads the calendar live rather than through sync: meetings are
 * reference material, not work rodeo tracks, and a stale answer about today is
 * worse than a slow one. `available: false` means rodeo cannot say — the recap
 * keeps that apart from a day that genuinely had no meetings.
 */
async function meetingsForDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new T.HttpError(400, 'day must be YYYY-MM-DD');
  const { outlook } = providers;
  const cfg = loadConfig().outlook;
  if (!outlook.configured(cfg)) return { available: false, detail: outlook.describe(cfg) };
  if (!outlook.hasToken()) return { available: false, detail: 'not signed in — ⚙ → Connect' };
  try {
    return { available: true, meetings: await outlook.fetchMeetings(cfg, day) };
  } catch (err) {
    return { available: false, detail: err.message };
  }
}

async function handleApi(req, res, pathname, query) {
  // Several routes share a path shape, so keep looking after a method mismatch —
  // giving up on the first one would hide DELETE behind PATCH.
  const allowed = [];
  for (const [method, pattern, handler] of routes) {
    const m = pathname.match(pattern);
    if (!m) continue;
    if (req.method !== method) { allowed.push(method); continue; }
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    return send(res, 200, await handler(m, body, query));
  }
  if (allowed.length) return send(res, 405, { error: `use ${allowed.join(' or ')} for this endpoint` });
  return send(res, 404, { error: `no route for ${req.method} ${pathname}` });
}

async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    send(res, 200, data, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

const server = createServer(async (req, res) => {
  if (!localOnly(req)) return send(res, 403, { error: "Don't Get Fired only serves local requests" });
  const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);
  try {
    // Entra sends the browser here, so this one answers with a page, not JSON.
    // Each account has its own callback path, and only it can finish its sign-in.
    const account = mailAccounts.find((a) => a.CALLBACK_PATH === pathname);
    if (account) {
      const html = await account.handleCallback(loadConfig()[account.id], searchParams);
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, searchParams);
    return await serveStatic(res, pathname);
  } catch (err) {
    const code = err.status ?? 500;
    if (code >= 500) console.error('[dont-get-fired]', err);
    send(res, code, { error: err.message || 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🔥 Don't Get Fired is running — http://${HOST}:${PORT}\n`);
});
