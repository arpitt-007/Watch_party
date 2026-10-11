# 🍿 Watch Party

A real-time watch-party web app: everyone in a room watches the same video in lock-step, with live chat, emoji reactions, a shared queue, group polls, host controls and movie discovery with fuzzy search.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 23 tests: protocol, concurrency, reconnects, search, sync algorithm
npm run loadtest   # latency / convergence / reconnect benchmark (see docs/LATENCY.md)
```

Open the app in two browser windows (or on two machines on your LAN: `http://<your-ip>:3000`), create a room in one, and join with the invite link or the 6-character code in the other. Node ≥ 18, one dependency (`ws`), no build step.

## Feature checklist

| Requirement | Where |
|---|---|
| Create / join via invite link or room code | `POST /api/rooms`, `/?room=CODE`, case-insensitive codes from an unambiguous alphabet |
| Synchronised play / pause / seek | server-authoritative playback clock, see *How sync works* |
| YouTube videos | catalog entries + paste any YouTube link (title looked up via oEmbed) + optional search; played with the YouTube IFrame API, see *YouTube* below |
| Movie recommendations, categories, filters, fuzzy search | `server/search.js` (typo-tolerant, Damerau-Levenshtein per token over title / genre / tags / people / description), `/api/categories`, `/api/recommendations` |
| Emoji reactions, live chat, shared playlists, polls, host transfer | `server/room.js` |
| Automatic drift detection + correction | `public/sync-core.js` |
| Late joins, reconnections, concurrent actions | snapshot-on-join, `clientId` identity, `seq` ordering, idempotent action ids |
| ≥ 10 users / room | tested at 10, 25 and 50 (cap 100) |
| p95 propagation ≤ 250 ms, drift ≤ 500 ms | measured: p95 ≈ 2–4 ms on loopback; simulated drift worst ≈ 120 ms. Details and caveats in [docs/LATENCY.md](docs/LATENCY.md) |

### Beyond the basics
* **Reaction timeline** – every emoji is stamped with the movie position and drawn as a heat-map on the seek bar, so you can see where the room laughed/screamed (and jump there).
* **"What next?" polls** – pick 2–6 titles in Discover, start a poll; the winner is pinned to the top of the queue and auto-plays when the current video ends.
* **Vote-sorted queue** – 👍 reorders the queue; the next item auto-starts when the room's clock reaches the end of the video.
* **Group recommendations** – genre affinity from what this room watched, queued and voted for ("Because your room likes Animation").
* **Synchronised countdown start** – a new video is scheduled 1.5 s ahead on the shared clock so every player has loaded before anyone starts.
* **Live sync-health panel** – per-person drift, RTT and buffering state in *People*; the header badge shows your own drift.
* **Host-only mode** – the host can restrict playback control; everyone can still chat, react, vote and queue.
* **Play any direct video URL** (mp4/webm) for the whole room.

## How sync works

```
 client A ──control{seek,aid}──▶ server ──state{playing,pos,at,seq}──▶ every client
```

1. **The server owns the clock.** Playback state is `{playing, pos, at, seq}`: "at server time `at` the video was at `pos`; it advances at 1× if `playing`". Position now = `pos + (serverNow − at)`. Clients never tell the room where *they* are; they only request play/pause/seek. A pause takes its position from the server clock, not from the pressing client.
2. **Clock sync.** Every client pings every 3 s (6 quick pings at join). NTP-style samples (`offset = ts − (t0+t2)/2`); the best third by RTT are averaged, so one congested sample doesn't skew the offset. Propagation delay is therefore *compensated* rather than added to the error.
3. **Drift loop (every 250 ms):** `drift = currentTime − expected`; under 40 ms do nothing, up to 350 ms nudge `playbackRate` by up to ±8 %, beyond that hard-seek. A 1.2 s post-seek cooldown prevents seek storms while the player re-buffers.
4. **Concurrency.** One server thread serialises all actions; each accepted change bumps `seq`; the last action wins; redundant play/pause are no-ops. Clients ignore stale `seq`.
5. **Late join.** The welcome message carries the full room snapshot; the client loads the video, seeks to the *expected* position and the drift loop does the rest.
6. **Reconnection.** Identity is a per-tab `clientId` (sessionStorage), so a refresh or network blip returns you to the same seat — same name, same host role if within the grace period — with no ghost duplicate.
7. **Local interference.** Native controls are removed and the player re-asserts the room state if something (a media key, an extension) pauses it behind the app's back.

