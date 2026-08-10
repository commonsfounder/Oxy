const assert = require('node:assert/strict');
const test = require('node:test');
const { zipSync, strToU8 } = require('fflate');

const {
  extractPdf, extractDocx, extractPlainText, extractImage, extractorFor, EXTRACTION_PRODUCERS
} = require('../../api/services/document-extraction');

const KEY = 'a'.repeat(64);
process.env.OXY_TOKEN_ENCRYPTION_KEY = KEY;

// A genuinely valid one-page PDF with a real text layer — built here rather than
// checked in as a fixture so the test explains what it is.
function buildPdf(text) {
  const content = Buffer.from(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ];
  let out = Buffer.from('%PDF-1.4\n');
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
  });
  const xref = out.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(o => { tail += `${String(o).padStart(10, '0')} 00000 n \n`; });
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail)]);
}

function buildDocx(paragraphs) {
  const body = paragraphs.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(xml)
  }));
}

test('extractPdf reads the text layer and strips the parser\'s page markers', async () => {
  const result = await extractPdf(buildPdf('Policy number ABC-12345'));
  assert.match(result.text, /Policy number ABC-12345/);
  // pdf-parse appends "-- 1 of 1 --" separators; those are parser furniture, not content.
  assert.ok(!/--\s*1 of 1\s*--/.test(result.text), 'page markers must not leak into extracted text');
  assert.equal(result.producer, EXTRACTION_PRODUCERS.pdf);
  assert.equal(result.confidence, 1);
});

test('a PDF with no text layer reports low confidence and says why, rather than returning ""', async () => {
  // An empty-content PDF stands in for a scan: structurally valid, no readable text.
  const result = await extractPdf(buildPdf(''));
  assert.equal(result.text.trim(), '');
  assert.ok(result.confidence < 0.5, 'an empty read must not be presented as a confident one');
  assert.match(result.notes || '', /no (readable )?text/i);
});

test('extractDocx reads paragraphs using fflate, with no new dependency', async () => {
  const result = await extractDocx(buildDocx(['Dear Sir or Madam', 'I am applying for the role.']));
  assert.match(result.text, /Dear Sir or Madam/);
  assert.match(result.text, /applying for the role/);
  // Paragraphs must not be run together into one word.
  assert.ok(!/MadamI am/.test(result.text), 'paragraph boundaries must survive as whitespace');
  assert.equal(result.producer, EXTRACTION_PRODUCERS.docx);
});

test('extractDocx on a file that is not a real docx fails softly instead of throwing', async () => {
  const result = await extractDocx(Buffer.from('this is not a zip'));
  assert.equal(result.ok, false);
  assert.ok(result.notes, 'a failure must explain itself for whoever reads the record later');
});

test('extractPlainText decodes utf-8 and keeps the content intact', async () => {
  const result = await extractPlainText(Buffer.from('Réf: 12345 — renewal', 'utf8'));
  assert.match(result.text, /Réf: 12345 — renewal/);
});

test('extractImage routes to the injected vision function and never invents a confident reading', async () => {
  const calls = [];
  const vision = async ({ base64, mimeType }) => {
    calls.push({ len: base64.length, mimeType });
    return { text: 'INVOICE\nTotal 42.00', fields: { total: { value: '42.00', confidence: 0.55 } } };
  };
  const result = await extractImage(Buffer.from('fake-png-bytes'), 'image/png', vision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mimeType, 'image/png');
  assert.match(result.text, /Total 42.00/);
  // OCR is a reading, not a fact. Its ceiling must stay below a text-layer extraction's 1.
  assert.ok(result.confidence < 1, 'OCR output must never claim full confidence');
  assert.equal(result.producer, EXTRACTION_PRODUCERS.image);
});

test('extractImage with no vision function configured fails softly rather than throwing', async () => {
  const result = await extractImage(Buffer.from('x'), 'image/png', null);
  assert.equal(result.ok, false);
  assert.match(result.notes || '', /vision|not configured/i);
});

test('extractorFor picks by mime type and returns null for formats we cannot read', () => {
  assert.equal(extractorFor('application/pdf').kind, 'pdf');
  assert.equal(extractorFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document').kind, 'docx');
  assert.equal(extractorFor('image/jpeg').kind, 'image');
  assert.equal(extractorFor('text/plain').kind, 'text');
  // Unsupported must be an explicit null the caller handles, not a silent empty extraction
  // that looks like "we read it and it said nothing".
  assert.equal(extractorFor('application/zip'), null);
});
