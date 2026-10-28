import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { literalFragmentLines, MAX_WORKSPACE_EDIT_PREVIEW_CHARS, validateWorkspaceEditPreview,
  workspaceEditApprovalError, workspaceEditReceipt } from '../src/workspace-edits.mjs';
import { initialRun, pollAgentRun, reconcileRun, reduceRunEvent } from '../src/protocol.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const position = (text, offset) => {
  const prefix = text.slice(0, offset), parts = prefix.split(/\r\n|\r|\n/);
  return { line: parts.length, column: parts.at(-1).length + 1 };
};
function fixture(source = 'prefix😀 old\r\nmiddle\rline\nend', replacements = [{ oldText: 'old\r\nmiddle', newText: 'new\n🌱' }]) {
  const intervals = replacements.map(edit => ({ ...edit, offset: source.indexOf(edit.oldText) })).sort((a, b) => a.offset - b.offset);
  let after = '', cursor = 0;
  const edits = intervals.map(edit => {
    after += source.slice(cursor, edit.offset);
    const beforePosition = position(source, edit.offset), afterPosition = position(after, after.length);
    const row = { startLine: beforePosition.line, startColumn: beforePosition.column, newStartLine: afterPosition.line, newStartColumn: afterPosition.column,
      offsetUtf16: edit.offset, oldText: edit.oldText, newText: edit.newText };
    after += edit.newText; cursor = edit.offset + edit.oldText.length; return row;
  });
  after += source.slice(cursor);
  const lineEndings = { lf: 0, crlf: 0, cr: 0 };
  for (const item of source.matchAll(/\r\n|\r|\n/g)) lineEndings[item[0] === '\r\n' ? 'crlf' : item[0] === '\r' ? 'cr' : 'lf']++;
  return { kind: 'workspace_edit', path: 'src/example.js', expectedHash: digest(source), newHash: digest(after), bytesBefore: Buffer.byteLength(source), bytesAfter: Buffer.byteLength(after),
    edits, complete: true, atomic: false, lineEndings, utf8Bom: source.startsWith('\uFEFF'), warning: 'Unchanged bytes are hash-bound.' };
}

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/WorkspaceEditPreview.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: import.meta.resolve('react'), external: true }));
  } }]
});
const { default: WorkspaceEditPreview, WorkspaceEditReceipt } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('literal edit normalization keeps exact hashes, Unicode byte deltas and original/proposed UTF-16 anchors', () => {
  const preview = fixture(), before = clone(preview);
  preview.extraServerContext = { toolName: 'workspace.edit', readback: 'later' };
  const result = validateWorkspaceEditPreview(preview);
  assert.equal(result.valid, true, result.errors.join(' '));
  assert.equal(result.preview.edits[0].offsetUtf16, 9);
  assert.equal(result.preview.edits[0].startColumn, 10, 'The astral symbol counts two UTF-16 units.');
  assert.equal(result.preview.expectedHash, preview.expectedHash);
  assert.equal(result.preview.newHash, preview.newHash);
  assert.deepEqual(result.preview.lineEndings, { lf: 1, crlf: 1, cr: 1 });
  assert.equal(result.preview.edits[0].removed.map(row => row.text + row.ending).join(''), preview.edits[0].oldText);
  assert.equal(result.preview.edits[0].added.map(row => row.text + row.ending).join(''), preview.edits[0].newText);
  assert.deepEqual({ ...preview, extraServerContext: undefined }, { ...before, extraServerContext: undefined });
});

test('literal rows preserve CRLF, CR, LF, BOM, empty literals and absence of a fragment-ending newline', () => {
  for (const literal of ['\uFEFF😀\r\nnext\rthird\nlast', 'line\r\n', '\r\n', 'line\n', '\r', 'x\t<node>', '']) {
    const rows = literalFragmentLines(literal, { startLine: 4, startColumn: 8 });
    assert.equal(rows.map(row => row.text + row.ending).join(''), literal);
    if (rows.length) assert.equal(rows[0].column, 8);
    for (const row of rows.slice(1)) assert.equal(row.column, 1);
  }
  assert.equal(literalFragmentLines('line\r\n').length, 1, 'No synthetic trailing empty source line.');
  assert.equal(literalFragmentLines('line').at(-1).ending, '');
  assert.deepEqual(literalFragmentLines(''), []);
  assert.throws(() => literalFragmentLines('\uD800'), /Literal text/);
});

