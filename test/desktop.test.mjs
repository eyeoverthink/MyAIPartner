import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRequest, directChatHistory, initialRun, reduceRunEvent, loadPendingRun, savePendingRun } from '../src/protocol.mjs';
import { assertDesktopGrant, localDesktopModel, verifiedDesktopVision, loadDesktopGrant, saveDesktopGrant,
  desktopActionReceipt, desktopCurrentValue, desktopHealthInvalidationKey, shouldRefreshDesktopHealth, desktopSnapshot, desktopScreenshotUrl, canCaptureOperatorPreview, operatorPreviewSnapshot } from '../src/desktop.mjs';
import { refreshDesktopHealth } from '../src/desktop-health.mjs';

const model = { name: 'tested-local', provider: 'ollama', tools: true, vision: false };
const health = { configured: true, available: true, engine: 'windows-uia', isolation: 'none', localOnly: true, approvalRequired: true,
  verifiedVisionModels: [], screenshotModelInputVerified: false };
const grant = () => ({ sessionId: 'session-1', state: 'active', window: { title: 'PRIVATE_WINDOW_SENTINEL', app: 'allowed.exe' },
  allowScreenshots: false, createdAt: Date.now(), expiresAt: Date.now() + 600000 });
const base = () => ({ requestId: 'request-1', conversationId: 'conversation-1', goal: 'Authored desktop goal', model, desktopSession: grant(), desktopHealth: health });
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };

test('text-only desktop runs bind only the active grant ID and explicitly use local bounded execution', () => {
  const request = buildAgentRequest(base());
  assert.equal(request.desktopSessionId, 'session-1');
  assert.equal(request.provider, 'ollama');
  assert.equal(request.budget.maxDurationMs, 300000);
  assert.equal(request.budget.maxInputTokens, 32768);
  assert.equal(request.budget.maxTotalTokens, 64000);
  assert.equal(request.budget.maxCostUsd, 0);
  assert.equal(JSON.stringify(request).includes('PRIVATE_WINDOW_SENTINEL'), false);
  assert.equal(Object.hasOwn(request, 'desktopSession'), false);
});

test('desktop binding rejects cloud, expired grants and unavailable native health independently of Docker status', () => {
  assert.throws(() => buildAgentRequest({ ...base(), model: { ...model, provider: 'openai', cloud: true } }), /local Ollama/);
  assert.throws(() => assertDesktopGrant({ ...grant(), expiresAt: Date.now() - 1 }, model, health), /expired/);
  assert.throws(() => buildAgentRequest({ ...base(), desktopHealth: { ...health, available: false }, capabilities: { codeExecution: { available: true, sandboxed: true } } }), /Native desktop access is not verified/);
  assert.throws(() => assertDesktopGrant({ ...grant(), state: 'revoked' }, model, health), /active desktop grant/);
  assert.equal(localDesktopModel({ ...model, tools: false }), false);
});

test('advertised vision alone never enables screenshots; only a verified exact local model can use the 32k path', () => {
  const vision = { ...model, vision: true };
  const images = { ...grant(), allowScreenshots: true };
  assert.equal(verifiedDesktopVision(vision, health), false);
  assert.throws(() => buildAgentRequest({ ...base(), model: vision, desktopSession: images }), /has not been verified/);
  const verified = { ...health, screenshotModelInputVerified: true, verifiedVisionModels: [vision.name] };
  assert.equal(verifiedDesktopVision(vision, verified), true);
  assert.equal(verifiedDesktopVision({ ...vision, name: 'different-model' }, verified), false);
  const request = buildAgentRequest({ ...base(), model: vision, desktopSession: images, desktopHealth: verified });
  assert.equal(request.budget.maxInputTokens, 32768);
  assert.equal(request.budget.maxTotalTokens, 64000);
});

test('grant request recovery retains the original idempotency identity and pending run payload remains immutable', () => {
  const local = storage();
  const tracking = { requestId: 'grant-request-1', windowId: 'window-1', allowScreenshots: false };
  saveDesktopGrant(tracking, local);
  assert.deepEqual(loadDesktopGrant(local), tracking);
  const pending = { runId: 'run-1', request: buildAgentRequest(base()) };
  savePendingRun(pending, local);
  saveDesktopGrant({ ...tracking, sessionId: 'different-session' }, local);
  assert.equal(loadPendingRun(local).request.desktopSessionId, 'session-1');
  saveDesktopGrant(null, local);
  assert.equal(loadDesktopGrant(local), null);
});

