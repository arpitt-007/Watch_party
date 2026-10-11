'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const nowMs = () => performance.timeOrigin + performance.now();
  const EMOJIS = ['😂', '😮', '😢', '❤️', '👏', '🔥', '😱', '🎉'];
  const BIN_SECONDS = 5;

  // XSS-safe element builder: text always goes through textContent / text nodes.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const rid = () => Math.random().toString(36).slice(2, 10);
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  };
  const hue = (n) => `hsl(${n} 70% 65%)`;
  const posterStyle = (m) => `background:linear-gradient(135deg,hsl(${m.hue} 55% 38%),hsl(${(m.hue + 40) % 360} 60% 18%))`;

  const store = {
    get: (k, area = localStorage) => { try { return area.getItem(k); } catch (e) { return null; } },
    set: (k, v, area = localStorage) => { try { area.setItem(k, v); } catch (e) { /* private mode */ } },
    del: (k, area = sessionStorage) => { try { area.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const S = {
    ws: null, code: null, you: null, name: '', hostId: null, controlMode: 'everyone', members: [], health: {},
    video: null, pb: null, clock: new SyncCore.ClockSync(), lastSeekAt: -1e9, needsSeek: false,
    retry: 0, leaving: false, bins: {}, drift: 0, buffering: false, dragging: false, connected: false,
    queue: [], polls: [], picks: [], chat: [], filters: { genres: new Set() }, startTimer: null, timers: [],
  };
  const v = $('video');
  const serverNow = () => S.clock.serverNow(nowMs());
  const isHost = () => S.hostId === S.you;
  const canControl = () => S.controlMode === 'everyone' || isHost();
  const memberById = (id) => S.members.find((m) => m.id === id);
  const nameOf = (id) => (memberById(id) || {}).name || 'Someone';

  function toast(text, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text);
    $('toasts').append(t);
    setTimeout(() => t.remove(), 3500);
  }
  const send = (o) => { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(o)); return true; } toast('Not connected — reconnecting…', true); return false; };

  // ================= landing =================
  const params = new URLSearchParams(location.search);
  $('nameInput').value = store.get('wp_name') || '';
  $('codeInput').value = (params.get('room') || '').toUpperCase();

  async function enterRoom(code) {
    const name = $('nameInput').value.trim();
    if (!name) { $('landingError').textContent = 'Please enter your name first.'; $('nameInput').focus(); return; }
    store.set('wp_name', name);
    $('landingError').textContent = '';
    const r = await fetch('/api/rooms/' + encodeURIComponent(code)).catch(() => null);
    if (!r || !r.ok) { $('landingError').textContent = 'Room not found. Check the code and try again.'; return; }
    S.code = (await r.json()).code; S.name = name; S.leaving = false;
    let id = store.get('wp_cid', sessionStorage);
    if (!id) { id = 'c' + rid() + rid(); store.set('wp_cid', id, sessionStorage); }
    S.you = id;
    store.set('wp_room', S.code, sessionStorage);
    history.replaceState(null, '', '?room=' + S.code);
    $('landing').classList.add('hidden'); $('roomView').classList.remove('hidden');
    $('roomCode').textContent = S.code;
    connect();
  }
  $('createBtn').onclick = async () => {
    if (!$('nameInput').value.trim()) { $('landingError').textContent = 'Please enter your name first.'; return; }
    const r = await fetch('/api/rooms', { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { $('landingError').textContent = 'Could not create a room.'; return; }
    enterRoom((await r.json()).code);
  };
  $('joinForm').onsubmit = (e) => { e.preventDefault(); const c = $('codeInput').value.trim(); if (c) enterRoom(c); };
  $('leaveBtn').onclick = () => leave();
  $('codeBtn').onclick = async () => {
    const link = location.origin + '/?room=' + S.code;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch (e) { prompt('Copy this invite link:', link); }
  };
  function leave(msg) {
    S.leaving = true;
    S.timers.forEach(clearInterval); S.timers = [];
    if (S.ws) try { S.ws.close(); } catch (e) { /* closed */ }
    html5.clear(); yt.clear();
    S.video = null; S.pb = null; S.members = []; S.queue = []; S.polls = []; S.chat = []; S.bins = {}; S.picks = [];
    store.del('wp_room');
    history.replaceState(null, '', location.pathname);
    $('roomView').classList.add('hidden'); $('landing').classList.remove('hidden');
    $('chatLog').replaceChildren(); $('banner').classList.add('hidden');
    $('landingError').textContent = msg || '';
    $('codeInput').value = '';
  }

  // ================= connection =================
  function connect() {
    clearTimeout(S.reconnectTimer);
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    S.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', room: S.code, name: S.name, clientId: S.you }));
      for (let i = 0; i < 6; i++) setTimeout(ping, i * 150); // burst for a fast initial clock estimate
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
    ws.onclose = (ev) => {
      if (S.ws !== ws) return;
      S.connected = false; stopTimers(); renderBadge();
      if (S.leaving) return;
      if (ev.code === 4001) return leave('That room no longer exists.');
      if (ev.code === 4003) return leave('You were removed from the room by the host.');
      if (ev.code === 4002) return leave('That room is full.');
      if (ev.code === 4000) { showBanner('This room is open in another tab — this tab is now inactive.', true); v.pause(); return; }
      showBanner('Connection lost — reconnecting…');
      const delay = Math.min(5000, 400 * Math.pow(1.6, S.retry++)) * (0.7 + Math.random() * 0.6); // jittered exponential backoff
      S.reconnectTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => {};
  }
  function startTimers() {
    stopTimers();
    S.timers.push(setInterval(ping, 3000));
    S.timers.push(setInterval(enforce, 250));
    S.timers.push(setInterval(report, 2000));
    S.timers.push(setInterval(uiTick, 250));
  }
  function stopTimers() { S.timers.forEach(clearInterval); S.timers = []; }
  function ping() { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t: 'ping', c: nowMs() })); }
  function report() {
    if (!S.video || !S.connected) return;
    send({ t: 'report', pos: P.time(), drift: S.drift, rtt: S.clock.rtt, buffering: S.buffering, duration: P.dur(), token: S.video.token });
  }
  function showBanner(text, bad) { const b = $('banner'); b.textContent = text; b.classList.toggle('bad', !!bad); b.classList.remove('hidden'); }

  function onMessage(m) {
    switch (m.t) {
      case 'pong': S.clock.addSample(m.c, m.s, nowMs()); break;
      case 'welcome': onWelcome(m); break;
      case 'presence': S.hostId = m.hostId; S.controlMode = m.controlMode; S.members = m.members; renderPeople(); renderControls(); renderMovieActions(); renderBadge(); break;
      case 'health': S.health = m.h; renderPeople(); break;
      case 'state': onState(m); break;
      case 'chat': addChat(m.msg); break;
      case 'reaction': onReaction(m); break;
      case 'playlist': S.queue = m.items; renderQueue(); break;
      case 'polls': S.polls = m.polls; renderPolls(); break;
      case 'error': toast(m.msg || 'Something went wrong', true); break;
      case 'kicked': break;
    }
  }

  function onWelcome(m) {
    S.connected = true; S.retry = 0;
    $('banner').classList.add('hidden');
    if (!S.clock.ready) S.clock.offset = m.serverNow - nowMs();
    S.hostId = m.hostId; S.controlMode = m.controlMode; S.members = m.members; S.queue = m.playlist; S.polls = m.polls; S.bins = m.bins || {};
    $('chatLog').replaceChildren(); S.chat = [];
    m.chat.forEach(addChat);
    startTimers();
    const changed = !S.video || (m.video && m.video.token !== S.video.token) || (!m.video && S.video);
    S.pb = m.pb;
    if (changed) loadVideo(m.video, true);
    enforce();
    renderAll();
  }

  function onState(m) {
    if (S.pb && m.pb.seq < S.pb.seq) return; // stale (out-of-order) update
    S.pb = m.pb;
    if (m.why === 'noop') { renderControls(); return; }
    const changed = (m.video && (!S.video || m.video.token !== S.video.token)) || (!m.video && S.video);
    if (changed) loadVideo(m.video);
    if (m.why === 'seek' || m.why === 'video') { S.lastSeekAt = -1e9; }
    enforce();
    renderControls();
    if (m.by && m.why !== 'video' && m.why !== 'auto' && m.from !== S.you) toast(`${m.by}: ${{ play: '▶ play', pause: '⏸ pause', seek: '⏩ seek' }[m.why] || m.why}`);
  }

  // ================= player sync =================
  // Two interchangeable players behind one interface: <video> for direct files, YouTube IFrame API for YouTube.
  class Html5Player {
    constructor(el) { this.v = el; this.cfg = {}; }
    show(on) { this.v.classList.toggle('hidden', !on); }
    load(video) { this.show(true); if (this.v.getAttribute('src') !== video.src) { this.v.src = video.src; this.v.load(); } }
    clear() { this.v.pause(); this.v.removeAttribute('src'); this.v.load(); this.show(false); }
    ready() { return this.v.readyState > 0; }
    time() { return this.v.currentTime; }
    dur() { return isFinite(this.v.duration) && this.v.duration > 0 ? this.v.duration : null; }
    paused() { return this.v.paused; }
    buffering() { return this.v.seeking || this.v.readyState < 3; }
    ended() { return this.v.ended; }
    rate() { return this.v.playbackRate; }
    setRate(r) { this.v.playbackRate = r; }
    seek(t) { this.v.currentTime = Math.max(0, t); }
    play() { return this.v.play() || Promise.resolve(); }
    pause() { this.v.pause(); }
    setVolume(x) { this.v.volume = x; }
    setMuted(b) { this.v.muted = b; }
  }

  let ytPromise = null;
  function ytApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!ytPromise) {
      ytPromise = new Promise((resolve, reject) => {
        window.onYouTubeIframeAPIReady = resolve;
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => { ytPromise = null; reject(new Error('blocked')); };
        document.head.append(s);
      });
    }
    return ytPromise;
  }

  class YTPlayer {
    // The IFrame API only offers fixed playback rates (0.25/0.5/1/1.25...), so there is no +-8 % nudging: drift is
    // corrected by seeking only, with a tighter threshold and a longer cooldown (a YouTube seek costs a re-buffer).
    constructor() {
      this.p = null; this.st = -1; this.apiReady = false; this.id = null; this.created = null; this.gen = 0; this.inflight = null;
      this.cfg = { softThreshold: Infinity, softRelease: Infinity, hardThreshold: 0.45, seekCooldownMs: 2500 };
    }
    show(on) { $('ytWrap').classList.toggle('hidden', !on); }
    async load(video) {
      this.show(true); this.id = video.ytId; const gen = ++this.gen;
      try { await ytApi(); } catch (e) { toast('Could not load the YouTube player (blocked or offline)', true); return; }
      if (gen !== this.gen) return;
      if (this.p) { if (this.apiReady) { this.st = -1; this.p.cueVideoById(this.id); } return; } // else onReady cues this.id
      const host = h('div');
      $('ytHost').replaceChildren(host);
      this.created = this.id;
      this.p = new window.YT.Player(host, {
        width: '100%', height: '100%', videoId: this.id,
        playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => { this.apiReady = true; applyVolume(); if (this.id !== this.created) { this.st = -1; this.p.cueVideoById(this.id); } setTimeout(enforce, 0); },
          onStateChange: (e) => { this.st = e.data; if (e.data === 0) onVideoEnded(); if (e.data === 1) { $('spinner').classList.add('hidden'); $('tapOverlay').classList.add('hidden'); } setTimeout(enforce, 0); },
          onError: (e) => { $('spinner').classList.add('hidden'); toast([101, 150].includes(e.data) ? 'The owner of this YouTube video disabled embedding.' : 'This YouTube video is unavailable.', true); },
        },
      });
    }
    clear() { this.gen++; this.show(false); if (this.apiReady) { try { this.p.stopVideo(); } catch (e) { /* ignore */ } } this.st = -1; }
    // getPlayerState() is polled rather than cached: a player created with a videoId never fires a 'cued' event.
    get state() { try { return this.apiReady ? this.p.getPlayerState() : -1; } catch (e) { return -1; } }
    ready() { return this.apiReady; }
    time() { try { return this.p.getCurrentTime() || 0; } catch (e) { return 0; } }
    dur() { try { const d = this.p.getDuration(); return d > 0 ? d : null; } catch (e) { return null; } }
    paused() { const s = this.state; return s !== 1 && s !== 3; }
    buffering() { const s = this.state; return s === 3 || s === -1 || s === 5; }
    ended() { return this.state === 0; }
    rate() { return 1; }
    setRate() { /* unsupported at fine granularity */ }
    seek(t) { try { this.p.seekTo(Math.max(0, t), true); } catch (e) { /* ignore */ } }
    play() {
      if (this.inflight) return this.inflight;
      try { this.p.playVideo(); } catch (e) { /* ignore */ }
      // playVideo() gives no error when autoplay is refused; detect it by the player not starting.
      this.inflight = new Promise((res, rej) => setTimeout(() => { this.inflight = null; if (this.state === 1 || this.state === 3) res(); else rej({ name: 'NotAllowedError' }); }, 1500));
      return this.inflight;
    }
    pause() { try { this.p.pauseVideo(); } catch (e) { /* ignore */ } }
    setVolume(x) { if (this.apiReady) this.p.setVolume(Math.round(x * 100)); }
    setMuted(b) { if (this.apiReady) { if (b) this.p.mute(); else this.p.unMute(); } }
  }

  const html5 = new Html5Player(v);
  const yt = new YTPlayer();
  let P = html5;
  S.vol = 1; S.muted = false;
  function applyVolume() { P.setVolume(S.vol); P.setMuted(S.muted); }

  function loadVideo(video, keepBins) {
    S.video = video; if (!keepBins) S.bins = {};
    S.needsSeek = true; S.buffering = false; S.drift = 0;
    $('emptyState').classList.toggle('hidden', !!video);
    $('tapOverlay').classList.add('hidden');
    if (!video) { html5.clear(); yt.clear(); renderNowPlaying(); return; }
    const next = video.source === 'youtube' ? yt : html5;
    if (next !== P) P.clear();
    P = next;
    P.load(video);
    applyVolume();
    $('spinner').classList.remove('hidden');
    renderNowPlaying(); drawHeat();
  }

  function tryPlay() {
    if (!$('tapOverlay').classList.contains('hidden')) return; // waiting for the user's tap
    const p = P.play();
    if (p && p.catch) p.catch((e) => { if (e && e.name === 'NotAllowedError') $('tapOverlay').classList.remove('hidden'); });
  }
  $('tapOverlay').onclick = () => { $('tapOverlay').classList.add('hidden'); tryPlay(); enforce(); };
  function onVideoEnded() { if (S.video) send({ t: 'ended', token: S.video.token }); }

  function enforce() {
    if (!S.video || !S.pb) return;
    const pb = S.pb, now = serverNow();
    const dur = P.dur();
    const cd = $('startCountdown');
    if (pb.playing && now < pb.at) { // scheduled start: hold at the start position until the shared clock reaches `at`
      cd.textContent = Math.max(1, Math.ceil((pb.at - now) / 1000)); cd.classList.remove('hidden');
      if (!P.paused()) P.pause();
      if (P.ready() && Math.abs(P.time() - pb.pos) > 0.3) P.seek(pb.pos);
      clearTimeout(S.startTimer); S.startTimer = setTimeout(enforce, Math.max(0, pb.at - now));
      return;
    }
    cd.classList.add('hidden');
    if (!P.ready()) return; // metadata pending; player events re-run enforce()
    const exp = SyncCore.expectedPosition(pb, now, dur);
    if (S.needsSeek) { // first positioning after load / late join / reconnect-with-new-video
      S.needsSeek = false; S.lastSeekAt = performance.now();
      if (pb.playing || Math.abs(P.time() - exp) > 0.3) P.seek(exp + (pb.playing ? SyncCore.CFG.seekLead : 0));
    }
    if (!pb.playing) {
      if (!P.paused()) P.pause();
      if (!P.buffering() && Math.abs(P.time() - exp) > (P === yt ? 0.3 : 0.05)) P.seek(exp);
      if (P.rate() !== 1) P.setRate(1);
      S.drift = 0; S.buffering = false;
      return;
    }
    if (P.ended()) return;
    if (P.paused()) tryPlay();
    if (P.buffering()) { S.buffering = true; return; }
    S.buffering = false;
    S.drift = P.time() - exp;
    const d = SyncCore.decide({ drift: S.drift, currentRate: P.rate(), sinceSeekMs: performance.now() - S.lastSeekAt, cfg: { ...SyncCore.CFG, ...P.cfg } });
    if (d.action === 'seek') { P.seek(P.time() + d.delta); S.lastSeekAt = performance.now(); }
    if (Math.abs(P.rate() - d.rate) > 0.001) P.setRate(d.rate);
  }

  v.addEventListener('loadedmetadata', () => { enforce(); drawHeat(); renderControls(); });
  v.addEventListener('canplay', () => { $('spinner').classList.add('hidden'); enforce(); });
  v.addEventListener('waiting', () => $('spinner').classList.remove('hidden'));
  v.addEventListener('playing', () => { $('spinner').classList.add('hidden'); $('tapOverlay').classList.add('hidden'); });
  v.addEventListener('seeked', () => $('spinner').classList.add('hidden'));
  v.addEventListener('ended', onVideoEnded);
  v.addEventListener('error', () => { if (S.video && P === html5) { $('spinner').classList.add('hidden'); toast('This video failed to load (is the source reachable?)', true); } });
  // Someone pressing a hardware media key must not desync us from the room.
  v.addEventListener('pause', () => { if (S.pb && S.pb.playing && !v.ended && !v.seeking) setTimeout(enforce, 50); });
  v.addEventListener('play', () => { if (S.pb && !S.pb.playing) setTimeout(enforce, 0); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) enforce(); });

  // ================= controls =================
  const act = (a, extra) => send({ t: 'control', action: a, aid: rid(), ...extra });
  const curPos = () => (S.pb ? SyncCore.expectedPosition(S.pb, serverNow(), P.dur()) : 0);
  $('playBtn').onclick = () => { if (S.pb && S.video) act(S.pb.playing ? 'pause' : 'play'); };
  $('back10').onclick = () => act('seek', { position: Math.max(0, curPos() - 10) });
  $('fwd10').onclick = () => act('seek', { position: curPos() + 10 });
  $('player').addEventListener('click', (e) => { if ((e.target === $('player') || e.target === v) && canControl() && S.video) $('playBtn').click(); });
  $('seek').addEventListener('input', () => { S.dragging = true; const d = P.dur() || 0; $('time').textContent = fmt(($('seek').value / 1000) * d) + ' / ' + fmt(d); });
  $('seek').addEventListener('change', () => { S.dragging = false; if (P.dur()) act('seek', { position: ($('seek').value / 1000) * P.dur() }); });
  $('muteBtn').onclick = () => { S.muted = !S.muted; applyVolume(); renderVolume(); };
  $('volume').oninput = () => { S.vol = Number($('volume').value); S.muted = S.vol === 0; applyVolume(); renderVolume(); };
  $('fsBtn').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else $('player').requestFullscreen().catch(() => {}); };
  $('player').addEventListener('dblclick', (e) => { if (e.target === $('player') || e.target === v) $('fsBtn').click(); });
  function renderVolume() { $('muteBtn').textContent = S.muted || S.vol === 0 ? '🔇' : '🔊'; }
  let idleT;
  $('player').addEventListener('mousemove', () => { $('player').classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (S.pb && S.pb.playing) $('player').classList.add('idle'); }, 3000); });
  document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey || $('roomView').classList.contains('hidden')) return;
    if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
    else if (e.key === 'ArrowLeft') $('back10').click();
    else if (e.key === 'ArrowRight') $('fwd10').click();
    else if (e.key === 'm') $('muteBtn').click();
    else if (e.key === 'f') $('fsBtn').click();
  });

  function renderControls() {
    const ok = canControl() && !!S.video;
    for (const id of ['playBtn', 'back10', 'fwd10', 'seek']) $(id).disabled = !ok;
    $('lockNote').classList.toggle('hidden', canControl());
    $('playBtn').textContent = S.pb && S.pb.playing ? '⏸' : '▶';
    $('hostBadge').classList.toggle('hidden', !isHost());
    $('memberCount').textContent = `${S.members.filter((m) => m.connected).length} watching`;
  }
  function uiTick() {
    if (S.video && !S.dragging && P.dur() && P.ready()) {
      $('seek').value = Math.round((P.time() / P.dur()) * 1000);
      $('time').textContent = fmt(P.time()) + ' / ' + fmt(P.dur());
    }
    $('playBtn').textContent = S.pb && S.pb.playing ? '⏸' : '▶';
    renderBadge();
    document.querySelectorAll('[data-closes]').forEach((el) => {
      const left = Math.max(0, Math.ceil((Number(el.dataset.closes) - serverNow()) / 1000));
      el.textContent = left ? `closes in ${left}s` : 'closing…';
    });
  }
  function renderBadge() {
    const b = $('syncBadge');
    let text, cls = '';
    if (!S.connected) { text = 'reconnecting…'; cls = 'bad'; }
    else if (!S.video) { text = 'connected'; cls = 'good'; }
    else if (S.buffering) { text = 'buffering…'; cls = 'warn'; }
    else if (S.pb && !S.pb.playing) { text = '⏸ paused · in sync'; cls = 'good'; }
    else {
      const ms = Math.round(Math.abs(S.drift) * 1000);
      text = `in sync ±${ms} ms`; cls = ms < 100 ? 'good' : ms < 300 ? 'warn' : 'bad';
    }
    b.textContent = text; b.className = 'badge ' + cls;
    b.title = S.clock.ready ? `RTT ${Math.round(S.clock.rtt)} ms · clock offset ${Math.round(S.clock.offset)} ms` : '';
  }
  function renderNowPlaying() {
    const vd = S.video;
    $('npTitle').textContent = vd ? `${vd.emoji || ''} ${vd.title}` : '—';
    $('npSub').textContent = vd ? (vd.source === 'youtube' ? 'YouTube' : vd.source === 'url' ? 'Custom URL' : 'From the catalog') : 'Pick something from Discover';
    document.title = vd ? `${vd.title} · Watch Party` : 'Watch Party';
  }

  // ================= reactions =================
  const rb = $('reactionBar');
  EMOJIS.forEach((e) => rb.append(h('button', { 'aria-label': 'React ' + e, onclick: () => send({ t: 'react', emoji: e }) }, e)));
  function onReaction(m) {
    if (!S.video || m.token !== S.video.token) return;
    S.bins[m.bin] = m.count;
    const x = 10 + Math.random() * 80;
    const el = h('div', { class: 'float', style: `left:${x}%` }, h('span', { class: 'e' }, m.emoji), h('span', { class: 'n' }, m.name));
    el.addEventListener('animationend', () => el.remove());
    $('reactionLayer').append(el);
    requestAnimationFrame(drawHeat);
  }
  function drawHeat() {
    const c = $('heat'), dur = P.dur();
    const w = (c.width = c.clientWidth || 600), ht = c.height;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, ht);
    ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(0, 1, w, ht - 2);
    if (!dur) return;
    const max = Math.max(1, ...Object.values(S.bins));
    const bw = Math.max(2, (BIN_SECONDS / dur) * w);
    for (const [bin, count] of Object.entries(S.bins)) {
      ctx.fillStyle = `rgba(255,92,154,${0.35 + 0.65 * (count / max)})`;
      ctx.fillRect((bin * BIN_SECONDS / dur) * w, 0, bw, ht);
    }
  }
  window.addEventListener('resize', drawHeat);

  // ================= chat =================
  function addChat(msg) {
    const log = $('chatLog');
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const mem = memberById(msg.from);
    const el = msg.sys
      ? h('div', { class: 'msg sys' }, msg.text)
      : h('div', { class: 'msg' }, h('span', { class: 'who', style: `color:${hue(mem ? mem.hue : 200)}` }, msg.name), msg.text, h('span', { class: 't' }, time));
    log.append(el);
    while (log.children.length > 300) log.firstChild.remove();
    if (near || msg.from === S.you) log.scrollTop = log.scrollHeight;
  }
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim();
    if (t && send({ t: 'chat', text: t })) $('chatInput').value = '';
  };

  // ================= tabs =================
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'discover') loadDiscover();
    if (b.dataset.tab === 'chat') { const l = $('chatLog'); l.scrollTop = l.scrollHeight; }
  });

  // ================= discover =================
  let discoverGen = 0, debounce;
  const gc = $('genreChips');
  function buildGenres(genres) {
    if (gc.children.length) return;
    genres.forEach((g) => gc.append(h('button', { onclick: (e) => { S.filters.genres.has(g) ? S.filters.genres.delete(g) : S.filters.genres.add(g); e.target.classList.toggle('on'); loadDiscover(); } }, g)));
  }
  ['fRating', 'fLength', 'fSort'].forEach((id) => { $(id).onchange = loadDiscover; });
  $('q').oninput = () => { clearTimeout(debounce); debounce = setTimeout(loadDiscover, 150); };

  function movieCard(m, compact) {
    const picked = S.picks.includes(m.id);
    return h('div', { class: 'movie' + (compact ? ' compact' : ''), 'data-id': m.id },
      h('div', { class: 'poster', style: posterStyle(m) }, m.emoji),
      h('div', null,
        h('h5', null, m.title, m.youtube ? h('span', { class: 'yt-tag' }, '  ▶ YouTube') : null),
        h('div', { class: 'meta' }, `${m.year} · ★ ${m.rating.toFixed(1)} · ${m.durationSec >= 120 ? Math.round(m.durationSec / 60) + ' min' : m.durationSec + ' s'}`),
        h('div', { class: 'meta' }, m.genres.join(' · ')),
        compact ? null : h('p', null, m.description),
        m.reason ? h('div', { class: 'why' }, '✨ ' + m.reason) : null,
        h('div', { class: 'acts' },
          h('button', { class: 'playm', disabled: !canControl(), title: canControl() ? 'Play for everyone' : 'Only the host controls playback', onclick: () => send({ t: 'setVideo', catalogId: m.id }) }, '▶ Play'),
          h('button', { onclick: () => send({ t: 'queue.add', catalogId: m.id }) }, '＋ Queue'),
          h('button', { class: picked ? 'on' : '', title: 'Add to a "what next?" poll', onclick: (e) => togglePick(m.id, e.target) }, picked ? '✓ Poll' : '📊 Poll'))));
  }
  function togglePick(id, btn) {
    const i = S.picks.indexOf(id);
    if (i >= 0) S.picks.splice(i, 1);
    else if (S.picks.length < 6) S.picks.push(id); else return toast('A poll can have up to 6 options', true);
    btn.classList.toggle('on', i < 0); btn.textContent = i < 0 ? '✓ Poll' : '📊 Poll';
    renderPicks();
  }
  function renderPicks() {
    $('pickBar').classList.toggle('hidden', !S.picks.length);
    $('pickCount').textContent = `${S.picks.length} picked`;
    $('pickPoll').disabled = S.picks.length < 2;
  }
  $('pickClear').onclick = () => { S.picks = []; renderPicks(); loadDiscover(); };
  $('pickPoll').onclick = () => {
    if (send({ t: 'poll.create', kind: 'next', question: 'What should we watch next?', options: S.picks, durationSec: 60 })) {
      S.picks = []; renderPicks(); loadDiscover(); document.querySelector('[data-tab="polls"]').click();
    }
  };

  async function loadDiscover() {
    if (!S.code) return;
    const gen = ++discoverGen;
    const q = $('q').value.trim(), genres = [...S.filters.genres];
    const rating = $('fRating').value, len = $('fLength').value, sort = $('fSort').value;
    const body = $('discoverBody');
    try {
      if (!q && !genres.length && !rating && !len && !sort) {
        const [cat, rec] = await Promise.all([fetch('/api/categories').then((r) => r.json()), fetch('/api/recommendations?room=' + S.code).then((r) => r.json())]);
        if (gen !== discoverGen) return;
        buildGenres(cat.genres);
        const shelf = (title, items) => h('div', { class: 'shelf' }, h('h4', null, title), h('div', { class: 'scroller' }, items.map((m) => movieCard(m, true))));
        body.replaceChildren(shelf('✨ Recommended for this room', rec.items), ...cat.rows.map((r) => shelf(r.title, r.items)));
      } else {
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        genres.forEach((g) => p.append('genre', g));
        if (rating) p.set('ratingMin', rating);
        if (len === 'short') p.set('durMax', 300);
        if (len === 'long') p.set('durMin', 540);
        if (sort) p.set('sort', sort);
        const res = await fetch('/api/movies?' + p).then((r) => r.json());
        if (gen !== discoverGen) return;
        buildGenres(res.genres);
        body.replaceChildren(res.items.length ? h('div', { class: 'list' }, res.items.map((m) => movieCard(m, false))) : h('p', { class: 'muted' }, 'No matches. Try fewer filters or a different spelling.'));
      }
    } catch (e) { body.replaceChildren(h('p', { class: 'error' }, 'Could not load movies.')); }
  }
  function renderMovieActions() { document.querySelectorAll('.playm').forEach((b) => { b.disabled = !canControl(); }); }
  const urlOf = () => { const u = $('urlInput').value.trim(); if (!/^https?:\/\//i.test(u)) { toast('Enter a full http(s) video URL', true); return null; } return u; };
  // YouTube search (needs YOUTUBE_API_KEY on the server; without it only links and catalog titles are available)
  const decode = (t) => new DOMParser().parseFromString(t, 'text/html').documentElement.textContent;
  $('ytForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('ytQ').value.trim();
    if (!q) return $('ytResults').replaceChildren();
    const r = await fetch('/api/youtube/search?q=' + encodeURIComponent(q)).then((x) => x.json()).catch(() => null);
    if (!r || !r.enabled) { $('ytResults').replaceChildren(h('p', { class: 'muted small' }, 'YouTube search is not configured on this server (set YOUTUBE_API_KEY). Paste a YouTube link below instead.')); return; }
    if (r.error) { $('ytResults').replaceChildren(h('p', { class: 'error' }, r.error)); return; }
    $('ytResults').replaceChildren(...r.items.map((it) => {
      const url = 'https://www.youtube.com/watch?v=' + it.ytId, title = decode(it.title);
      return h('div', { class: 'movie' }, h('img', { class: 'thumb', src: 'https://i.ytimg.com/vi/' + it.ytId + '/mqdefault.jpg', alt: '', loading: 'lazy' }),
        h('div', null, h('h5', null, title), h('div', { class: 'meta' }, decode(it.channel)),
          h('div', { class: 'acts' }, h('button', { class: 'playm', disabled: !canControl(), onclick: () => send({ t: 'setVideo', url, title }) }, '▶ Play'),
            h('button', { onclick: () => send({ t: 'queue.add', url, title }) }, '＋ Queue'))));
    }));
  };
  $('urlPlay').onclick = () => { const u = urlOf(); if (u) send({ t: 'setVideo', url: u }); };
  $('urlQueue').onclick = () => { const u = urlOf(); if (u) send({ t: 'queue.add', url: u }); };

  // ================= queue =================
  function renderQueue() {
    const open = S.queue.length;
    $('queueBadge').textContent = open; $('queueBadge').classList.toggle('hidden', !open);
    const body = $('queueBody');
    if (!open) return body.replaceChildren(h('p', { class: 'muted' }, 'The queue is empty. Add titles from Discover — the next one starts automatically when the current video ends.'));
    body.replaceChildren(
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('span', { class: 'muted small' }, 'Sorted by votes · auto-plays next'),
        h('button', { class: 'primary', disabled: !canControl(), onclick: () => send({ t: 'queue.play' }) }, '⏭ Play next')),
      h('div', { class: 'list' }, S.queue.map((it, i) => h('div', { class: 'qitem' + (it.pinned ? ' pinned' : '') },
        h('div', { class: 'poster', style: posterStyle(it.video) }, it.video.emoji),
        h('div', null, h('b', null, (i === 0 ? '⏭ ' : '') + it.video.title), h('div', { class: 'muted small' }, `added by ${nameOf(it.addedBy)}${it.pinned ? ' · poll winner' : ''}`)),
        h('div', { class: 'row' },
          h('button', { class: it.voters.includes(S.you) ? 'on' : '', style: it.voters.includes(S.you) ? 'border-color:var(--accent)' : '', title: 'Vote up', onclick: () => send({ t: 'queue.vote', id: it.id }) }, '👍 ' + it.voters.length),
          h('button', { disabled: !canControl(), title: 'Play now', onclick: () => send({ t: 'queue.play', id: it.id }) }, '▶'),
          (it.addedBy === S.you || isHost()) ? h('button', { title: 'Remove', onclick: () => send({ t: 'queue.remove', id: it.id }) }, '✕') : null)))));
  }

  // ================= polls =================
  $('addOpt').onclick = () => { if ($('pollOpts').children.length < 6) $('pollOpts').append(h('input', { class: 'pollOpt', maxlength: 60, placeholder: 'Option ' + ($('pollOpts').children.length + 1) })); };
  $('pollForm').onsubmit = (e) => {
    e.preventDefault();
    const options = [...document.querySelectorAll('.pollOpt')].map((i) => i.value.trim()).filter(Boolean);
    if (!$('pollQ').value.trim() || options.length < 2) return toast('Add a question and at least two options', true);
    if (send({ t: 'poll.create', question: $('pollQ').value, options, durationSec: Number($('pollDur').value) })) {
      $('pollQ').value = ''; document.querySelectorAll('.pollOpt').forEach((i) => { i.value = ''; });
    }
  };
  function renderPolls() {
    const openUnvoted = S.polls.filter((p) => !p.closed && !p.options.some((o) => o.voters.includes(S.you))).length;
    $('pollBadge').textContent = openUnvoted; $('pollBadge').classList.toggle('hidden', !openUnvoted);
    const list = $('pollList');
    list.replaceChildren(...[...S.polls].reverse().map((p) => {
      const total = p.options.reduce((s, o) => s + o.voters.length, 0);
      return h('div', { class: 'poll' },
        h('h5', null, p.question),
        p.options.map((o) => h('button', { class: 'opt' + (o.voters.includes(S.you) ? ' mine' : '') + (p.winner === o.id ? ' win' : ''), disabled: p.closed,
          title: o.voters.map(nameOf).join(', ') || 'No votes yet', onclick: () => send({ t: 'poll.vote', id: p.id, option: o.id }) },
          h('div', { class: 'bar', style: `width:${total ? (o.voters.length / total) * 100 : 0}%` }),
          h('span', null, (o.emoji ? o.emoji + ' ' : '') + o.text), h('span', null, o.voters.length))),
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('span', { class: 'muted small', ...(p.closed || !p.closesAt ? {} : { 'data-closes': p.closesAt }) }, p.closed ? 'closed' : p.closesAt ? '' : `by ${nameOf(p.createdBy)}`),
          !p.closed && (p.createdBy === S.you || isHost()) ? h('button', { onclick: () => send({ t: 'poll.close', id: p.id }) }, 'Close poll') : null));
    }));
    if (!S.polls.length) list.replaceChildren(h('p', { class: 'muted' }, 'No polls yet. Ask the room anything, or pick titles in Discover and start a “what next?” poll.'));
  }

  // ================= people =================
  function renderPeople() {
    const body = $('peopleBody');
    const sorted = [...S.members].sort((a, b) => (b.id === S.hostId) - (a.id === S.hostId) || a.joinedAt - b.joinedAt);
    const rows = sorted.map((m) => {
      const hl = S.health[m.id] || m;
      const d = hl.drift == null ? null : Math.abs(hl.drift);
      const cls = d == null ? '' : d < 100 ? 'good' : d < 300 ? 'warn' : 'bad';
      return h('div', { class: 'person' },
        h('span', { class: 'avatar', style: `background:${hue(m.hue)}` }, m.name[0].toUpperCase()),
        h('div', { class: 'grow' }, h('b', null, m.name + (m.id === S.you ? ' (you)' : '') + (m.id === S.hostId ? ' 👑' : '')),
          h('span', { class: 'muted small' }, m.connected ? (hl.buffering ? 'buffering…' : 'connected') : 'reconnecting…'),
          d != null && m.connected ? h('span', { class: 'small drift ' + cls }, ` · ±${d} ms${hl.rtt != null ? ` · ${hl.rtt} ms RTT` : ''}`) : null),
        isHost() && m.id !== S.you ? [
          m.connected ? h('button', { onclick: () => send({ t: 'host.transfer', to: m.id }), title: 'Make host' }, '👑') : null,
          h('button', { onclick: () => { if (confirm('Remove ' + m.name + '?')) send({ t: 'host.kick', to: m.id }); }, title: 'Remove' }, '✕')] : null);
    });
    body.replaceChildren(
      h('div', { class: 'list' }, rows),
      h('label', { class: 'row', style: 'margin-top:12px' },
        h('input', { type: 'checkbox', style: 'flex:none', ...(S.controlMode === 'host' ? { checked: true } : {}), ...(isHost() ? {} : { disabled: true }), onchange: (e) => send({ t: 'settings', controlMode: e.target.checked ? 'host' : 'everyone' }) }),
        h('span', null, 'Only the host controls playback')),
      h('p', { class: 'muted small' }, 'Drift = how far each person is from the shared clock, measured every 2 s. Players self-correct above 40 ms (speed nudges) and seek above 350 ms.'));
  }

  function renderAll() {
    renderControls(); renderNowPlaying(); renderPeople(); renderQueue(); renderPolls(); renderPicks(); renderBadge(); renderVolume();
    $('emptyState').classList.toggle('hidden', !!S.video);
    drawHeat();
    if ($('tab-discover').classList.contains('active')) loadDiscover();
  }

  // Resume after a page reload within the same tab.
  const resume = store.get('wp_room', sessionStorage);
  if (resume && store.get('wp_name') && (!params.get('room') || params.get('room').toUpperCase() === resume)) enterRoom(resume);
  else if (params.get('room') && store.get('wp_name')) $('codeInput').value = params.get('room').toUpperCase();
  window.__wp = { S, enforce }; // handy for debugging in devtools
})();