## YouTube

* **Catalog:** 7 official Blender short films are hosted on YouTube (tagged ▶ YouTube) next to the direct-file titles.
* **Any video:** paste a `youtube.com/watch`, `youtu.be`, `/shorts/` or `/embed/` link in *Discover*. The server extracts the 11-character id and looks up the title with YouTube's keyless oEmbed endpoint.
* **Search (optional):** `YOUTUBE_API_KEY=<Data API v3 key> npm start` enables the *Search YouTube* box (only embeddable videos are returned). Without a key the box explains how to enable it; links and catalog titles still work. *Search is untested against the live API in this repo, since no key was available.*
* **Sync differences:** the IFrame API cannot do fine playback-rate changes, so YouTube drift is corrected by seeking only (threshold 450 ms, 2.5 s cooldown) instead of the ±8 % speed nudge. Observed in two browser tabs: ±19–60 ms. The YouTube iframe is click-through (`pointer-events:none`) so every control goes through the room; owners who disabled embedding show a message instead of a player.
* Requires internet access to youtube.com. Playing YouTube through a custom UI follows YouTube's embedded-player terms; ads shown by YouTube are not suppressed and each viewer's player plays them on their own schedule, which can cause a brief resync.

## Protocol (JSON over WebSocket `/ws`)

Client → server: `join`, `ping`, `control{action: play|pause|seek, position, aid}`, `setVideo{catalogId|url}`, `ended{token}`, `report{drift, rtt, buffering, duration, token}`, `chat`, `react`, `queue.add|remove|vote|play`, `poll.create|vote|close`, `host.transfer|kick`, `settings{controlMode}`.
Server → client: `welcome` (snapshot), `state`, `presence`, `health`, `chat`, `reaction`, `playlist`, `polls`, `pong`, `error`, `kicked`.
HTTP: `POST /api/rooms`, `GET /api/rooms/:code`, `GET /api/movies?q=&genre=&ratingMin=&durMin=&durMax=&sort=`, `GET /api/categories`, `GET /api/recommendations?room=`, `GET /api/metrics`.

## Layout

```
server/index.js    HTTP + WebSocket, rate limiting, heartbeats
server/room.js     room state machine: playback, members, host, queue, polls, reactions
server/catalog.js  movie data;  server/search.js  fuzzy search, filters, categories, recommendations
public/            vanilla JS client (sync-core.js is shared with Node tests)
test/              node:test suites;  scripts/  load test, headless client, drift simulator
docs/LATENCY.md    measurements, test conditions, failure handling
```

## Honest limitations
* **Catalog is small** (15 titles: Blender open movies and CC0 clips, 7 of them via YouTube). Metadata such as ratings is hand-curated. Adding titles = adding objects to `server/catalog.js`; any direct video URL also works. The sources are third-party hosts; if one goes offline the player shows an error (Google's old sample bucket was already dead and was replaced during development).
* Only HTML5-playable sources (mp4/webm) and YouTube. No DRM streaming services (Netflix etc.) — their players can't be driven.
* Rooms are in memory (a server restart ends them); no accounts or auth — anyone with the code can join.
* Latency was measured on loopback; drift was validated by simulation plus a two-tab browser check, not on a fleet of real devices.
* Background browser tabs are throttled by the browser, which can cause brief drift until the tab is active again.