test('native dispatch and unknown effects never become successful verification, including truncated durable results', () => {
  const dispatched = desktopActionReceipt({ result: { actionId: 'action-1', status: 'input_dispatched', effectObserved: null } });
  assert.equal(dispatched.verified, false);
  assert.equal(dispatched.unknownEffect, true);
  const unknown = desktopActionReceipt({ result: { truncated: true, status: 'value_verified', effectObserved: true },
    receipt: { actionId: 'action-1', status: 'outcome_unknown', effectObserved: null } });
  assert.equal(unknown.label, 'Outcome unknown');
  assert.equal(unknown.verified, false);
  assert.equal(desktopActionReceipt({ receipt: { actionId: 'action-1', status: 'value_verified', effectObserved: true } }).verified, true);
  assert.equal(desktopActionReceipt({ receipt: { actionId: 'action-1', status: 'value_verified', effectObserved: null } }).verified, false);
});

test('late native receipt updates replace pending effects after terminal cancellation without reviving the run', () => {
  let state = initialRun('run-1');
  const event = (sequence, type, data) => ({ runId: 'run-1', sequence, type, data });
  state = reduceRunEvent(state, event(1, 'desktop_receipt', { receipt: { actionId: 'action-1', status: 'outcome_unknown', effectObserved: null } }));
  state = reduceRunEvent(state, event(2, 'cancelled', { reason: 'Operator revoked grant' }));
  state = reduceRunEvent(state, event(3, 'desktop_receipt', { receipt: { actionId: 'action-1', status: 'value_verified', effectObserved: true, cleanup: 'finished' } }));
  assert.equal(state.status, 'cancelled');
  assert.equal(state.desktopReceipts.length, 1);
  assert.equal(state.desktopReceipts[0].effectObserved, true);
  assert.equal(state.sequence, 3);
});

test('snapshot text remains untrusted and screenshot URLs require a matching UUID on the local selected-window route', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const snapshot = desktopSnapshot({ snapshotId: id, sessionId: 'session-1', elements: [{ elementId: 'element-1', name: '<script>untrusted</script>' }],
    image: { snapshotId: id, mimeType: 'image/png', url: `/api/desktop/snapshots/${id}/image` } });
  assert.equal(snapshot.untrusted, true);
  assert.equal(snapshot.elements[0].name, '<script>untrusted</script>');
  assert.equal(desktopScreenshotUrl(snapshot), `/api/desktop/snapshots/${id}/image`);
  for (const url of [`https://external.example/api/desktop/snapshots/${id}/image`, `/api/desktop/snapshots/${id}/image?other=1`, '/api/desktop/snapshots/../../private/image']) {
    assert.equal(desktopScreenshotUrl({ ...snapshot, image: { ...snapshot.image, url } }), null);
  }
  assert.equal(desktopScreenshotUrl({ ...snapshot, image: { ...snapshot.image, snapshotId: 'another-snapshot' } }), null);
});

test('desktop-derived browser messages are excluded from Direct history alongside canned interface text', () => {
  const history = directChatHistory([
    { role: 'assistant', text: 'Hello', kind: 'greeting' },
    { role: 'user', text: 'PRIVATE_DESKTOP_SENTINEL', desktopSessionId: 'session-1' },
    { role: 'assistant', text: 'PRIVATE_UIA_RESULT_SENTINEL', desktopSessionId: 'session-1' },
    { role: 'user', text: 'Explicitly authored ordinary goal' }
  ]);
  assert.deepEqual(history, [{ role: 'user', content: 'Explicitly authored ordinary goal' }]);
});

test('human preview is available for a text-only grant but blocked during active work, revocation or expiry', () => {
  const current = grant();
  assert.equal(verifiedDesktopVision(model, health), false);
  assert.equal(canCaptureOperatorPreview(current), true);
  assert.equal(canCaptureOperatorPreview(current, { locked: true }), false);
  assert.equal(canCaptureOperatorPreview(current, { busy: true }), false);
  assert.equal(canCaptureOperatorPreview(current, { revoking: true }), false);
  assert.equal(canCaptureOperatorPreview({ ...current, state: 'revoked' }), false);
  assert.equal(canCaptureOperatorPreview({ ...current, expiresAt: Date.now() - 1 }), false);
});

