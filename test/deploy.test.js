'use strict';
// Split deployment: static page on one origin (Vercel), API + WebSocket server on another (Render).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

process.env.WP_BLOCKED_FILE = path.join(os.tmpdir(), 'wp-blocked-deploy-' + process.pid + '.json');
const { createApp } = require('../server/index');

const saved = { A: process.env.ALLOWED_ORIGIN, B: process.env.AUTO_BLOCK, C: process.env.ADMIN_TOKEN };
test.afterEach(() => {
  for (const [k, v] of [['ALLOWED_ORIGIN', saved.A], ['AUTO_BLOCK', saved.B], ['ADMIN_TOKEN', saved.C]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function withServer(fn) {
  const app = createApp();
  const base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1'));
  try { await fn(base); } finally { await app.close(); }
}
const open = (url, origin) => new Promise((resolve) => {
  const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', () => resolve('rejected'));
  ws.on('error', () => resolve('rejected'));
});

test('API answers CORS for any origin by default, including preflight', async () => {
  delete process.env.ALLOWED_ORIGIN;
  await withServer(async (base) => {
    const r = await fetch(base + '/api/categories', { headers: { Origin: 'https://site.vercel.app' } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    const pre = await fetch(base + '/api/blocked', { method: 'OPTIONS', headers: { Origin: 'https://site.vercel.app', 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
    const h = await fetch(base + '/healthz', { headers: { Origin: 'https://site.vercel.app' } });
    assert.strictEqual(h.headers.get('access-control-allow-origin'), '*', 'health check (used to wake a sleeping server) is cross-origin too');
  });
});

test('ALLOWED_ORIGIN restricts both the API and the WebSocket handshake to the listed sites', async () => {
  process.env.ALLOWED_ORIGIN = 'https://good.vercel.app, https://other.example/';
  await withServer(async (base) => {
    const good = await fetch(base + '/api/categories', { headers: { Origin: 'https://good.vercel.app' } });
    assert.strictEqual(good.headers.get('access-control-allow-origin'), 'https://good.vercel.app');
    assert.match(good.headers.get('vary') || '', /Origin/);
    const trailing = await fetch(base + '/api/categories', { headers: { Origin: 'https://other.example' } });
    assert.strictEqual(trailing.headers.get('access-control-allow-origin'), 'https://other.example', 'trailing slash in the setting is tolerated');
    const bad = await fetch(base + '/api/categories', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(bad.headers.get('access-control-allow-origin'), null, 'other sites get no CORS permission');
    const wsBase = base.replace('http', 'ws') + '/ws';
    assert.strictEqual(await open(wsBase, 'https://good.vercel.app'), 'open');
    assert.strictEqual(await open(wsBase, 'https://evil.example'), 'rejected');
    assert.strictEqual(await open(wsBase), 'open', 'non-browser clients (no Origin header) are not affected');
  });
});

test('public mode (AUTO_BLOCK=0): nobody can globally hide catalog videos', async () => {
  process.env.AUTO_BLOCK = '0';
  await withServer(async (base) => {
    const r = await fetch(base + '/api/blocked', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: 'aqz-KE-bpKQ', code: 150 }] }) });
    assert.strictEqual(r.status, 403);
    const catalog = require('../server/catalog');
    assert.strictEqual(catalog.block('aqz-KE-bpKQ', 150), false);
    assert.strictEqual(catalog.blocked.has('aqz-KE-bpKQ'), false);
  });
});

test('ADMIN_TOKEN gates /api/blocked when set', async () => {
  process.env.ADMIN_TOKEN = 's3cret';
  delete process.env.AUTO_BLOCK;
  await withServer(async (base) => {
    const body = JSON.stringify({ items: [{ id: 'not-in-catalog', code: 1 }] });
    const no = await fetch(base + '/api/blocked', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.strictEqual(no.status, 403);
    const yes = await fetch(base + '/api/blocked', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 's3cret' }, body });
    assert.strictEqual(yes.status, 200);
  });
});

test('Vercel build step writes the backend URL into public/config.js and rejects bad values', () => {
  const cfg = path.join(__dirname, '..', 'public', 'config.js');
  const original = fs.readFileSync(cfg, 'utf8');
  const run = (url) => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-vercel.js')], { env: { ...process.env, BACKEND_URL: url }, stdio: 'pipe' });
  try {
    run('https://watch-party-server.onrender.com/');
    assert.match(fs.readFileSync(cfg, 'utf8'), /"backend":"https:\/\/watch-party-server\.onrender\.com"/, 'trailing slash removed');
    assert.throws(() => run('ws://not-https.example'), /BACKEND_URL must be/);
    assert.throws(() => run('javascript:alert(1)'), /BACKEND_URL must be/);
    run('');
    assert.match(fs.readFileSync(cfg, 'utf8'), /"backend":""/);
  } finally { fs.writeFileSync(cfg, original); }
});
