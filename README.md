# 🍿 Watch Party

Watch YouTube videos together, in perfect sync. Create a room, share the link, and everyone's player plays, pauses and seeks as one. Live chat, emoji reactions, a shared queue, group polls and a searchable movie catalog are built in.

**Live demo:** https://watch-party-ruby.vercel.app
*(The real-time server runs on Render's free plan and sleeps when idle, so the first visit after a quiet spell can take 30–60 seconds. See [Deployment](#deployment).)*

- [Features](#features)
- [Quick start](#quick-start)
- [Using the app](#using-the-app)
- [How it works](#how-it-works)
- [The video catalog](#the-video-catalog)
- [Deployment](#deployment)
- [Configuration reference](#configuration-reference)
- [Mobile and touch](#mobile-and-touch)
- [Testing and performance](#testing-and-performance)
- [API and protocol](#api-and-protocol)
- [Project structure](#project-structure)
- [Limitations](#limitations)

## Features

**Watching together**
- Create or join rooms with an invite link or a 6-character code. Rooms hold 10+ people (tested at 50, capped at 100).
- Synchronised play, pause and seek. A shared server clock plus automatic drift correction keeps everyone within a fraction of a second.
- Late joiners land on the right frame. Dropped connections rejoin the same seat, and simultaneous clicks resolve to one outcome for everybody.
- A new video starts on a short shared countdown so every player has loaded first. When a video ends, **Replay** restarts the whole room.

**Social**
- Live chat with grouped messages, timestamps and unread badges.
- Emoji reactions that float over the video, and show as hot-spots on the seek bar so you can see where the room reacted.
- A shared queue sorted by votes that plays the next video automatically.
- Group polls, including "what should we watch next?" polls whose winner jumps to the top of the queue.
- Host controls: transfer hosting, remove people, or restrict playback control to the host. If the host drops, hosting passes on automatically after a short grace period.

**Discovery**
- A catalog of real YouTube videos (movies, trailers, music, shorts, documentaries), with category rows, genre chips, popularity, length and sort filters.
- Typo-tolerant fuzzy search, and recommendations based on what the room has watched, queued and voted for.
- Paste any YouTube link to play or queue it for the room.

**Interface**
- Dark, responsive UI for desktop, tablet and phone, with a custom player control bar that fades out while you watch.
- Full keyboard control with a built-in shortcut help (press `?`), theater mode, and fullscreen everywhere including iPhones.
- Touch gestures, 44 px touch targets and landscape layouts on phones.

## Quick start

Requires Node.js 18 or newer. There is one dependency (`ws`) and no build step.

```bash
git clone https://github.com/arpitt-007/Watch_party.git
cd Watch_party
npm install
npm start            # http://localhost:3000
```

Open the app in two browser windows, create a room in one and join from the other. To try it on a phone or another computer on the same Wi-Fi, open `http://<your-computer's-IP>:3000` (and allow Node through the firewall if asked).

| Command | What it does |
|---|---|
| `npm start` | Run the server (serves the pages and the API/WebSocket) |
| `npm run dev` | Same, but restarts automatically when server code changes |
| `npm test` | Run the full test suite (43 tests, no network needed) |
| `npm run check` | Syntax-check all JavaScript |
| `npm run loadtest` | Latency, convergence and reconnect benchmark (see [docs/LATENCY.md](docs/LATENCY.md)) |
| `npm run verify-catalog` | Re-check every catalog video against YouTube |
| `npm run prune` | Remove videos recorded as unplayable from the catalog |
| `npm run build:vercel` | The Vercel build step (writes `public/config.js` from `BACKEND_URL`) |

> **If a server-side change seems to have no effect,** restart the server. The browser reloads page files on refresh, but the Node process keeps running old code until it is restarted. `npm run dev` avoids this.

## Using the app

1. Enter your name and press **Create a room**, or enter a room code (or open an invite link) and press **Join**.
2. Open **Discover**, pick something and press **Play**. Everyone in the room starts together.
3. Use **Chat**, **Queue**, **Polls** and **People** in the side panel. **Invite** copies the link (or opens the share sheet on a phone).

### Keyboard shortcuts

Press `?` in a room to see this list. Shortcuts act on the real player, and everything also works with the mouse or touch.

| Keys | Action |
|---|---|
| Space or K | Play / pause (for the whole room) |
| ← / → | Seek 5 s back / forward |
| Shift+← / Shift+→, J / L | Seek 10 s back / forward |
| M | Mute / unmute |
| ↑ / ↓ | Volume up / down |
| F | Fullscreen |
| T | Theater mode |
| Esc | Close the open dialog, then exit theater mode or fullscreen, or leave a text field |
| / | Focus the chat box |
| Enter, Ctrl/Cmd+Enter | Send a message (Shift+Enter for a new line) |
| ? | Show / hide shortcut help |

Shortcuts never fire while you type in a text field, and only Esc and `?` work while a dialog is open. Space and Enter on a focused button, and arrow keys on sliders and tabs, keep their normal behaviour. Ctrl/Cmd/Alt combinations are left to the browser. In a host-only room, non-hosts get a clear message instead of a silent no-op. Captions and picture-in-picture are not offered, because the YouTube player API gives no reliable way to toggle them.

## How it works

```
 browser ──control{play|pause|seek}──▶ server ──state{playing,pos,at,seq}──▶ every browser
```

1. **The server owns the clock.** Playback state is `{playing, pos, at, seq}`, meaning "at server time `at` the video was at `pos`, and advances at 1× if `playing`". The position right now is `pos + (serverNow − at)`. Clients only ask for play, pause or seek; they never tell the room where they are. A pause takes its position from the server clock, not from whoever clicked.
2. **Clock sync.** Each client pings every 3 s (six quick pings when it joins) and estimates the server clock NTP-style, averaging the lowest-latency third of samples. Network delay is compensated instead of added to the error.
3. **Drift correction (every 250 ms).** `drift = currentTime − expected`. Under 40 ms: nothing. Up to 350 ms: nudge the playback rate by up to ±8 % (imperceptible). Beyond that: seek, with a cooldown so a slow re-buffer doesn't cause seek storms. YouTube's player only allows fixed playback rates, so for YouTube drift is corrected by seeking only (threshold 450 ms).
4. **Concurrency.** One server thread handles all actions in order. Every accepted change bumps `seq`, the last action wins, and clients ignore stale updates. Pressing play on a playing video (or pause on a paused one) is a no-op, so two people clicking together don't toggle it back. Every action carries an id, so a retry after a reconnect is applied once.
5. **Late joins.** The welcome message carries a full snapshot (video, position, chat, queue, polls, roster). The client loads the video and seeks to the *expected* position.
6. **Reconnection.** Identity is a per-tab id stored in `sessionStorage`. After a refresh or network drop you return to the same seat. Hosting is kept through an 8 s grace period, and members are kept for 30 s.
7. **Video end and replay.** When a video ends, the room parks at the end and shows a **Video ended** card. **Replay** (or Space) restarts the room from 0:00 for everyone. If the queue has items, the next one starts automatically.

## The video catalog

The catalog (`server/catalog.json`) holds 37 real YouTube videos: 7 full public-domain movies, 12 official trailers, 2 music videos, 11 Blender animated shorts, 4 documentaries and 1 comedy clip. You can also paste any YouTube link (`watch`, `youtu.be`, `/shorts/` or `/embed/`). The server checks it with YouTube's oEmbed endpoint first and rejects videos that are private, removed, or have embedding disabled.

**Embedding restrictions the server can't see.** Whether a video plays can depend on the viewer's region or browser. So the app adapts at run time:
- If a viewer's player refuses a video (error 2, 100, 101 or 150), the room skips to the next queued video.
- On a private or local setup, that video is also **blocked**: hidden from Discover and recommendations, and remembered in `server/blocked.json` (git-ignored; delete the file to reset). Public deployments turn this off (`AUTO_BLOCK=0`) so one visitor can't hide videos for everyone.
- `npm run verify-catalog` re-checks every video from the server's point of view.
- Open `/probe.html` in your own browser, keep the tab in front, and it plays every catalog video muted and records the ones YouTube refuses for you. Then run `npm run prune` to remove them from `server/catalog.json`.

**Updating the catalog:** edit `server/catalog.json` (`id`, `title`, `category`, `year`, `genres`, `tags`, `description`, `channel`, `durationSec`, `views`). The videos are third-party uploads and can disappear or change at any time, so the full-movie re-uploads in particular may need replacing.

**Search all of YouTube (optional):** set `YOUTUBE_API_KEY` (a YouTube Data API v3 key) on the server to show a *Search YouTube* box. Without a key the box is hidden. This path has not been tested against the live API.

YouTube's own ads are not suppressed, and each viewer's player plays them on its own schedule, which can cause a brief resync.

## Deployment

The app has two parts:

| Part | What it is | Where it can run |
|---|---|---|
| **Pages** | Static files in `public/` | Anywhere, including Vercel |
| **Real-time server** | Node process in `server/`: REST API and WebSocket, with rooms held in memory | Any host that runs a long-lived Node process (Render, Railway, Fly.io, a VPS, your own computer) |

Vercel runs short-lived serverless functions. It cannot keep WebSocket connections open or hold room state between requests, so **the real-time server cannot run on Vercel**. The live site therefore uses a split deployment:

```
 browser ──https──▶ Vercel   (static pages: public/)
    │
    └──wss / https──▶ Render  (Node server: API + WebSocket, server/)
```

The pages learn the server's address from `public/config.js`. It is empty by default (same origin) and is written at build time on Vercel from the `BACKEND_URL` environment variable.

### Option A: Vercel pages + Render server (what the live site uses)

**1. Deploy the real-time server on Render (free plan)**
1. Push this repository to GitHub.
2. In Render, choose **New +** → **Blueprint** and select the repository. Render reads [`render.yaml`](render.yaml), which sets the build and start commands, the Node version, the health check (`/healthz`) and `AUTO_BLOCK=0`.
3. When prompted for `ALLOWED_ORIGIN`, enter your Vercel site's address (for example `https://watch-party-ruby.vercel.app`). If you don't know it yet, leave it empty (any website may then connect) and set it later.
4. Wait for the deploy to finish and copy the service URL, for example `https://watch-party-server-03wr.onrender.com`. Opening `<that URL>/healthz` should return `{"ok":true}`.

**2. Deploy the pages on Vercel**
1. Import the repository in Vercel, or use the CLI as below. [`vercel.json`](vercel.json) already configures the static output (`public/`) and the build step (`node scripts/build-vercel.js`), so leave the framework preset as *Other*.
2. Set the environment variable `BACKEND_URL` to the Render service URL (https, no trailing path), for **Production**.
3. Deploy. With the CLI:
   ```bash
   npm i -g vercel
   vercel login
   vercel link                          # create / connect the project
   vercel env add BACKEND_URL production   # paste the Render URL when asked
   vercel deploy --prod
   ```
4. Once Vercel gives you the final site address, set `ALLOWED_ORIGIN` on Render to exactly that (scheme and host, no path or trailing slash; several origins may be comma separated). Render redeploys automatically.

**3. Check it works.** Open the Vercel site, create a room, start a video and join from a second browser tab with the invite link. Vercel redeploys on every push to the connected branch.

### Option B: everything on one host

Deploy the repository to a single Node host (Render, Railway, Fly.io, a VPS, …) with build command `npm ci --omit=dev` and start command `npm start`. The server serves both the pages and the API, so leave `public/config.js` untouched and `BACKEND_URL` unset. Set `AUTO_BLOCK=0` for a public instance.

### Option C: your own network

`npm start` on any computer, then share `http://<its-IP>:3000` with people on the same network. For friends outside your network, use a tunnelling tool or Option A/B.

### Free-plan behaviour and troubleshooting

- **Sleeping server.** Render's free plan stops the service after about 15 minutes without traffic. The next visit wakes it in 30–60 seconds (the page shows "Waking up the server…"). Rooms live in memory, so they end whenever the server sleeps or restarts. For always-on rooms, use a paid instance or an uptime pinger on `/healthz`.
- **"Server is not responding" / room won't create.** The server may still be waking up (wait a minute and retry), `BACKEND_URL` may be wrong or missing (check `https://<your-site>/config.js`, which should contain your Render URL), or `ALLOWED_ORIGIN` may not match the site's exact address. Browsers treat each address as its own origin, so a Vercel preview URL is *not* the same origin as the production domain and needs to be listed too.
- **Changed `BACKEND_URL`?** It is baked in at build time, so redeploy the Vercel project.
- **"Address already in use" locally.** Another copy is already running on port 3000. Stop it, or set `PORT`.
- **Vercel preview URLs asking for a login.** That is Vercel's deployment protection for non-production URLs. Share the production domain.
- **Custom domains.** Add the domain in Vercel, then add its origin to `ALLOWED_ORIGIN` on Render.

## Configuration reference

All settings are environment variables on the **server**, except `BACKEND_URL`, which belongs to the **Vercel build**.

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `PORT` | server | `3000` | Port to listen on (Render sets this itself) |
| `ALLOWED_ORIGIN` | server | any origin | Comma-separated list of site origins allowed to call the API and open WebSockets. Empty or `*` allows any |
| `AUTO_BLOCK` | server | on | `0` = public mode: unplayable videos are skipped for the room but not hidden for everyone, and `POST /api/blocked` is disabled |
| `ADMIN_TOKEN` | server | unset | If set, `POST /api/blocked` requires an `X-Admin-Token` header with this value |
| `YOUTUBE_API_KEY` | server | unset | Enables the optional *Search YouTube* box |
| `WP_BLOCKED_FILE` | server | `server/blocked.json` | Where blocked videos are remembered |
| `BACKEND_URL` | Vercel build | unset | Real-time server address written into `public/config.js` (`https://…`, or `http://localhost…` for local tests) |

## Mobile and touch

Checked at 320, 360, 375, 414, 600 and 768 px wide and in phone landscape (812×375), with no horizontal overflow and the header, Leave button and message box always on screen.

- **Portrait phones and small tablets:** the room is one fixed screen (header, player, now-playing and reactions, panel). The page itself never scrolls, so the video can't scroll away, and the chat box stays pinned at the bottom (it follows the on-screen keyboard).
- **Phone landscape:** video on the left, panel on the right.
- **Touch targets:** on touch devices every button, tab, chip, option and the seek bar are at least 44 px. Inputs are 16 px so iOS doesn't zoom, hover-only UI is replaced by always-visible controls, and notch and home-bar spacing is respected.
- **Gestures:** the first tap on a video with hidden controls only reveals them, and a later tap plays or pauses. Double-tap the left or right third to seek 10 s back or forward; double-tap the middle for fullscreen. A double-tap sends a single seek.
- **Autoplay blocked:** if the browser refuses to start the video, a "Tap to join playback" prompt appears (only while the room is actually playing).
- **Fullscreen:** the button is always shown. It uses the browser's Fullscreen API where available. On iPhone Safari, which only offers fullscreen for bare video elements, or when a browser refuses, the player fills the whole screen instead (rotate the phone for a landscape picture). Android Chrome also tries to lock landscape.

## Testing and performance

```bash
npm test
```

43 tests with no network needed, covering: rooms, host and permission rules, synchronised control, concurrent actions, duplicate retries, late joins, reconnects, queue and auto-advance, polls, chat limits, replay, fuzzy search and filters, YouTube link handling, the sync algorithm (including a closed-loop drift simulation), the keyboard manager's rules, and the split-deployment behaviour (CORS, origin checks, public mode, the Vercel build step).

Measured on one machine over loopback (see [docs/LATENCY.md](docs/LATENCY.md) for method and caveats):

| | Result | Requirement |
|---|---|---|
| Control propagation, 10–50 users | p95 ≈ 2–4 ms | ≤ 250 ms at p95 on a local network |
| Playback drift after correction | ≤ ~120 ms (simulation) | ≤ 500 ms |
| Concurrent conflicting actions | 30 / 30 rounds converged at 10, 25 and 50 users | n/a |

Drift was validated by simulation plus a two-browser check, not on a fleet of real devices. Over the real Internet (live deployment, Vercel page to Render server) a round trip took about 240 ms and playback drift stayed under 50 ms.

## API and protocol

HTTP (JSON): `POST /api/rooms`, `GET /api/rooms/:code`, `GET /api/movies?q=&genre=&viewsMin=&durMin=&durMax=&sort=`, `GET /api/categories`, `GET /api/recommendations?room=`, `GET /api/youtube/search?q=`, `GET /api/metrics`, `GET /healthz`, `POST /api/blocked`.

WebSocket at `/ws` (JSON messages):
- Client → server: `join`, `ping`, `control {action: play|pause|seek, position, aid}`, `setVideo {catalogId | url}`, `ended`, `unplayable`, `report`, `chat`, `react`, `queue.add|remove|vote|play`, `poll.create|vote|close`, `host.transfer|kick`, `settings`.
- Server → client: `welcome` (full snapshot), `state`, `presence`, `health`, `chat`, `reaction`, `playlist`, `polls`, `pong`, `error`, `kicked`.

## Project structure

```
server/
  index.js          HTTP + WebSocket server, CORS, rate limiting, heartbeats
  room.js           room state machine: playback, members, host, queue, polls, reactions
  catalog.js        loads catalog.json, remembers blocked videos
  catalog.json      the YouTube video catalog
  search.js         fuzzy search, filters, categories, recommendations
public/
  index.html        landing page, room view, dialogs
  app.js            UI, players (HTML5 + YouTube), sync loop, controls, chat, discover
  shortcuts.js      keyboard shortcut manager
  sync-core.js      clock sync + drift correction (shared with the tests)
  icons.js          inline SVG icon set
  style.css         styles (responsive, touch, reduced motion)
  config.js         runtime config (backend address)
  probe.html        in-browser catalog checker
scripts/            load test, drift simulator, catalog tools, Vercel build step
test/               node:test suites
docs/LATENCY.md     measurements, test conditions, failure handling
render.yaml         Render Blueprint for the real-time server
vercel.json         Vercel configuration for the pages
```

## Limitations

- **Rooms live in memory.** A server restart ends them, and so does Render's free plan going to sleep. There are no accounts, and anyone with a room code can join.
- **YouTube only.** The player is YouTube's embedded player, so videos must allow embedding, ads play on each viewer's own schedule, and DRM streaming services (Netflix and similar) can't be used. Captions and picture-in-picture aren't available.
- **The catalog is a snapshot** of 37 curated videos. Links to third-party uploads can break, and view counts and lengths date from when it was built. Pasting a link always works for any embeddable video.
- **Sync precision on YouTube** is slightly coarser than for plain video files, since YouTube's player can't adjust playback speed in small steps.
- **Public instances** have no per-IP connection limits beyond per-connection rate limiting and room caps, so put a rate-limiting proxy in front of anything heavily exposed.
- Background browser tabs are throttled by the browser, which can cause brief drift until the tab is active again.

## License

MIT, as declared in `package.json`.
