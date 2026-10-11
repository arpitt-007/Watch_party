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

  // ---- YouTube-hosted (official Blender channels; played through the YouTube IFrame player) ----
  { id: 'spring', title: 'Spring', year: 2019, genres: ['Animation', 'Fantasy', 'Drama'], rating: 7.9, durationSec: 468, youtube: 'WhWc3b3KhnY',
    director: 'Andy Goralczyk', cast: ['Shepherd Girl', 'Spirit'], tags: ['nature', 'spirits', 'blender', 'emotional', 'beautiful'],
    description: 'A shepherd girl and her dog face ancient spirits in order to continue the cycle of life.', emoji: '🌸', hue: 150 },
  { id: 'cosmos', title: 'Cosmos Laundromat', year: 2015, genres: ['Animation', 'Comedy', 'Fantasy'], rating: 7.2, durationSec: 720, youtube: 'Y-rmzh0PI3c',
    director: 'Mathieu Auvray', cast: ['Franck', 'Victor'], tags: ['sheep', 'island', 'surreal', 'blender', 'afterlife'],
    description: 'On a desolate island, a suicidal sheep named Franck meets a quirky salesman who offers him the gift of a lifetime.', emoji: '🐑', hue: 260 },
  { id: 'llamigos', title: 'Caminandes 3: Llamigos', year: 2016, genres: ['Short', 'Animation', 'Comedy', 'Family'], rating: 7.7, durationSec: 150, youtube: 'SkVqJ1SGeL0',
    director: 'Pablo Vazquez', cast: ['Koro', 'Oti'], tags: ['llama', 'penguin', 'patagonia', 'blender', 'funny', 'quick'],
    description: 'Koro the llama is back, and this time he is ready to take on a rival over the tastiest grass in Patagonia.', emoji: '🦙', hue: 40 },
  { id: 'agent327', title: 'Agent 327: Operation Barbershop', year: 2017, genres: ['Short', 'Animation', 'Action', 'Comedy'], rating: 7.0, durationSec: 231, youtube: 'mN0zPOpADL4',
    director: 'Hjalti Hjalmarsson', cast: ['Agent 327'], tags: ['spy', 'barber', 'blender', 'quick', 'dutch'],
    description: 'A secret agent walks into a barbershop that is not what it seems.', emoji: '💈', hue: 0 },
  { id: 'sprite', title: 'Sprite Fright', year: 2021, genres: ['Animation', 'Comedy', 'Fantasy'], rating: 7.1, durationSec: 628, youtube: '_cMxraX_5RE',
    director: 'Mathew Luhn', cast: ['Sprites'], tags: ['horror', 'forest', 'campers', 'blender', '80s', 'spooky'],
    description: 'A group of campers discovers that the forest has its own ideas about visitors, in this 80s horror-comedy homage.', emoji: '🧚', hue: 120 },
  { id: 'coffee', title: 'Coffee Run', year: 2020, genres: ['Short', 'Animation', 'Action', 'Comedy'], rating: 7.4, durationSec: 200, youtube: 'PVGeM40dABA',
    director: 'Hjalti Hjalmarsson', cast: ['Heroine'], tags: ['coffee', 'chase', 'blender', 'quick', 'stylized'],
    description: 'A woman wakes up desperate for coffee, with unexpected consequences.', emoji: '☕', hue: 25 },
  { id: 'charge', title: 'Charge', year: 2022, genres: ['Short', 'Animation', 'Sci-Fi', 'Action'], rating: 7.3, durationSec: 252, youtube: 'UXqq0ZvbOnk',
    director: 'Ihsan Bayraktar', cast: ['Old man'], tags: ['robots', 'dystopia', 'energy', 'blender', 'quick'],
    description: 'In a harsh world, a frail man races to protect the last energy cell.', emoji: '🔋', hue: 55 },
];

const byId = new Map(movies.map((m) => [m.id, m]));
const genres = [...new Set(movies.flatMap((m) => m.genres))].sort();

function toVideo(m) {
  if (m.youtube) return { id: m.id, title: m.title, source: 'youtube', ytId: m.youtube, src: 'https://www.youtube.com/watch?v=' + m.youtube, emoji: m.emoji, hue: m.hue };
  return { id: m.id, title: m.title, src: m.src, emoji: m.emoji, hue: m.hue, source: 'catalog' };
}

module.exports = { movies, byId, genres, toVideo };
