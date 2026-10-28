import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { MAX_WORKSPACE_EDIT_PREVIEW_CHARS, safeWorkspacePatchPath, validateWorkspacePatchPreview,
  workspaceEditApprovalError, workspacePatchReceipt } from '../src/workspace-edits.mjs';
import { initialRun, pollAgentRun, reconcileRun, reduceRunEvent } from '../src/protocol.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const event = (sequence, type, data = {}) => ({ runId: 'patch-run', sequence, type, data });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function fileFixture(path, source, replacements) {
  const position = (text, offset) => {
    const parts = text.slice(0, offset).split(/\r\n|\r|\n/);
    return { line: parts.length, column: parts.at(-1).length + 1 };
  };
  let after = '', cursor = 0;
  const edits = replacements.map(edit => ({ ...edit, offset: source.indexOf(edit.oldText) })).sort((a, b) => a.offset - b.offset).map(edit => {
    assert.ok(edit.offset >= 0);
    after += source.slice(cursor, edit.offset);
    const beforePosition = position(source, edit.offset), afterPosition = position(after, after.length);
    const row = { startLine: beforePosition.line, startColumn: beforePosition.column,
      newStartLine: afterPosition.line, newStartColumn: afterPosition.column, offsetUtf16: edit.offset,
      oldText: edit.oldText, newText: edit.newText };
    after += edit.newText; cursor = edit.offset + edit.oldText.length;
    return row;
  });
  after += source.slice(cursor);
  const lineEndings = { lf: 0, crlf: 0, cr: 0 };
  for (const match of source.matchAll(/\r\n|\r|\n/g)) lineEndings[match[0] === '\r\n' ? 'crlf' : match[0] === '\r' ? 'cr' : 'lf']++;
  return { kind: 'workspace_edit', path, expectedHash: digest(source), newHash: digest(after), bytesBefore: Buffer.byteLength(source), bytesAfter: Buffer.byteLength(after),
    edits, complete: true, atomic: false, lineEndings, utf8Bom: source.startsWith('\uFEFF') };
}
function patchFixture() {
  const files = [
    fileFixture('src/first.js', '\uFEFFfirst😀\r\nold = true;\r\ntail\n', [{ oldText: 'old = true;', newText: '<script>new</script>' }, { oldText: 'tail', newText: 'finish\t\u202E\u200D' }]),
    fileFixture('docs/second.md', 'second\rleft\nright', [{ oldText: 'left\nright', newText: 'updated\r\n🌱' }])
  ];
  return { preview: { kind: 'workspace_patch', complete: true, atomic: false, fileCount: files.length, files },
    args: { files: files.map(file => ({ path: file.path, expectedHash: file.expectedHash,
      edits: file.edits.map(({ oldText, newText }) => ({ oldText, newText })).reverse() })) } };
}
const approval = ({ preview, args } = patchFixture()) => ({ name: 'workspace.patch', approvalId: 'approve-patch', preview, arguments: args });
function patchReceipt(states = ['verified', 'not_dispatched'], outcome = 'partial', complete = true) {
  const { preview } = patchFixture();
  const files = preview.files.map((file, index) => ({ path: file.path, expectedHash: file.expectedHash, newHash: file.newHash,
    bytesBefore: file.bytesBefore, bytesAfter: file.bytesAfter, editCount: file.edits.length, outcome: states[index],
    dispatchAttempted: ['verified', 'unknown'].includes(states[index]), verified: states[index] === 'verified',
    ...(states[index] === 'verified' ? { observedHash: file.newHash, observedBytes: file.bytesAfter } : {}) }));
  const counts = { total: files.length, verified: 0, unknown: 0, notDispatched: 0, pending: 0 };
  for (const file of files) counts[file.outcome === 'not_dispatched' ? 'notDispatched' : file.outcome]++;
  return { kind: 'workspace_patch', effectId: 'patch-effect-1', outcome, complete, atomic: false, files, counts };
}

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/App.jsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: import.meta.resolve(args.path), external: true })); } }]
});
const { default: App, WorkspacePatchPreview, WorkspacePatchReceipt } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('full patch binds exact normalized paths, hashes and literal sets while retaining every original fragment', () => {
  const { preview, args } = patchFixture(), before = clone(preview);
  args.files[0].path = 'src\\first.js';
  preview.additionalServerContext = { lease: 'cooperative', externalChangesStillPossible: true };
  const result = validateWorkspacePatchPreview(preview, args);
  assert.equal(result.valid, true, result.errors.join(' '));
  assert.deepEqual(result.preview, preview);
  assert.equal(result.preview.files[0].edits[0].startLine, 2);
  assert.equal(result.preview.files[0].utf8Bom, true);
  assert.deepEqual(result.preview.files[0].lineEndings, { lf: 1, crlf: 2, cr: 0 });
  assert.deepEqual(result.preview.files[1], before.files[1]);
  assert.equal(workspaceEditApprovalError({ name: 'workspace.patch', preview, arguments: args }), null);
  result.preview.files[0].edits[0].newText = 'changed clone';
  assert.deepEqual(preview.files, before.files, 'Validation does not mutate request or preview.');
});

