'use strict';
// Vercel build step: the Vercel project serves only the static front end (public/). The real-time server (WebSockets +
// in-memory rooms) cannot run on Vercel's serverless platform, so it runs elsewhere (see render.yaml) and its address is
// injected here from the BACKEND_URL environment variable into public/config.js.
const fs = require('fs');
const path = require('path');

const url = (process.env.BACKEND_URL || '').trim().replace(/\/+$/, '');
// https only, except plain http to localhost so the split setup can be tried on one machine
if (url && !/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[^\s]*)?$/.test(url)) {
  console.error('BACKEND_URL must be an https:// URL (or http://localhost for local tests), e.g. https://watch-party-server.onrender.com (got: ' + url + ')');
  process.exit(1);
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'window.WP_CONFIG = ' + JSON.stringify({ backend: url }) + ';\n');
if (url) console.log('Front end will talk to the backend at ' + url);
else console.warn('WARNING: BACKEND_URL is not set. The site will load but cannot create or join rooms until it is set to the WebSocket server URL.');
