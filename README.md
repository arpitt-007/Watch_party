# 🍿 Watch Party

A real-time watch-party web app: everyone in a room watches the same video in lock-step, with live chat, emoji reactions, a shared queue, group polls, host controls and movie discovery with fuzzy search.

```bash
npm install
npm start          # http://localhost:3000
npm test           # protocol, concurrency, reconnects, search, sync algorithm, keyboard-manager rules
npm run check      # syntax check of all JS
npm run loadtest   # latency / convergence / reconnect benchmark (see docs/LATENCY.md)
```

Open the app in two browser windows (or on two machines on your LAN: `http://<your-ip>:3000`), create a room in one, and join with the invite link or the 6-character code in the other. Node ≥ 18, one dependency (`ws`), no build step.

## Feature checklist

| Requirement | Where |
|---|---|
| Create / join via invite link or room code | `POST /api/rooms`, `/?room=CODE`, case-insensitive codes from an unambiguous alphabet |
| Synchronised play / pause / seek | server-authoritative playback clock, see *How sync works* |
| YouTube videos | the whole catalog is YouTube (movies, trailers, music videos, shorts…); paste any link; IFrame-API player, see *YouTube-only catalog* |
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

## YouTube-only catalog

Everything in the catalog is a real YouTube video (39 titles; every one existed and allowed embedding for the browser that checked it): 7 full public-domain movies (Night of the Living Dead, Nosferatu, Metropolis, A Trip to the Moon, The General, Safety Last!, Plan 9), 12 official trailers (Inception, Interstellar, Dune: Part Two, Oppenheimer, …), 4 official music videos (Queen, Michael Jackson, Adele, Eminem), 11 Blender animated shorts, plus documentaries and comedy. Browse by category row, genre chips, popularity (view count), length and sort, or fuzzy-search titles / genres / tags / channels.

* **Any video:** paste a `youtube.com/watch`, `youtu.be`, `/shorts/` or `/embed/` link in *Discover*. The server extracts the 11-character id, looks the title up with YouTube's keyless oEmbed endpoint and uses the YouTube thumbnail as poster. A link to a catalog video resolves to its catalog entry.
* **Search all of YouTube (optional):** `YOUTUBE_API_KEY=<Data API v3 key> npm start` shows a *Search YouTube* box (only embeddable videos are returned). Without a key the box is hidden. *This path is untested against the live API, since no key was available.*
* **Embedding is enforced, not assumed:** (1) every catalog video is verified by `npm run verify-catalog` (exists, playable, `playableInEmbed`, oEmbed OK, not age-gated); server-side checks cannot see every restriction: 13 music videos passed them but YouTube refused to embed them in a real browser (error 150), so they were removed using `/probe.html`. (2) A pasted link is checked with oEmbed first; videos whose owner disabled embedding, or that are private/removed, are rejected with a message. (3) If a viewer's player still reports error 2/100/101/150 at play time (e.g. a region lock or an owner restriction that only applies to some viewers), the room skips to the next queued video **and the video is blocked**: it disappears from Discover and recommendations and stays hidden across restarts (`server/blocked.json`, git-ignored; delete the file to reset). This is how the catalog adapts to your audience's regions, which cannot be checked from the server.
* **Checking in your own browser:** open `http://localhost:3000/probe.html` (keep the tab in front). It plays every catalog video muted, marks the ones YouTube refuses to embed *for you* (errors 2/100/101/150), hides them immediately, and `npm run prune` then deletes them from `server/catalog.json`. Server-side checks cannot see every restriction (e.g. Gangnam Style and See You Again passed them but were refused in a real player, and were removed).
* **Updating the catalog:** edit `server/catalog.json` (id, title, category, year, genres, tags, description, channel, durationSec, views). Sources are third-party uploads; if an uploader deletes a video or disables embedding, the player shows a message for it. Full-movie entries are public-domain re-uploads by third-party channels and are the most likely to disappear.
* **Sync differences:** the IFrame API cannot do fine playback-rate changes, so YouTube drift is corrected by seeking only (threshold 450 ms, 2.5 s cooldown) instead of the ±8 % speed nudge. Observed in two browser tabs: ±15–60 ms. The iframe is click-through so every control goes through the room.
* Requires internet access to youtube.com. YouTube's own ads are not suppressed and each viewer's player plays them on their own schedule, which can cause a brief resync. Non-YouTube direct video URLs still work if pasted (plain `<video>` player), but the UI only advertises YouTube.