test('operator preview remains human-only and cannot change screenshot permission or enter the model payload', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const current = grant();
  const preview = operatorPreviewSnapshot({ snapshotId: id, window: current.window, createdAt: Date.now(), untrusted: true, operatorPreview: true,
    image: { snapshotId: id, url: `/api/desktop/snapshots/${id}/image`, mimeType: 'image/png', sha256: 'a'.repeat(64), bytes: 100, width: 20, height: 20 } }, current.sessionId);
  assert.equal(preview.sessionId, current.sessionId);
  assert.equal(preview.operatorPreview, true);
  assert.equal(preview.untrusted, true);
  assert.equal(current.allowScreenshots, false);
  const request = buildAgentRequest({ ...base(), desktopSession: current });
  assert.equal(JSON.stringify(request).includes(id), false);
  assert.equal(Object.hasOwn(request, 'image'), false);
  assert.equal(verifiedDesktopVision(model, health), false);
  assert.throws(() => operatorPreviewSnapshot({ ...preview, sessionId: 'another-session' }, current.sessionId), /bound to this desktop grant/);
  assert.throws(() => operatorPreviewSnapshot({ ...preview, image: { ...preview.image, url: 'https://external.example/image' } }, current.sessionId), /image route/);
});

test('native approval distinguishes an explicitly blank current value from missing, false and zero', () => {
  assert.equal(desktopCurrentValue({ value: '' }), 'Empty string (blank)');
  assert.equal(desktopCurrentValue({ currentValue: '', value: 'older value' }), 'Empty string (blank)');
  assert.equal(desktopCurrentValue({}), 'Not recorded');
  assert.equal(desktopCurrentValue({ value: false }), 'false');
  assert.equal(desktopCurrentValue({ value: 0 }), '0');
  assert.equal(desktopCurrentValue({ currentValue: null, value: 'ignored fallback' }), 'null');
});

test('terminal and late unknown native outcomes invalidate health without depending on unrelated stream updates', () => {
  let state = reduceRunEvent(initialRun('run-1'), { runId: 'run-1', sequence: 1, type: 'desktop_receipt',
    data: { receipt: { actionId: 'action-1', sessionId: 'session-1', status: 'outcome_unknown', effectObserved: null, reason: 'Pending native action' } } });
  const runningKey = desktopHealthInvalidationKey(state);
  assert.ok(runningKey);
  state = reduceRunEvent(state, { runId: 'run-1', sequence: 2, type: 'cancelled', data: { reason: 'Operator cancellation' } });
  const terminalKey = desktopHealthInvalidationKey(state);
  assert.notEqual(terminalKey, runningKey);
  assert.equal(desktopHealthInvalidationKey({ ...state, sequence: 99, output: 'unrelated text' }), terminalKey);
  state = reduceRunEvent(state, { runId: 'run-1', sequence: 3, type: 'desktop_receipt',
    data: { receipt: { actionId: 'action-1', sessionId: 'session-1', status: 'outcome_unknown', effectObserved: null, reason: 'Cleanup uncertain', cleanup: { confirmed: false } } } });
  assert.notEqual(desktopHealthInvalidationKey(state), terminalKey);
  assert.equal(state.status, 'cancelled');
});

test('unknown-outcome health refresh clears stale availability first and makes only a health GET, never an action or grant retry', async () => {
  for (const status of ['failed', 'cancelled']) {
    const run = { ...initialRun('run-1'), status, desktopReceipts: [{ actionId: 'action-1', status: 'outcome_unknown', effectObserved: null }] };
    assert.ok(desktopHealthInvalidationKey(run));
    const updates = [], requests = [];
    const refreshed = await refreshDesktopHealth({ onHealth: value => updates.push(value), fetchImpl: async (url, options) => {
      assert.equal(updates[0], null);
      requests.push({ url, method: options.method || 'GET' });
      return new Response(JSON.stringify({ ...health, available: false, reason: 'quarantined' }));
    }});
    assert.equal(refreshed.available, false);
    assert.equal(updates.at(-1).reason, 'quarantined');
    assert.deepEqual(requests, [{ url: '/api/desktop/health', method: 'GET' }]);
  }
});

test('pending-to-verified native action never requests a health refresh while the action is running', () => {
  let state = reduceRunEvent(initialRun('run-1'), { runId: 'run-1', sequence: 1, type: 'desktop_receipt',
    data: { receipt: { actionId: 'action-1', pending: true, status: 'outcome_unknown', effectObserved: null } } });
  const pendingKey = desktopHealthInvalidationKey(state);
  assert.equal(pendingKey, '');
  assert.equal(shouldRefreshDesktopHealth('', pendingKey), false);
  state = reduceRunEvent(state, { runId: 'run-1', sequence: 2, type: 'desktop_receipt',
    data: { receipt: { actionId: 'action-1', pending: false, status: 'value_verified', effectObserved: true } } });
  const verifiedKey = desktopHealthInvalidationKey(state);
  assert.equal(verifiedKey, '');
  assert.equal(shouldRefreshDesktopHealth(pendingKey, verifiedKey), false);
});

