// Permanently removes every video listed in server/blocked.json from server/catalog.json, then clears blocked.json.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'server');
const blockedFile = process.env.WP_BLOCKED_FILE || path.join(dir, 'blocked.json');
let blocked = {};
try { blocked = JSON.parse(fs.readFileSync(blockedFile, 'utf8')); } catch (e) { /* nothing blocked */ }
const catFile = path.join(dir, 'catalog.json');
const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
const keep = cat.filter((m) => !blocked[m.id]);
const removed = cat.filter((m) => blocked[m.id]);
fs.writeFileSync(catFile, JSON.stringify(keep, null, 1));
fs.writeFileSync(blockedFile, '{}');
console.log('Removed ' + removed.length + ' videos, ' + keep.length + ' remain.');
removed.forEach((m) => console.log('  - ' + m.title + ' (' + m.channel + ')'));
