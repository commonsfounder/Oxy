const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The iOS design system only stays a system if nothing bypasses it. Every rule here
// is one the app had already drifted off: 26 distinct type sizes (five of them
// half-point), ten `appSurface.opacity(...)` fills, six widths for one hairline,
// ~20 ad-hoc ink opacities, and hardcoded black/white in a light+dark app.

const APP_ROOT = path.join(__dirname, '..', '..', 'OxyApp', 'OxyApp');
const THEME = path.join(APP_ROOT, 'Extensions', 'AppTheme.swift');

function swiftFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) swiftFiles(full, out);
    else if (full.endsWith('.swift')) out.push(full);
  }
  return out;
}

const FILES = swiftFiles(APP_ROOT).map((file) => ({
  file,
  where: path.relative(APP_ROOT, file),
  lines: fs.readFileSync(file, 'utf8').split('\n'),
}));

// Skips the token definitions themselves — that is where the raw values belong.
const SCREENS = FILES.filter(({ file }) => file !== THEME);

function findAll(files, pattern, { skipComments = true } = {}) {
  const hits = [];
  for (const { where, lines } of files) {
    lines.forEach((line, index) => {
      if (skipComments && /^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (pattern.test(line)) hits.push(`${where}:${index + 1}  ${line.trim()}`);
      pattern.lastIndex = 0;
    });
  }
  return hits;
}

function report(hits, message) {
  assert.deepStrictEqual(hits, [], `${message}\n  ${hits.join('\n  ')}`);
}

test('every icon is a bundled asset, never an SF Symbol', () => {
  report(
    findAll(FILES, /Image\(systemName:|systemImage:|\.tabItem/),
    'SF Symbols are banned (AGENTS.md): add the asset and use AppIcon("name").'
  );
});

test('type goes through the app font tokens, not Font.system', () => {
  report(
    findAll(SCREENS, /\.system\(size:/),
    'Use .appBody / .appDisplay / .appMono so every screen shares one type scale.'
  );
});

test('every type size is a step on the scale', () => {
  const scale = new Set(
    [...fs.readFileSync(THEME, 'utf8').matchAll(/static let (\w+): CGFloat = ([\d.]+)/g)]
      .filter(([, , value]) => /^\d+$/.test(value))
      .map(([, name]) => name)
  );
  const offScale = [];
  for (const { where, lines } of SCREENS) {
    lines.forEach((line, index) => {
      for (const [, fn, size] of line.matchAll(/\.(appBody|appDisplay|appMono|appTitle)\(\s*([\d.]+)/g)) {
        offScale.push(`${where}:${index + 1}  .${fn}(${size}) — pass an AppText step`);
      }
      for (const [, step] of line.matchAll(/AppText\.(\w+)/g)) {
        if (!scale.has(step)) offScale.push(`${where}:${index + 1}  AppText.${step} is not declared`);
      }
    });
  }
  report(offScale, 'Type sizes come from AppText, and only from AppText.');
});

test('text never drops below the muted legibility floor', () => {
  const hits = findAll(
    SCREENS,
    /(?:foregroundStyle|foregroundColor|\.tint)\([^)]*(?:Color\.appInk|\bink)\.opacity\(/
  );
  report(hits, 'DESIGN.md sets a legibility floor: secondary text is Color.appMuted, not faded ink.');
  report(
    findAll(SCREENS, /(?:foregroundStyle|foregroundColor)\(\s*Color\.appFaint\s*\)/),
    'appFaint is for rules and inactive glyphs — it does not carry text.'
  );
});

test('surfaces are opaque and come from the elevation tokens', () => {
  report(
    findAll(SCREENS, /Color\.(?:appSurface2?|appRaised|appFloating)\.opacity\(/),
    'A card sits at an elevation, not at an opacity. Use AppElevation / .appPlate().'
  );
});

test('there is one hairline width and one strong border', () => {
  // Only borders — a StrokeStyle drawing a dashed route or a progress ring is
  // artwork, and picks its own weight.
  report(
    findAll(SCREENS, /strokeBorder\([^)]*lineWidth: (?!AppBorder)[\d.]/),
    'Borders are AppBorder.hairline or AppBorder.strong.'
  );
});

test('corner radii come from AppRadius', () => {
  report(
    findAll(SCREENS, /cornerRadius: (?!AppRadius|Self\.|cornerRadius|0\b)[\d.]/),
    'Radii come from AppRadius so nested shapes stay concentric.'
  );
});

test('the light and dark finishes both get a real colour', () => {
  report(
    findAll(SCREENS, /Color\.(?:white|black|red|orange|primary|secondary|gray|grey)\b(?!\.opacity\(0\.(?:0|1)\d*\))/),
    'Fixed system colours break one of the two finishes. Use the app tokens (or appAdaptive).'
  );
});

test('padding and stack spacing stay on the grid', () => {
  const offGrid = [];
  for (const { where, lines } of SCREENS) {
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const values = [
        ...line.matchAll(/\.padding\((?:\.\w+, )?(\d+)\)/g),
        ...line.matchAll(/spacing: (\d+)[,)]/g),
      ];
      for (const [, raw] of values) {
        const value = Number(raw);
        // 1 and 2 are optical nudges; above that the grid is even numbers.
        if (value > 3 && value % 2 !== 0) {
          offGrid.push(`${where}:${index + 1}  ${value}pt`);
        }
      }
    });
  }
  report(offGrid, 'Spacing is on an even grid — see AppSpacing.');
});

test('the theme declares the scale the screens are held to', () => {
  const theme = fs.readFileSync(THEME, 'utf8');
  for (const token of ['enum AppText', 'enum AppRadius', 'enum AppBorder', 'enum AppSpacing', 'enum AppElevation']) {
    assert.ok(theme.includes(token), `AppTheme.swift must declare ${token}`);
  }
  for (const step of ['micro', 'caption', 'footnote', 'body', 'callout', 'title', 'display', 'hero']) {
    assert.match(theme, new RegExp(`static let ${step}: CGFloat`), `AppText is missing .${step}`);
  }
});
