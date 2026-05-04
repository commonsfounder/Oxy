const { createCanvas } = require('canvas');
const fs = require('fs');

function makeIcon(size, file) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0c0e';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#2ABFBF';
  ctx.font = `bold ${size * 0.45}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('O', size / 2, size / 2);
  const buf = c.toBuffer('image/png');
  fs.writeFileSync(file, buf);
  console.log('Created', file);
}

makeIcon(192, 'icon-192.png');
makeIcon(512, 'icon-512.png');
