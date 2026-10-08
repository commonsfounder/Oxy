// A sent photo is shown back in the chat from a small client-made thumbnail stored
// on the user's conversation row. The full upload is never persisted here.

const MAX_THUMBNAIL_CHARS = 250 * 1024;
const THUMBNAIL_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/;

function sanitizeThumbnail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_THUMBNAIL_CHARS) return null;
  return THUMBNAIL_PATTERN.test(trimmed) ? trimmed : null;
}

// Stored user turn for /chat-with-image. The thumbnail rides along only for images.
function buildAttachmentMessage({ message, isImage, label, thumbnail }) {
  const text = `${message}\n\n[Attached ${isImage ? 'image' : 'file'}: ${label}]`;
  const image = isImage ? sanitizeThumbnail(thumbnail) : null;
  return image ? { text, image } : text;
}

module.exports = { MAX_THUMBNAIL_CHARS, sanitizeThumbnail, buildAttachmentMessage };