test('combined full preview accepts exactly 24,000 serialized characters and rejects excess without partial children', () => {
  const { preview, args } = patchFixture(); preview.extra = '';
  preview.extra = 'x'.repeat(MAX_WORKSPACE_EDIT_PREVIEW_CHARS - JSON.stringify(preview).length);
  assert.equal(JSON.stringify(preview).length, 24000);
  assert.equal(validateWorkspacePatchPreview(preview, args).valid, true);
  preview.extra += 'x';
  const invalid = validateWorkspacePatchPreview(preview, args);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.preview, null);
  assert.match(invalid.errors.join(' '), /rejected, not truncated/);
});

test('missing, truncated, malformed and incomplete child previews block patch approval', () => {
  for (const value of [null, undefined, [], 'preview', false]) assert.equal(validateWorkspacePatchPreview(value, patchFixture().args).valid, false);
  const changes = [{ complete: false }, { atomic: true }, { kind: 'workspace_edit' }, { truncated: true }, { truncated: 'false' }, { incomplete: true }, { files: [] }, { files: [patchFixture().preview.files[0]] }, { fileCount: 3 }, { totalFiles: 99 }];
  for (const change of changes) {
    const value = approval(); Object.assign(value.preview, change);
    assert.match(workspaceEditApprovalError(value), /cannot be approved/, JSON.stringify(change));
  }
  for (const change of [{ complete: false }, { expectedHash: 'bad' }, { newHash: patchFixture().preview.files[0].expectedHash }, { edits: [] }, { bytesAfter: -1 }, { truncated: true }, { incomplete: 'false' }, { utf8Bom: undefined }]) {
    const value = approval(); Object.assign(value.preview.files[0], change);
    assert.ok(workspaceEditApprovalError(value), JSON.stringify(change));
  }
  const brokenUnicode = approval(); brokenUnicode.preview.files[0].edits[0].newText = '\uD800';
  assert.match(workspaceEditApprovalError(brokenUnicode), /Unicode/);
});

test('approval rejects argument path/hash/literal/count/file-order mismatches and unexpected fields', () => {
  const mutations = [
    value => { value.arguments = undefined; },
    value => { value.arguments.extra = true; },
    value => { value.arguments.files[0].path = 'src/other.js'; },
    value => { value.arguments.files[0].path = 'SRC/first.js'; },
    value => { value.arguments.files[0].expectedHash = 'a'.repeat(64); },
    value => { value.arguments.files[0].edits[0].oldText += 'different'; },
    value => { value.arguments.files[0].edits[0].newText += 'different'; },
    value => { value.arguments.files[0].edits.pop(); },
    value => { value.arguments.files[0].edits[0].extra = true; },
    value => { value.arguments.files[0].extra = true; },
    value => { value.arguments.files.pop(); },
    value => { value.arguments.files.reverse(); },
    value => { value.arguments.files[0].edits[1] = clone(value.arguments.files[0].edits[0]); }
  ];
  for (const mutate of mutations) { const value = approval(); mutate(value); assert.ok(workspaceEditApprovalError(value), mutate.toString()); }
  const existing = patchFixture().preview.files[0];
  assert.equal(workspaceEditApprovalError({ name: 'workspace.edit', preview: existing }), null, 'Existing single-file behavior is preserved.');
  assert.equal(workspaceEditApprovalError({ name: 'other.tool', preview: null }), null);
});

