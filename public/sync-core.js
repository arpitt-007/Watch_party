/* Pure synchronization logic, shared by the browser client and the Node tests/simulator.
 *
 * Model: the server owns the playback state {playing, pos, at, seq}: "at server time `at`
 * the video was at `pos` seconds, and it plays at 1x if `playing`".  Every client derives the
 * expected position from its own estimate of the server clock, so propagation delay is
 * compensated for rather than ignored.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CFG = {
    softThreshold: 0.04,   // s: start nudging playbackRate above this drift
    softRelease: 0.02,     // s: back to 1x once drift is below this (hysteresis)
    hardThreshold: 0.35,   // s: seek outright above this drift (spec: drift <= 500 ms)
    maxRateDelta: 0.08,    // +-8% playback speed is imperceptible and corrects 300 ms in ~4 s
    rateGain: 1 / 3,       // aim to close the gap in ~3 s
    seekCooldownMs: 1200,  // let a seek settle/buffer before judging drift again
    seekLead: 0.12,        // s: when hard-seeking while playing, aim slightly ahead for the seek latency
  };

  function expectedPosition(pb, serverNow, duration) {
    let p = pb.playing ? pb.pos + Math.max(0, serverNow - pb.at) / 1000 : pb.pos;
    if (duration && p > duration) p = duration;
    return p;
  }

  /** drift > 0: this client is ahead of the room. Returns what the player should do now. */
  function decide({ drift, currentRate = 1, sinceSeekMs = Infinity, cfg = CFG }) {
    const a = Math.abs(drift);
    if (a > cfg.hardThreshold && sinceSeekMs > cfg.seekCooldownMs) {
      return { action: 'seek', delta: -drift + cfg.seekLead, rate: 1 };
    }
    if (a > cfg.softThreshold || (currentRate !== 1 && a > cfg.softRelease)) {
      const delta = Math.max(-cfg.maxRateDelta, Math.min(cfg.maxRateDelta, drift * cfg.rateGain));
      return { action: 'rate', rate: 1 - delta };
    }
    return { action: 'none', rate: 1 };
  }

  /** NTP-style clock estimate: keep the lowest-RTT samples (least queueing noise) and use their offset. */
  class ClockSync {
    constructor(maxSamples = 12) { this.samples = []; this.max = maxSamples; this.offset = 0; this.rtt = null; this.ready = false; }
    // t0: client send time, ts: server time at reply, t2: client receive time (all ms)
    addSample(t0, ts, t2) {
      const rtt = t2 - t0;
      if (rtt < 0) return;
      this.samples.push({ rtt, offset: ts - (t0 + t2) / 2 });
      if (this.samples.length > this.max) this.samples.shift();
      const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 3)));
      this.offset = best.reduce((s, x) => s + x.offset, 0) / best.length;
      this.rtt = best.reduce((s, x) => s + x.rtt, 0) / best.length;
      this.ready = true;
    }
    serverNow(clientNow) { return clientNow + this.offset; }
  }

  return { CFG, expectedPosition, decide, ClockSync };
});
