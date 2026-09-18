import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ROOT } from './db.js';
import { loadConfig, redactedConfig, CONFIG_PATH } from './config.js';
import * as T from './tasks.js';
import { syncAll, status as integrationStatus, providers } from './integrations/index.js';

const PUBLIC = join(ROOT, 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || loadConfig().port || 4444);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
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

  ['POST', /^\/api\/integrations\/outlook\/login$/, () =>
    providers.outlook.startLogin(loadConfig().outlook)],
  ['POST', /^\/api\/integrations\/outlook\/poll$/, () => providers.outlook.pollLogin()],
  ['POST', /^\/api\/integrations\/outlook\/signout$/, () => providers.outlook.signOut()],

  ['GET', /^\/api\/export$/, () => ({ exported_at: new Date().toISOString(), tasks: T.snapshot() })],
];

async function handleApi(req, res, pathname) {
  // Several routes share a path shape, so keep looking after a method mismatch —
  // giving up on the first one would hide DELETE behind PATCH.
  const allowed = [];
  for (const [method, pattern, handler] of routes) {
    const m = pathname.match(pattern);
    if (!m) continue;
    if (req.method !== method) { allowed.push(method); continue; }
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    return send(res, 200, await handler(m, body));
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
  if (!localOnly(req)) return send(res, 403, { error: 'rodeo only serves local requests' });
  const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);
  try {
    // Entra sends the browser here, so this one answers with a page, not JSON.
    if (pathname === providers.outlook.CALLBACK_PATH) {
      const html = await providers.outlook.handleCallback(loadConfig().outlook, searchParams);
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return await serveStatic(res, pathname);
  } catch (err) {
    const code = err.status ?? 500;
    if (code >= 500) console.error('[rodeo]', err);
    send(res, code, { error: err.message || 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🐂 rodeo is running — http://${HOST}:${PORT}\n`);
});