## Interface and keyboard shortcuts

Dark, responsive UI (desktop, tablet, phone) with a landing page, a room view and a custom player control bar. Icons are an inline Lucide-style SVG set (`public/icons.js`); there are no external UI dependencies or build step. Side panel (Chat / Discover / Queue / Polls / People) can be hidden, and **theater mode** gives the player the full width with the panel as an overlay. On-screen indicators confirm play, pause, seek, mute and volume (including what other people did), the seek bar shows a time preview on hover, and reaction hot-spots are drawn on the timeline.

All shortcuts live in one manager (`public/shortcuts.js`) and act on the real player. They are also reachable with the mouse; nothing is keyboard-only. Press **?** in a room to see the same list (generated from the bindings, so it only shows what is supported).

| Keys | Action |
|---|---|
| Space or K | Play / pause (synchronised for the room) |
| ← / → | Seek 5 s back / forward |
| Shift+← / Shift+→, J / L | Seek 10 s back / forward |
| M | Mute / unmute |
| ↑ / ↓ | Volume up / down |
| F | Fullscreen |
| T | Theater mode |
| Esc | Close dialog, then exit theater / fullscreen, or leave a text field |
| / | Focus the chat box |
| Enter, Ctrl/Cmd+Enter | Send message (Shift+Enter for a new line) |
| ? | Show / hide the shortcut help |

Rules: shortcuts never fire while typing in an input, textarea, select or contenteditable (except Esc and Ctrl/Cmd+Enter in the composer); while a dialog is open only Esc and ? work; Space/Enter on a focused button and arrows on sliders/tabs keep their native behaviour; Ctrl/Cmd/Alt combinations are left to the browser; held keys repeat only for seeks and volume. In a host-only room non-hosts get a clear message instead of a silent no-op, and local actions (mute, volume, theater) still work.

**Not provided, deliberately:** captions (`C`) and picture-in-picture, because the YouTube IFrame API exposes no reliable way to toggle them; they are neither bound nor listed in the help.

## Protocol (JSON over WebSocket `/ws`)

Client → server: `join`, `ping`, `control{action: play|pause|seek, position, aid}`, `setVideo{catalogId|url}`, `ended{token}`, `report{drift, rtt, buffering, duration, token}`, `chat`, `react`, `queue.add|remove|vote|play`, `poll.create|vote|close`, `host.transfer|kick`, `settings{controlMode}`.
Server → client: `welcome` (snapshot), `state`, `presence`, `health`, `chat`, `reaction`, `playlist`, `polls`, `pong`, `error`, `kicked`.
HTTP: `POST /api/rooms`, `GET /api/rooms/:code`, `GET /api/movies?q=&genre=&viewsMin=&durMin=&durMax=&sort=`, `GET /api/categories`, `GET /api/recommendations?room=`, `GET /api/metrics`.

## Layout

```
server/index.js    HTTP + WebSocket, rate limiting, heartbeats
server/room.js     room state machine: playback, members, host, queue, polls, reactions
server/catalog.js + catalog.json  YouTube video data;  server/search.js  fuzzy search, filters, categories, recommendations
public/            vanilla JS client: app.js (UI + players), shortcuts.js (keyboard manager), icons.js, sync-core.js (shared with Node tests), probe.html
test/              node:test suites;  scripts/  load test, headless client, drift simulator
docs/LATENCY.md    measurements, test conditions, failure handling
```

## Honest limitations
* **Catalog is a snapshot** of 39 curated YouTube videos; view counts and lengths are from build time. Anything else: paste a link.
* Only HTML5-playable sources (mp4/webm) and YouTube. No DRM streaming services (Netflix etc.) — their players can't be driven.
* Rooms are in memory (a server restart ends them); no accounts or auth — anyone with the code can join.
* Latency was measured on loopback; drift was validated by simulation plus a two-tab browser check, not on a fleet of real devices.
* Background browser tabs are throttled by the browser, which can cause brief drift until the tab is active again.
