const fs = require('fs');
const https = require('https');
const path = require('path');

const outDir = path.join(__dirname, '..', 'OxyApp', 'OxyApp', 'Resources', 'Assets.xcassets');

const icons = [
  { asset: 'google', slug: 'google', bg: '#FFFFFF', fg: '#4285F4' },
  { asset: 'netflix', slug: 'netflix', bg: '#000000', fg: '#E50914' },
  { asset: 'spotify', slug: 'spotify', bg: '#1DB954', fg: '#191414' },
  { asset: 'deliveroo', slug: 'deliveroo', bg: '#00CCBC', fg: '#FFFFFF' },
  { asset: 'ubereats', slug: 'ubereats', bg: '#000000', fg: '#06C167' },
  { asset: 'uber', slug: 'uber', bg: '#000000', fg: '#FFFFFF' },
  { asset: 'telegram', slug: 'telegram', bg: '#26A5E4', fg: '#FFFFFF' },
  { asset: 'monzo', slug: 'monzo', bg: '#14233C', fg: '#FFFFFF' },
  { asset: 'maps', slug: 'googlemaps', bg: '#FFFFFF', fg: '#4285F4' },
  { asset: 'notion', slug: 'notion', bg: '#FFFFFF', fg: '#000000' },
  { asset: 'betfair', slug: 'betfair', bg: '#FFD21E', fg: '#111111' },
  { asset: 'whatsapp', slug: 'whatsapp', bg: '#25D366', fg: '#FFFFFF' }
];

function fetchSvg(slug, color) {
  const url = `https://cdn.simpleicons.org/${slug}/${color.replace('#', '')}`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`${slug}: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function extractInner(svg) {
  const body = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i)?.[1];
  if (!body) throw new Error('Could not parse SVG');
  return body.replace(/<title>[\s\S]*?<\/title>/gi, '').trim();
}

function wrapIcon({ bg, fg }, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${bg}"/>
  <g transform="translate(14 14) scale(1.5)" fill="${fg}">
    ${inner}
  </g>
</svg>
`;
}

async function main() {
  for (const icon of icons) {
    const svg = await fetchSvg(icon.slug, icon.fg);
    const wrapped = wrapIcon(icon, extractInner(svg));
    const imageset = path.join(outDir, `${icon.asset}.imageset`);
    fs.mkdirSync(imageset, { recursive: true });
    fs.writeFileSync(path.join(imageset, `${icon.asset}.svg`), wrapped);
    fs.writeFileSync(
      path.join(imageset, 'Contents.json'),
      JSON.stringify({ images: [{ filename: `${icon.asset}.svg`, idiom: 'universal' }], info: { author: 'xcode', version: 1 } }, null, 2) + '\n'
    );
    console.log(`updated ${icon.asset} from simple-icons/${icon.slug}`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
