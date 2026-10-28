export const MAX_WORKSPACE_EDIT_PREVIEW_CHARS = 24000;

const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const wellFormed = value => typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

function jsonStringsAreWellFormed(value) {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') { if (!wellFormed(item)) return false; }
    else if (item && typeof item === 'object') {
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
      for (const [key, child] of Object.entries(item)) {
        if (!wellFormed(key)) return false;
        stack.push(child);
      }
    } else if (item !== null && !['boolean', 'number'].includes(typeof item)) return false;
    else if (typeof item === 'number' && !Number.isFinite(item)) return false;
  }
  return true;
}

// Rows retain every literal character and its exact terminator. The final row
// is not invented when the fragment ends at the start of another source line.
export function literalFragmentLines(text, { startLine = 1, startColumn = 1 } = {}) {
  if (!wellFormed(text) || !integer(startLine, 1) || !integer(startColumn, 1)) throw new Error('Literal text and one-based UTF-16 positions are required.');
  if (!text) return [];
  const rows = [], breaks = /\r\n|\r|\n/g;
  let offset = 0, line = startLine, column = startColumn, match;
  while ((match = breaks.exec(text))) {
    rows.push({ line, column, text: text.slice(offset, match.index), ending: match[0] });
    offset = match.index + match[0].length; line++; column = 1;
  }
  if (offset < text.length) rows.push({ line, column, text: text.slice(offset), ending: '' });
  return rows;
}

