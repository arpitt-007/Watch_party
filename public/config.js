// Runtime configuration. Empty backend = the page talks to the server it was loaded from (local dev, or the all-in-one
// Node deployment). The Vercel build (scripts/build-vercel.js) overwrites this file with the real WebSocket/API server's URL.
window.WP_CONFIG = { backend: '' };