test('patch paths reject traversal, aliases, devices, sensitive paths and invisible display controls', () => {
  for (const path of ['src/main.js', 'spaced folder/file name.md', 'src/visible-🌱.js', 'docs/café.md']) assert.equal(safeWorkspacePatchPath(path), true, path);
  for (const path of ['', '/absolute', 'C:/file', '../file', './file', 'src//file', 'https://example.invalid/file', 'src\\file', 'src/file.', 'src/name ', ' src/file', '.env.local', '.git/config', 'secrets.json', 'src/CON.txt', 'src/token.key', 'src/<img>.js', 'src/name\u202E.js', 'src/name\u200D.js', 'src/name\t.js', 'src/name\u0085.js', 'src/name\u034F.js', 'src/name\uFE0F.js', 'src/name\uD800.js']) {
    assert.equal(safeWorkspacePatchPath(path), false, JSON.stringify(path));
    const value = approval(); value.preview.files[0].path = path; value.arguments.files[0].path = path;
    assert.ok(workspaceEditApprovalError(value), JSON.stringify(path));
  }
  for (const paths of [['src/first.js', 'src/first.js'], ['src/first.js', 'SRC/FIRST.js'], ['docs/caf\u00e9.md', 'docs/cafe\u0301.md']]) {
    const value = approval();
    paths.forEach((path, index) => { value.preview.files[index].path = path; value.arguments.files[index].path = path; });
    assert.match(workspaceEditApprovalError(value), /duplicates/);
  }
});

test('patch receipt shows individual readback, unattempted, unknown and pending states with exact derived counts', () => {
  const partial = workspacePatchReceipt(patchReceipt());
  assert.equal(partial.verified, false);
  assert.match(partial.label, /Partial patch/);
  assert.deepEqual(partial.counts, { total: 2, verified: 1, unknown: 0, notDispatched: 1, pending: 0 });
  assert.deepEqual(partial.files.map(file => file.state), ['verified', 'notDispatched']);
  assert.equal(partial.files[0].observedHash, partial.files[0].newHash);
  assert.equal(partial.files[0].observedBytes, partial.files[0].bytesAfter);
  const pending = workspacePatchReceipt(patchReceipt(['pending', 'pending'], 'in_progress', false));
  assert.equal(pending.inProgress, true);
  assert.equal(pending.counts.pending, 2);
  assert.equal(pending.verified, false);
  const dispatched = workspacePatchReceipt(patchReceipt(['unknown', 'pending'], 'in_progress', false));
  assert.equal(dispatched.inProgress, true);
  assert.equal(dispatched.counts.unknown, 1);
  assert.equal(workspacePatchReceipt(patchReceipt(['unknown', 'not_dispatched'], 'unknown')).verified, false);
  assert.equal(workspacePatchReceipt(patchReceipt(['not_dispatched', 'not_dispatched'], 'not_dispatched')).notDispatched, true);
  assert.equal(workspacePatchReceipt(patchReceipt(['verified', 'verified'], 'verified')).verified, true);
});

test('a claimed verified batch needs exact observed hashes/bytes, consistent metadata and complete validated counts', () => {
  const mutations = [
    value => { delete value.files[0].observedHash; },
    value => { delete value.files[0].observedBytes; },
    value => { value.files[0].observedHash = '0'.repeat(64); },
    value => { value.files[0].observedBytes++; },
    value => { delete value.files[0].bytesAfter; },
    value => { delete value.files[0].bytesBefore; },
    value => { value.files[0].editCount = 0; },
    value => { value.files[0].dispatchAttempted = false; },
    value => { value.files[0].verified = false; },
    value => { value.files[0].expectedHash = value.files[0].newHash; },
    value => { value.files[1].path = value.files[0].path; },
    value => { value.files[1].path = 'src/hidden\u202E.js'; },
    value => { value.complete = false; },
    value => { value.atomic = true; },
    value => { value.counts.verified = 99; },
    value => { value.counts.extra = 0; },
    value => { value.counts = null; },
    value => { value.files = [value.files[0]]; }
  ];
  for (const mutate of mutations) {
    const receipt = patchReceipt(['verified', 'verified'], 'verified'); mutate(receipt);
    const result = workspacePatchReceipt(receipt);
    assert.equal(result.verified, false, mutate.toString());
    assert.ok(result.issues.length, mutate.toString());
    assert.doesNotMatch(result.label, /^All patch files verified$/);
  }
  const declaredPartial = workspacePatchReceipt(patchReceipt(['verified', 'verified'], 'partial'));
  assert.equal(declaredPartial.verified, false, 'A partial declaration never becomes full success based on counts alone.');
  assert.equal(workspacePatchReceipt(null), null);
  assert.equal(workspacePatchReceipt({ ...patchReceipt(), effectId: 'effect\u202E' }), null);
});