export function validateWorkspaceEditPreview(value) {
  const errors = [];
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { return { valid: false, errors: ['The edit preview is not serializable JSON.'], preview: null }; }
  if (typeof serialized !== 'string') return { valid: false, errors: ['The edit preview is missing.'], preview: null };
  if (serialized.length > MAX_WORKSPACE_EDIT_PREVIEW_CHARS) return { valid: false, errors: [`The complete preview exceeds ${MAX_WORKSPACE_EDIT_PREVIEW_CHARS.toLocaleString('en-US')} serialized characters. It must be rejected, not truncated.`], preview: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['The edit preview must be an object.'], preview: null };
  if (!jsonStringsAreWellFormed(value)) return { valid: false, errors: ['The preview contains malformed Unicode or non-JSON fields.'], preview: null };
  if (value.kind !== 'workspace_edit') errors.push('The preview is not a workspace edit.');
  if (value.complete !== true) errors.push('The full edit preview is not confirmed complete.');
  if (value.truncated === true || value.incomplete === true) errors.push('A truncated or incomplete edit preview cannot be approved.');
  if (typeof value.path !== 'string' || !value.path || value.path.length > 1024 || /[\x00-\x1f\x7f]/.test(value.path)) errors.push('The exact workspace path is missing or malformed.');
  if (!hash(value.expectedHash) || !hash(value.newHash)) errors.push('Both complete SHA-256 hashes are required.');
  else if (value.expectedHash.toLowerCase() === value.newHash.toLowerCase()) errors.push('The combined edit does not change the file hash.');
  if (!integer(value.bytesBefore) || !integer(value.bytesAfter)) errors.push('Exact nonnegative UTF-8 byte counts are required.');
  if (value.atomic !== false) errors.push('This preview must explicitly identify the edit as non-atomic.');
  if (typeof value.utf8Bom !== 'boolean') errors.push('UTF-8 BOM metadata is missing.');
  if (!value.lineEndings || typeof value.lineEndings !== 'object' || ['lf', 'crlf', 'cr'].some(key => !integer(value.lineEndings[key]))) errors.push('LF, CRLF and CR file counts are required.');
  if (!Array.isArray(value.edits) || !value.edits.length || value.edits.length > 8) errors.push('One to eight complete literal replacements are required.');
  const edits = [];
  let previousOffset = -1, previousEnd = 0, previousLine = 0, previousColumn = 0, byteDelta = 0;
  const encoder = new TextEncoder();
  for (const [index, edit] of (Array.isArray(value.edits) ? value.edits : []).entries()) {
    const label = `Replacement ${index + 1}`;
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)
      || !['startLine', 'startColumn', 'newStartLine', 'newStartColumn'].every(key => integer(edit[key], 1))
      || !integer(edit.offsetUtf16) || !wellFormed(edit.oldText) || !wellFormed(edit.newText)) {
      errors.push(`${label} is missing exact text or valid UTF-16 positions.`); continue;
    }
    if (!edit.oldText || edit.oldText === edit.newText || edit.oldText.includes('\0') || edit.newText.includes('\0')) errors.push(`${label} must replace nonempty, NUL-free literal text with a different value.`);
    if (!Number.isSafeInteger(edit.offsetUtf16 + edit.oldText.length)) errors.push(`${label} has an invalid UTF-16 end offset.`);
    if (integer(value.bytesBefore) && (edit.startLine > value.bytesBefore + 1 || edit.startColumn > value.bytesBefore + 1 || edit.offsetUtf16 + edit.oldText.length > value.bytesBefore)) errors.push(`${label} has original positions outside the recorded file size.`);
    if (integer(value.bytesAfter) && (edit.newStartLine > value.bytesAfter + 1 || edit.newStartColumn > value.bytesAfter + 1)) errors.push(`${label} has proposed positions outside the recorded file size.`);
    if (edit.offsetUtf16 <= previousOffset || edit.offsetUtf16 < previousEnd) errors.push(`${label} overlaps another edit or is not in original-file order.`);
    if (edit.startLine < previousLine || (edit.startLine === previousLine && edit.startColumn <= previousColumn)) errors.push(`${label} has inconsistent original line/column order.`);
    previousOffset = edit.offsetUtf16; previousEnd = edit.offsetUtf16 + edit.oldText.length;
    previousLine = edit.startLine; previousColumn = edit.startColumn;
    byteDelta += encoder.encode(edit.newText).byteLength - encoder.encode(edit.oldText).byteLength;
    edits.push({ startLine: edit.startLine, startColumn: edit.startColumn, newStartLine: edit.newStartLine, newStartColumn: edit.newStartColumn,
      offsetUtf16: edit.offsetUtf16, oldText: edit.oldText, newText: edit.newText,
      removed: literalFragmentLines(edit.oldText, { startLine: edit.startLine, startColumn: edit.startColumn }),
      added: literalFragmentLines(edit.newText, { startLine: edit.newStartLine, startColumn: edit.newStartColumn }) });
  }
  if (integer(value.bytesBefore) && integer(value.bytesAfter) && value.bytesAfter - value.bytesBefore !== byteDelta) errors.push('UTF-8 byte counts do not match the literal replacement sizes.');
  if (errors.length) return { valid: false, errors, preview: null };
  return { valid: true, errors: [], preview: { kind: value.kind, path: value.path, expectedHash: value.expectedHash, newHash: value.newHash,
    bytesBefore: value.bytesBefore, bytesAfter: value.bytesAfter, complete: true, atomic: false,
    utf8Bom: value.utf8Bom, lineEndings: { lf: value.lineEndings.lf, crlf: value.lineEndings.crlf, cr: value.lineEndings.cr }, edits } };
}

export function workspaceEditApprovalError(approval) {
  if (approval?.name === 'workspace.patch') {
    const validation = validateWorkspacePatchPreview(approval.preview, approval.arguments);
    return validation.valid ? null : `Workspace patch cannot be approved: ${validation.errors.join(' ')}`;
  }
  if (approval?.name !== 'workspace.edit') return null;
  const validation = validateWorkspaceEditPreview(approval.preview);
  return validation.valid ? null : `Workspace edit cannot be approved: ${validation.errors.join(' ')}`;
}

