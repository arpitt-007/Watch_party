# Latency, drift and failure-handling measurements

Everything here is reproducible with `npm run loadtest` (raw output of the run below: [`loadtest-output.txt`](loadtest-output.txt)).

## Test conditions (read this before trusting the numbers)

| | |
|---|---|
| Machine | Windows 11 laptop, Node v22.19.0, single process for server **and** load generator |
| Network | **Loopback only** (127.0.0.1). This is a best case: it measures server + WebSocket + JSON cost, not wire time. On a real LAN add one RTT/2 (typically 1–5 ms Wi-Fi 5/6, <1 ms wired). |
| Clock | Sender and receivers share one clock (same process, `performance.timeOrigin + performance.now()`), so latencies are exact, not estimated. Cross-machine runs (`--url http://host:3000`) need NTP-synced hosts. |
| Load | 10 / 25 / 50 users in a single room, 300 control actions per run (seek / pause / play, issued by *different* users, 15 ms apart), 100 % of messages delivered in every run |
| What "latency" means | Time from a user's `control` message leaving their socket until the resulting `state` broadcast is received by each *other* participant. It excludes the browser's own decode/seek time, which the drift loop absorbs. |
| Drift | **Simulated**, not measured in real browsers (see below). In-browser sanity check: two tabs on one machine showed ±4–19 ms reported drift while playing. |

## 1. Playback-control propagation (requirement: p95 ≤ 250 ms)

| users | samples | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| 10 | 2700/2700 | 1.12 ms | 1.99 ms | 2.93 ms | 6.74 ms |
| 25 | 7200/7200 | 1.53 ms | 2.36 ms | 3.34 ms | 5.86 ms |
| 50 | 14700/14700 | 2.44 ms | 3.47 ms | 4.32 ms | 5.79 ms |

The budget is 250 ms; on loopback we use ~1 %. The server serialises each broadcast once (`JSON.stringify` once, same string to all sockets), so cost grows slowly with room size. Headroom for a real network is large, but **this has not been measured over Wi-Fi/LAN.**

## 2. Concurrent conflicting actions

Every user sends a different action (play / pause / seek) at the same instant, 30 rounds. A round "converges" when all clients hold the same `{seq, pos, playing}`.

| users | converged | time for last client to settle p50 | max |
|---|---|---|---|
| 10 | 30/30 | 5.0 ms | 7.7 ms |
| 25 | 30/30 | 23.5 ms | 27.1 ms |
| 50 | 30/30 | 68.8 ms | 89.7 ms |

Resolution rule: the server is the single serialization point, and the **last action it receives wins**. Every state carries a monotonically increasing `seq`; clients drop anything older than what they have applied. `play` while already playing (and `pause` while paused) is a no-op, so two people clicking "pause" together do not toggle the room back to playing.

## 3. Late join and reconnect storm

| users | late-join snapshot p50 / max | killed + reconnected at once | all back in | connected after | duplicate members | state restored |
|---|---|---|---|---|---|---|
| 10 | 4.4 / 4.8 ms | 4 | 7.5 ms | 10 | none | yes |
| 25 | 7.6 / 10.4 ms | 10 | 28.7 ms | 25 | none | yes |
| 50 | 10.1 / 18.4 ms | 20 | 51.1 ms | 50 | none | yes |

(40 % of sockets are terminated without a close frame, then reopened with the same `clientId`.) Late join time is socket-open → full snapshot (state, video, chat history, queue, polls, reaction timeline, roster). In a browser the video must additionally load; the client then seeks to the *expected* position (`pos + (serverNow − at)`) and the drift loop trims the rest.

## 4. Drift after correction (requirement: ≤ 500 ms)

The client algorithm lives in `public/sync-core.js` and is shared verbatim by the browser and by a deterministic closed-loop simulator (`scripts/driftsim.js`). 12 simulated players, 120 s each, per player: ±10 s clock skew vs the server, ±0.5 % playback-rate error (a very bad crystal), and a 2.5 s buffering stall at t = 60 s. Drift is measured every 250 ms against the true room position.

| seed | p95 | worst (steady state, after recovery) |
|---|---|---|
| 1 | 39.6 ms | 121.2 ms |
| 2 | 39.5 ms | 120.7 ms |
| 3 | 39.9 ms | 121.0 ms |
| 4 | 39.7 ms | 120.8 ms |
| 5 | 39.9 ms | 120.9 ms |

Caveats: it is a model. It doesn't include decoder/seek latency spikes or tab throttling. The sampled worst case excludes the stall window itself and the ~300 ms after it, during which a real player is by definition not playing. In real browsers a hard seek costs one buffering round; we apply a 1.2 s cooldown after each seek so slow seeks don't cause seek storms. Background tabs are throttled by browsers (timers fire ≈1 Hz), where we observed transient drift up to ~0.4 s that is corrected when the tab runs again.

How the correction works: `drift = video.currentTime − expectedPosition`.
* |drift| < 20–40 ms: nothing (hysteresis band).
* 40 ms – 350 ms: nudge `playbackRate` by drift/3 s, capped at ±8 % — inaudible and corrects 300 ms in ≈4 s with no visible jump.
* \> 350 ms: hard seek to the expected position (+120 ms lead for seek latency).

## 5. Failure handling (all covered by `npm test`)

| Failure | Behaviour | Test |
|---|---|---|
| Client socket drops | Server keeps the member for 30 s (shown as "reconnecting…"); client reconnects with exponential back-off + jitter (0.4 s → 5 s), re-sends `join`, gets a fresh snapshot. Playback continues locally meanwhile. | `reconnect with the same clientId…` |
| Host drops | 8 s grace (a refresh does not lose hosting); then the longest-present connected member becomes host and the room is told. If the host returns inside the grace period nothing changes. | `host disconnect transfers hosting…` |
| Same user opens two tabs / double connects | Newest connection wins, the older one is closed with code 4000 and shows a banner instead of fighting for the member slot. | `same clientId in a second connection…` |
| Retried action after a reconnect | Each control carries an `aid`; the server remembers the last 200 per member and ignores duplicates. | `duplicate action ids…` |
| Out-of-order / stale state | `seq` check on the client. | covered by `onState` guard + convergence tests |
| Autoplay blocked | Client shows a "Tap to join playback" overlay. | manual |
| Malicious / buggy clients | 16 KB max frame, token-bucket rate limit (30 msg/s), chat 8 msgs / 5 s, reactions 8 / 2 s, emoji whitelist, UI is rendered only with `textContent`. A bogus `ended` event is ignored unless the room's clock is at the end. | `chat, reactions… and flood protection`, `queue…` |
| Server restart | Rooms are in memory and are lost; clients get "room no longer exists". (Known limitation.) | – |
