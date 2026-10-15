'use strict';
// Catalog of real YouTube videos (full public-domain movies, official trailers, official music videos, Blender
// open movies, documentaries, comedy). catalog.json was curated and verified (every video existed and allowed
// embedding when it was generated; lengths and view counts are from that day). The `id` is the YouTube video id.
const fs = require('fs');
const path = require('path');
const raw = require('./catalog.json');

const EMOJI = { Movie: '🎞️', Trailer: '🎬', Music: '🎵', Short: '🎨', Docs: '🌍', Comedy: '😂' };
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const thumbFor = (ytId) => `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`;

const movies = raw.map((r) => ({
  ...r,
  genres: r.category === 'Movie' ? ['Full Movie', ...r.genres] : r.genres,
  source: 'youtube', ytId: r.id, src: 'https://www.youtube.com/watch?v=' + r.id,
  thumb: thumbFor(r.id), emoji: EMOJI[r.category] || '▶️', hue: hash(r.id),
}));

const byId = new Map(movies.map((m) => [m.id, m]));
const genreCount = {};
movies.forEach((m) => m.genres.forEach((g) => { genreCount[g] = (genreCount[g] || 0) + 1; }));
const genres = Object.keys(genreCount).sort((a, b) => genreCount[b] - genreCount[a] || a.localeCompare(b));

// Videos that a viewer's player reported as unplayable (embedding disabled, removed, region-locked...) are hidden from
// browsing and recommendations. Persisted so the knowledge survives restarts; delete the file to reset.
const blockedFile = process.env.WP_BLOCKED_FILE || path.join(__dirname, 'blocked.json');
const blocked = new Map();
try { for (const [id, info] of Object.entries(JSON.parse(fs.readFileSync(blockedFile, 'utf8')))) blocked.set(id, info); } catch (e) { /* none yet */ }
function block(id, code) {
  if (process.env.AUTO_BLOCK === '0') return false; // public deployments: one visitor must not hide a video for everybody
  if (!byId.has(id) || blocked.has(id)) return false;
  blocked.set(id, { code: Number(code) || null, at: new Date().toISOString() });
  try { fs.writeFileSync(blockedFile, JSON.stringify(Object.fromEntries(blocked), null, 1)); } catch (e) { /* read-only disk: keep in memory */ }
  return true;
}

function toVideo(m) {
  return { id: m.id, title: m.title, source: 'youtube', ytId: m.ytId, src: m.src, thumb: m.thumb, emoji: m.emoji, hue: m.hue };
}

module.exports = { movies, byId, genres, toVideo, thumbFor, blocked, block };
