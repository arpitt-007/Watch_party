'use strict';
const crypto = require('crypto');
const catalog = require('./catalog');
const search = require('./search');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const EMOJIS = ['😂', '😮', '😢', '❤️', '👏', '🔥', '😱', '🎉'];
const BIN_SECONDS = 5;
const MAX_MEMBERS = 100;

function youtubeId(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch (e) { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/); id = m && m[2]; }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
async function youtubeInfo(id) {
  try {
    const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), { signal: AbortSignal.timeout(3000) });
    if (res.ok) return { embeddable: true, title: clampStr((await res.json()).title, 100) };
    if ([401, 403, 404].includes(res.status)) return { embeddable: false, title: '', status: res.status };
  } catch (e) { /* offline or blocked: assume embeddable and let the player report errors */ }
  return { embeddable: null, title: '' };
}

const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const clampStr = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.opts = manager.opts;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.hostId = null;
    this.controlMode = 'everyone'; // 'everyone' | 'host'
    this.members = new Map();
    this.video = null;
    this.playback = { playing: false, pos: 0, at: Date.now(), seq: 0 };
    this.chat = [];
    this.playlist = [];
    this.polls = [];
    this.bins = {};
    this.watched = [];
    this.liked = [];
    this.hostTimer = null;
    this.healthDirty = false;
    this.nextColor = Math.floor(Math.random() * 360);
  }

  // ---------- helpers ----------
  expectedPos(t = Date.now()) {
    const pb = this.playback;
    if (!pb.playing) return pb.pos;
    let p = pb.pos + Math.max(0, t - pb.at) / 1000;
    if (this.video && this.video.duration && p > this.video.duration) p = this.video.duration;
    return p;
  }
  send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const m of this.members.values()) if (m.ws && m.ws.readyState === 1) m.ws.send(s);
  }
  connectedCount() { let n = 0; for (const m of this.members.values()) if (m.connected) n++; return n; }
  publicMember(m) {
    return { id: m.id, name: m.name, hue: m.hue, connected: m.connected, joinedAt: m.joinedAt, drift: m.drift, rtt: m.rtt, buffering: m.buffering };
  }
  presence() {
    return { t: 'presence', hostId: this.hostId, controlMode: this.controlMode, members: [...this.members.values()].map((m) => this.publicMember(m)) };
  }
  orderedPlaylist() {
    return [...this.playlist].sort((a, b) => (b.pinned - a.pinned) || (b.voters.size - a.voters.size) || (a.addedAt - b.addedAt));
  }
  publicPlaylist() {
    return { t: 'playlist', items: this.orderedPlaylist().map((i) => ({ id: i.id, video: i.video, addedBy: i.addedBy, voters: [...i.voters], pinned: i.pinned })) };
  }
  publicPoll(p) {
    return { id: p.id, question: p.question, kind: p.kind, createdBy: p.createdBy, closesAt: p.closesAt, closed: p.closed, winner: p.winner,
      options: p.options.map((o) => ({ id: o.id, text: o.text, voters: [...o.voters], emoji: o.video && o.video.emoji })) };
  }
  publicPolls() { return { t: 'polls', polls: this.polls.map((p) => this.publicPoll(p)) }; }
  snapshot(forId) {
    return {
      code: this.code, you: forId, hostId: this.hostId, controlMode: this.controlMode,
      members: [...this.members.values()].map((m) => this.publicMember(m)),
      video: this.video, pb: this.playback, serverNow: Date.now(),
      chat: this.chat.slice(-100), playlist: this.publicPlaylist().items, polls: this.polls.map((p) => this.publicPoll(p)), bins: this.bins,
    };
  }
  sysChat(text) {
    const msg = { id: rid(4), sys: true, text, ts: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > 200) this.chat.shift();
    this.broadcast({ t: 'chat', msg });
  }
  isHost(id) { return this.hostId === id; }
  canControl(id) { return this.controlMode === 'everyone' || this.isHost(id); }
  name(id) { const m = this.members.get(id); return m ? m.name : 'Someone'; }
  touch() { this.lastActive = Date.now(); }

  // ---------- membership ----------
  join(ws, { clientId, name }) {
    this.touch();
    let m = this.members.get(clientId);
    let isNew = false;
    if (m) {
      if (m.ws && m.ws !== ws) { m.ws.replaced = true; try { m.ws.close(4000, 'replaced'); } catch (e) { /* closing */ } }
      clearTimeout(m.removeTimer);
      m.ws = ws; m.connected = true;
      if (name) m.name = name;
    } else {
      if (this.members.size >= MAX_MEMBERS) { this.send(ws, { t: 'error', code: 'full', msg: 'Room is full' }); ws.close(4002, 'full'); return null; }
      isNew = true;
      m = { id: clientId, name, hue: (this.nextColor = (this.nextColor + 137) % 360), joinedAt: Date.now(), ws, connected: true,
        drift: null, rtt: null, buffering: false, aids: new Set(), msgTimes: [], reactTimes: [] };
      this.members.set(clientId, m);
    }
    ws.member = m; ws.room = this;
    if (!this.hostId || !this.members.has(this.hostId)) this.hostId = clientId;
    if (clientId === this.hostId) { clearTimeout(this.hostTimer); this.hostTimer = null; }
    this.send(ws, { t: 'welcome', ...this.snapshot(clientId) });
    this.broadcast(this.presence());
    if (isNew) this.sysChat(`${m.name} joined`);
    return m;
  }

  disconnect(ws) {
    const m = ws.member;
    if (!m || m.ws !== ws) return; // already superseded by a newer connection
    this.touch();
    m.ws = null; m.connected = false; m.buffering = false;
    this.broadcast(this.presence());
    m.removeTimer = setTimeout(() => this.removeMember(m.id, 'timed out'), this.opts.memberGraceMs);
    if (m.removeTimer.unref) m.removeTimer.unref();
    if (this.isHost(m.id)) {
      clearTimeout(this.hostTimer);
      this.hostTimer = setTimeout(() => this.reassignHost('The host disconnected'), this.opts.hostGraceMs);
      if (this.hostTimer.unref) this.hostTimer.unref();
    }
  }

  removeMember(id, why) {
    const m = this.members.get(id);
    if (!m) return;
    clearTimeout(m.removeTimer);
    this.members.delete(id);
    if (this.isHost(id)) this.reassignHost('The host left');
    this.sysChat(`${m.name} left`);
    this.broadcast(this.presence());
  }

  reassignHost(reason) {
    clearTimeout(this.hostTimer); this.hostTimer = null;
    const cur = this.members.get(this.hostId);
    if (cur && cur.connected) return; // host is back
    const candidates = [...this.members.values()].filter((m) => m.connected && m.id !== this.hostId).sort((a, b) => a.joinedAt - b.joinedAt);
    if (!candidates.length) { if (!cur) this.hostId = null; return; }
    this.hostId = candidates[0].id;
    this.sysChat(`${reason}. ${candidates[0].name} is now the host`);
    this.broadcast(this.presence());
  }

  // ---------- message dispatch ----------
  handle(m, msg) {
    this.touch();
    switch (msg.t) {
      case 'control': return this.control(m, msg);
      case 'setVideo': return this.setVideoFrom(m, msg);
      case 'ended': return this.videoEnded(m, msg);
      case 'unplayable': return this.videoUnplayable(m, msg);
      case 'report': return this.report(m, msg);
      case 'chat': return this.chatMsg(m, msg);
      case 'react': return this.react(m, msg);
      case 'queue.add': return this.queueAdd(m, msg);
      case 'queue.remove': return this.queueRemove(m, msg);
      case 'queue.vote': return this.queueVote(m, msg);
      case 'queue.play': return this.queuePlay(m, msg);
      case 'poll.create': return this.pollCreate(m, msg);
      case 'poll.vote': return this.pollVote(m, msg);
      case 'poll.close': return this.pollClose(m, msg);
      case 'host.transfer': return this.hostTransfer(m, msg);
      case 'host.kick': return this.hostKick(m, msg);
      case 'settings': return this.settings(m, msg);
      default: return this.err(m, 'unknown', 'Unknown message type');
    }
  }
  err(m, code, msg) { this.send(m.ws, { t: 'error', code, msg }); }

  // ---------- playback ----------
  pushState(why, m, aid) {
    this.playback.seq++;
    this.broadcast({ t: 'state', pb: this.playback, video: this.video, why, by: m ? m.name : null, from: m ? m.id : null, aid: aid || null });
  }

  control(m, msg) {
    if (!this.video) return this.err(m, 'no-video', 'Pick something to watch first');
    if (!this.canControl(m.id)) return this.err(m, 'forbidden', 'Only the host can control playback');
    if (msg.aid) { // idempotency: a client that retries after a reconnect must not double-apply
      if (m.aids.has(msg.aid)) return;
      m.aids.add(msg.aid);
      if (m.aids.size > 200) m.aids.delete(m.aids.values().next().value);
    }
    const now = Date.now();
    const pb = this.playback;
    const cur = this.expectedPos(now);
    if (msg.action === 'play') {
      if (pb.playing) return this.send(m.ws, { t: 'state', pb, video: this.video, why: 'noop', aid: msg.aid || null }); // already playing: no-op, keeps the room steady under concurrent clicks
      // Pressing play on a video that has ended is "replay": start over, and re-arm the end-of-video handling.
      const dur = this.video.duration;
      const atEnd = this.video.endHandled || (dur && cur >= dur - 0.5);
      if (atEnd) this.video.endHandled = false;
      this.playback = { playing: true, pos: atEnd ? 0 : cur, at: now, seq: pb.seq };
    } else if (msg.action === 'pause') {
      if (!pb.playing) return this.send(m.ws, { t: 'state', pb, video: this.video, why: 'noop', aid: msg.aid || null });
      this.playback = { playing: false, pos: cur, at: now, seq: pb.seq }; // pause position comes from the server clock, not the client
    } else if (msg.action === 'seek') {
      const target = Number(msg.position);
      if (!Number.isFinite(target)) return this.err(m, 'bad-seek', 'Invalid position');
      const max = this.video.duration || Infinity;
      this.playback = { playing: pb.playing, pos: Math.max(0, Math.min(target, max)), at: now, seq: pb.seq };
      if (this.playback.pos < max - 3) this.video.endHandled = false; // scrubbed away from the end: it can end (and auto-advance) again
    } else return this.err(m, 'bad-action', 'Unknown action');
    this.pushState(msg.action, m, msg.aid);
  }

  makeVideo(desc) {
    if (desc && desc.catalogId) {
      const mv = catalog.byId.get(String(desc.catalogId));
      return mv ? catalog.toVideo(mv) : null;
    }
    if (desc && desc.url) {
      const ytId = youtubeId(desc.url);
      if (ytId) {
        const known = catalog.byId.get(ytId);
        if (known) return catalog.toVideo(known);
        return { id: null, title: clampStr(desc.title, 100), needsTitle: true, source: 'youtube', ytId, src: 'https://www.youtube.com/watch?v=' + ytId, thumb: catalog.thumbFor(ytId), emoji: '▶️', hue: 0 };
      }
      let u;
      try { u = new URL(String(desc.url)); } catch (e) { return null; }
      if (!/^https?:$/.test(u.protocol) || String(desc.url).length > 500) return null;
      return { id: null, title: clampStr(desc.title, 100) || u.pathname.split('/').pop() || u.host, src: u.href, emoji: '🎞️', hue: 220, source: 'url' };
    }
    return null;
  }

  // Resolve a video descriptor; pasted YouTube links need a title lookup (async), everything else is synchronous.
  withVideo(m, desc, done) {
    const v = this.makeVideo(desc);
    if (!v) return this.err(m, 'bad-video', 'Could not use that video');
    if (!v.needsTitle) return done(v);
    delete v.needsTitle;
    (this.opts.youtubeInfo || youtubeInfo)(v.ytId).then((info) => {
      if (info.embeddable === false) return this.err(m, 'no-embed', info.status === 404 ? 'That YouTube video is unavailable or private' : 'The owner of that YouTube video does not allow embedding');
      v.title = v.title || info.title || 'YouTube video';
      done(v);
    }).catch(() => { v.title = v.title || 'YouTube video'; done(v); });
  }

  startVideo(video, m, why = 'video') {
    const now = Date.now();
    this.video = { ...video, token: rid(4), duration: null };
    this.bins = {};
    if (video.id && !this.watched.includes(video.id)) this.watched.push(video.id);
    // Scheduled start: everyone's player gets ~1.5 s to load before the shared clock starts.
    this.playback = { playing: true, pos: 0, at: now + this.opts.startLeadMs, seq: this.playback.seq };
    this.pushState(why, m);
    this.sysChat(`${m ? m.name : 'The queue'} started "${video.title}"`);
  }

  setVideoFrom(m, msg) {
    if (!this.canControl(m.id)) return this.err(m, 'forbidden', 'Only the host can change the video');
    this.withVideo(m, msg, (v) => this.startVideo(v, m));
  }

  videoEnded(m, msg) {
    if (!this.video || msg.token !== this.video.token || this.video.endHandled) return;
    const exp = this.expectedPos();
    if (this.video.duration && exp < this.video.duration - 3) return; // implausible: a glitchy client, not the room
    this.video.endHandled = true;
    const next = this.orderedPlaylist()[0];
    if (next) {
      this.playlist = this.playlist.filter((i) => i.id !== next.id);
      this.broadcast(this.publicPlaylist());
      this.startVideo(next.video, null, 'auto');
    } else {
      // park exactly at the end (a client may legitimately report 'ended' up to 3 s before the server clock gets there)
      this.playback = { playing: false, pos: this.video.duration || exp, at: Date.now(), seq: this.playback.seq };
      this.pushState('ended', null);
    }
  }

  // A client's YouTube player refused the video (embedding disabled, removed, region-locked...): skip it for everyone.
  videoUnplayable(m, msg) {
    if (!this.video || msg.token !== this.video.token || this.video.endHandled) return;
    this.video.endHandled = true;
    if (this.video.id) catalog.block(this.video.id, msg.code);
    this.sysChat(`"${this.video.title}" can't be played in an embedded player (${m.name} got error ${Number(msg.code) || '?'}) — skipping`);
    const next = this.orderedPlaylist()[0];
    if (next) {
      this.playlist = this.playlist.filter((i) => i.id !== next.id);
      this.broadcast(this.publicPlaylist());
      this.startVideo(next.video, null, 'auto');
    } else {
      this.playback = { playing: false, pos: 0, at: Date.now(), seq: this.playback.seq };
      this.pushState('ended', null);
    }
  }

  report(m, msg) {
    if (typeof msg.drift === 'number' && Math.abs(msg.drift) < 3600) m.drift = Math.round(msg.drift * 1000);
    if (typeof msg.rtt === 'number') m.rtt = Math.round(msg.rtt);
    m.buffering = !!msg.buffering;
    const d = Number(msg.duration);
    if (this.video && Number.isFinite(d) && d > 0 && d < 172800 && msg.token === this.video.token) {
      // First report wins, except that a clearly longer length replaces it: a player that has not finished loading can
      // briefly report the previous video's (shorter) length, and a stored length that is too short would clamp seeks.
      if (!this.video.duration || d > this.video.duration * 1.05) this.video.duration = d;
    }
    this.healthDirty = true;
  }
  flushHealth() {
    if (!this.healthDirty) return;
    this.healthDirty = false;
    const h = {};
    for (const m of this.members.values()) h[m.id] = { drift: m.drift, rtt: m.rtt, buffering: m.buffering };
    this.broadcast({ t: 'health', h });
  }

  // ---------- social ----------
  chatMsg(m, msg) {
    const text = clampStr(msg.text, 500);
    if (!text) return;
    const now = Date.now();
    m.msgTimes = m.msgTimes.filter((t) => now - t < 5000);
    if (m.msgTimes.length >= 8) return this.err(m, 'slow-down', 'You are sending messages too fast');
    m.msgTimes.push(now);
    const out = { id: rid(4), from: m.id, name: m.name, text, ts: now };
    this.chat.push(out);
    if (this.chat.length > 200) this.chat.shift();
    this.broadcast({ t: 'chat', msg: out });
  }

  react(m, msg) {
    if (!EMOJIS.includes(msg.emoji) || !this.video) return;
    const now = Date.now();
    m.reactTimes = m.reactTimes.filter((t) => now - t < 2000);
    if (m.reactTimes.length >= 8) return;
    m.reactTimes.push(now);
    const pos = this.expectedPos(now);
    const bin = Math.floor(pos / BIN_SECONDS);
    this.bins[bin] = (this.bins[bin] || 0) + 1;
    this.broadcast({ t: 'reaction', from: m.id, name: m.name, emoji: msg.emoji, pos, bin, count: this.bins[bin], token: this.video.token });
  }

  // ---------- queue ----------
  queueAdd(m, msg) {
    if (this.playlist.length >= 50) return this.err(m, 'queue-full', 'Queue is full');
    this.withVideo(m, msg, (v) => {
      const dup = this.playlist.find((i) => i.video.src === v.src);
      if (dup) { dup.voters.add(m.id); } else {
        this.playlist.push({ id: rid(4), video: v, addedBy: m.id, addedAt: Date.now(), voters: new Set([m.id]), pinned: 0 });
        this.sysChat(`${m.name} queued "${v.title}"`);
      }
      this.broadcast(this.publicPlaylist());
    });
  }
  queueRemove(m, msg) {
    const it = this.playlist.find((i) => i.id === msg.id);
    if (!it || (it.addedBy !== m.id && !this.isHost(m.id))) return;
    this.playlist = this.playlist.filter((i) => i !== it);
    this.broadcast(this.publicPlaylist());
  }
  queueVote(m, msg) {
    const it = this.playlist.find((i) => i.id === msg.id);
    if (!it) return;
    if (it.voters.has(m.id)) it.voters.delete(m.id); else it.voters.add(m.id);
    this.broadcast(this.publicPlaylist());
  }
  queuePlay(m, msg) {
    if (!this.canControl(m.id)) return this.err(m, 'forbidden', 'Only the host can change the video');
    const it = msg.id ? this.playlist.find((i) => i.id === msg.id) : this.orderedPlaylist()[0];
    if (!it) return;
    this.playlist = this.playlist.filter((i) => i !== it);
    this.broadcast(this.publicPlaylist());
    this.startVideo(it.video, m);
  }

  // ---------- polls ----------
  pollCreate(m, msg) {
    const question = clampStr(msg.question, 120);
    let options = Array.isArray(msg.options) ? msg.options.slice(0, 6) : [];
    const kind = msg.kind === 'next' ? 'next' : 'generic';
    options = options.map((o) => {
      if (kind === 'next') { const v = this.makeVideo({ catalogId: o }); return v ? { text: v.title, video: v } : null; }
      const text = clampStr(o, 60);
      return text ? { text } : null;
    }).filter(Boolean);
    if (!question || options.length < 2) return this.err(m, 'bad-poll', 'A poll needs a question and at least two options');
    if (this.polls.filter((p) => !p.closed).length >= 5) return this.err(m, 'too-many', 'Close an open poll first');
    const dur = Math.max(0, Math.min(600, Number(msg.durationSec) || 0));
    const poll = { id: rid(4), question, kind, createdBy: m.id, closed: false, winner: null, closesAt: dur ? Date.now() + dur * 1000 : null,
      options: options.map((o) => ({ id: rid(3), text: o.text, video: o.video, voters: new Set() })) };
    if (dur) { poll.timer = setTimeout(() => this.closePoll(poll), dur * 1000); if (poll.timer.unref) poll.timer.unref(); }
    this.polls.push(poll);
    if (this.polls.length > 20) this.polls.shift();
    this.broadcast(this.publicPolls());
    this.sysChat(`${m.name} started a poll: ${question}`);
  }
  pollVote(m, msg) {
    const p = this.polls.find((x) => x.id === msg.id);
    if (!p || p.closed) return;
    const opt = p.options.find((o) => o.id === msg.option);
    if (!opt) return;
    for (const o of p.options) o.voters.delete(m.id); // one vote per member, changeable until close
    opt.voters.add(m.id);
    this.broadcast(this.publicPolls());
  }
  pollClose(m, msg) {
    const p = this.polls.find((x) => x.id === msg.id);
    if (!p || p.closed) return;
    if (p.createdBy !== m.id && !this.isHost(m.id)) return this.err(m, 'forbidden', 'Only the poll creator or host can close it');
    this.closePoll(p);
  }
  closePoll(p) {
    if (p.closed) return;
    clearTimeout(p.timer);
    p.closed = true;
    let best = null;
    for (const o of p.options) if (o.voters.size && (!best || o.voters.size > best.voters.size)) best = o; // ties -> earliest option
    p.winner = best ? best.id : null;
    if (best && p.kind === 'next' && best.video) {
      const dup = this.playlist.find((i) => i.video.src === best.video.src);
      if (dup) dup.pinned = 1; else this.playlist.push({ id: rid(4), video: best.video, addedBy: p.createdBy, addedAt: Date.now(), voters: new Set(best.voters), pinned: 1 });
      if (best.video.id && !this.liked.includes(best.video.id)) this.liked.push(best.video.id);
      this.broadcast(this.publicPlaylist());
    }
    this.sysChat(best ? `Poll closed: "${best.text}" won with ${best.voters.size} vote${best.voters.size === 1 ? '' : 's'}${p.kind === 'next' ? ' and is up next' : ''}` : 'Poll closed with no votes');
    this.broadcast(this.publicPolls());
  }

  // ---------- host powers ----------
  hostTransfer(m, msg) {
    if (!this.isHost(m.id)) return this.err(m, 'forbidden', 'Only the host can transfer hosting');
    const t = this.members.get(msg.to);
    if (!t || !t.connected || t.id === m.id) return this.err(m, 'bad-target', 'That person is not available');
    this.hostId = t.id;
    this.sysChat(`${m.name} made ${t.name} the host`);
    this.broadcast(this.presence());
  }
  hostKick(m, msg) {
    if (!this.isHost(m.id)) return this.err(m, 'forbidden', 'Only the host can remove people');
    const t = this.members.get(msg.to);
    if (!t || t.id === m.id) return;
    if (t.ws) { t.ws.kicked = true; this.send(t.ws, { t: 'kicked' }); try { t.ws.close(4003, 'kicked'); } catch (e) { /* closing */ } }
    this.removeMember(t.id, 'kicked');
  }
  settings(m, msg) {
    if (!this.isHost(m.id)) return this.err(m, 'forbidden', 'Only the host can change room settings');
    if (msg.controlMode === 'host' || msg.controlMode === 'everyone') {
      this.controlMode = msg.controlMode;
      this.sysChat(msg.controlMode === 'host' ? 'Playback is now host-only' : 'Everyone can control playback');
      this.broadcast(this.presence());
    }
  }

  destroy() {
    clearTimeout(this.hostTimer);
    for (const m of this.members.values()) clearTimeout(m.removeTimer);
    for (const p of this.polls) clearTimeout(p.timer);
  }

  recommendations() {
    return search.recommend({ watched: this.watched, queued: this.playlist.map((i) => i.video.id).filter(Boolean), liked: this.liked });
  }
}

