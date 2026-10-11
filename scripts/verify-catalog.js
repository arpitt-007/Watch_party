// Re-checks every catalog video against YouTube (exists, playable, embedding allowed, not age-gated).
// Run `npm run verify-catalog` before releases; remove any id it reports from server/catalog.json.
const cat = require('../server/catalog.json');
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36', cookie: 'CONSENT=YES+1; SOCS=CAI' };
async function check(m) {
  const id = m.id;
  const watch = await fetch('https://www.youtube.com/watch?hl=en&v=' + id, { headers: H }).then((r) => r.text()).catch(() => '');
  const emb = await fetch('https://www.youtube.com/embed/' + id + '?enablejsapi=1', { headers: { ...H, referer: 'http://localhost:3000/' } }).then((r) => r.text()).catch(() => '');
  const pie = (watch.match(/"playableInEmbed":(true|false)/) || [])[1];
  const status = (watch.match(/"playabilityStatus":\{"status":"(\w+)"/) || [])[1];
  const embStatus = (emb.match(/"playabilityStatus":\{"status":"(\w+)"/) || emb.match(/"status":"(UNPLAYABLE|LOGIN_REQUIRED|ERROR|OK)"/) || [])[1];
  const oe = await fetch('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=' + id).then((r) => r.status);
  const ageGate = /age-restricted|"isAgeRestricted":true|LOGIN_REQUIRED/.test(watch);
  const ok = pie === 'true' && status === 'OK' && oe === 200 && !ageGate && embStatus !== 'UNPLAYABLE' && embStatus !== 'ERROR';
  return { id, title: m.title, pie, status, embStatus, oe, ageGate, ok };
}
(async () => {
  const bad = [];
  for (let i = 0; i < cat.length; i += 6) {
    const rs = await Promise.all(cat.slice(i, i + 6).map(check));
    rs.forEach((r) => { if (!r.ok) bad.push(r); });
  }
  console.log('checked', cat.length, 'videos; not embeddable/unavailable:', bad.length);
  bad.forEach((b) => console.log('  ' + b.id + '  ' + b.title + '  ' + JSON.stringify({ playableInEmbed: b.pie, status: b.status, oembed: b.oe })));
  process.exit(bad.length ? 1 : 0);
})();
