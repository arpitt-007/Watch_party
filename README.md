# 🍿 Watch Party

Watch YouTube videos together, in sync. Create a room, share the link, and everyone's player plays, pauses and seeks as one. Includes live chat, reactions, a shared queue, polls and movie search.

**Live:** https://watch-party-ruby.vercel.app

## Run locally

```bash
npm install
npm start        # http://localhost:3000
npm test         # run the tests
```

## Deploy

Vercel can't run the live WebSocket server, so the app is split in two:

1. **Server on Render:** New + → Blueprint → select this repo (uses `render.yaml`). Set `ALLOWED_ORIGIN` to your Vercel site's URL.
2. **Pages on Vercel:** import this repo, set the environment variable `BACKEND_URL` to the Render URL, and deploy (uses `vercel.json`).

Render's free plan sleeps when idle, so the first visit can take up to a minute, and rooms end when it sleeps.

## Shortcuts

Press `?` in a room to see them. Space/K play-pause, ←/→ seek, M mute, F fullscreen, `/` chat.