class RoomManager {
  constructor(opts = {}) {
    this.opts = { memberGraceMs: 30000, hostGraceMs: 8000, startLeadMs: 1500, roomTtlMs: 5 * 60000, ...opts };
    this.rooms = new Map();
    this.counters = { messages: 0, dropped: 0, connections: 0 };
    this.timer = setInterval(() => this.tick(), 2000);
    if (this.timer.unref) this.timer.unref();
  }
  create() {
    let code;
    do { code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (this.rooms.has(code));
    const r = new Room(code, this);
    this.rooms.set(code, r);
    return r;
  }
  get(code) { return this.rooms.get(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')); }
  tick() {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      r.flushHealth();
      if (r.connectedCount() === 0 && now - r.lastActive > this.opts.roomTtlMs) { r.destroy(); this.rooms.delete(code); }
    }
  }
  metrics() {
    let members = 0, connected = 0;
    const drifts = [];
    for (const r of this.rooms.values()) for (const m of r.members.values()) { members++; if (m.connected) { connected++; if (m.drift != null) drifts.push(Math.abs(m.drift)); } }
    drifts.sort((a, b) => a - b);
    const p = (q) => drifts.length ? drifts[Math.min(drifts.length - 1, Math.floor(q * drifts.length))] : null;
    return { rooms: this.rooms.size, members, connected, ...this.counters, reportedDriftMs: { n: drifts.length, p50: p(0.5), p95: p(0.95), max: p(1) } };
  }
  close() { clearInterval(this.timer); for (const r of this.rooms.values()) r.destroy(); }
}

module.exports = { Room, RoomManager, EMOJIS, youtubeId };
