'use strict';
// Minimal headless client used by the integration tests and the load test.
const WebSocket = require('ws');
const { performance } = require('perf_hooks');

const hr = () => performance.timeOrigin + performance.now(); // sub-ms wall clock

class TestClient {
  constructor(base, room, name, clientId) {
    this.base = base; this.room = room; this.name = name;
    this.clientId = clientId || ('c' + Math.random().toString(36).slice(2, 12) + name);
    this.events = [];
    this.waiters = [];
    this.state = null; this.welcome = null; this.members = [];
    this.onState = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws'));
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: this.room, name: this.name, clientId: this.clientId })));
      ws.on('message', (d) => {
        const recvAt = hr();
        const msg = JSON.parse(d);
        msg._at = recvAt;
        if (msg.t === 'welcome') { this.welcome = msg; this.state = { pb: msg.pb, video: msg.video }; this.members = msg.members; resolve(this); }
        if (msg.t === 'state') { this.state = msg; if (this.onState) this.onState(msg); }
        if (msg.t === 'presence') this.members = msg.members;
        if (msg.t === 'error' && !this.welcome) reject(new Error(msg.msg));
        this.events.push(msg);
        this.waiters = this.waiters.filter((w) => { if (w.pred(msg)) { w.resolve(msg); return false; } return true; });
      });
      ws.on('error', reject);
    });
  }
  send(o) { const t = hr(); this.ws.send(JSON.stringify(o)); return t; }
  waitFor(pred, ms = 3000) {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('timeout waiting for event')); }, ms);
    });
  }
  next(pred, ms = 3000) { // only events arriving after this call
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('timeout waiting for event')); }, ms);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* closed */ } }
  kill() { try { this.ws.terminate(); } catch (e) { /* closed */ } }
}

async function createRoom(base) {
  const r = await fetch(base + '/api/rooms', { method: 'POST' });
  return (await r.json()).code;
}

module.exports = { TestClient, createRoom, hr };
