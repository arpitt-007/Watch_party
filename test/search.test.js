'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { searchMovies, categories, recommend, editDistance } = require('../server/search');

const top = (q, o = {}) => (searchMovies({ q, ...o })[0] || {}).title;

test('fuzzy search tolerates typos, transpositions and partial words', () => {
  assert.strictEqual(top('sintl'), 'Sintel');
  assert.strictEqual(top('snitel'), 'Sintel');
  assert.strictEqual(top('elephnt dream'), 'Elephants Dream');
  assert.strictEqual(top('tears stel'), 'Tears of Steel');
  assert.strictEqual(top('bunny'), 'Big Buck Bunny');
  assert.strictEqual(searchMovies({ q: 'xyzzyqq' }).length, 0);
});

test('search matches genres, tags and people', () => {
  assert.ok(searchMovies({ q: 'dragon' }).some((m) => m.id === 'sintel'));
  assert.ok(searchMovies({ q: 'blender' }).length >= 4);
});

test('filters combine', () => {
  const r = searchMovies({ genres: ['Animation'], ratingMin: 7 });
  assert.ok(r.length >= 2 && r.every((m) => m.genres.includes('Animation') && m.rating >= 7));
  const s = searchMovies({ durationMax: 60 });
  assert.ok(s.length && s.every((m) => m.durationSec <= 60));
  const both = searchMovies({ genres: ['Animation', 'Sci-Fi'], allGenres: true });
  assert.ok(both.every((m) => m.genres.includes('Animation') && m.genres.includes('Sci-Fi')));
  assert.deepStrictEqual(searchMovies({ sort: 'year' }).map((m) => m.year), searchMovies({ sort: 'year' }).map((m) => m.year).sort((a, b) => b - a));
});

test('categories and recommendations', () => {
  assert.ok(categories().length >= 5);
  const recs = recommend({ watched: ['bbb'], queued: [], liked: [] });
  assert.ok(!recs.some((m) => m.id === 'bbb'));
  assert.ok(recs[0].genres.some((g) => ['Animation', 'Comedy', 'Family'].includes(g)), 'leans toward genres of what was watched');
  assert.ok(editDistance('kitten', 'sitting', 5) === 3);
});
