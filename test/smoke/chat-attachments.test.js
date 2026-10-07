const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_THUMBNAIL_CHARS,
  sanitizeThumbnail,
  buildAttachmentMessage
} = require('../../api/services/chat-attachments');

const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('sanitizeThumbnail accepts small jpeg/png data URLs only', () => {
  assert.equal(sanitizeThumbnail(THUMB), THUMB);
  assert.equal(sanitizeThumbnail('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(sanitizeThumbnail('data:text/html;base64,PGI+'), null);
  assert.equal(sanitizeThumbnail('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(sanitizeThumbnail('https://example.com/a.jpg'), null);
  assert.equal(sanitizeThumbnail(`data:image/jpeg;base64,${'A'.repeat(MAX_THUMBNAIL_CHARS)}`), null);
  assert.equal(sanitizeThumbnail(undefined), null);
});

test('buildAttachmentMessage stores the thumbnail for images', () => {
  assert.deepEqual(
    buildAttachmentMessage({ message: 'what is this', isImage: true, label: 'photo.jpg', thumbnail: THUMB }),
    { text: 'what is this\n\n[Attached image: photo.jpg]', image: THUMB }
  );
});

test('buildAttachmentMessage stays plain text without a valid thumbnail or for files', () => {
  assert.equal(
    buildAttachmentMessage({ message: 'hi', isImage: true, label: 'photo.jpg', thumbnail: 'nope' }),
    'hi\n\n[Attached image: photo.jpg]'
  );
  assert.equal(
    buildAttachmentMessage({ message: 'read', isImage: false, label: 'a.pdf', thumbnail: THUMB }),
    'read\n\n[Attached file: a.pdf]'
  );
});
