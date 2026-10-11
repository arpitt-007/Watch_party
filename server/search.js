'use strict';
const { movies, genres } = require('./catalog');

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Damerau-Levenshtein (optimal string alignment) with early exit above `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

// Score of one query token against one field token, 0..1.
function tokenScore(q, t) {
  if (q === t) return 1;
  if (q.length >= 2 && t.startsWith(q)) return 0.9;
  if (q.length >= 3 && t.includes(q)) return 0.7;
  const allowed = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
  if (allowed) {
    const d = editDistance(q, t, allowed);
    if (d <= allowed) return 0.8 - 0.2 * (d - 1);
    // typo inside a prefix of a longer word ("elephnt" vs "elephants")
    if (t.length > q.length) {
      const d2 = editDistance(q, t.slice(0, q.length + 1), allowed);
      if (d2 <= allowed) return 0.6 - 0.1 * (d2 - 1);
    }
  }
  return 0;
}

const FIELD_WEIGHTS = { title: 3, genres: 1.6, tags: 1.4, people: 1.2, description: 0.5 };

const index = movies.map((m) => ({
  m,
  fields: {
    title: norm(m.title).split(' '),
    genres: norm(m.genres.join(' ')).split(' '),
    tags: norm(m.tags.join(' ')).split(' ').filter(Boolean),
    people: norm([m.director, ...m.cast].join(' ')).split(' ').filter(Boolean),
    description: norm(m.description).split(' ').filter((w) => w.length > 3),
  },
}));

function scoreMovie(entry, qTokens) {
  let total = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const [field, tokens] of Object.entries(entry.fields)) {
      let fieldBest = 0;
      for (const t of tokens) {
        const s = tokenScore(q, t);
        if (s > fieldBest) fieldBest = s;
      }
      best = Math.max(best, fieldBest * FIELD_WEIGHTS[field]);
    }
    if (best < 0.3) return 0; // every query token must match something (fuzzily)
    total += best;
  }
  return total / qTokens.length;
}

function searchMovies(opts = {}) {
  const q = norm(opts.q || '');
  const qTokens = q ? q.split(' ') : [];
  const want = (opts.genres || []).map(norm);
  const matchAll = !!opts.allGenres;
  const yearMin = Number.isFinite(opts.yearMin) ? opts.yearMin : -Infinity;
  const yearMax = Number.isFinite(opts.yearMax) ? opts.yearMax : Infinity;
  const ratingMin = Number.isFinite(opts.ratingMin) ? opts.ratingMin : -Infinity;
  const durMin = Number.isFinite(opts.durationMin) ? opts.durationMin : -Infinity;
  const durMax = Number.isFinite(opts.durationMax) ? opts.durationMax : Infinity;
  const exclude = new Set(opts.exclude || []);

  const rows = [];
  for (const entry of index) {
    const m = entry.m;
    if (exclude.has(m.id)) continue;
    if (m.year < yearMin || m.year > yearMax || m.rating < ratingMin || m.durationSec < durMin || m.durationSec > durMax) continue;
    if (want.length) {
      const have = m.genres.map(norm);
      const ok = matchAll ? want.every((g) => have.includes(g)) : want.some((g) => have.includes(g));
      if (!ok) continue;
    }
    let score = 1;
    if (qTokens.length) {
      score = scoreMovie(entry, qTokens);
      if (!score) continue;
    }
    rows.push({ m, score });
  }
  const sort = opts.sort || (qTokens.length ? 'relevance' : 'rating');
  const cmp = {
    relevance: (a, b) => b.score - a.score || b.m.rating - a.m.rating,
    rating: (a, b) => b.m.rating - a.m.rating,
    year: (a, b) => b.m.year - a.m.year,
    duration: (a, b) => a.m.durationSec - b.m.durationSec,
    title: (a, b) => a.m.title.localeCompare(b.m.title),
  }[sort] || ((a, b) => b.score - a.score);
  rows.sort(cmp);
  return rows.map((r) => ({ ...r.m, score: Math.round(r.score * 100) / 100 }));
}

// Home-screen rows.
function categories() {
  const rows = [];
  rows.push({ id: 'top', title: 'Top rated', items: searchMovies({ sort: 'rating' }).slice(0, 8) });
  rows.push({ id: 'short', title: 'Quick watch (under 5 min)', items: searchMovies({ durationMax: 300, sort: 'rating' }) });
  rows.push({ id: 'feature', title: 'Settle in (9+ min)', items: searchMovies({ durationMin: 540, sort: 'rating' }) });
  rows.push({ id: 'new', title: 'Newest', items: searchMovies({ sort: 'year' }).slice(0, 6) });
  for (const g of genres) {
    const items = searchMovies({ genres: [g], sort: 'rating' });
    if (items.length >= 2) rows.push({ id: 'g-' + g, title: g, items });
  }
  return rows;
}

// Group recommendations: genre affinity from what the room watched / queued / voted for.
function recommend({ watched = [], queued = [], liked = [] }, limit = 6) {
  const weights = {};
  const bump = (ids, w) => ids.forEach((id) => {
    const m = movies.find((x) => x.id === id);
    if (m) m.genres.forEach((g) => { weights[g] = (weights[g] || 0) + w / m.genres.length; });
  });
  bump(watched, 2); bump(queued, 1); bump(liked, 1.5);
  const seen = new Set(watched);
  return movies.filter((m) => !seen.has(m.id)).map((m) => {
    const affinity = m.genres.reduce((s, g) => s + (weights[g] || 0), 0) / m.genres.length;
    const top = m.genres.filter((g) => weights[g]).sort((a, b) => weights[b] - weights[a])[0];
    return { ...m, score: affinity + m.rating / 20, reason: top ? `Because your room likes ${top}` : 'Highly rated' };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { searchMovies, categories, recommend, editDistance, norm };