test('terminal patch receipts cannot hide pending children or infer no dispatch from contradictory flags', () => {
  const terminalPending = workspacePatchReceipt(patchReceipt(['pending', 'pending'], 'unknown'));
  assert.match(terminalPending.issues.join(' '), /conflicts with pending/);
  assert.equal(terminalPending.inProgress, false);
  const receipt = patchReceipt(['not_dispatched', 'not_dispatched'], 'not_dispatched');
  receipt.files[0].dispatchAttempted = true;
  const result = workspacePatchReceipt(receipt);
  assert.equal(result.notDispatched, false);
  assert.equal(result.files[0].state, 'unknown');
  assert.equal(result.counts.unknown, 1);
});

test('same-effect progress and final receipts replace in order after cancellation without reviving the source run', () => {
  const progress = patchReceipt(['pending', 'pending'], 'in_progress', false), partial = patchReceipt();
  let state = reduceRunEvent(initialRun('patch-run'), event(1, 'workspace_receipt', { receipt: progress }));
  state = reduceRunEvent(state, event(2, 'cancelled', { reason: 'Stopped by user' }));
  state = reduceRunEvent(state, event(3, 'workspace_receipt', { receipt: partial }));
  assert.equal(state.status, 'cancelled');
  assert.equal(state.error, 'Stopped by user');
  assert.equal(state.workspaceReceipts.length, 1);
  assert.deepEqual(state.workspaceReceipts[0], partial);
  assert.equal(reduceRunEvent(state, event(3, 'workspace_receipt', { receipt: progress })), state);
  assert.equal(reduceRunEvent(state, event(4, 'completed', { output: 'Not authorized to revive' })), state);
  const fresh = reconcileRun(state, { status: 'completed', output: 'another stale output' });
  assert.equal(fresh.status, 'cancelled');
  assert.deepEqual(fresh.workspaceReceipts, [partial]);
  const single = { kind: 'workspace_edit', effectId: 'single-effect', outcome: 'unknown' };
  state = reduceRunEvent(state, event(5, 'workspace_receipt', { receipt: single }));
  assert.equal(state.workspaceReceipts.length, 2, 'Independent single-edit receipts remain available.');
});

