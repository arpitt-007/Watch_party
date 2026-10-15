'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const nowMs = () => performance.timeOrigin + performance.now();
  const EMOJIS = ['😂', '😮', '😢', '❤️', '👏', '🔥', '😱', '🎉'];
  const BIN_SECONDS = 5;
  // Where the API and WebSocket live: the page's own origin by default, or WP_CONFIG.backend (set at deploy time) when the
  // page is hosted separately from the real-time server (e.g. static site on Vercel, Node server on Render).
  const BACKEND = String((window.WP_CONFIG && window.WP_CONFIG.backend) || '').replace(/\/+$/, '');
  const apiUrl = (p) => BACKEND + p;
  const wsUrl = () => (BACKEND ? BACKEND.replace(/^http/, 'ws') : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host) + '/ws';
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const icon = (name, size) => Icons.el(name, size);

  // XSS-safe element builder: text always goes through text nodes / textContent.
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
  const hue = (n) => `hsl(${n} 70% 66%)`;
  const posterStyle = (m) => `${m.thumb ? `background-image:url('${m.thumb}'),` : 'background-image:'}linear-gradient(135deg,hsl(${m.hue} 55% 38%),hsl(${(m.hue + 40) % 360} 60% 18%))`;
  const fmtViews = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
  const initial = (name) => ((name || '?').trim()[0] || '?').toUpperCase();
  const avatar = (m, cls) => h('span', { class: 'avatar' + (cls ? ' ' + cls : ''), style: `background:${hue(m.hue)}`, title: m.name }, initial(m.name));
  function swapIcon(btn, name, size) { const old = btn.querySelector('svg.icon'); const n = icon(name, size || Number(old && old.getAttribute('width')) || 20); if (old) old.replaceWith(n); else btn.prepend(n); }

  const store = {
    get: (k, area = localStorage) => { try { return area.getItem(k); } catch (e) { return null; } },
    set: (k, v, area = localStorage) => { try { area.setItem(k, v); } catch (e) { /* private mode */ } },
    del: (k, area = sessionStorage) => { try { area.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const S = {
    ws: null, code: null, you: null, name: '', hostId: null, controlMode: 'everyone', members: [], health: {},
    video: null, pb: null, clock: new SyncCore.ClockSync(), lastSeekAt: -1e9, needsSeek: false,
    retry: 0, leaving: false, bins: {}, drift: 0, buffering: false, dragging: false, connected: false, everConnected: false,
    queue: [], polls: [], picks: [], chat: [], filters: { genres: new Set() }, startTimer: null, timers: [],
    vol: Number(store.get('wp_vol')) >= 0 && store.get('wp_vol') !== null ? Number(store.get('wp_vol')) : 1, muted: store.get('wp_muted') === '1',
    inRoom: false, abort: null, lastAct: null, lastSeek: null, lastChat: null, unread: 0, lastMsg: null,
    ui: { sidebar: true, theater: false, sideBeforeTheater: true, tab: 'chat' },
  };
  const v = $('video');
  const serverNow = () => S.clock.serverNow(nowMs());
  const isHost = () => S.hostId === S.you;
  const canControl = () => S.controlMode === 'everyone' || isHost();
  const memberById = (id) => S.members.find((m) => m.id === id);
  const nameOf = (id) => (memberById(id) || {}).name || 'Someone';

  // ================= feedback: toasts, OSD, copy, confirm =================
  function toast(text, kind) {
    const wrap = $('toasts');
    for (const t of wrap.children) if (t.dataset.text === text) return; // no stacked duplicates (e.g. key repeat)
    const ic = { good: 'check', bad: 'alert', warn: 'alert' }[kind] || 'zap';
    const t = h('div', { class: 'toast ' + (kind === 'bad' || kind === 'warn' ? 'bad' : kind || ''), 'data-text': text }, icon(ic, 16), h('span', null, text));
    wrap.append(t);
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 220); }, 3200);
  }
  let osdTimer;
  function osd(ic, text) {
    $('osdIcon').replaceChildren(icon(ic, 22)); $('osdText').textContent = text;
    const o = $('osd'); o.classList.add('show');
    clearTimeout(osdTimer); osdTimer = setTimeout(() => o.classList.remove('show'), 850);
  }
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through to the legacy path */ }
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0;left:-999px' }, text);
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  const inviteLink = () => location.origin + '/?room=' + S.code;
  async function copyInvite() {
    const ok = await copyText(inviteLink());
    if (ok) {
      toast('Invite link copied', 'good');
      const b = $('codeBtn'); b.classList.add('copied');
      const mark = (name) => { const old = b.querySelector('.copy-ic'); const n = icon(name, 15); n.classList.add('copy-ic'); old.replaceWith(n); };
      mark('check');
      setTimeout(() => { b.classList.remove('copied'); mark('copy'); }, 1500);
    } else toast('Could not copy. Link: ' + inviteLink(), 'bad');
  }
  async function shareInvite() {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Watch Party', text: `Join my watch party (room ${S.code})`, url: inviteLink() }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    copyInvite();
  }
  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const d = $('confirmDialog');
      $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirmOk').textContent = okLabel || 'Confirm';
      d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
      d.showModal();
    });
  }
  const send = (o) => { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(o)); return true; } toast('Not connected. Reconnecting…', 'bad'); return false; };

  // ================= landing =================
  const params = new URLSearchParams(location.search);
  $('nameInput').value = store.get('wp_name') || '';
  $('codeInput').value = (params.get('room') || '').toUpperCase();
  const landingError = (msg, focusId) => { $('landingError').textContent = msg || ''; if (msg && focusId) $(focusId).focus(); };
  let joining = false;

  async function enterRoom(code) {
    if (joining) return;
    const name = $('nameInput').value.trim();
    if (!name) return landingError('Please enter your name first.', 'nameInput');
    joining = true; $('createBtn').disabled = true; $('joinBtn').disabled = true;
    try {
      store.set('wp_name', name);
      landingError('');
      const r = await fetch(apiUrl('/api/rooms/' + encodeURIComponent(code))).catch(() => null);
      if (!r || !r.ok) return landingError(r ? 'Room not found. Check the code and try again.' : 'Could not reach the server.', 'codeInput');
      S.code = (await r.json()).code; S.name = name; S.leaving = false;
      let id = store.get('wp_cid', sessionStorage);
      if (!id) { id = 'c' + rid() + rid(); store.set('wp_cid', id, sessionStorage); }
      S.you = id;
      store.set('wp_room', S.code, sessionStorage);
      history.replaceState(null, '', '?room=' + S.code);
      document.body.classList.add('in-room');
      $('landing').classList.add('hidden'); $('roomView').classList.remove('hidden');
      $('roomCode').textContent = S.code;
      startSession();
      connect();
    } finally { joining = false; $('createBtn').disabled = false; $('joinBtn').disabled = false; }
  }
  $('createBtn').onclick = async () => {
    if (!$('nameInput').value.trim()) return landingError('Please enter your name first.', 'nameInput');
    $('createBtn').disabled = true;
    const r = await fetch(apiUrl('/api/rooms'), { method: 'POST' }).catch(() => null);
    $('createBtn').disabled = false;
    if (!r || !r.ok) return landingError('Could not create a room. Is the server running?');
    enterRoom((await r.json()).code);
  };
  $('joinForm').onsubmit = (e) => { e.preventDefault(); const c = $('codeInput').value.replace(/[^A-Za-z0-9]/g, ''); if (!c) return landingError('Enter the room code.', 'codeInput'); enterRoom(c); };
  $('codeInput').addEventListener('input', () => landingError(''));
  $('nameInput').addEventListener('input', () => landingError(''));
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ($('codeInput').value.trim() ? $('joinBtn') : $('createBtn')).click(); } });
  $('leaveBtn').onclick = () => leave();
  $('codeBtn').onclick = copyInvite;
  $('shareBtn').onclick = shareInvite;

  // A separately hosted free-tier server may be asleep: wake it as soon as the page opens, and say so if it is slow.
  (function warmBackend() {
    if (!BACKEND) return;
    const note = $('landingNote');
    const slow = setTimeout(() => { note.textContent = 'Waking up the server… this can take up to a minute the first time.'; }, 1500);
    fetch(apiUrl('/healthz'), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('bad status'); note.textContent = ''; })
      .catch(() => { note.textContent = 'The server is not responding yet. Try again in a moment.'; })
      .finally(() => clearTimeout(slow));
  })();

  // Real catalog thumbnails as the hero art (no invented content).
  (async function posterWall() {
    const wall = $('posterWall');
    wall.classList.add('skeleton-wall');
    wall.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'p' })));
    try {
      const { rows } = await fetch(apiUrl('/api/categories')).then((r) => r.json());
      const items = (rows[0] ? rows[0].items : []).filter((m) => m.thumb).slice(0, 6);
      if (!items.length) throw new Error('empty');
      wall.classList.remove('skeleton-wall');
      wall.replaceChildren(...items.map((m, i) => h('div', { class: 'p', style: `background-image:url('${m.thumb}');animation-delay:${i * 70}ms` })));
    } catch (e) { $('posterWall').closest('.hero-art').classList.add('hidden'); }
  })();

  function leave(msg) {
    S.leaving = true;
    endSession();
    S.timers.forEach(clearInterval); S.timers = [];
    if (S.ws) { try { S.ws.close(); } catch (e) { /* already closed */ } }
    html5.clear(); yt.clear();
    S.video = null; S.pb = null; S.members = []; S.queue = []; S.polls = []; S.chat = []; S.bins = {}; S.picks = []; S.connected = false; S.everConnected = false; S.unread = 0; S.lastMsg = null;
    setPseudoFs(false); setTheater(false); setSidebar(true);
    store.del('wp_room');
    history.replaceState(null, '', location.pathname);
    document.body.classList.remove('in-room');
    $('roomView').classList.add('hidden'); $('landing').classList.remove('hidden');
    $('chatLog').replaceChildren(); $('banner').classList.add('hidden'); $('player').classList.remove('has-video');
    landingError(msg || '');
    $('codeInput').value = '';
    renderNowPlaying();
  }

  // ================= connection =================
  function connect() {
    clearTimeout(S.reconnectTimer);
    const ws = new WebSocket(wsUrl());
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
      if (ev.code === 4000) { showBanner('This room is open in another tab, so this tab is now inactive.', true); P.pause(); return; }
      showBanner('Connection lost. Reconnecting…');
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
      case 'playlist': S.queue = m.items; renderQueue(); renderEnded(); break;
      case 'polls': S.polls = m.polls; renderPolls(); break;
      case 'error': toast(m.msg || 'Something went wrong', 'bad'); break;
      case 'kicked': break;
    }
  }

  function onWelcome(m) {
    const restored = S.everConnected;
    S.connected = true; S.everConnected = true; S.retry = 0;
    $('banner').classList.add('hidden');
    if (restored) toast('Connection restored', 'good');
    if (!S.clock.ready) S.clock.offset = m.serverNow - nowMs();
    S.hostId = m.hostId; S.controlMode = m.controlMode; S.members = m.members; S.queue = m.playlist; S.polls = m.polls; S.bins = m.bins || {};
    $('chatLog').replaceChildren(); S.chat = []; S.lastMsg = null; S.unread = 0;
    m.chat.forEach((msg) => addChat(msg, true));
    renderChatEmpty(); scrollChat(true);
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
    if (m.why === 'seek' || m.why === 'video' || m.why === 'play') S.lastSeekAt = -1e9;
    enforce();
    renderControls();
    if (m.why === 'play' || m.why === 'pause' || m.why === 'seek') {
      const who = m.from && m.from !== S.you ? m.by + ' ' : '';
      if (m.why === 'play') osd('play', who ? who + 'resumed' : 'Play');
      else if (m.why === 'pause') osd('pause', who ? who + 'paused' : 'Paused');
      else osd('skip', (who ? who + 'jumped to ' : 'Seek to ') + fmt(m.pb.pos));
    }
  }

  // ================= players =================
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
    // It also exposes no reliable caption toggle or picture-in-picture, so those shortcuts are intentionally absent.
    constructor() {
      this.p = null; this.apiReady = false; this.id = null; this.created = null; this.gen = 0; this.inflight = null;
      this.cfg = { softThreshold: Infinity, softRelease: Infinity, hardThreshold: 0.45, seekCooldownMs: 2500 };
    }
    show(on) { $('ytWrap').classList.toggle('hidden', !on); }
    async load(video) {
      this.show(true); this.id = video.ytId; const gen = ++this.gen;
      try { await ytApi(); } catch (e) { showVideoError('Could not load the YouTube player (blocked or offline).'); return; }
      if (gen !== this.gen) return;
      if (this.p) { if (this.apiReady) this.p.cueVideoById(this.id); return; } // else onReady cues this.id
      const host = h('div');
      $('ytHost').replaceChildren(host);
      this.created = this.id;
      this.p = new window.YT.Player(host, {
        width: '100%', height: '100%', videoId: this.id,
        playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => { this.apiReady = true; applyVolume(); if (this.id !== this.created) this.p.cueVideoById(this.id); setTimeout(enforce, 0); },
          onStateChange: (e) => { if (e.data === 0) onVideoEnded(); if (e.data === 1) { hideSpinner(); $('tapOverlay').classList.add('hidden'); scheduleIdle(); } setTimeout(enforce, 0); },
          onError: (e) => {
            hideSpinner();
            if ([2, 100, 101, 150].includes(e.data) && S.video) { send({ t: 'unplayable', token: S.video.token, code: e.data }); setTimeout(loadDiscover, 700); }
            showVideoError([101, 150].includes(e.data) ? 'The owner of this YouTube video disabled embedding.' : 'This YouTube video is unavailable.');
          },
        },
      });
    }
    clear() { this.gen++; this.show(false); if (this.apiReady) { try { this.p.stopVideo(); } catch (e) { /* player not attached */ } } }
    // getPlayerState() is polled rather than cached: a player created with a videoId never fires a 'cued' event.
    get state() { try { return this.apiReady ? this.p.getPlayerState() : -1; } catch (e) { return -1; } }
    ready() { return this.apiReady; }
    time() { try { return this.p.getCurrentTime() || 0; } catch (e) { return 0; } }
    // After cueVideoById() the player keeps answering with the PREVIOUS video's length until the new one has loaded, so only
    // trust getDuration() once the player says it is on the video we asked for (otherwise the room learns a wrong length).
    onCurrentVideo() { try { return this.p.getVideoData().video_id === this.id; } catch (e) { return false; } }
    dur() { try { if (!this.onCurrentVideo()) return null; const d = this.p.getDuration(); return d > 0 ? d : null; } catch (e) { return null; } }
    paused() { const s = this.state; return s !== 1 && s !== 3; }
    buffering() { const s = this.state; return s === 3 || s === -1 || s === 5; }
    ended() { return this.state === 0; }
    rate() { return 1; }
    setRate() { /* unsupported at fine granularity */ }
    seek(t) { try { this.p.seekTo(Math.max(0, t), true); } catch (e) { /* player not attached */ } }
    play() {
      if (this.inflight) return this.inflight;
      try { this.p.playVideo(); } catch (e) { /* player not attached */ }
      // playVideo() gives no error when autoplay is refused; detect it by the player not starting.
      this.inflight = new Promise((res, rej) => setTimeout(() => { this.inflight = null; if (this.state === 1 || this.state === 3) res(); else rej({ name: 'NotAllowedError' }); }, 1500));
      return this.inflight;
    }
    pause() { try { this.p.pauseVideo(); } catch (e) { /* player not attached */ } }
    setVolume(x) { if (this.apiReady) this.p.setVolume(Math.round(x * 100)); }
    setMuted(b) { if (this.apiReady) { if (b) this.p.mute(); else this.p.unMute(); } }
  }

  const html5 = new Html5Player(v);
  const yt = new YTPlayer();
  let P = html5;
  function applyVolume() { P.setVolume(S.vol); P.setMuted(S.muted); }
  const hideSpinner = () => $('spinner').classList.add('hidden');
  function showVideoError(text) { $('errorText').textContent = text; $('errorOverlay').classList.remove('hidden'); toast(text, 'bad'); }

  function loadVideo(video, keepBins) {
    S.video = video; if (!keepBins) S.bins = {};
    S.needsSeek = true; S.buffering = false; S.drift = 0; S.playingSince = null;
    $('emptyState').classList.toggle('hidden', !!video);
    $('player').classList.toggle('has-video', !!video);
    $('tapOverlay').classList.add('hidden'); $('errorOverlay').classList.add('hidden');
    if (!video) { html5.clear(); yt.clear(); renderNowPlaying(); renderControls(); return; }
    const next = video.source === 'youtube' ? yt : html5;
    if (next !== P) P.clear();
    P = next;
    P.load(video);
    applyVolume();
    $('spinner').classList.remove('hidden');
    renderNowPlaying(); drawHeat(); showControls();
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
      $('tapOverlay').classList.add('hidden'); // nothing to join while the room is paused
      if (!P.paused()) P.pause();
      if (!P.buffering() && Math.abs(P.time() - exp) > (P === yt ? 0.3 : 0.05)) P.seek(exp);
      if (P.rate() !== 1) P.setRate(1);
      S.drift = 0; S.buffering = false;
      return;
    }
    if (P.ended() && exp >= (dur || Infinity) - 0.5) return; // really at the end; a replay (exp near 0) must continue below
    if (P.paused()) tryPlay();
    if (P.buffering()) { S.buffering = true; return; }
    S.buffering = false;
    S.drift = P.time() - exp;
    const d = SyncCore.decide({ drift: S.drift, currentRate: P.rate(), sinceSeekMs: performance.now() - S.lastSeekAt, cfg: { ...SyncCore.CFG, ...P.cfg } });
    if (d.action === 'seek') { P.seek(P.time() + d.delta); S.lastSeekAt = performance.now(); }
    if (Math.abs(P.rate() - d.rate) > 0.001) P.setRate(d.rate);
  }

  v.addEventListener('loadedmetadata', () => { enforce(); drawHeat(); renderControls(); });
  v.addEventListener('canplay', () => { hideSpinner(); enforce(); });
  v.addEventListener('waiting', () => $('spinner').classList.remove('hidden'));
  v.addEventListener('playing', () => { hideSpinner(); $('tapOverlay').classList.add('hidden'); scheduleIdle(); });
  v.addEventListener('seeked', hideSpinner);
  v.addEventListener('ended', onVideoEnded);
  v.addEventListener('error', () => { if (S.video && P === html5) { hideSpinner(); showVideoError('This video failed to load. Is the source reachable?'); } });
  // Someone pressing a hardware media key must not desync us from the room.
  v.addEventListener('pause', () => { if (S.pb && S.pb.playing && !v.ended && !v.seeking) setTimeout(enforce, 50); });
  v.addEventListener('play', () => { if (S.pb && !S.pb.playing) setTimeout(enforce, 0); });

  // ================= playback actions (shared by buttons, progress bar and keyboard shortcuts) =================
  const act = (a, extra) => send({ t: 'control', action: a, aid: rid(), ...extra });
  const curPos = () => (S.pb ? SyncCore.expectedPosition(S.pb, serverNow(), P.dur()) : 0);

  function guardControl() {
    if (!S.video || !S.pb) { toast('Nothing is playing yet. Pick something in Discover.', 'warn'); return false; }
    if (!canControl()) { toast('Only the host can control playback in this room.', 'warn'); return false; }
    if (!P.ready()) { toast('The player is still loading. Try again in a moment.', 'warn'); return false; }
    return true;
  }
  function togglePlay() {
    if (!guardControl()) return;
    const want = S.pb.playing ? 'pause' : 'play';
    if (S.lastAct && S.lastAct.a === want && Date.now() - S.lastAct.t < 250) return; // swallow accidental double events
    S.lastAct = { a: want, t: Date.now() };
    act(want);
  }
  function seekBy(sec) {
    if (!guardControl()) return;
    const base = S.lastSeek && Date.now() - S.lastSeek.t < 600 ? S.lastSeek.pos : curPos(); // rapid presses accumulate
    const target = clamp(base + sec, 0, P.dur() || Infinity);
    S.lastSeek = { pos: target, t: Date.now() };
    act('seek', { position: target });
  }
  function seekTo(pos) {
    if (!guardControl()) return;
    S.lastSeek = { pos, t: Date.now() };
    act('seek', { position: pos });
  }
  function setVolume(x, announce = true) {
    S.vol = clamp(Math.round(x * 100) / 100, 0, 1);
    S.muted = S.vol === 0;
    applyVolume(); renderVolume(); store.set('wp_vol', String(S.vol)); store.set('wp_muted', S.muted ? '1' : '0');
    if (announce) osd(S.vol === 0 ? 'volume-x' : S.vol < 0.5 ? 'volume-1' : 'volume-2', 'Volume ' + Math.round(S.vol * 100) + '%');
  }
  function toggleMute() {
    S.muted = !S.muted;
    if (!S.muted && S.vol === 0) S.vol = 0.5;
    applyVolume(); renderVolume(); store.set('wp_vol', String(S.vol)); store.set('wp_muted', S.muted ? '1' : '0');
    osd(S.muted ? 'volume-x' : 'volume-2', S.muted ? 'Muted' : 'Volume ' + Math.round(S.vol * 100) + '%');
  }
  // Fullscreen: the real Fullscreen API where the browser offers it for page elements; otherwise (iPhone Safari, embedded
  // webviews, or when the browser refuses) a "pseudo" fullscreen where the player simply fills the whole screen.
  const isFullscreen = () => !!document.fullscreenElement || S.ui.pseudoFs;
  function setPseudoFs(on) {
    if (on === !!S.ui.pseudoFs) return;
    S.ui.pseudoFs = on;
    $('player').classList.toggle('pseudo-fs', on);
    document.body.classList.toggle('pseudo-fs-on', on);
    if (on && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => { /* only allowed in real fullscreen / installed apps */ });
    if (!on && screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    renderFullscreen(); showControls();
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (S.ui.pseudoFs) { setPseudoFs(false); return; }
    if (!document.fullscreenEnabled) { setPseudoFs(true); return; }
    $('player').requestFullscreen().catch(() => setPseudoFs(true)); // refused (permissions, iframe policy...): fall back
  }
  function renderFullscreen() {
    const on = isFullscreen();
    swapIcon($('fsBtn'), on ? 'minimize' : 'maximize', 20);
    $('fsBtn').setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen'); $('fsBtn').dataset.tip = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
    drawHeat();
  }
  function setTheater(on) {
    if (on === S.ui.theater) return;
    S.ui.theater = on;
    if (on) { S.ui.sideBeforeTheater = S.ui.sidebar; setSidebar(false); } else setSidebar(S.ui.sideBeforeTheater);
    document.body.classList.toggle('theater', on);
    $('theaterBtn').setAttribute('aria-pressed', String(on));
    $('theaterBtn').dataset.tip = on ? 'Exit theater mode (T)' : 'Theater mode (T)';
    drawHeat();
  }
  function setSidebar(open) {
    S.ui.sidebar = open;
    $('layout').classList.toggle('side-closed', !open);
    const b = $('panelBtn');
    b.setAttribute('aria-expanded', String(open)); b.setAttribute('aria-label', open ? 'Hide side panel' : 'Show side panel'); b.dataset.tip = open ? 'Hide side panel' : 'Show side panel';
    if (open && S.ui.tab === 'chat') { clearUnread(); scrollChat(true); }
    requestAnimationFrame(drawHeat);
  }

  // ----- control bar wiring -----
  const noFocusSteal = (e) => e.preventDefault(); // clicking a control must not leave focus on it (Space would then re-trigger it)
  ['playBtn', 'back10', 'fwd10', 'muteBtn', 'theaterBtn', 'fsBtn'].forEach((id) => $(id).addEventListener('mousedown', noFocusSteal));
  $('playBtn').onclick = togglePlay;
  $('replayBtn').onclick = togglePlay; // the server turns "play" on an ended video into a restart from 0
  $('nextBtn').onclick = () => send({ t: 'queue.play' });
  $('back10').onclick = () => seekBy(-10);
  $('fwd10').onclick = () => seekBy(10);
  $('muteBtn').onclick = toggleMute;
  $('volume').addEventListener('input', () => setVolume(Number($('volume').value), false));
  $('theaterBtn').onclick = () => setTheater(!S.ui.theater);
  $('fsBtn').onclick = toggleFullscreen;
  $('panelBtn').onclick = () => setSidebar(!S.ui.sidebar);
  $('kbdBtn').onclick = () => toggleHelp();
  $('emptyBrowse').onclick = () => { openSidebar(); selectTab('discover', true); };

  // Click / tap on the video itself.
  //  mouse: click toggles play.
  //  touch: pointerdown reveals the controls *before* the click fires, so remember whether they were hidden at that moment:
  //         the first tap only reveals them; a later tap toggles play after a short delay so that a double-tap (seek) never
  //         also pauses/resumes the video.
  let lastPointer = 'mouse', idleAtDown = false, tapTimer = null;
  $('player').addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; idleAtDown = $('player').classList.contains('idle'); }, { capture: true, passive: true });
  $('player').addEventListener('click', (e) => {
    if (e.target !== $('player') && e.target !== v && e.target !== $('ytWrap')) return;
    if (lastPointer === 'touch') {
      if (idleAtDown) { idleAtDown = false; showControls(); return; }
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; return; } // 2nd tap of a double-tap: the dblclick handler takes over
      tapTimer = setTimeout(() => { tapTimer = null; if (S.video) togglePlay(); }, 260);
      return;
    }
    if ($('player').classList.contains('idle')) { showControls(); return; }
    if (S.video) togglePlay();
  });
  $('player').addEventListener('dblclick', (e) => {
    if (e.target !== $('player') && e.target !== v && e.target !== $('ytWrap')) return;
    if (lastPointer === 'touch' && S.video) { // double-tap: left third back 10 s, right third forward 10 s, middle fullscreen
      const r = $('player').getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
      if (x < 0.33) return seekBy(-10);
      if (x > 0.67) return seekBy(10);
    }
    toggleFullscreen();
  });
  // Controls (including the progress bar) dissolve a few seconds after playback starts and whenever the pointer is idle;
  // any mouse/touch/keyboard activity brings them back, and they stay up while paused or while the pointer is on them.
  const IDLE_MS = 3000;
  let idleT = null;
  const wantsIdle = () => !!(S.pb && S.pb.playing && S.video);
  function armIdle(ms = IDLE_MS) {
    clearTimeout(idleT);
    idleT = setTimeout(() => {
      idleT = null;
      // :hover is sticky on touch screens (it stays after a tap), so it only blocks the fade for a real mouse
      const mouseOverControls = lastPointer !== 'touch' && matchMedia('(hover: hover)').matches && $('controls').matches(':hover');
      if (mouseOverControls || document.querySelector('dialog[open]')) { armIdle(); return; }
      if (!wantsIdle()) return;
      // Count from when the video really started playing (S.playingSince, set in uiTick), not from when it was requested.
      const playingFor = S.playingSince ? performance.now() - S.playingSince : 0;
      if (!S.playingSince || playingFor < IDLE_MS) { armIdle(S.playingSince ? IDLE_MS - playingFor + 20 : 400); return; }
      $('player').classList.add('idle');
    }, ms);
  }
  // Real user activity: show the controls and restart the countdown (paused / nothing playing: stay visible).
  function showControls() {
    $('player').classList.remove('idle'); clearTimeout(idleT); idleT = null;
    if (wantsIdle()) armIdle();
  }
  // Player/state events must not keep resetting the countdown or un-hide the controls: they only start one if none is running.
  function scheduleIdle() {
    if (!wantsIdle()) { showControls(); return; }
    if (idleT === null && !$('player').classList.contains('idle')) armIdle();
  }
  ['mousemove', 'pointerdown', 'touchstart', 'focusin'].forEach((ev) => $('player').addEventListener(ev, showControls, { passive: true }));
  document.addEventListener('keydown', (e) => { if (S.inRoom && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) showControls(); }, true);
  $('player').addEventListener('pointerup', () => { if (document.activeElement === prog) prog.blur(); }); // a clicked seek bar must not pin the controls open

  // ----- progress / seek slider (role="slider": keyboard handled by the shortcut manager, pointer handled here) -----
  const prog = $('progress');
  const pctAt = (e) => { const r = prog.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  function setProgressVisual(pct, text) {
    $('played').style.width = pct * 100 + '%'; $('thumb').style.left = pct * 100 + '%';
    if (text) $('time').textContent = text;
  }
  function tipAt(e) {
    const d = P.dur(); if (!d) return;
    const pct = pctAt(e), tip = $('seekTip');
    tip.textContent = fmt(pct * d); tip.style.left = clamp(pct * prog.clientWidth, 24, prog.clientWidth - 24) + 'px'; tip.classList.remove('hidden');
  }
  prog.addEventListener('pointerenter', tipAt);
  prog.addEventListener('pointerleave', () => { if (!S.dragging) $('seekTip').classList.add('hidden'); });
  prog.addEventListener('pointerdown', (e) => {
    if (!P.dur()) return;
    if (!canControl()) { guardControl(); return; }
    prog.setPointerCapture(e.pointerId); S.dragging = true; prog.classList.add('drag');
    const pct = pctAt(e); setProgressVisual(pct, fmt(pct * P.dur()) + ' / ' + fmt(P.dur())); tipAt(e);
  });
  prog.addEventListener('pointermove', (e) => {
    tipAt(e);
    if (S.dragging) { const pct = pctAt(e); setProgressVisual(pct, fmt(pct * P.dur()) + ' / ' + fmt(P.dur())); }
  });
  const endDrag = (e, commit) => {
    if (!S.dragging) return;
    S.dragging = false; prog.classList.remove('drag'); $('seekTip').classList.add('hidden');
    if (commit && P.dur()) seekTo(pctAt(e) * P.dur());
  };
  prog.addEventListener('pointerup', (e) => endDrag(e, true));
  prog.addEventListener('pointercancel', (e) => endDrag(e, false));

  function renderVolume() {
    const lvl = S.muted || S.vol === 0 ? 'volume-x' : S.vol < 0.5 ? 'volume-1' : 'volume-2';
    swapIcon($('muteBtn'), lvl, 20);
    $('muteBtn').setAttribute('aria-label', S.muted ? 'Unmute' : 'Mute'); $('muteBtn').dataset.tip = S.muted ? 'Unmute (M)' : 'Mute (M)';
    $('volume').value = S.muted ? 0 : S.vol;
    $('volume').setAttribute('aria-valuetext', S.muted ? 'Muted' : Math.round(S.vol * 100) + '%');
  }
  // "Ended": the room is paused at (or within 1.5 s of) the end of the video.
  const isEnded = () => !!(S.video && S.pb && !S.pb.playing && P.dur() && S.pb.pos >= P.dur() - 1.5);
  function renderEnded() {
    const ended = isEnded();
    if (S.endedShown !== ended) { S.endedShown = ended; renderControls(); } // refresh the Play/Replay button as soon as the state flips (the length may only become known later)
    $('replayOverlay').classList.toggle('hidden', !ended);
    $('nextBtn').classList.toggle('hidden', !(ended && S.queue.length && canControl()));
    $('replayBtn').disabled = !canControl();
    if (ended) $('tapOverlay').classList.add('hidden');
  }
  function renderControls() {
    const ok = canControl() && !!S.video;
    for (const id of ['back10', 'fwd10']) $(id).disabled = !ok;
    $('playBtn').disabled = !S.video || !canControl();
    prog.setAttribute('aria-disabled', String(!ok));
    $('lockNote').classList.toggle('hidden', canControl());
    const playing = !!(S.pb && S.pb.playing);
    scheduleIdle();
    const ended = isEnded();
    const label = playing ? 'Pause' : ended ? 'Replay' : 'Play';
    swapIcon($('playBtn'), playing ? 'pause' : ended ? 'rotate-ccw' : 'play', 22);
    $('playBtn').setAttribute('aria-label', label); $('playBtn').dataset.tip = label + ' (Space)';
    renderEnded();
    $('hostBadge').classList.toggle('hidden', !isHost());
    const online = S.members.filter((m) => m.connected).length;
    $('memberCount').textContent = online ? `${online} watching` : '';
    const stack = $('avatarStack');
    stack.replaceChildren(...S.members.filter((m) => m.connected).slice(0, 5).map((m) => avatar(m)));
  }
  function uiTick() {
    const d = P.dur();
    if (S.video && !S.dragging && d && P.ready()) {
      const t = isEnded() ? d : P.time(); // an ended player rewinds itself to 0; show the full bar instead
      setProgressVisual(clamp(t / d, 0, 1), fmt(t) + ' / ' + fmt(d));
      prog.setAttribute('aria-valuemax', String(Math.round(d))); prog.setAttribute('aria-valuenow', String(Math.round(t)));
      prog.setAttribute('aria-valuetext', fmt(t) + ' of ' + fmt(d));
    }
    const live = !!(S.video && S.pb && S.pb.playing && P.ready() && !P.paused() && !P.buffering());
    // A stall shorter than 1.2 s (YouTube flips to "buffering" briefly while playing) does not restart the countdown.
    if (live) { if (!S.playingSince) S.playingSince = performance.now(); S.notLiveSince = null; }
    else { if (!S.notLiveSince) S.notLiveSince = performance.now(); if (performance.now() - S.notLiveSince > 1200) S.playingSince = null; }
    renderBadge();
    if (S.video) renderEnded();
    document.querySelectorAll('[data-closes]').forEach((el) => {
      const left = Math.max(0, Math.ceil((Number(el.dataset.closes) - serverNow()) / 1000));
      el.textContent = left ? `closes in ${left}s` : 'closing…';
    });
  }
  function renderBadge() {
    const b = $('syncBadge');
    let text, cls = '';
    if (!S.connected) { text = S.everConnected ? 'Reconnecting…' : 'Connecting…'; cls = 'bad'; }
    else if (!S.video) { text = 'Connected'; cls = 'good'; }
    else if (S.buffering) { text = 'Buffering…'; cls = 'warn'; }
    else if (S.pb && !S.pb.playing) { text = 'Paused · in sync'; cls = 'good'; }
    else {
      const ms = Math.round(Math.abs(S.drift) * 1000);
      text = `In sync · ±${ms} ms`; cls = ms < 100 ? 'good' : ms < 300 ? 'warn' : 'bad';
    }
    if ($('syncText').textContent !== text) $('syncText').textContent = text;
    const nc = 'status ' + cls;
    if (b.className !== nc) b.className = nc;
    b.title = S.clock.ready ? `RTT ${Math.round(S.clock.rtt)} ms · clock offset ${Math.round(S.clock.offset)} ms` : '';
  }
  function renderNowPlaying() {
    const vd = S.video;
    $('npTitle').textContent = vd ? vd.title : 'Nothing playing';
    $('npSub').textContent = vd ? 'Playing from YouTube' + (vd.source === 'url' ? ' (custom link)' : '') : 'Pick something from Discover';
    $('npThumb').style.cssText = vd && vd.thumb ? `background-image:url('${vd.thumb}')` : '';
    $('npThumb').classList.toggle('hidden', !vd);
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
    if (!dur) return;
    const max = Math.max(1, ...Object.values(S.bins));
    const bw = Math.max(2, (BIN_SECONDS / dur) * w);
    for (const [bin, count] of Object.entries(S.bins)) {
      ctx.fillStyle = `rgba(255,107,154,${0.4 + 0.6 * (count / max)})`;
      ctx.fillRect((bin * BIN_SECONDS / dur) * w, 0, bw, ht);
    }
  }

  // ================= chat =================
  const chatLog = $('chatLog');
  const nearBottom = () => chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 70;
  function scrollChat(force) { if (force || nearBottom()) { chatLog.scrollTop = chatLog.scrollHeight; $('jumpBtn').classList.add('hidden'); } }
  function renderChatEmpty() {
    if (chatLog.children.length) return;
    chatLog.append(h('div', { class: 'chat-empty', id: 'chatEmpty' }, icon('message', 26), h('b', null, 'No messages yet'), h('span', { class: 'small' }, 'Say hi to the room. Press / to jump to the message box.')));
  }
  function addChat(msg, silent) {
    const empty = $('chatEmpty'); if (empty) empty.remove();
    const wasNear = nearBottom();
    const mine = msg.from === S.you;
    let el;
    if (msg.sys) { el = h('div', { class: 'sys' }, msg.text); S.lastMsg = null; }
    else {
      const mem = memberById(msg.from) || { name: msg.name, hue: 200 };
      const cont = S.lastMsg && S.lastMsg.from === msg.from && msg.ts - S.lastMsg.ts < 120000;
      const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el = h('div', { class: 'msg' + (cont ? ' cont' : '') + (mine ? ' mine' : '') },
        avatar({ name: msg.name, hue: mem.hue }),
        h('div', null,
          cont ? null : h('div', { class: 'head' }, h('span', { class: 'who', style: `color:${hue(mem.hue)}` }, msg.name), h('time', { class: 't', datetime: new Date(msg.ts).toISOString() }, time)),
          h('div', { class: 'body' }, msg.text)));
      S.lastMsg = msg;
    }
    chatLog.append(el);
    while (chatLog.children.length > 300) chatLog.firstChild.remove();
    if (silent) return;
    if (wasNear || mine) scrollChat(true);
    else $('jumpBtn').classList.remove('hidden');
    if (!msg.sys && !mine && (S.ui.tab !== 'chat' || !S.ui.sidebar || document.hidden)) { S.unread++; renderUnread(); }
  }
  function renderUnread() { const b = $('chatBadge'); b.textContent = S.unread > 99 ? '99+' : S.unread; b.classList.toggle('hidden', !S.unread); }
  function clearUnread() { S.unread = 0; renderUnread(); }
  chatLog.addEventListener('scroll', () => { if (nearBottom()) $('jumpBtn').classList.add('hidden'); }, { passive: true });
  $('jumpBtn').onclick = () => { scrollChat(true); $('chatInput').focus(); };
  const chatInput = $('chatInput');
  const autosize = () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + 'px'; };
  chatInput.addEventListener('input', autosize);
  function submitChat() {
    const text = chatInput.value.trim();
    if (!text) return false;
    if (S.lastChat && S.lastChat.text === text && Date.now() - S.lastChat.t < 400) return false; // double-submit guard
    if (!send({ t: 'chat', text })) return false; // offline: keep the draft
    S.lastChat = { text, t: Date.now() };
    chatInput.value = ''; autosize();
    return true;
  }
  $('chatForm').onsubmit = (e) => { e.preventDefault(); submitChat(); };
  chatInput.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter inserts a newline. Ctrl/Cmd+Enter is handled by the shortcut manager.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) { e.preventDefault(); submitChat(); }
  });

  // ================= panel tabs =================
  function selectTab(name, focusTab) {
    S.ui.tab = name;
    document.querySelectorAll('#tabs [role=tab]').forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      if (on && focusTab) t.focus();
    });
    document.querySelectorAll('.tabpane').forEach((p) => { const on = p.id === 'tab-' + name; p.classList.toggle('active', on); p.hidden = !on; });
    if (name === 'discover') loadDiscover();
    if (name === 'chat') { clearUnread(); requestAnimationFrame(() => scrollChat(true)); }
  }
  function openSidebar() { if (!S.ui.sidebar) setSidebar(true); }
  function focusChat() { openSidebar(); selectTab('chat'); chatInput.focus(); }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) selectTab(b.dataset.tab); });
  $('tabs').addEventListener('keydown', (e) => {
    const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
    const i = tabs.findIndex((t) => t.dataset.tab === S.ui.tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1;
    if (n >= 0) { e.preventDefault(); selectTab(tabs[n].dataset.tab, true); }
  });

  // ================= discover =================
  let discoverGen = 0, debounce;
  const gc = $('genreChips');
  function buildGenres(genres) {
    if (gc.children.length) return;
    genres.forEach((g) => gc.append(h('button', { type: 'button', 'aria-pressed': 'false', onclick: (e) => { const on = !S.filters.genres.has(g); on ? S.filters.genres.add(g) : S.filters.genres.delete(g); e.currentTarget.classList.toggle('on', on); e.currentTarget.setAttribute('aria-pressed', String(on)); loadDiscover(); } }, g)));
  }
  ['fRating', 'fLength', 'fSort'].forEach((id) => { $(id).onchange = loadDiscover; });
  $('q').oninput = () => { clearTimeout(debounce); debounce = setTimeout(loadDiscover, 150); };

  function movieCard(m, compact) {
    const picked = S.picks.includes(m.id);
    return h('div', { class: 'movie' + (compact ? ' compact' : ''), 'data-id': m.id },
      h('div', { class: 'poster', style: posterStyle(m) }, m.thumb ? '' : m.emoji, h('span', { class: 'dur' }, fmt(m.durationSec))),
      h('div', null,
        h('h5', null, m.title),
        h('div', { class: 'meta' }, `${m.year} · ${fmtViews(m.views)} views`),
        compact ? null : h('div', { class: 'meta' }, m.genres.join(' · ')),
        compact ? null : h('div', { class: 'meta' }, m.channel),
        compact ? null : h('p', null, m.description),
        m.reason ? h('div', { class: 'why' }, m.reason) : null,
        h('div', { class: 'acts' },
          h('button', { class: 'btn playm', disabled: !canControl(), title: canControl() ? 'Play for everyone' : 'Only the host controls playback', onclick: () => send({ t: 'setVideo', catalogId: m.id }) }, icon('play', 13), 'Play'),
          h('button', { class: 'btn', onclick: () => send({ t: 'queue.add', catalogId: m.id }) }, icon('plus', 13), 'Queue'),
          h('button', { class: 'btn' + (picked ? ' on' : ''), 'aria-pressed': String(picked), title: 'Add to a "what next?" poll', onclick: (e) => togglePick(m.id, e.currentTarget) }, icon(picked ? 'check' : 'chart', 13), 'Poll'))));
  }
  function togglePick(id, btn) {
    const i = S.picks.indexOf(id);
    if (i >= 0) S.picks.splice(i, 1);
    else if (S.picks.length < 6) S.picks.push(id); else return toast('A poll can have up to 6 options', 'warn');
    btn.classList.toggle('on', i < 0); btn.setAttribute('aria-pressed', String(i < 0)); swapIcon(btn, i < 0 ? 'check' : 'chart', 13);
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
      S.picks = []; renderPicks(); loadDiscover(); selectTab('polls');
    }
  };
  const skeletons = () => [h('div', { class: 'skeleton sk-title' }), ...Array.from({ length: 4 }, () => h('div', { class: 'skeleton sk-row' }))];

  async function loadDiscover() {
    if (!S.code) return;
    const gen = ++discoverGen;
    const q = $('q').value.trim(), genres = [...S.filters.genres];
    const rating = $('fRating').value, len = $('fLength').value, sort = $('fSort').value;
    const body = $('discoverBody');
    if (!body.children.length) body.replaceChildren(...skeletons());
    try {
      if (!q && !genres.length && !rating && !len && !sort) {
        const [cat, rec] = await Promise.all([fetch(apiUrl('/api/categories')).then((r) => r.json()), fetch(apiUrl('/api/recommendations?room=' + S.code)).then((r) => r.json())]);
        if (gen !== discoverGen) return;
        buildGenres(cat.genres);
        const shelf = (title, items) => h('div', { class: 'shelf' }, h('h4', null, title), h('div', { class: 'scroller' }, items.map((m) => movieCard(m, true))));
        body.replaceChildren(shelf('Recommended for this room', rec.items), ...cat.rows.map((r) => shelf(r.title, r.items)));
      } else {
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        genres.forEach((g) => p.append('genre', g));
        if (rating) p.set('viewsMin', rating);
        if (len === 'short') p.set('durMax', 300);
        if (len === 'mid') { p.set('durMin', 300); p.set('durMax', 1200); }
        if (len === 'long') p.set('durMin', 1200);
        if (sort) p.set('sort', sort);
        const res = await fetch(apiUrl('/api/movies?' + p)).then((r) => r.json());
        if (gen !== discoverGen) return;
        buildGenres(res.genres);
        body.replaceChildren(res.items.length ? h('div', { class: 'list' }, res.items.map((m) => movieCard(m, false))) : h('div', { class: 'empty-note' }, icon('search', 24), h('b', null, 'No matches'), h('span', { class: 'small' }, 'Try fewer filters or a different spelling.')));
      }
    } catch (e) { body.replaceChildren(h('div', { class: 'empty-note' }, icon('alert', 24), h('b', null, 'Could not load videos'), h('button', { class: 'btn sm', onclick: loadDiscover }, 'Retry'))); }
  }
  function renderMovieActions() { document.querySelectorAll('.playm').forEach((b) => { b.disabled = !canControl(); }); }
  const urlOf = () => { const u = $('urlInput').value.trim(); if (!/^https?:\/\//i.test(u)) { toast('Paste a full YouTube link (https://…)', 'warn'); $('urlInput').focus(); return null; } return u; };

  // YouTube search (needs YOUTUBE_API_KEY on the server; without it only links and catalog titles are available)
  fetch(apiUrl('/api/youtube/search?q=')).then((r) => r.json()).then((r) => { if (r.enabled) $('ytForm').classList.remove('hidden'); }).catch(() => {});
  const decode = (t) => new DOMParser().parseFromString(t, 'text/html').documentElement.textContent;
  $('ytForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('ytQ').value.trim();
    if (!q) return $('ytResults').replaceChildren();
    $('ytResults').replaceChildren(...skeletons().slice(1, 3));
    const r = await fetch(apiUrl('/api/youtube/search?q=' + encodeURIComponent(q))).then((x) => x.json()).catch(() => null);
    if (!r || !r.enabled) { $('ytResults').replaceChildren(h('p', { class: 'muted small' }, 'YouTube search is not configured on this server.')); return; }
    if (r.error) { $('ytResults').replaceChildren(h('p', { class: 'form-error' }, r.error)); return; }
    $('ytResults').replaceChildren(...r.items.map((it) => {
      const url = 'https://www.youtube.com/watch?v=' + it.ytId, title = decode(it.title);
      return h('div', { class: 'movie' }, h('div', { class: 'poster', style: `background-image:url('https://i.ytimg.com/vi/${it.ytId}/mqdefault.jpg')` }),
        h('div', null, h('h5', null, title), h('div', { class: 'meta' }, decode(it.channel)),
          h('div', { class: 'acts' }, h('button', { class: 'btn playm', disabled: !canControl(), onclick: () => send({ t: 'setVideo', url, title }) }, icon('play', 13), 'Play'),
            h('button', { class: 'btn', onclick: () => send({ t: 'queue.add', url, title }) }, icon('plus', 13), 'Queue'))));
    }));
  };
  $('urlForm').onsubmit = (e) => { e.preventDefault(); const u = urlOf(); if (u) { send({ t: 'setVideo', url: u }); $('urlInput').value = ''; } };
  $('urlPlay').onclick = () => { const u = urlOf(); if (u) { send({ t: 'setVideo', url: u }); $('urlInput').value = ''; } };
  $('urlQueue').onclick = () => { const u = urlOf(); if (u) { send({ t: 'queue.add', url: u }); $('urlInput').value = ''; } };

  // ================= queue =================
  function renderQueue() {
    const open = S.queue.length;
    $('queueBadge').textContent = open; $('queueBadge').classList.toggle('hidden', !open);
    const body = $('queueBody');
    if (!open) return body.replaceChildren(h('div', { class: 'empty-note' }, icon('list', 26), h('b', null, 'The queue is empty'), h('span', { class: 'small' }, 'Add titles from Discover. The next one starts automatically when the current video ends.')));
    body.replaceChildren(
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' }, h('span', { class: 'muted small' }, 'Sorted by votes · auto-plays next'),
        h('button', { class: 'btn sm primary', disabled: !canControl(), onclick: () => send({ t: 'queue.play' }) }, icon('skip', 14), 'Play next')),
      h('div', { class: 'list' }, S.queue.map((it, i) => h('div', { class: 'qitem' + (it.pinned ? ' pinned' : '') },
        h('div', { class: 'poster', style: posterStyle(it.video) }, it.video.thumb ? '' : it.video.emoji),
        h('div', null, h('b', null, (i === 0 ? 'Next: ' : '') + it.video.title), h('div', { class: 'muted small' }, `added by ${nameOf(it.addedBy)}${it.pinned ? ' · poll winner' : ''}`)),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm' + (it.voters.includes(S.you) ? ' primary' : ''), 'aria-pressed': String(it.voters.includes(S.you)), 'aria-label': 'Vote up', onclick: () => send({ t: 'queue.vote', id: it.id }) }, icon('thumbs-up', 14), String(it.voters.length)),
          h('button', { class: 'icon-btn', disabled: !canControl(), 'aria-label': 'Play now', title: 'Play now', onclick: () => send({ t: 'queue.play', id: it.id }) }, icon('play', 16)),
          (it.addedBy === S.you || isHost()) ? h('button', { class: 'icon-btn', 'aria-label': 'Remove from queue', title: 'Remove', onclick: () => send({ t: 'queue.remove', id: it.id }) }, icon('x', 16)) : null)))));
  }

  // ================= polls =================
  $('addOpt').onclick = () => { const n = $('pollOpts').children.length; if (n < 6) $('pollOpts').append(h('input', { class: 'pollOpt', maxlength: 60, placeholder: 'Option ' + (n + 1), 'aria-label': 'Option ' + (n + 1) })); };
  $('pollForm').onsubmit = (e) => {
    e.preventDefault();
    const options = [...document.querySelectorAll('.pollOpt')].map((i) => i.value.trim()).filter(Boolean);
    if (!$('pollQ').value.trim() || options.length < 2) { toast('Add a question and at least two options', 'warn'); return; }
    if (send({ t: 'poll.create', question: $('pollQ').value, options, durationSec: Number($('pollDur').value) })) {
      $('pollQ').value = ''; document.querySelectorAll('.pollOpt').forEach((i) => { i.value = ''; });
    }
  };
  function renderPolls() {
    const openUnvoted = S.polls.filter((p) => !p.closed && !p.options.some((o) => o.voters.includes(S.you))).length;
    $('pollBadge').textContent = openUnvoted; $('pollBadge').classList.toggle('hidden', !openUnvoted);
    const list = $('pollList');
    if (!S.polls.length) return list.replaceChildren(h('div', { class: 'empty-note' }, icon('chart', 26), h('b', null, 'No polls yet'), h('span', { class: 'small' }, 'Ask the room anything, or pick titles in Discover and start a “what next?” poll.')));
    list.replaceChildren(...[...S.polls].reverse().map((p) => {
      const total = p.options.reduce((s, o) => s + o.voters.length, 0);
      return h('div', { class: 'poll' },
        h('h5', null, p.question),
        p.options.map((o) => h('button', { class: 'opt' + (o.voters.includes(S.you) ? ' mine' : '') + (p.winner === o.id ? ' win' : ''), disabled: p.closed, 'aria-pressed': String(o.voters.includes(S.you)),
          title: o.voters.map(nameOf).join(', ') || 'No votes yet', onclick: () => send({ t: 'poll.vote', id: p.id, option: o.id }) },
          h('div', { class: 'bar', style: `width:${total ? (o.voters.length / total) * 100 : 0}%` }),
          h('span', null, (o.emoji ? o.emoji + ' ' : '') + o.text), h('span', null, String(o.voters.length)))),
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('span', { class: 'muted small', ...(p.closed || !p.closesAt ? {} : { 'data-closes': p.closesAt }) }, p.closed ? 'closed' : p.closesAt ? '' : `by ${nameOf(p.createdBy)}`),
          !p.closed && (p.createdBy === S.you || isHost()) ? h('button', { class: 'btn sm', onclick: () => send({ t: 'poll.close', id: p.id }) }, 'Close poll') : null));
    }));
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
        avatar(m, m.connected ? '' : 'off'),
        h('div', { class: 'grow' }, h('b', null, m.name + (m.id === S.you ? ' (you)' : '')),
          h('span', { class: 'muted small' }, (m.id === S.hostId ? 'Host · ' : '') + (m.connected ? (hl.buffering ? 'buffering…' : 'connected') : 'reconnecting…')),
          d != null && m.connected ? h('span', { class: 'small drift ' + cls }, ` · ±${d} ms${hl.rtt != null ? ` · ${hl.rtt} ms RTT` : ''}`) : null),
        isHost() && m.id !== S.you ? [
          m.connected ? h('button', { class: 'icon-btn', 'aria-label': 'Make ' + m.name + ' the host', title: 'Make host', onclick: () => send({ t: 'host.transfer', to: m.id }) }, icon('crown', 16)) : null,
          h('button', { class: 'icon-btn', 'aria-label': 'Remove ' + m.name, title: 'Remove from room', onclick: async () => { if (await confirmDialog('Remove ' + m.name + '?', 'They will be disconnected from the room.', 'Remove')) send({ t: 'host.kick', to: m.id }); } }, icon('x', 16))] : null);
    });
    const focused = document.activeElement && document.activeElement.id === 'controlModeBox';
    body.replaceChildren(
      h('div', { class: 'list' }, rows),
      h('label', { class: 'setting' },
        h('input', { id: 'controlModeBox', type: 'checkbox', ...(S.controlMode === 'host' ? { checked: true } : {}), ...(isHost() ? {} : { disabled: true }), onchange: (e) => send({ t: 'settings', controlMode: e.target.checked ? 'host' : 'everyone' }) }),
        h('span', null, 'Only the host controls playback', isHost() ? null : h('span', { class: 'muted small' }, ' (host only)'))),
      h('p', { class: 'muted small', style: 'margin-top:12px' }, 'Drift is each person’s distance from the shared clock, measured every 2 s. Players self-correct above 40 ms and seek above 350 ms.'));
    if (focused) $('controlModeBox').focus();
  }

  function renderAll() {
    renderControls(); renderNowPlaying(); renderPeople(); renderQueue(); renderPolls(); renderPicks(); renderBadge(); renderVolume();
    $('emptyState').classList.toggle('hidden', !!S.video);
    drawHeat();
    if (S.ui.tab === 'discover') loadDiscover();
  }

  // ================= keyboard shortcuts =================
  const sm = new ShortcutManager({ isModalOpen: () => !!document.querySelector('dialog[open]') });
  const inRoom = () => S.inRoom;
  const kbdDialog = $('kbdDialog');
  const toggleHelp = () => { if (kbdDialog.open) kbdDialog.close(); else { renderHelp(); kbdDialog.showModal(); } };
  function renderHelp() {
    const keyEl = (k) => h('kbd', null, k);
    const body = $('kbdBody');
    const order = ['Playback', 'Audio', 'Display', 'Chat'];
    const groups = sm.help();
    body.replaceChildren(...order.filter((g) => groups.has(g)).map((g) => h('section', { class: 'kbd-group' }, h('h3', null, g),
      groups.get(g).map((b) => h('div', { class: 'kbd-row' }, h('span', null, b.label),
        h('span', { class: 'kbd-keys' }, b.hint.flatMap((alt, i) => [i ? h('span', { class: 'or' }, 'or') : null, ...alt.flatMap((k, j) => [j ? h('span', { class: 'or' }, '+') : null, keyEl(k)])])))))));
  }
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  sm.add({ id: 'playpause', group: 'Playback', label: 'Play / Pause', hint: [['Space'], ['K']], keys: [{ key: ' ' }, { key: 'k' }], noRepeat: true, enabled: inRoom, run: togglePlay })
    .add({ id: 'back5', group: 'Playback', label: 'Back 5 seconds', hint: [['←']], keys: [{ key: 'ArrowLeft', shift: false }], enabled: inRoom, run: () => seekBy(-5) })
    .add({ id: 'fwd5', group: 'Playback', label: 'Forward 5 seconds', hint: [['→']], keys: [{ key: 'ArrowRight', shift: false }], enabled: inRoom, run: () => seekBy(5) })
    .add({ id: 'back10', group: 'Playback', label: 'Back 10 seconds', hint: [['Shift', '←'], ['J']], keys: [{ key: 'ArrowLeft', shift: true }, { key: 'j' }], enabled: inRoom, run: () => seekBy(-10) })
    .add({ id: 'fwd10', group: 'Playback', label: 'Forward 10 seconds', hint: [['Shift', '→'], ['L']], keys: [{ key: 'ArrowRight', shift: true }, { key: 'l' }], enabled: inRoom, run: () => seekBy(10) })
    .add({ id: 'mute', group: 'Audio', label: 'Mute / Unmute', hint: [['M']], keys: [{ key: 'm' }], noRepeat: true, enabled: inRoom, run: toggleMute })
    .add({ id: 'volup', group: 'Audio', label: 'Volume up', hint: [['↑']], keys: [{ key: 'ArrowUp' }], enabled: inRoom, run: () => setVolume(S.vol + 0.05) })
    .add({ id: 'voldown', group: 'Audio', label: 'Volume down', hint: [['↓']], keys: [{ key: 'ArrowDown' }], enabled: inRoom, run: () => setVolume(S.vol - 0.05) })
    .add({ id: 'fullscreen', group: 'Display', label: 'Toggle fullscreen', hint: [['F']], keys: [{ key: 'f' }], noRepeat: true, enabled: inRoom, run: toggleFullscreen })
    .add({ id: 'theater', group: 'Display', label: 'Toggle theater mode', hint: [['T']], keys: [{ key: 't' }], noRepeat: true, enabled: inRoom, run: () => setTheater(!S.ui.theater) })
    .add({ id: 'escape', group: 'Display', label: 'Close dialog, exit theater mode or fullscreen', hint: [['Esc']], keys: [{ key: 'Escape' }], inText: true, inModal: true, enabled: inRoom,
      run: () => {
        if (document.querySelector('dialog[open]')) return false; // the native dialog closes itself
        if (document.fullscreenElement) { document.exitFullscreen(); return true; }
        if (S.ui.pseudoFs) { setPseudoFs(false); return true; }
        if (S.ui.theater && S.ui.sidebar) { setSidebar(false); return true; }
        if (S.ui.theater) { setTheater(false); return true; }
        const a = document.activeElement;
        if (a && a !== document.body && (a === chatInput || a.id === 'q' || a.id === 'urlInput' || a.id === 'pollQ')) { a.blur(); return true; }
        return false;
      } })
    .add({ id: 'focuschat', group: 'Chat', label: 'Focus the chat box', hint: [['/']], keys: [{ key: '/', shift: false }], noRepeat: true, enabled: inRoom, run: focusChat })
    .add({ id: 'sendchat', group: 'Chat', label: 'Send message', hint: [['Enter'], [mod, 'Enter']], keys: [{ key: 'Enter', mod: true }], inText: true, supported: inRoom, enabled: () => inRoom() && document.activeElement === chatInput, run: () => { submitChat(); return true; } })
    .add({ id: 'help', group: 'Display', label: 'Show / hide this help', hint: [['?']], keys: [{ key: '?' }], noRepeat: true, inModal: true, enabled: inRoom, run: () => { toggleHelp(); return true; } });
  kbdDialog.addEventListener('click', (e) => { if (e.target === kbdDialog) kbdDialog.close(); }); // click on the backdrop closes
  $('kbdClose').onclick = () => kbdDialog.close();
  $('confirmDialog').addEventListener('click', (e) => { if (e.target === $('confirmDialog')) $('confirmDialog').close('cancel'); });

  // ================= room session: every global listener is registered here and removed on leave =================
  function startSession() {
    endSession();
    S.inRoom = true;
    S.abort = new AbortController();
    const opts = { signal: S.abort.signal };
    document.addEventListener('fullscreenchange', renderFullscreen, opts);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { enforce(); if (S.ui.tab === 'chat' && S.ui.sidebar) clearUnread(); } }, opts);
    window.addEventListener('resize', drawHeat, opts);
    sm.attach();
    renderVolume();
  }
  function endSession() {
    S.inRoom = false;
    if (S.abort) { S.abort.abort(); S.abort = null; }
    sm.detach();
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setPseudoFs(false);
  }

  Icons.hydrate(document);
  if (matchMedia('(pointer: coarse)').matches) chatInput.placeholder = 'Message the room…'; // the "press /" hint is meaningless on touch
  renderVolume();

  // Resume after a page reload within the same tab.
  const resume = store.get('wp_room', sessionStorage);
  if (resume && store.get('wp_name') && (!params.get('room') || params.get('room').toUpperCase() === resume)) enterRoom(resume);
  else if (params.get('room') && store.get('wp_name')) $('codeInput').value = params.get('room').toUpperCase();
  window.__wp = { S, sm, enforce, get P() { return P; } }; // handy for debugging in devtools and for the browser tests
})();