const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const forbiddenPathName = /^(?:\.git(?:config|modules)?|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const credentialPathName = /^(?:\.git-credentials|api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|client[_-]?secrets?|service[_-]?account(?:[_-]?keys?)?|authorized_keys|known_hosts)(?:[._-].*)?$/i;
const devicePathName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const invisiblePath = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const patchPathKey = path => path.toLowerCase().normalize('NFC');

export function safeWorkspacePatchPath(path) {
  return wellFormed(path) && path.length > 0 && path.length <= 1024 && !invisiblePath.test(path) && !path.includes('\\')
    && path.split('/').every(part => part && part !== '.' && part !== '..' && part.trim() === part && !/[. ]$/.test(part)
      && !/[<>:"|?*]/.test(part) && !forbiddenPathName.test(part) && !credentialPathName.test(part)
      && !/\.(?:pem|key|p12|pfx|kdbx|keystore)$/i.test(part) && !devicePathName.test(part));
}

export function validateWorkspacePatchPreview(value, args) {
  const errors = [];
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return { valid: false, errors: ['The patch preview is not serializable JSON.'], preview: null }; }
  if (typeof serialized !== 'string' || !plain(value)) return { valid: false, errors: ['The complete patch preview is missing.'], preview: null };
  if (serialized.length > MAX_WORKSPACE_EDIT_PREVIEW_CHARS) return { valid: false, errors: ['The combined patch preview exceeds 24,000 serialized characters; it must be rejected, not truncated.'], preview: null };
  if (!jsonStringsAreWellFormed(value)) return { valid: false, errors: ['The patch contains malformed Unicode or non-JSON metadata.'], preview: null };
  if (value.kind !== 'workspace_patch' || value.complete !== true || value.atomic !== false
    || (Object.hasOwn(value, 'truncated') && value.truncated !== false) || (Object.hasOwn(value, 'incomplete') && value.incomplete !== false)) errors.push('The full non-atomic workspace patch must be confirmed complete and untruncated.');
  if (!Array.isArray(value.files) || value.files.length < 2 || value.files.length > 8) return { valid: false, errors: [...errors, 'A patch requires 2–8 complete file previews.'], preview: null };
  if (!exactKeys(args, ['files']) || !Array.isArray(args.files) || args.files.length < 2 || args.files.length > 8) errors.push('Exact patch arguments with 2–8 files are required.');
  const files = Array.isArray(value.files) ? value.files : [], inputs = Array.isArray(args?.files) ? args.files : [];
  if (files.length !== inputs.length) errors.push('The argument and preview file counts differ.');
  for (const key of ['fileCount', 'totalFiles', 'totalCount']) if (Object.hasOwn(value, key) && value[key] !== files.length) errors.push('The declared patch file count differs from its complete file list.');
  const seenPreview = new Set(), seenArgs = new Set();
  for (const [index, child] of files.entries()) {
    const label = `File ${index + 1}`, input = inputs[index];
    const validated = validateWorkspaceEditPreview(child);
    if (!validated.valid) errors.push(`${label}: ${validated.errors.join(' ')}`);
    if (plain(child) && ((Object.hasOwn(child, 'truncated') && child.truncated !== false) || (Object.hasOwn(child, 'incomplete') && child.incomplete !== false))) errors.push(`${label} has invalid truncation metadata.`);
    if (!safeWorkspacePatchPath(child?.path)) errors.push(`${label} has an unsafe or visually ambiguous preview path.`);
    else { const key = patchPathKey(child.path); if (seenPreview.has(key)) errors.push(`${label} duplicates another preview path or its case/Unicode alias.`); seenPreview.add(key); }
    if (!exactKeys(input, ['path', 'expectedHash', 'edits'])) { errors.push(`${label} has incomplete or unexpected argument fields.`); continue; }
    const path = typeof input.path === 'string' ? input.path.replace(/\\/g, '/') : null;
    if (!safeWorkspacePatchPath(path)) errors.push(`${label} has an unsafe or visually ambiguous argument path.`);
    else { const key = patchPathKey(path); if (seenArgs.has(key)) errors.push(`${label} duplicates another argument path or its case/Unicode alias.`); seenArgs.add(key); }
    if (path !== child?.path || input.expectedHash !== child?.expectedHash || !hash(input.expectedHash)) errors.push(`${label} path or expected hash does not match its exact arguments.`);
    if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 8 || !Array.isArray(child?.edits) || input.edits.length !== child.edits.length) {
      errors.push(`${label} literal replacement counts differ or are invalid.`); continue;
    }
    const expectedPairs = new Set(), expectedOld = new Set();
    for (const edit of input.edits) {
      if (!exactKeys(edit, ['oldText', 'newText']) || !wellFormed(edit.oldText) || !edit.oldText || !wellFormed(edit.newText)
        || edit.oldText.includes('\0') || edit.newText.includes('\0') || edit.oldText === edit.newText || expectedOld.has(edit.oldText)) {
        errors.push(`${label} has invalid or duplicate literal arguments.`); continue;
      }
      expectedOld.add(edit.oldText); expectedPairs.add(JSON.stringify([edit.oldText, edit.newText]));
    }
    const previewPairs = new Set(child.edits.map(edit => JSON.stringify([edit?.oldText, edit?.newText])));
    if (expectedPairs.size !== input.edits.length || previewPairs.size !== child.edits.length || expectedPairs.size !== previewPairs.size
      || [...expectedPairs].some(pair => !previewPairs.has(pair))) errors.push(`${label} literal text differs from its exact arguments.`);
  }
  return errors.length ? { valid: false, errors, preview: null }
    : { valid: true, errors: [], preview: JSON.parse(serialized) };
}

