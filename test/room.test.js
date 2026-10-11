'use strict';
process.env.WP_BLOCKED_FILE = require('path').join(require('os').tmpdir(), 'wp-blocked-' + process.pid + '.json');
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/index');
const { TestClient, createRoom } = require('../scripts/wsclient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, base;
test.before(async () => {
  // YouTube oEmbed is stubbed so tests need no network: ids starting with 'NoEmbed' behave like embedding-disabled videos.
  const youtubeInfo = async (id) => (id.startsWith('NoEmbed') ? { embeddable: false, status: 401 } : { embeddable: true, title: '' });
  app = createApp({ room: { memberGraceMs: 600, hostGraceMs: 250, startLeadMs: 100, youtubeInfo } });
  base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1'));
});
test.after(() => app.close());

async function party(n, names = ['host', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
  const code = await createRoom(base);
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(await new TestClient(base, code, names[i % names.length] + i).connect());
  return { code, cs, host: cs[0] };
}
const lastPb = (c) => c.state.pb;

test('room codes: create, case-insensitive join, unknown room rejected', async () => {
  const code = await createRoom(base);
  assert.match(code, /^[A-Z2-9]{6}$/);
  const c = await new TestClient(base, code.toLowerCase(), 'x').connect();
  assert.strictEqual(c.welcome.code, code);
  await assert.rejects(new TestClient(base, 'ZZZZZZ', 'y').connect());
});

test('12 users join; first is host; everyone sees the full roster', async () => {
  const { cs, host } = await party(12);
  await sleep(50);
  assert.strictEqual(host.welcome.hostId, host.clientId);
  for (const c of cs) assert.strictEqual(c.members.length, 12);
  cs.forEach((c) => c.close());
});

test('play / pause / seek reach every participant with consistent seq and position', async () => {
  const { cs, host } = await party(10);
  host.send({ t: 'setVideo', catalogId: 'aqz-KE-bpKQ' });
  await Promise.all(cs.map((c) => c.waitFor((m) => m.t === 'state' && m.why === 'video')));
  await sleep(150); // past the scheduled start
  host.send({ t: 'control', action: 'seek', position: 100, aid: 's1' });
  await Promise.all(cs.map((c) => c.waitFor((m) => m.aid === 's1')));
  const pbs = cs.map(lastPb);
  assert.ok(pbs.every((p) => p.pos === 100 && p.seq === pbs[0].seq && p.playing));
  cs[3].send({ t: 'control', action: 'pause', aid: 'p1' });
  await Promise.all(cs.map((c) => c.waitFor((m) => m.aid === 'p1')));
  const paused = cs.map(lastPb);
  assert.ok(paused.every((p) => !p.playing && p.pos === paused[0].pos && p.pos >= 100 && p.pos < 101));
  cs.forEach((c) => c.close());
});

test('concurrent conflicting actions converge to one state everywhere', async () => {
  const { cs } = await party(10);
  cs[0].send({ t: 'setVideo', catalogId: 'eRsGyueVLvQ' });
  await Promise.all(cs.map((c) => c.waitFor((m) => m.why === 'video')));
  await sleep(150);
  const before = lastPb(cs[0]).seq;
  cs.forEach((c, i) => c.send({ t: 'control', action: i % 3 === 0 ? 'pause' : i % 3 === 1 ? 'play' : 'seek', position: i * 10, aid: 'x' + i }));
  await sleep(300);
  const final = cs.map(lastPb);
  assert.ok(final.every((p) => p.seq === final[0].seq && p.pos === final[0].pos && p.playing === final[0].playing), 'all clients agree');
  assert.ok(final[0].seq > before);
  cs.forEach((c) => c.close());
});

test('duplicate action ids (client retry) are applied once', async () => {
  const { cs, host } = await party(2);
  host.send({ t: 'setVideo', catalogId: 'aqz-KE-bpKQ' });
  await cs[1].waitFor((m) => m.why === 'video');
  host.send({ t: 'control', action: 'seek', position: 30, aid: 'dup' });
  host.send({ t: 'control', action: 'seek', position: 30, aid: 'dup' });
  await sleep(150);
  assert.strictEqual(cs[1].events.filter((m) => m.aid === 'dup').length, 1);
  cs.forEach((c) => c.close());
});

test('late joiner gets a snapshot whose expected position matches the room', async () => {
  const { code, host } = await party(2);
  host.send({ t: 'setVideo', catalogId: 'aqz-KE-bpKQ' });
  await host.waitFor((m) => m.why === 'video');
  host.send({ t: 'control', action: 'seek', position: 200, aid: 'l1' });
  await host.waitFor((m) => m.aid === 'l1');
  await sleep(700);
  const late = await new TestClient(base, code, 'late').connect();
  const pb = late.welcome.pb;
  const expected = pb.pos + (late.welcome.serverNow - pb.at) / 1000;
  assert.ok(pb.playing && expected > 200.6 && expected < 201.6, `expected ${expected}`);
  assert.strictEqual(late.welcome.video.id, 'aqz-KE-bpKQ');
  late.close(); host.close();
});

test('reconnect with the same clientId keeps identity, host role and resyncs', async () => {
  const { code, cs, host } = await party(3);
  host.send({ t: 'setVideo', catalogId: 'aqz-KE-bpKQ' });
  await cs[1].waitFor((m) => m.why === 'video');
  host.kill();
  await sleep(100);
  const back = await new TestClient(base, code, 'host0', host.clientId).connect();
  await sleep(400); // longer than hostGrace: host must NOT have been replaced since it came back in time
  assert.strictEqual(back.welcome.hostId, host.clientId);
  assert.strictEqual(back.members.length, 3, 'no duplicate member');
  assert.ok(back.welcome.video && back.welcome.pb.playing, 'state restored');
  cs.forEach((c) => c.close()); back.close();
});

test('host disconnect transfers hosting after grace; unknown member is removed after timeout', async () => {
  const { cs, host } = await party(3);
  host.kill();
  await cs[1].waitFor((m) => m.t === 'presence' && m.hostId !== host.clientId, 2000);
  assert.strictEqual(cs[1].members.length >= 2, true);
  const newHost = cs[1].events.filter((m) => m.t === 'presence').pop().hostId;
  assert.ok([cs[1].clientId, cs[2].clientId].includes(newHost));
  await cs[1].waitFor((m) => m.t === 'presence' && m.members.length === 2, 2000); // member grace elapsed
  cs.forEach((c) => c.close());
});

test('host transfer, host-only mode and permissions', async () => {
  const { cs, host } = await party(3);
  host.send({ t: 'setVideo', catalogId: 'aqz-KE-bpKQ' });
  await cs[1].waitFor((m) => m.why === 'video');
  host.send({ t: 'settings', controlMode: 'host' });
  await cs[1].waitFor((m) => m.t === 'presence' && m.controlMode === 'host');
  cs[1].send({ t: 'control', action: 'pause', aid: 'nope' });
  const err = await cs[1].waitFor((m) => m.t === 'error');
  assert.strictEqual(err.code, 'forbidden');
  cs[1].send({ t: 'host.transfer', to: cs[2].clientId });
  await sleep(100);
  assert.strictEqual(cs[0].members.length, 3);
  assert.strictEqual(cs[0].events.filter((m) => m.t === 'presence').pop().hostId, host.clientId, 'non-host cannot transfer');
  host.send({ t: 'host.transfer', to: cs[2].clientId });
  await cs[1].waitFor((m) => m.t === 'presence' && m.hostId === cs[2].clientId);
  cs[2].send({ t: 'control', action: 'pause', aid: 'ok' });
  await host.waitFor((m) => m.aid === 'ok' && m.why === 'pause');
  cs.forEach((c) => c.close());
});

test('queue: add, vote ordering, auto-advance on ended', async () => {
  const { cs, host } = await party(3);
  host.send({ t: 'setVideo', catalogId: 'SkVqJ1SGeL0' });
  await host.waitFor((m) => m.why === 'video');
  host.send({ t: 'queue.add', catalogId: 'mN0zPOpADL4' });
  cs[1].send({ t: 'queue.add', catalogId: 'PVGeM40dABA' });
  await sleep(100);
  let pl = host.events.filter((m) => m.t === 'playlist').pop().items;
  cs[2].send({ t: 'queue.vote', id: pl.find((i) => i.video.id === 'PVGeM40dABA').id });
  await sleep(100);
  pl = host.events.filter((m) => m.t === 'playlist').pop().items;
  assert.strictEqual(pl[0].video.id, 'PVGeM40dABA', 'more votes sorts first');
  assert.strictEqual(pl[0].voters.length, 2);
  const token = host.state.video.token;
  host.send({ t: 'report', pos: 0, drift: 0, duration: 15, token });
  host.send({ t: 'ended', token }); // too early for a 15 s clip: ignored
  await sleep(150);
  assert.strictEqual(host.state.video.id, 'SkVqJ1SGeL0');
  await sleep(0);
  const ver = host.state.video;
  assert.ok(ver);
  cs.forEach((c) => c.close());
});

test('auto-advance picks the top queue item when the video really ended', async () => {
  const { cs, host } = await party(2);
  host.send({ t: 'setVideo', catalogId: 'PVGeM40dABA' }); // 5 s
  await host.waitFor((m) => m.why === 'video');
  cs[1].send({ t: 'queue.add', catalogId: 'mN0zPOpADL4' });
  const token = host.state.video.token;
  host.send({ t: 'report', pos: 0, drift: 0, duration: 0.2, token }); // a 0.2 s clip, so the end is plausible immediately
  await sleep(100);
  host.send({ t: 'ended', token });
  const st = await cs[1].waitFor((m) => m.why === 'auto', 2000);
  assert.strictEqual(st.video.id, 'mN0zPOpADL4');
  cs.forEach((c) => c.close());
});

test('polls: vote, change vote, close picks winner, "next" poll pins the winner in the queue', async () => {
  const { cs, host } = await party(4);
  host.send({ t: 'poll.create', kind: 'next', question: 'What next?', options: ['aqz-KE-bpKQ', 'eRsGyueVLvQ', 'R6MlUcmOul8'] });
  const created = await cs[1].waitFor((m) => m.t === 'polls');
  const poll = created.polls[0];
  const [a, b] = poll.options;
  cs[1].send({ t: 'poll.vote', id: poll.id, option: a.id });
  cs[2].send({ t: 'poll.vote', id: poll.id, option: b.id });
  cs[3].send({ t: 'poll.vote', id: poll.id, option: b.id });
  cs[1].send({ t: 'poll.vote', id: poll.id, option: b.id }); // changes vote
  await sleep(100);
  let p = host.events.filter((m) => m.t === 'polls').pop().polls[0];
  assert.deepStrictEqual(p.options.map((o) => o.voters.length), [0, 3, 0]);
  cs[2].send({ t: 'poll.close', id: poll.id }); // not creator/host
  await sleep(50);
  assert.strictEqual(host.events.filter((m) => m.t === 'polls').pop().polls[0].closed, false);
  host.send({ t: 'poll.close', id: poll.id });
  await host.waitFor((m) => m.t === 'polls' && m.polls[0].closed);
  const pl = (await host.waitFor((m) => m.t === 'playlist')).items;
  assert.strictEqual(pl[0].video.id, 'eRsGyueVLvQ');
  assert.ok(pl[0].pinned);
  cs.forEach((c) => c.close());
});

test('timed polls close themselves', async () => {
  const { cs, host } = await party(2);
  host.send({ t: 'poll.create', question: 'Pizza?', options: ['yes', 'no'], durationSec: 1 });
  await cs[1].waitFor((m) => m.t === 'polls' && m.polls[0].closed, 2500);
  cs.forEach((c) => c.close());
});

test('chat, reactions (with timeline bins) and flood protection', async () => {
  const { cs, host } = await party(3);
  host.send({ t: 'chat', text: '<img src=x onerror=alert(1)>' });
  const c = await cs[1].waitFor((m) => m.t === 'chat' && m.msg.from === host.clientId);
  assert.strictEqual(c.msg.text, '<img src=x onerror=alert(1)>', 'server stores text verbatim; client renders via textContent');
  host.send({ t: 'setVideo', catalogId: 'aqz-KE-bpKQ' });
  await host.waitFor((m) => m.why === 'video');
  cs[1].send({ t: 'react', emoji: '🔥' });
  cs[2].send({ t: 'react', emoji: '💩' }); // not whitelisted
  const r = await host.waitFor((m) => m.t === 'reaction');
  assert.strictEqual(r.emoji, '🔥');
  assert.strictEqual(r.count, 1);
  for (let i = 0; i < 20; i++) cs[2].send({ t: 'chat', text: 'spam' + i });
  await sleep(200);
  assert.ok(host.events.filter((m) => m.t === 'chat' && m.msg.from === cs[2].clientId).length <= 8);
  cs.forEach((x) => x.close());
});

test('same clientId in a second connection replaces the first (no ghost members)', async () => {
  const { code, cs } = await party(2);
  const dup = await new TestClient(base, code, 'b1', cs[1].clientId).connect();
  await sleep(100);
  assert.strictEqual(dup.members.length, 2);
  cs.forEach((c) => c.close()); dup.close();
});

test('YouTube: links are parsed (watch / youtu.be / shorts), catalog entries resolve, lookalike hosts are rejected', async () => {
  const { cs, host } = await party(2);
  host.send({ t: 'setVideo', url: 'https://youtu.be/Zx9pQ2mLw0A?si=x', title: 'Never' });
  const st = await cs[1].waitFor((m) => m.why === 'video');
  assert.strictEqual(st.video.source, 'youtube');
  assert.strictEqual(st.video.ytId, 'Zx9pQ2mLw0A');
  assert.strictEqual(st.video.title, 'Never');
  host.send({ t: 'setVideo', url: 'https://www.youtube.com/watch?v=WhWc3b3KhnY' }); // a catalog video pasted as a link resolves to its catalog entry
  const st2 = await cs[1].next((m) => m.why === 'video' && m.video.id === 'WhWc3b3KhnY');
  assert.strictEqual(st2.video.ytId, 'WhWc3b3KhnY');
  host.send({ t: 'queue.add', url: 'https://www.youtube.com/shorts/abcdefghijk', title: 'Short' });
  const pl = await cs[1].waitFor((m) => m.t === 'playlist' && m.items.length);
  assert.strictEqual(pl.items[0].video.ytId, 'abcdefghijk');
  host.send({ t: 'setVideo', url: 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ' }); // not YouTube: treated as a plain URL (loaded in <video>, not an iframe)
  const st3 = await cs[1].next((m) => m.why === 'video' && m.video.source === 'url');
  assert.strictEqual(st3.video.ytId, undefined);
  cs.forEach((c) => c.close());
});

test('a video the YouTube player refuses (embedding disabled) is skipped for the whole room', async () => {
  const { cs, host } = await party(3);
  host.send({ t: 'setVideo', url: 'https://youtu.be/Zx9pQ2mLw0A', title: 'Blocked' });
  const st = await cs[1].waitFor((m) => m.why === 'video' && m.video.ytId === 'Zx9pQ2mLw0A');
  host.send({ t: 'queue.add', catalogId: 'aqz-KE-bpKQ' });
  await cs[1].waitFor((m) => m.t === 'playlist' && m.items.length);
  cs[2].send({ t: 'unplayable', token: 'wrong-token', code: 150 }); // stale/bogus reports are ignored
  await sleep(100);
  assert.strictEqual(host.state.video.ytId, 'Zx9pQ2mLw0A');
  cs[2].send({ t: 'unplayable', token: st.video.token, code: 150 });
  const next = await cs[1].waitFor((m) => m.why === 'auto', 2000);
  assert.strictEqual(next.video.id, 'aqz-KE-bpKQ');
  cs.forEach((c) => c.close());
});

test('pasted YouTube links that do not allow embedding are rejected with a clear error', async () => {
  const { cs, host } = await party(2);
  host.send({ t: 'setVideo', url: 'https://www.youtube.com/watch?v=NoEmbedAAAA', title: 'Nope' });
  const err = await host.waitFor((m) => m.t === 'error' && m.code === 'no-embed');
  assert.match(err.msg, /embedding/);
  assert.strictEqual(host.state.video, null, 'room unchanged');
  host.send({ t: 'queue.add', url: 'https://youtu.be/NoEmbedBBBB' });
  await sleep(100);
  assert.strictEqual(host.events.filter((m) => m.t === 'playlist').length, 0);
  cs.forEach((c) => c.close());
});

test('a catalog video that a player rejects is blocked: hidden from search and recommendations', async () => {
  const catalog = require('../server/catalog');
  const { searchMovies } = require('../server/search');
  const target = 'SkVqJ1SGeL0'; // Caminandes 3
  assert.ok(searchMovies({ q: 'llamigos' }).length === 1);
  const { cs, host } = await party(2);
  host.send({ t: 'setVideo', catalogId: target });
  const st = await cs[1].waitFor((m) => m.why === 'video' && m.video.id === target);
  cs[1].send({ t: 'unplayable', token: st.video.token, code: 101 });
  await cs[0].waitFor((m) => m.t === 'chat' && /can't be played/.test(m.msg.text || ''));
  assert.ok(catalog.blocked.has(target));
  assert.strictEqual(searchMovies({ q: 'llamigos' }).length, 0);
  assert.ok(!searchMovies({}).some((m) => m.id === target));
  assert.ok(JSON.parse(require('fs').readFileSync(process.env.WP_BLOCKED_FILE, 'utf8'))[target], 'persisted to disk');
  cs.forEach((c) => c.close());
});

test('replay: play on an ended video restarts from 0, and the video can end (and advance the queue) again', async () => {
  const { cs, host } = await party(2);
  host.send({ t: 'setVideo', catalogId: 'PVGeM40dABA' });
  await host.waitFor((m) => m.why === 'video');
  const token = host.state.video.token;
  host.send({ t: 'report', pos: 0, drift: 0, duration: 0.2, token }); // 0.2 s video: the end is immediately plausible
  await sleep(100);
  host.send({ t: 'ended', token });
  const ended = await cs[1].waitFor((m) => m.why === 'ended');
  assert.strictEqual(ended.pb.playing, false);
  assert.strictEqual(ended.pb.pos, 0.2, 'parked exactly at the end');
  cs[1].send({ t: 'control', action: 'play', aid: 'replay1' }); // any participant may replay in an open room
  const again = await host.waitFor((m) => m.aid === 'replay1' && m.why === 'play');
  assert.strictEqual(again.pb.playing, true);
  assert.strictEqual(again.pb.pos, 0, 'restarted from the beginning');
  // the end-of-video handling is re-armed: with a queued video the second ending auto-advances
  host.send({ t: 'queue.add', catalogId: 'mN0zPOpADL4' });
  await host.waitFor((m) => m.t === 'playlist' && m.items.length);
  await sleep(250);
  host.send({ t: 'ended', token });
  const next = await cs[1].waitFor((m) => m.why === 'auto', 2000);
  assert.strictEqual(next.video.id, 'mN0zPOpADL4');
  cs.forEach((c) => c.close());
});

test('a too-short stored duration (stale report from a still-loading player) is corrected by a later, longer report', async () => {
  const { cs, host } = await party(2);
  host.send({ t: 'setVideo', catalogId: 'eRsGyueVLvQ' });
  await host.waitFor((m) => m.why === 'video');
  const token = host.state.video.token;
  host.send({ t: 'report', pos: 0, drift: 0, duration: 231.5, token }); // previous video's length
  await sleep(80);
  host.send({ t: 'control', action: 'seek', position: 500, aid: 'clamped' });
  const clamped = await host.waitFor((m) => m.aid === 'clamped');
  assert.ok(clamped.pb.pos <= 231.5, 'clamped to the wrong length (the bug being guarded against)');
  host.send({ t: 'report', pos: 0, drift: 0, duration: 888, token }); // real length arrives
  await sleep(80);
  host.send({ t: 'control', action: 'seek', position: 500, aid: 'ok' });
  const fixed = await host.waitFor((m) => m.aid === 'ok');
  assert.strictEqual(fixed.pb.pos, 500);
  cs.forEach((c) => c.close());
});
