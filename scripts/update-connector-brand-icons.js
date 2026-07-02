// Pulls the real, full-colour App Store product icons for each connector and writes
// them into the asset catalog as single-scale PNG imagesets. The asset name MUST match
// the connector's `icon` slug in api/index.js CONNECTORS so the Apps row finds it.
//
// Source is the public iTunes Search API (artworkUrl512) — the genuine product icons,
// not the single-colour simple-icons glyphs we used before. The app clips each square
// artwork to the iOS superellipse itself (see ConnectorIcon), so we store full-bleed
// squares here. Any slug without a store app falls back to a monogram tile in-app.
//
// Run:  node scripts/update-connector-brand-icons.js
const fs = require('fs');
const https = require('https');
const path = require('path');

const outDir = path.join(__dirname, '..', 'OxyApp', 'OxyApp', 'Resources', 'Assets.xcassets');

// asset (= connector icon slug) → exact App Store search term for the official app.
const icons = [
  { asset: 'google',    term: 'Google' },
  { asset: 'uber',      term: 'Uber Request a ride' },
  { asset: 'bolt',      term: 'Bolt Request a Ride' },
  { asset: 'maps',      term: 'Google Maps' },
  { asset: 'telegram',  term: 'Telegram Messenger' },
  { asset: 'trainline', term: 'Trainline' },
  { asset: 'github',    term: 'GitHub' },
  { asset: 'outlook',   term: 'Microsoft Outlook' },
  { asset: 'notion',    term: 'Notion' },
  { asset: 'youtube',   term: 'YouTube' },
  { asset: 'indeed',    term: 'Indeed Job Search' },
  { asset: 'linkedin',  term: 'LinkedIn' },
  { asset: 'spotify',   term: 'Spotify Music and Podcasts' },
  { asset: 'linear',    term: 'Linear Mobile' }
];

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function lookup(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=1&country=us`;
  const data = await getJSON(url);
  const r = data.results && data.results[0];
  if (!r) throw new Error('no App Store result');
  const art = r.artworkUrl512 || r.artworkUrl100 || r.artworkUrl60;
  if (!art) throw new Error('no artwork url');
  // The size segment is interchangeable; ask for a crisp 512.
  return { name: r.trackName, art: art.replace(/\/[0-9]+x[0-9]+bb\.(png|jpg)$/, '/512x512bb.png') };
}

async function main() {
  let failures = 0;
  for (const icon of icons) {
    try {
      const { name, art } = await lookup(icon.term);
      const png = await download(art);
      const imageset = path.join(outDir, `${icon.asset}.imageset`);
      // Clear any prior (simple-icons SVG) representation so the slug resolves to the PNG only.
      fs.rmSync(imageset, { recursive: true, force: true });
      fs.mkdirSync(imageset, { recursive: true });
      fs.writeFileSync(path.join(imageset, `${icon.asset}.png`), png);
      fs.writeFileSync(
        path.join(imageset, 'Contents.json'),
        JSON.stringify({
          images: [{ filename: `${icon.asset}.png`, idiom: 'universal' }],
          info: { author: 'xcode', version: 1 }
        }, null, 2) + '\n'
      );
      console.log(`updated ${icon.asset.padEnd(10)} ← ${name}`);
    } catch (err) {
      failures++;
      console.warn(`skipped ${icon.asset.padEnd(10)} (${icon.term}): ${err.message}`);
    }
  }
  if (failures) console.warn(`\n${failures} icon(s) skipped — those rows show a monogram tile in-app.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