function visiblePatchPath(path) {
  if (typeof path !== 'string') return 'Not recorded';
  return [...path].map(character => invisiblePath.test(character) ? `⟨U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩` : character).join('');
}

export function workspacePatchReceipt(receipt) {
  if (!plain(receipt) || receipt.kind !== 'workspace_patch' || typeof receipt.effectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(receipt.effectId)) return null;
  const issues = [], rows = [], seen = new Set();
  if (receipt.atomic !== false || typeof receipt.complete !== 'boolean' || !['in_progress', 'verified', 'partial', 'unknown', 'not_dispatched'].includes(receipt.outcome)) issues.push('Patch completion/outcome metadata is inconsistent.');
  const boundedFiles = Array.isArray(receipt.files) && receipt.files.length >= 2 && receipt.files.length <= 8;
  if (!boundedFiles) issues.push('The complete bounded file receipt list is unavailable.');
  const counts = { total: 0, verified: 0, unknown: 0, notDispatched: 0, pending: 0 };
  for (const file of boundedFiles ? receipt.files : []) {
    const normalized = workspaceEditReceipt({ ...file, kind: 'workspace_edit', effectId: receipt.effectId, atomic: receipt.atomic });
    const pathValid = safeWorkspacePatchPath(file?.path), key = pathValid ? patchPathKey(file.path) : null;
    const duplicate = key !== null && seen.has(key); if (key !== null) seen.add(key);
    if (!pathValid || duplicate) issues.push('A file path is unsafe, ambiguous or duplicated.');
    const metadataValid = plain(file) && hash(file.expectedHash) && hash(file.newHash) && file.expectedHash.toLowerCase() !== file.newHash.toLowerCase()
      && integer(file.bytesBefore) && integer(file.bytesAfter) && integer(file.editCount, 1) && file.editCount <= 8
      && typeof file.dispatchAttempted === 'boolean' && typeof file.verified === 'boolean'
      && ['pending', 'verified', 'unknown', 'not_dispatched'].includes(file.outcome);
    if (!metadataValid) issues.push('A file receipt is missing valid hash, byte, edit-count or dispatch metadata.');
    const verified = metadataValid && pathValid && !duplicate && normalized?.verified === true;
    const notDispatched = metadataValid && pathValid && !duplicate && normalized?.notDispatched === true;
    const pending = metadataValid && pathValid && !duplicate && file?.outcome === 'pending' && file.dispatchAttempted === false && file.verified === false;
    const state = verified ? 'verified' : notDispatched ? 'notDispatched' : pending ? 'pending' : 'unknown';
    if (file?.outcome === 'verified' && !verified) issues.push('A reported file verification lacks consistent path/readback evidence.');
    counts.total++; counts[state]++;
    rows.push({ path: file?.path, displayPath: visiblePatchPath(file?.path), state,
      label: verified ? 'Verified readback' : notDispatched ? 'Not dispatched' : pending ? 'Pending · not dispatched yet' : file?.outcome === 'verified' ? 'Verification not confirmed' : 'Outcome unknown',
      dispatchAttempted: typeof file?.dispatchAttempted === 'boolean' ? file.dispatchAttempted : null,
      expectedHash: normalized?.expectedHash, newHash: normalized?.newHash, observedHash: normalized?.observedHash,
      bytesBefore: normalized?.bytesBefore, bytesAfter: normalized?.bytesAfter, observedBytes: normalized?.observedBytes,
      editCount: normalized?.editCount, displayCode: normalized?.code ? visiblePatchPath(normalized.code) : null });
  }
  const countKeys = ['total', 'verified', 'unknown', 'notDispatched', 'pending'];
  const countsMatch = exactKeys(receipt.counts, countKeys) && countKeys.every(key => integer(receipt.counts[key]) && receipt.counts[key] === counts[key]);
  if (!countsMatch) issues.push('Reported counts do not match validated file outcomes.');
  if ((receipt.outcome === 'in_progress') !== (receipt.complete === false) || (receipt.complete === true && counts.pending > 0)) issues.push('The final/progress state conflicts with pending files.');
  const verified = issues.length === 0 && receipt.complete === true && receipt.outcome === 'verified' && counts.total >= 2 && counts.verified === counts.total;
  const notDispatched = issues.length === 0 && receipt.complete === true && receipt.outcome === 'not_dispatched' && counts.notDispatched === counts.total;
  const inProgress = issues.length === 0 && receipt.outcome === 'in_progress' && receipt.complete === false;
  return { effectId: receipt.effectId, declaredOutcome: receipt.outcome, complete: typeof receipt.complete === 'boolean' ? receipt.complete : null,
    atomic: receipt.atomic === false ? false : null, files: rows, counts, issues,
    verified, notDispatched, inProgress,
    label: verified ? 'All patch files verified' : inProgress ? 'Patch progress reported' : notDispatched ? 'Patch not dispatched' : receipt.outcome === 'partial' ? 'Partial patch · full success not confirmed' : 'Patch outcome unknown or unconfirmed' };
}

