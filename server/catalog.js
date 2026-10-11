'use strict';
// Curated catalog of freely streamable titles (Blender open movies, CC0 clips). Sources are public hosts that
// support HTTP range requests (needed for seeking). Metadata is hand-curated; durations are approximate.
const movies = [
  { id: 'bbb', title: 'Big Buck Bunny', year: 2008, genres: ['Animation', 'Comedy', 'Family'], rating: 7.6, durationSec: 596,
    director: 'Sacha Goedegebure', cast: ['Big Buck', 'Frank', 'Rinky', 'Gimera'], tags: ['rabbit', 'bunny', 'forest', 'revenge', 'blender', 'slapstick'],
    description: 'A giant rabbit with a heart bigger than himself gets fed up with three bullying rodents and plans a gloriously elaborate revenge.',
    emoji: '🐰', hue: 130, src: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4' },
  { id: 'sintel', title: 'Sintel', year: 2010, genres: ['Animation', 'Fantasy', 'Adventure', 'Drama'], rating: 7.5, durationSec: 888,
    director: 'Colin Levy', cast: ['Sintel', 'Scales'], tags: ['dragon', 'quest', 'warrior', 'blender', 'emotional', 'epic'],
    description: 'A lonely young woman searches the world for the baby dragon she befriended, in a journey that ends somewhere she never expected.',
    emoji: '🐉', hue: 20, src: 'https://archive.org/download/Sintel/sintel-2048-surround.mp4' },
  { id: 'tears', title: 'Tears of Steel', year: 2012, genres: ['Sci-Fi', 'Action', 'Drama'], rating: 6.5, durationSec: 734,
    director: 'Ian Hubert', cast: ['Derek de Lint', 'Sergio Hasselbaink'], tags: ['robots', 'amsterdam', 'future', 'blender', 'vfx', 'war'],
    description: 'A group of warriors and scientists try to save the world from a robot onslaught by revisiting a moment in the past.',
    emoji: '🤖', hue: 210, src: 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov' },
  { id: 'elephants', title: 'Elephants Dream', year: 2006, genres: ['Animation', 'Sci-Fi', 'Fantasy'], rating: 6.2, durationSec: 653,
    director: 'Bassam Kurdali', cast: ['Proog', 'Emo'], tags: ['surreal', 'machine', 'dream', 'blender', 'first open movie', 'weird'],
    description: 'Two strange characters explore a capricious and seemingly infinite machine in the first ever Blender open movie.',
    emoji: '🐘', hue: 280, src: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4' },
  { id: 'trailer', title: 'Sintel (Trailer)', year: 2010, genres: ['Short', 'Animation', 'Fantasy', 'Adventure'], rating: 7.3, durationSec: 52,
    director: 'Colin Levy', cast: ['Sintel'], tags: ['dragon', 'trailer', 'blender', 'quick', 'epic'],
    description: 'Under a minute of dragons, snow and heartbreak. A perfect warm-up before the full film.',
    emoji: '❄️', hue: 195, src: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4' },
  { id: 'bbbclip', title: 'Big Buck Bunny (10s Clip)', year: 2008, genres: ['Short', 'Animation', 'Comedy', 'Family'], rating: 6.9, durationSec: 10,
    director: 'Sacha Goedegebure', cast: ['Big Buck'], tags: ['rabbit', 'bunny', 'blender', 'quick', 'demo', 'test'],
    description: 'A ten second slice of Big Buck Bunny. Handy for testing sync with quick seeks and the shared queue.',
    emoji: '🥕', hue: 100, src: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4' },
  { id: 'jelly', title: 'Jellyfish', year: 2017, genres: ['Short', 'Nature', 'Documentary'], rating: 7.1, durationSec: 10,
    director: 'test-videos.co.uk', cast: [], tags: ['ocean', 'sea', 'calm', 'underwater', 'relaxing', 'demo'],
    description: 'Ten calming seconds of jellyfish drifting through the deep.',
    emoji: '🪼', hue: 300, src: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_5MB.mp4' },
  { id: 'flower', title: 'Flower Timelapse', year: 2020, genres: ['Short', 'Nature', 'Documentary'], rating: 7.0, durationSec: 5,
    director: 'MDN', cast: [], tags: ['nature', 'timelapse', 'bloom', 'cc0', 'calm', 'relaxing'], description: 'A calming timelapse of a flower blooming. CC0.',
    emoji: '🌼', hue: 60, src: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
];

const byId = new Map(movies.map((m) => [m.id, m]));
const genres = [...new Set(movies.flatMap((m) => m.genres))].sort();

function toVideo(m) {
  return { id: m.id, title: m.title, src: m.src, emoji: m.emoji, hue: m.hue, source: 'catalog' };
}

module.exports = { movies, byId, genres, toVideo };