test('complete previews accept the exact serialized bound and reject oversize instead of slicing', () => {
  const preview = { ...fixture(), extraServerContext: '' };
  preview.extraServerContext = 'x'.repeat(MAX_WORKSPACE_EDIT_PREVIEW_CHARS - JSON.stringify(preview).length);
  assert.equal(JSON.stringify(preview).length, 24000);
  assert.equal(validateWorkspaceEditPreview(preview).valid, true);
  preview.extraServerContext += 'x';
  const rejected = validateWorkspaceEditPreview(preview);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.preview, null);
  assert.match(rejected.errors.join(' '), /rejected, not truncated/);
});

test('missing, incomplete and malformed preview metadata cannot enable approval', () => {
  const changes = [
    { complete: false }, { complete: undefined }, { truncated: true }, { kind: 'workspace_write' }, { expectedHash: 'a'.repeat(63) },
    { newHash: 'not-a-hash' }, { newHash: fixture().expectedHash }, { bytesBefore: -1 }, { bytesAfter: '100' }, { atomic: true }, { atomic: undefined },
    { utf8Bom: 'yes' }, { lineEndings: { lf: 1, crlf: -1, cr: 0 } }, { edits: [] }, { path: 'bad\npath' }
  ];
  for (const change of changes) assert.equal(validateWorkspaceEditPreview({ ...fixture(), ...change }).valid, false, JSON.stringify(change));
  for (const value of [null, undefined, false, [], 'preview']) assert.equal(validateWorkspaceEditPreview(value).valid, false);
  const badBytes = fixture(); badBytes.bytesAfter++;
  assert.match(validateWorkspaceEditPreview(badBytes).errors.join(' '), /byte counts/);
});

test('original UTF-16 edit ranges must be ordered and non-overlapping, while adjacent matches remain valid', () => {
  const adjacent = fixture('abcdef', [{ oldText: 'ab', newText: 'A' }, { oldText: 'cd', newText: 'CD' }]);
  assert.equal(validateWorkspaceEditPreview(adjacent).valid, true);
  assert.equal(adjacent.edits[1].newStartColumn, 2);
  const overlap = clone(adjacent); overlap.edits[1].offsetUtf16 = 1;
  assert.match(validateWorkspaceEditPreview(overlap).errors.join(' '), /overlaps/);
  const reversed = clone(adjacent); reversed.edits.reverse();
  assert.match(validateWorkspaceEditPreview(reversed).errors.join(' '), /original-file order/);
  const badPosition = clone(adjacent); badPosition.edits[0].newStartColumn = 0;
  assert.equal(validateWorkspaceEditPreview(badPosition).valid, false);
  const farOutside = clone(adjacent); farOutside.edits[0].offsetUtf16 = 1000;
  assert.match(validateWorkspaceEditPreview(farOutside).errors.join(' '), /outside the recorded file size/);
});

test('malformed Unicode, NUL, no-op fragments and cyclic/non-JSON previews fail closed', () => {
  for (const text of ['\uD800', '\uDC00']) {
    const preview = fixture(); preview.edits[0].newText = text;
    assert.match(validateWorkspaceEditPreview(preview).errors.join(' '), /Unicode/);
  }
  const badExtra = { ...fixture(), extraServerContext: { text: '\uD800' } };
  assert.equal(validateWorkspaceEditPreview(badExtra).valid, false);
  for (const replacement of [{ oldText: 'x', newText: 'x' }, { oldText: 'x', newText: '\0' }]) {
    assert.equal(validateWorkspaceEditPreview(fixture('xyz', [replacement])).valid, false);
  }
  const circular = fixture(); circular.self = circular;
  assert.match(validateWorkspaceEditPreview(circular).errors.join(' '), /serializable/);
  assert.equal(validateWorkspaceEditPreview({ ...fixture(), extraServerContext: () => {} }).valid, false);
});