export function workspaceEditReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || receipt.kind !== 'workspace_edit' || typeof receipt.effectId !== 'string' || !receipt.effectId) return null;
  const outcome = typeof receipt.outcome === 'string' ? receipt.outcome : 'unknown';
  const recordedHash = value => hash(value) ? value : null;
  const observedHash = recordedHash(receipt.observedHash), newHash = recordedHash(receipt.newHash);
  const verified = outcome === 'verified' && receipt.verified === true && receipt.dispatchAttempted === true
    && typeof receipt.path === 'string' && Boolean(receipt.path) && hash(receipt.expectedHash) && Boolean(newHash)
    && Boolean(observedHash) && observedHash.toLowerCase() === newHash.toLowerCase()
    && integer(receipt.observedBytes) && integer(receipt.bytesAfter) && receipt.observedBytes === receipt.bytesAfter
    && receipt.atomic === false;
  const notDispatched = outcome === 'not_dispatched' && receipt.dispatchAttempted === false && receipt.verified === false;
  return { effectId: receipt.effectId, path: typeof receipt.path === 'string' ? receipt.path : null,
    expectedHash: recordedHash(receipt.expectedHash), newHash, observedHash,
    outcome, verified, notDispatched,
    label: verified ? 'Verified in server receipt' : notDispatched ? 'Not dispatched' : outcome === 'verified' ? 'Verification not confirmed' : 'Outcome unknown',
    dispatchAttempted: typeof receipt.dispatchAttempted === 'boolean' ? receipt.dispatchAttempted : null,
    recordedVerified: typeof receipt.verified === 'boolean' ? receipt.verified : null,
    bytesBefore: integer(receipt.bytesBefore) ? receipt.bytesBefore : null,
    bytesAfter: integer(receipt.bytesAfter) ? receipt.bytesAfter : null,
    observedBytes: integer(receipt.observedBytes) ? receipt.observedBytes : null,
    editCount: integer(receipt.editCount) ? receipt.editCount : null,
    atomic: receipt.atomic === false ? false : null,
    code: typeof receipt.code === 'string' ? receipt.code : null,
    unknownEffect: !verified && !notDispatched
  };
}
