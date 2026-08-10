'use strict';
const { unzipSync, strFromU8 } = require('fflate');

// Reading documents.
//
// Three rules run through every extractor here, and they are the reason each one returns a
// result object instead of throwing:
//
//   1. **Extraction failure must leave the original document usable.** A scanned PDF we
//      cannot read is still a file the user can send to an insurer. So failure is a value
//      ({ ok: false, notes }), never an exception that unwinds the caller.
//   2. **A reading is not a fact.** Every result carries a confidence and a producer. A
//      DOCX text layer is 1; an OCR guess is capped well below it. Callers filter on this
//      rather than treating all extracted values alike.
//   3. **Mistakes stay visible.** `notes` records what went wrong or what was assumed —
//      "no text layer, fell back to OCR" — so a later engineer can see why a field is odd
//      instead of finding a confident-looking wrong answer.
//
// Nothing in this module writes to the database or mutates the original bytes; it turns
// bytes into candidate readings and hands them back. Persistence is documents.js's job.

const EXTRACTION_PRODUCERS = {
  pdf: 'pdf-text-layer',
  docx: 'docx-fflate',
  image: 'vision-ocr',
  text: 'plain-text'
};

const PRODUCER_VERSION = '1';

// OCR is inherently a reading of pixels. Even a clean scan can misread a 0 as an O, so its
// confidence ceiling sits below a real text layer's — a downstream filter asking for
// high-confidence fields should never be satisfied by OCR alone.
const OCR_CONFIDENCE_CEILING = 0.8;

function ok(fields) {
  return { ok: true, text: '', fields: null, confidence: 1, notes: null, producerVersion: PRODUCER_VERSION, ...fields };
}

function failed(producer, notes) {
  return { ok: false, text: '', fields: null, confidence: 0, notes, producer, producerVersion: PRODUCER_VERSION };
}

async function extractPdf(bytes) {
  let parser = null;
  try {
    const { PDFParse } = require('pdf-parse');
    parser = new PDFParse({ data: new Uint8Array(bytes) });
    const result = await parser.getText();
    // pdf-parse separates pages with "-- 3 of 12 --" markers. That is parser furniture; left
    // in, it becomes text the model reads back as document content.
    const text = String(result?.text || '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').trim();
    if (!text) {
      return ok({
        producer: EXTRACTION_PRODUCERS.pdf,
        text: '',
        confidence: 0.1,
        notes: 'PDF parsed but contained no readable text layer — likely a scan; needs OCR.'
      });
    }
    return ok({ producer: EXTRACTION_PRODUCERS.pdf, text, confidence: 1 });
  } catch (err) {
    return failed(EXTRACTION_PRODUCERS.pdf, `PDF could not be parsed: ${err.message}`);
  } finally {
    if (parser?.destroy) await parser.destroy().catch(() => {});
  }
}

// DOCX is a zip with the text in word/document.xml. fflate is already a dependency (see
// agent-continuity.js), so this costs nothing extra.
async function extractDocx(bytes) {
  try {
    const entries = unzipSync(new Uint8Array(bytes));
    const documentXml = entries['word/document.xml'];
    if (!documentXml) return failed(EXTRACTION_PRODUCERS.docx, 'Not a Word document — no word/document.xml inside.');
    const xml = strFromU8(documentXml);
    const text = xml
      // Paragraph and line breaks must become whitespace before tags are stripped, or every
      // paragraph runs into the next one as a single word.
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br\s*\/>/g, '\n')
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) return ok({ producer: EXTRACTION_PRODUCERS.docx, text: '', confidence: 0.1, notes: 'Word document contained no text.' });
    return ok({ producer: EXTRACTION_PRODUCERS.docx, text, confidence: 1 });
  } catch (err) {
    return failed(EXTRACTION_PRODUCERS.docx, `Word document could not be read: ${err.message}`);
  }
}

async function extractPlainText(bytes) {
  try {
    return ok({ producer: EXTRACTION_PRODUCERS.text, text: Buffer.from(bytes).toString('utf8').trim(), confidence: 1 });
  } catch (err) {
    return failed(EXTRACTION_PRODUCERS.text, `Text could not be decoded: ${err.message}`);
  }
}

// Images go to a vision model. The function is injected rather than imported so this module
// stays testable without a network and so the caller decides which model pays for it.
async function extractImage(bytes, mimeType, visionExtract) {
  if (typeof visionExtract !== 'function') {
    return failed(EXTRACTION_PRODUCERS.image, 'No vision extractor is configured, so images cannot be read yet.');
  }
  try {
    const result = await visionExtract({ base64: Buffer.from(bytes).toString('base64'), mimeType });
    const fields = clampFieldConfidences(result?.fields);
    return ok({
      producer: EXTRACTION_PRODUCERS.image,
      text: String(result?.text || '').trim(),
      fields,
      // Capped, never taken from the model's own self-report: a model asked how sure it is
      // will happily say "1".
      confidence: Math.min(Number(result?.confidence) || OCR_CONFIDENCE_CEILING, OCR_CONFIDENCE_CEILING),
      notes: 'Read from an image by a vision model — treat values as a reading, not a fact.'
    });
  } catch (err) {
    return failed(EXTRACTION_PRODUCERS.image, `Image could not be read: ${err.message}`);
  }
}

// Per-field confidences from a model are also self-reported, so they get the same ceiling.
function clampFieldConfidences(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const out = {};
  for (const [name, raw] of Object.entries(fields)) {
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    const stated = raw && typeof raw === 'object' ? Number(raw.confidence) : NaN;
    const confidence = Math.min(Number.isFinite(stated) ? stated : OCR_CONFIDENCE_CEILING, OCR_CONFIDENCE_CEILING);
    out[name] = { value, confidence };
  }
  return out;
}

// Explicitly null for anything we cannot read, so the caller records 'unsupported' rather
// than an empty extraction that reads as "we looked and it said nothing".
function extractorFor(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (mime === 'application/pdf') return { kind: 'pdf', run: extractPdf };
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { kind: 'docx', run: extractDocx };
  if (mime.startsWith('image/')) return { kind: 'image', run: extractImage };
  if (mime.startsWith('text/') || mime === 'application/json') return { kind: 'text', run: extractPlainText };
  return null;
}

module.exports = {
  EXTRACTION_PRODUCERS,
  PRODUCER_VERSION,
  OCR_CONFIDENCE_CEILING,
  extractPdf,
  extractDocx,
  extractPlainText,
  extractImage,
  extractorFor
};