test('shared approval guard blocks missing or incomplete workspace previews and leaves other tool guards alone', () => {
  assert.equal(workspaceEditApprovalError({ name: 'workspace.edit', preview: fixture() }), null);
  assert.match(workspaceEditApprovalError({ name: 'workspace.edit' }), /cannot be approved/);
  assert.match(workspaceEditApprovalError({ name: 'workspace.edit', preview: { ...fixture(), complete: false } }), /complete/);
  assert.equal(workspaceEditApprovalError({ name: 'workspace.read' }), null);
});

const receipt = () => ({ kind: 'workspace_edit', effectId: 'effect-1', path: 'src/example.js', expectedHash: 'a'.repeat(64), newHash: 'b'.repeat(64),
  outcome: 'unknown', dispatchAttempted: true, verified: false, bytesBefore: 10, bytesAfter: 11, editCount: 1, atomic: false, code: 'edit_write_unknown' });
const event = (sequence, type, data) => ({ runId: 'run-1', sequence, type, data });

test('late workspace receipts survive cancellation and replace effect IDs without reviving the source run', () => {
  const cancelled = reduceRunEvent(initialRun('run-1'), event(1, 'cancelled', { reason: 'User cancelled' }));
  const unknown = reduceRunEvent(cancelled, event(2, 'workspace_receipt', { receipt: receipt() }));
  assert.equal(unknown.status, 'cancelled');
  assert.equal(unknown.error, 'User cancelled');
  assert.equal(unknown.output, '');
  assert.equal(unknown.workspaceReceipts[0].outcome, 'unknown');
  assert.equal(reduceRunEvent(unknown, event(2, 'workspace_receipt', { receipt: receipt() })), unknown);
  assert.equal(reduceRunEvent(unknown, { ...event(3, 'workspace_receipt', { receipt: receipt() }), runId: 'other' }), unknown);
  const confirmed = { ...receipt(), outcome: 'verified', verified: true, observedHash: 'b'.repeat(64), observedBytes: 11 };
  const verified = reduceRunEvent(unknown, event(3, 'workspace_receipt', { receipt: confirmed }));
  assert.equal(verified.workspaceReceipts.length, 1);
  assert.equal(verified.workspaceReceipts[0].outcome, 'verified');
  assert.equal(verified.status, 'cancelled');
  assert.equal(reduceRunEvent(verified, event(4, 'completed', { output: 'false success' })), verified);
  assert.equal(reconcileRun(verified, { status: 'completed' }).workspaceReceipts[0].effectId, 'effect-1');
});