test('read-only terminal replay drains late aggregate receipts and preserves per-file partial evidence', async () => {
  const partial = patchReceipt(); let eventReads = 0;
  const methods = [];
  const result = await pollAgentRun('patch-run', { intervalMs: 0, fetchImpl: async (url, options) => {
    methods.push(options.method || 'GET');
    if (url.includes('/events')) return json({ events: ++eventReads === 1
      ? [event(1, 'workspace_receipt', { receipt: patchReceipt(['pending', 'pending'], 'in_progress', false) })]
      : [event(2, 'cancelled', { reason: 'Stopped' }), event(3, 'workspace_receipt', { receipt: partial })] });
    return json({ id: 'patch-run', status: 'cancelled', output: '', budget: { maxTotalTokens: 24000 } });
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.workspaceReceipts.length, 1);
  assert.deepEqual(result.workspaceReceipts[0], partial);
  assert.equal(workspacePatchReceipt(result.workspaceReceipts[0]).verified, false);
  assert.ok(methods.every(method => method === 'GET'));
});

test('actual patch preview SSR renders every child/hash/literal boundary, escapes source and states the non-atomic boundary', () => {
  const value = patchFixture();
  const markup = renderToStaticMarkup(React.createElement(WorkspacePatchPreview, { preview: value.preview, args: value.args }));
  assert.match(markup, /aria-label="Exact multi-file workspace patch"/);
  assert.equal((markup.match(/aria-label="Exact workspace edit preview"/g) || []).length, 2);
  for (const file of value.preview.files) {
    assert.ok(markup.includes(file.path)); assert.ok(markup.includes(file.expectedHash)); assert.ok(markup.includes(file.newHash));
  }
  assert.match(markup, /&lt;script&gt;new&lt;\/script&gt;/);
  assert.match(markup, /U\+0009 TAB/);
  assert.match(markup, /U\+202E/);
  assert.match(markup, /U\+200D/);
  assert.match(markup, /CRLF/);
  assert.match(markup, /no line break at fragment end/);
  assert.match(markup, /not whole source lines/);
  assert.match(markup, /not an all-or-nothing transaction/);
  assert.match(markup, /cancellation or power loss can leave only some files changed/);
  assert.doesNotMatch(markup, /[\u0009\u202E\u200D]/u);
  assert.doesNotMatch(markup, /<(script|img|iframe|a|button)\b/i);
});

test('actual invalid preview SSR shows no partial authorized fragments and tells the operator to keep raw arguments', () => {
  for (const alter of [value => { value.preview.complete = false; }, value => { value.args.files[1].path = 'different.md'; }, value => { value.preview.files[1].path = 'docs/x\u202E.md'; }, value => { value.preview.files[1].truncated = true; }]) {
    const value = patchFixture(); alter(value);
    const markup = renderToStaticMarkup(React.createElement(WorkspacePatchPreview, { preview: value.preview, args: value.args }));
    assert.match(markup, /Do not approve/);
    assert.match(markup, /exact raw preview and arguments remain available below/);
    assert.doesNotMatch(markup, /aria-label="Exact workspace edit preview"/);
  }
});

test('actual audit SSR keeps partial/unknown/unattempted states, readback evidence and safe visible path markers', () => {
  const partial = patchReceipt(), markup = renderToStaticMarkup(React.createElement(WorkspacePatchReceipt, { receipt: partial }));
  assert.match(markup, /Partial patch · full success not confirmed/);
  assert.match(markup, /1 verified \/ 2 total · 1 not dispatched/);
  assert.match(markup, /Verified readback/);
  assert.match(markup, /Not dispatched/);
  assert.match(markup, /Source-run cancellation is not filesystem rollback/);
  assert.ok(markup.includes(partial.files[0].observedHash));
  assert.doesNotMatch(markup, /All patch files verified/);
  const unsafe = patchReceipt(['unknown', 'not_dispatched'], 'unknown');
  unsafe.files[0].path = 'src/<img>\u202E\u200D\t.js'; unsafe.files[0].code = '<script>\u202Ebad</script>';
  const untrusted = renderToStaticMarkup(React.createElement(WorkspacePatchReceipt, { receipt: unsafe }));
  assert.match(untrusted, /&lt;img&gt;/);
  assert.match(untrusted, /U\+202E/); assert.match(untrusted, /U\+200D/); assert.match(untrusted, /U\+0009/);
  assert.match(untrusted, /&lt;script&gt;/);
  assert.doesNotMatch(untrusted, /[\u0009\u202E\u200D]/u);
  assert.doesNotMatch(untrusted, /<(script|img|iframe|a|button)\b/i);
  const invalid = renderToStaticMarkup(React.createElement(WorkspacePatchReceipt, { receipt: { ...partial, atomic: true, complete: undefined } }));
  assert.match(invalid, /atomicity not confirmed/);
  assert.match(invalid, /completion not recorded/);
  const missing = renderToStaticMarkup(React.createElement(WorkspacePatchReceipt, { receipt: null }));
  assert.match(missing, /Patch outcome is not confirmed/);
});

test('actual audit SSR claims every file verified only for a final full readback and keeps progress explicit', () => {
  const full = renderToStaticMarkup(React.createElement(WorkspacePatchReceipt, { receipt: patchReceipt(['verified', 'verified'], 'verified') }));
  assert.match(full, /All patch files verified/);
  const progress = renderToStaticMarkup(React.createElement(WorkspacePatchReceipt, { receipt: patchReceipt(['pending', 'pending'], 'in_progress', false) }));
  assert.match(progress, /Patch progress reported/);
  assert.match(progress, /receipt not final/);
  assert.match(progress, /Pending · not dispatched yet/);
  assert.doesNotMatch(progress, /All patch files verified/);
});

test('actual companion initial render still succeeds with no patch receipt or active approval', () => {
  const markup = renderToStaticMarkup(React.createElement(App));
  assert.match(markup, /Agent/);
  assert.match(markup, /Scheduled tasks/);
  assert.doesNotMatch(markup, /All patch files verified/);
});