test('pending-to-final-unknown native action refreshes health only after the final receipt', () => {
  const pending = { ...initialRun('run-1'), desktopReceipts: [{ actionId: 'action-1', pending: true, status: 'outcome_unknown', effectObserved: null }] };
  const final = { ...pending, desktopReceipts: [{ actionId: 'action-1', pending: false, status: 'outcome_unknown', effectObserved: null }] };
  assert.equal(desktopHealthInvalidationKey(pending), '');
  assert.ok(desktopHealthInvalidationKey(final));
  assert.equal(shouldRefreshDesktopHealth(desktopHealthInvalidationKey(pending), desktopHealthInvalidationKey(final)), true);
});

test('terminal pending receipts remain uncertain and a late verified receipt refreshes stale unavailable health', () => {
  const receipt = { actionId: 'action-1', pending: true, status: 'outcome_unknown', effectObserved: null };
  for (const status of ['completed', 'failed', 'cancelled']) {
    const terminal = { ...initialRun('run-1'), status, desktopReceipts: [receipt] };
    const key = desktopHealthInvalidationKey(terminal);
    assert.ok(key);
    assert.equal(shouldRefreshDesktopHealth('', key), true);
    const verified = { ...terminal, desktopReceipts: [{ ...receipt, pending: false, status: 'value_verified', effectObserved: true }] };
    assert.equal(desktopHealthInvalidationKey(verified), '');
    assert.equal(shouldRefreshDesktopHealth(key, desktopHealthInvalidationKey(verified)), true);
  }
});

test('quarantined health confirms the bound grant with a GET before changing its cached authority', async () => {
  let grantState = 'active';
  const requests = [], updates = [];
  await refreshDesktopHealth({ boundSessionId: 'session-1', onHealth: value => updates.push(value ? `health:${value.reason}` : 'health:invalidated'),
    onGrant: value => { grantState = value.state; updates.push(`grant:${value.state}`); },
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method || 'GET' });
      assert.equal(grantState, 'active');
      return new Response(JSON.stringify(url === '/api/desktop/health'
        ? { ...health, available: false, reason: 'quarantined' }
        : { sessionId: 'session-1', state: 'quarantined' }));
    }
  });
  assert.equal(grantState, 'quarantined');
  assert.deepEqual(updates, ['health:invalidated', 'health:quarantined', 'grant:quarantined']);
  assert.deepEqual(requests, [{ url: '/api/desktop/health', method: 'GET' }, { url: '/api/desktop/sessions/session-1', method: 'GET' }]);
});

test('failed grant confirmation preserves recovery authority while an authoritative missing grant can be cleared', async () => {
  for (const status of [403, 404]) {
    let confirmed;
    const work = refreshDesktopHealth({ boundSessionId: 'session-1', onGrant: value => { confirmed = value; }, fetchImpl: async url =>
      url === '/api/desktop/health' ? new Response(JSON.stringify({ ...health, available: false, reason: 'quarantined' }))
        : new Response('{"error":"grant status unavailable"}', { status }) });
    if (status === 403) {
      await assert.rejects(work, /grant status unavailable/);
      assert.equal(confirmed, undefined);
    } else {
      await work;
      assert.deepEqual(confirmed, { sessionId: 'session-1', state: 'missing', confirmedMissing: true });
    }
  }
  let uncertain;
  await assert.rejects(refreshDesktopHealth({ boundSessionId: 'session-1', onGrant: value => { uncertain = value; }, fetchImpl: async url =>
    new Response(JSON.stringify(url === '/api/desktop/health' ? { ...health, available: false, reason: 'quarantined' }
      : { sessionId: 'session-1', state: 'unconfirmed' })) }), /confirmed status/);
  assert.equal(uncertain, undefined);
});

test('ordinary unavailable health does not trigger grant inspection or recreate access', async () => {
  const requests = [];
  await refreshDesktopHealth({ boundSessionId: 'session-1', fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method || 'GET' });
    return new Response(JSON.stringify({ ...health, available: false, reason: 'native_unavailable' }));
  }});
  assert.deepEqual(requests, [{ url: '/api/desktop/health', method: 'GET' }]);
});
