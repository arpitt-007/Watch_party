'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { searchMovies, categories, recommend, editDistance } = require('../server/search');
const catalog = require('../server/catalog');

const top = (q, o = {}) => (searchMovies({ q, ...o })[0] || {}).title;

test('catalog contains only YouTube videos with valid ids and the metadata the UI needs', () => {
  assert.ok(catalog.movies.length >= 40);
  for (const m of catalog.movies) {
    assert.match(m.ytId, /^[A-Za-z0-9_-]{11}$/, m.title);
    assert.strictEqual(m.source, 'youtube');
    assert.ok(m.durationSec > 0 && m.views >= 0 && m.genres.length && m.title, m.title);
  }
  assert.strictEqual(new Set(catalog.movies.map((m) => m.id)).size, catalog.movies.length, 'unique ids');
});

test('fuzzy search tolerates typos, transpositions and partial words', () => {
  assert.match(top('bohemian rapsody'), /Bohemian Rhapsody/);
  assert.match(top('inceptoin'), /Inception/);
  assert.match(top('interstelar'), /Interstellar/);
  assert.match(top('nosfratu'), /Nosferatu/);
  assert.match(top('gangnam'), /Gangnam/);
  assert.match(top('thriler michael'), /Thriller/);
  assert.strictEqual(searchMovies({ q: 'xyzzyqq' }).length, 0);
});

test('search matches genres, tags and channels', () => {
  assert.ok(searchMovies({ q: 'dragon' }).some((m) => m.title === 'Sintel'));
  assert.ok(searchMovies({ q: 'blender' }).length >= 6);
  assert.ok(searchMovies({ q: 'kurzgesagt' }).length >= 2);
  assert.ok(searchMovies({ q: 'zombies' }).some((m) => /Living Dead/.test(m.title)));
});

test('filters combine', () => {
  const r = searchMovies({ genres: ['Music'], viewsMin: 1e8 });
  assert.ok(r.length >= 5 && r.every((m) => m.genres.includes('Music') && m.views >= 1e8));
  const s = searchMovies({ durationMax: 300 });
  assert.ok(s.length && s.every((m) => m.durationSec <= 300));
  const both = searchMovies({ genres: ['Sci-Fi', 'Trailer'], allGenres: true });
  assert.ok(both.length >= 3 && both.every((m) => m.genres.includes('Sci-Fi') && m.genres.includes('Trailer')));
  const long = searchMovies({ genres: ['Full Movie'] });
  assert.ok(long.length >= 6 && long.every((m) => m.durationSec > 600), 'full movies are not clips');
  const v = searchMovies({ sort: 'views' }).map((m) => m.views);
  assert.deepStrictEqual(v, [...v].sort((a, b) => b - a));
  const y = searchMovies({ sort: 'year' }).map((m) => m.year);
  assert.deepStrictEqual(y, [...y].sort((a, b) => b - a));
});

test('categories and recommendations', () => {
  const rows = categories();
  assert.ok(rows.length >= 8);
  assert.ok(['movies', 'trailers', 'music'].every((id) => rows.some((r) => r.id === id)));
  const queen = catalog.movies.find((m) => /Bohemian/.test(m.title)).id;
  const recs = recommend({ watched: [queen], queued: [], liked: [] });
  assert.ok(!recs.some((m) => m.id === queen));
  assert.ok(recs.slice(0, 3).some((m) => m.genres.includes('Music')), 'leans toward genres of what was watched');
  assert.ok(editDistance('kitten', 'sitting', 5) === 3);
});
