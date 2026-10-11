'use strict';
// Load / latency benchmark. Usage:
//   node scripts/loadtest.js                      # starts an in-process server on loopback
//   node scripts/loadtest.js --url http://192.168.1.20:3000 --users 10,25,50 --actions 300
// Latency = (receiver's local receive time) - (sender's local send time). Over loopback / a single host all
// processes share one clock, so the numbers are exact; across machines you need NTP-synced hosts.
const { createApp } = require('../server/index');
const { TestClient, createRoom, hr } = require('./wsclient');
const { simulate } = require('./driftsim');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const USERS = arg('users', '10,25,50').split(',').map(Number);
const ACTIONS = Number(arg('actions', 300));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');

async function makeRoom(base, n) {
  const code = await createRoom(base);
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(new TestClient(base, code, 'u' + i, 'lt' + Math.random().toString(36).slice(2, 10) + i));
  await Promise.all(cs.map((c) => c.connect()));
  cs[0].send({ t: 'setVideo', catalogId: 'bbb' });
  await Promise.all(cs.map((c) => c.waitFor((m) => m.t === 'state' && m.why === 'video')));
  return { code, cs };
}

async function fanout(base, n) {
  const { cs } = await makeRoom(base, n);
  const sent = new Map();
  const lat = [];
  for (const c of cs) c.onState = (m) => { if (m.aid && sent.has(m.aid) && c !== cs[0]) lat.push(m._at - sent.get(m.aid)); };
  await sleep(1700); // past scheduled start
  const kinds = ['seek', 'pause', 'play', 'seek'];
  for (let i = 0; i < ACTIONS; i++) {
    const sender = cs[i % n]; // different users act, as in a real room
    const aid = 'f' + i;
    const a = kinds[i % 4];
    sent.set(aid, 0);
    const t = sender.send({ t: 'control', action: a, position: (i * 7) % 500, aid });
    sent.set(aid, t);
    await sleep(15);
  }
  await sleep(300);
  cs.forEach((c) => c.close());
  const expected = ACTIONS * (n - 1);
  return { n, samples: lat.length, expected, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: Math.max(...lat) };
}

async function burst(base, n, rounds = 30) {
  const { cs } = await makeRoom(base, n);
  await sleep(1700);
  let agree = 0, settle = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = hr();
    cs.forEach((c, i) => c.send({ t: 'control', action: ['play', 'pause', 'seek'][(i + r) % 3], position: i * 3 + r, aid: `b${r}_${i}` }));
    await sleep(120);
    const pbs = cs.map((c) => c.state.pb);
    if (pbs.every((p) => p.seq === pbs[0].seq && p.pos === pbs[0].pos && p.playing === pbs[0].playing)) agree++;
    // time until the last client saw the final seq
    settle.push(Math.max(...cs.map((c) => c.events[c.events.length - 1]._at)) - t0);
  }
  cs.forEach((c) => c.close());
  return { n, rounds, agree, settleP50: pct(settle, 0.5), settleMax: Math.max(...settle) };
}

async function lateJoinAndReconnect(base, n) {
  const { code, cs } = await makeRoom(base, n);
  await sleep(1700);
  cs[0].send({ t: 'control', action: 'seek', position: 123, aid: 'lj' });
  await cs[1].waitFor((m) => m.aid === 'lj');
  await sleep(500);
  // late joiners: time from socket open to full snapshot
  const joinMs = [];
  for (let i = 0; i < 5; i++) {
    const c = new TestClient(base, code, 'late' + i);
    const t0 = hr();
    await c.connect();
    joinMs.push(hr() - t0);
    c.close();
  }
  await sleep(100);
  // reconnect storm: kill 40% of sockets at once, reconnect with the same ids
  const victims = cs.slice(1, 1 + Math.ceil(n * 0.4));
  victims.forEach((c) => c.kill());
  await sleep(50);
  const t1 = hr();
  const back = await Promise.all(victims.map((c) => new TestClient(base, code, c.name, c.clientId).connect()));
  const reconnectMs = hr() - t1;
  await sleep(150);
  const roster = back[0].members;
  const connected = roster.filter((m) => m.connected).length;
  const dupes = victims.some((v) => roster.filter((m) => m.id === v.clientId).length !== 1) || connected !== n;
  const resynced = back.every((b) => b.welcome.video && b.welcome.pb.playing !== undefined);
  [...cs, ...back].forEach((c) => c.close());
  return { n, lateJoinP50: pct(joinMs, 0.5), lateJoinMax: Math.max(...joinMs), reconnected: victims.length, reconnectMs, rosterSize: connected, duplicates: dupes, resynced };
}

(async () => {
  let app, base = arg('url');
  if (!base) { app = createApp({ room: { startLeadMs: 100 } }); base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1')); }
  console.log(`Target: ${base}   node ${process.version}   ${process.platform}   actions/run=${ACTIONS}\n`);

  console.log('## Control propagation latency (host action -> every other participant), ms');
  console.log('| users | samples | p50 | p95 | p99 | max |\n|---|---|---|---|---|---|');
  for (const n of USERS) {
    const r = await fanout(base, n);
    console.log(`| ${n} | ${r.samples}/${r.expected} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.max)} |`);
  }
  console.log('\n## Concurrent conflicting actions (every user acts at the same instant, 30 rounds)');
  console.log('| users | rounds converged | settle p50 (ms) | settle max (ms) |\n|---|---|---|---|');
  for (const n of USERS) { const r = await burst(base, n); console.log(`| ${n} | ${r.agree}/${r.rounds} | ${f(r.settleP50)} | ${f(r.settleMax)} |`); }
  console.log('\n## Late join + reconnect storm');
  console.log('| users | late-join p50 (ms) | late-join max (ms) | reconnected | reconnect all (ms) | connected after | duplicates | state resynced |\n|---|---|---|---|---|---|---|---|');
  for (const n of USERS) { const r = await lateJoinAndReconnect(base, n); console.log(`| ${n} | ${f(r.lateJoinP50)} | ${f(r.lateJoinMax)} | ${r.reconnected} | ${f(r.reconnectMs)} | ${r.rosterSize} | ${r.duplicates} | ${r.resynced} |`); }

  console.log('\n## Drift after correction (closed-loop simulation of the client sync algorithm, 12 players, 120 s, 5 seeds)');
  console.log('Injected per player: +-10 s clock skew, +-0.5% playback-rate error, 2.5 s buffering stall at t=60 s.\n| seed | p95 drift (ms) | worst steady-state drift (ms) | worst overall incl. stall recovery (ms) |\n|---|---|---|---|');
  for (const seed of [1, 2, 3, 4, 5]) { const r = simulate({ seed }); console.log(`| ${seed} | ${f(r.p95 * 1000)} | ${f(r.worstAfterSettle * 1000)} | ${f(r.worst * 1000)} |`); }
  if (app) await app.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