test('durable event replay recovers independent workspace effects using only GET after source cancellation', async () => {
  let reads = 0;
  const methods = [];
  const result = await pollAgentRun('run-1', { intervalMs: 0, fetchImpl: async (url, options) => {
    methods.push(options.method || 'GET');
    const value = url.includes('/events') ? { events: ++reads === 1 ? [] : [event(1, 'cancelled', { reason: 'Cancelled' }), event(2, 'workspace_receipt', { receipt: receipt() })] } : { id: 'run-1', status: 'cancelled' };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.workspaceReceipts[0].effectId, 'effect-1');
  assert.ok(methods.every(method => method === 'GET'));
});

test('workspace audit distinguishes verified, unknown, not-dispatched and contradictory readback facts', () => {
  assert.equal(workspaceEditReceipt(receipt()).unknownEffect, true);
  assert.equal(workspaceEditReceipt({ ...receipt(), outcome: 'not_dispatched', dispatchAttempted: false }).notDispatched, true);
  const confirmed = { ...receipt(), outcome: 'verified', verified: true, observedHash: 'b'.repeat(64), observedBytes: 11 };
  assert.equal(workspaceEditReceipt(confirmed).verified, true);
  for (const invalid of [{ observedHash: 'c'.repeat(64) }, { observedHash: 'bad' }, { observedHash: undefined }, { observedBytes: undefined }, { bytesAfter: undefined }, { observedBytes: 12 }, { dispatchAttempted: false }, { verified: false }, { expectedHash: null }, { atomic: true }]) {
    assert.equal(workspaceEditReceipt({ ...confirmed, ...invalid }).verified, false, JSON.stringify(invalid));
  }
  assert.equal(workspaceEditReceipt({ ...confirmed, bytesAfter: 0, observedBytes: 0 }).verified, true, 'Verified empty files retain an exact zero-byte readback.');
  assert.equal(workspaceEditReceipt({ ...receipt(), bytesBefore: -1 }).bytesBefore, null);
  assert.equal(workspaceEditReceipt(null), null);
});

test('actual preview SSR escapes untrusted literal/path text and makes CRLF/BOM/fragment boundaries visible', () => {
  const source = '\uFEFFconst tag = "<img src=x onerror=alert(1)>";\r\n';
  const preview = fixture(source, [{ oldText: source, newText: '\uFEFF<script>alert(1)</script>\nhttps://example.invalid' }]);
  preview.path = 'src/<untrusted>.js';
  const markup = renderToStaticMarkup(React.createElement(WorkspaceEditPreview, { preview }));
  assert.match(markup, /aria-label="Exact workspace edit preview"/);
  assert.ok(markup.includes(preview.expectedHash));
  assert.ok(markup.includes(preview.newHash));
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;untrusted&gt;/);
  assert.match(markup, /U\+FEFF/);
  assert.match(markup, /CRLF/);
  assert.match(markup, /no line break at fragment end/);
  assert.match(markup, /not whole source lines/);
  assert.doesNotMatch(markup, /<(script|img|iframe|a|button)\b/i);
});

test('actual SSR marks TAB, bidirectional and zero-width/control text in literals and paths without modifying source', () => {
  const ranges = [[1, 9], [11, 12], [14, 31], [127, 159], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x206F], [0xFEFF, 0xFEFF]];
  const points = ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, index) => start + index));
  const controls = String.fromCodePoint(...points), source = `old${controls}`;
  const preview = fixture(source, [{ oldText: source, newText: `new${controls}` }]);
  preview.path = 'src/\u202Ename\u200D.js';
  assert.equal(validateWorkspaceEditPreview(preview).valid, true, 'Well-formed Unicode source remains accepted.');
  const markup = renderToStaticMarkup(React.createElement(WorkspaceEditPreview, { preview }));
  for (const point of points) assert.ok(markup.includes(`U+${point.toString(16).toUpperCase().padStart(4, '0')}`));
  assert.match(markup, /U\+0009 TAB/);
  assert.match(markup, /U\+202E/);
  assert.match(markup, /U\+200D/);
  const rawControls = /[\u0001-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;
  assert.doesNotMatch(markup, rawControls);
  const audit = renderToStaticMarkup(React.createElement(WorkspaceEditReceipt, { receipt: { ...receipt(), path: `src/${controls}.js` } }));
  assert.match(audit, /U\+0009 TAB/);
  assert.match(audit, /U\+200D/);
  assert.doesNotMatch(audit, rawControls);
  assert.equal(preview.edits[0].oldText, source);
  assert.equal(preview.edits[0].newText, `new${controls}`);
});

test('actual preview and audit SSR reject absent previews and keep uncertain outcomes explicit with no actions', () => {
  for (const preview of [null, { ...fixture(), complete: false }]) {
    const markup = renderToStaticMarkup(React.createElement(WorkspaceEditPreview, { preview }));
    assert.match(markup, /Do not approve/);
    assert.doesNotMatch(markup, /aria-label="Exact workspace edit preview"/);
  }
  const markup = renderToStaticMarkup(React.createElement(WorkspaceEditReceipt, { receipt: { ...receipt(), path: '<unsafe>', code: '<script>bad</script>' } }));
  assert.match(markup, /Outcome unknown/);
  assert.match(markup, /&lt;unsafe&gt;/);
  assert.match(markup, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(markup, /No automatic retry or undo/);
  assert.doesNotMatch(markup, /<(script|img|iframe|a|button)\b/i);
  const missing = renderToStaticMarkup(React.createElement(WorkspaceEditReceipt, { receipt: null }));
  assert.match(missing, /outcome is not confirmed/);
});
