'use strict';
const { expectedPosition, decide, ClockSync } = require('../public/sync-core');

// Closed-loop simulation: players with clock skew, rate error, jitter and stalls follow the room.
function simulate({ clients = 12, seconds = 120, stalls = true, seed = 1 }) {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pb = { playing: true, pos: 0, at: 0, seq: 1 };
  const players = Array.from({ length: clients }, () => ({
    skew: (rnd() - 0.5) * 20000, // clock offset vs server
    rateErr: 1 + (rnd() - 0.5) * 0.01, // +-0.5% crystal error
    pos: 0, rate: 1, lastSeek: -1e9, stallUntil: -1, clock: new ClockSync(),
  }));
  for (const p of players) for (let i = 0; i < 8; i++) { const j = rnd() * 6; p.clock.addSample(0, p.skew + j, 2 * j); }
  let worst = 0, worstAfterSettle = 0;
  const samples = [];
  for (let t = 0; t < seconds * 1000; t += 50) {
    for (const p of players) {
      if (stalls && Math.abs(t - 60000 - players.indexOf(p) * 700) < 25) p.stallUntil = t + 2500; // 2.5 s network stall
      if (t < p.stallUntil) continue; // buffering: video does not advance
      p.pos += 0.05 * p.rate * p.rateErr;
      if (t % 250 === 0 && t > p.stallUntil + 300) {
        const exp = expectedPosition(pb, t); // sim server time == t
        const est = expectedPosition(pb, t + (p.clock.offset - p.skew)); // clock-estimate error -> position error
        const d = decide({ drift: p.pos - est, currentRate: p.rate, sinceSeekMs: t - p.lastSeek });
        if (d.action === 'seek') { p.pos += d.delta; p.lastSeek = t; p.rate = 1; } else p.rate = d.rate;
        const drift = Math.abs(p.pos - exp);
        if (t > 5000) { worst = Math.max(worst, drift); samples.push(drift); }
        if (t > 8000 && !(t >= 60000 && t < 66000)) worstAfterSettle = Math.max(worstAfterSettle, drift);
      }
    }
  }
  samples.sort((a, b) => a - b);
  return { worst, worstAfterSettle, p95: samples[Math.floor(samples.length * 0.95)] };
}

module.exports = { simulate };
