import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAttachment, attachmentMime, validateAttachmentSelection, validateRunAttachments, MAX_ATTACHMENT_BYTES, getAttachmentLimits } from '../src/protocol.mjs';

function file(name, type, contents) {
  const blob = new Blob([contents], { type });
  return { name, type, size: blob.size, arrayBuffer: () => blob.arrayBuffer() };
}

test('UTF-8 attachment payload preserves Unicode and uses the agreed JSON contract', async () => {
  const payload = await prepareAttachment(file('notes.md', '', '# Notes φ 🎙 世界'));
  assert.deepEqual(Object.keys(payload).sort(), ['dataBase64', 'mimeType', 'name']);
  assert.equal(payload.mimeType, 'text/markdown');
  assert.equal(Buffer.from(payload.dataBase64, 'base64').toString('utf8'), '# Notes φ 🎙 世界');
});

test('attachment selection rejects unsupported formats, oversize files and more than four files before upload', () => {
  assert.throws(() => validateAttachmentSelection([file('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx')]), /unsupported file type/);
  assert.throws(() => validateAttachmentSelection([{ name: 'large.png', type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 }]), /4 MiB/);
  assert.throws(() => validateAttachmentSelection([file('a.txt', 'text/plain', 'a')], 4), /at most 4/);
});

test('PDF and ZIP MIME inference handles missing types and common Windows ZIP aliases', () => {
  assert.equal(attachmentMime(file('REPORT.PDF', '', 'pdf')), 'application/pdf');
  assert.equal(attachmentMime(file('archive.ZIP', 'application/octet-stream', 'zip')), 'application/zip');
  assert.equal(attachmentMime(file('archive.zip', 'application/x-zip-compressed', 'zip')), 'application/zip');
  assert.equal(attachmentMime(file('report.pdf', 'application/pdf', 'pdf')), 'application/pdf');
  assert.equal(attachmentMime(file('unknown.bin', 'application/octet-stream', 'binary')), 'application/octet-stream');
});

test('PDF and ZIP uploads preserve binary bytes without applying text UTF-8 decoding', async () => {
  for (const [name, mimeType, bytes] of [
    ['report.pdf', 'application/pdf', Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00)],
    ['archive.zip', 'application/zip', Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0xff, 0x00)]
  ]) {
    const payload = await prepareAttachment(file(name, mimeType, bytes));
    assert.equal(payload.mimeType, mimeType);
    assert.deepEqual(Buffer.from(payload.dataBase64, 'base64'), Buffer.from(bytes));
  }
});

test('PDF and ZIP share the existing file limits and do not require image vision', () => {
  assert.doesNotThrow(() => validateAttachmentSelection([
    { name: 'report.pdf', type: 'application/pdf', size: MAX_ATTACHMENT_BYTES },
    { name: 'archive.zip', type: 'application/zip', size: MAX_ATTACHMENT_BYTES }
  ]));
  assert.throws(() => validateAttachmentSelection([{ name: 'large.pdf', type: 'application/pdf', size: MAX_ATTACHMENT_BYTES + 1 }]), /4 MiB/);
  assert.throws(() => validateAttachmentSelection([file('archive.zip', 'application/zip', 'zip')], 4), /at most 4/);
  assert.deepEqual(validateRunAttachments([
    { assetId: 'pdf-text', mimeType: 'application/pdf', document: { kind: 'pdf', textChars: 10, pages: 1 } },
    { assetId: 'zip-index', mimeType: 'application/zip', document: { kind: 'zip', textChars: 20, entries: ['notes.txt'] } }
  ], { name: 'text-model', vision: false }), ['pdf-text', 'zip-index']);
});

test('capability limits can tighten client limits without increasing its fixed safety maxima', () => {
  const limits = getAttachmentLimits({ limits: { maxAttachments: 2, maxImages: 1, maxImageBytes: 1024, maxFileBytes: 2048 } });
  assert.equal(limits.maxAttachments, 2);
  assert.equal(limits.maxImageBytes, 1024);
  assert.throws(() => validateAttachmentSelection([file('b.png', 'image/png', 'png')], 1, limits, 1), /at most 1 images/);
  assert.equal(getAttachmentLimits({ limits: { maxAttachments: 100, maxImageBytes: 100000000 } }).maxAttachments, 4);
});

test('invalid UTF-8 text never becomes an uploaded text asset', async () => {
  await assert.rejects(prepareAttachment(file('bad.txt', 'text/plain', Uint8Array.of(0xff, 0xfe))), /valid UTF-8/);
});

test('vision capability is required for images and run requests use only uploaded IDs', () => {
  const image = { assetId: 'asset-image', mimeType: 'image/png' };
  assert.throws(() => validateRunAttachments([image], { name: 'text-model' }), /does not advertise vision/);
  assert.deepEqual(validateRunAttachments([image], { name: 'vision-model', vision: true }), ['asset-image']);
  assert.deepEqual(validateRunAttachments([image], { name: 'vision-model', capabilities: ['vision'] }), ['asset-image']);
  assert.deepEqual(validateRunAttachments([{ id: 'asset-text', mimeType: 'text/plain' }], {}), ['asset-text']);
  assert.throws(() => validateRunAttachments([{ mimeType: 'text/plain' }], {}), /no uploaded asset ID/);
});
