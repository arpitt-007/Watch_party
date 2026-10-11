'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./room');
const catalog = require('./catalog');
const search = require('./search');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const num = (v) => (v === null || v === undefined || v === '' ? undefined : Number(v));

function createApp(options = {}) {
  const manager = new RoomManager(options.room);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const q = url.searchParams;
    if (req.method === 'POST' && p === '/api/rooms') {
      const r = manager.create();
      return json(res, 200, { code: r.code });
    }
    let m;
    if ((m = p.match(/^\/api\/rooms\/([A-Za-z0-9-]+)$/))) {
      const r = manager.get(m[1]);
      return r ? json(res, 200, { code: r.code, members: r.connectedCount() }) : json(res, 404, { error: 'Room not found' });
    }
    if (p === '/api/movies') {
      return json(res, 200, { genres: catalog.genres, items: search.searchMovies({
        q: q.get('q') || '', genres: q.getAll('genre'), allGenres: q.get('all') === '1', sort: q.get('sort') || undefined,
        viewsMin: num(q.get('viewsMin')), yearMin: num(q.get('yearMin')), yearMax: num(q.get('yearMax')),
        durationMin: num(q.get('durMin')), durationMax: num(q.get('durMax')) }) });
    }
    if (p === '/api/categories') return json(res, 200, { genres: catalog.genres, rows: search.categories() });
    if (p === '/api/recommendations') {
      const r = manager.get(q.get('room'));
      return json(res, 200, { items: r ? r.recommendations() : search.recommend({}) });
    }
    if (p === '/api/youtube/search') {
      const key = process.env.YOUTUBE_API_KEY;
      if (!key) return json(res, 200, { enabled: false, items: [] });
      const term = (q.get('q') || '').slice(0, 100);
      if (!term) return json(res, 200, { enabled: true, items: [] });
      const api = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=12&q=' + encodeURIComponent(term) + '&key=' + encodeURIComponent(key);
      fetch(api, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).then((d) => {
        if (d.error) return json(res, 502, { enabled: true, items: [], error: d.error.message });
        json(res, 200, { enabled: true, items: (d.items || []).map((x) => ({ ytId: x.id.videoId, title: x.snippet.title, channel: x.snippet.channelTitle })) });
      }).catch(() => json(res, 502, { enabled: true, items: [], error: 'YouTube search failed' }));
      return;
    }
    if (p === '/api/metrics') return json(res, 200, manager.metrics());
    if (p === '/healthz') return json(res, 200, { ok: true });

    // static files (no path traversal)
    let rel = p === '/' ? '/index.html' : decodeURIComponent(p);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024, perMessageDeflate: false });

  wss.on('connection', (ws) => {
    manager.counters.connections++;
    ws.alive = true;
    ws.bucket = { tokens: 60, at: Date.now() };
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data) => {
      ws.alive = true;
      const b = ws.bucket, now = Date.now();
      b.tokens = Math.min(60, b.tokens + ((now - b.at) / 1000) * 30);
      b.at = now;
      if (b.tokens < 1) { manager.counters.dropped++; return; }
      b.tokens--;
      manager.counters.messages++;
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try {
        if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
        if (msg.t === 'join') return onJoin(ws, msg);
        if (!ws.member) return;
        ws.room.handle(ws.member, msg);
      } catch (e) {
        console.error('handler error', e);
      }
    });
    ws.on('close', () => { if (ws.room) ws.room.disconnect(ws); });
    ws.on('error', () => {});
  });

  function onJoin(ws, msg) {
    if (ws.member) return;
    const room = manager.get(msg.room);
    const clientId = String(msg.clientId || '');
    if (!room) { ws.send(JSON.stringify({ t: 'error', code: 'no-room', msg: 'Room not found' })); return ws.close(4001, 'no room'); }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) { ws.send(JSON.stringify({ t: 'error', code: 'bad-id', msg: 'Bad client id' })); return ws.close(4004, 'bad id'); }
    const name = String(msg.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 24) || 'Guest-' + clientId.slice(0, 4);
    room.join(ws, { clientId, name });
  }

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    }
  }, 10000);
  if (hb.unref) hb.unref();

  return {
    server, wss, manager,
    listen(port = 3000, host = '0.0.0.0') { return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))); },
    close() { clearInterval(hb); manager.close(); for (const c of wss.clients) c.terminate(); return new Promise((r) => { wss.close(() => server.close(() => r())); }); },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port).then((p) => console.log(`Watch Party running at http://localhost:${p}`));
}

module.exports = { createApp };
