export const DESKTOP_GRANT_KEY = 'my-ai-partner-desktop-grant-v1';
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const text = value => typeof value === 'string' ? value : '';
const timestamp = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
};

export function localDesktopModel(model, screenshots = false) {
  if (!model || (model.provider || 'ollama') !== 'ollama' || model.local === false || model.cloud || model.isCloud || /:cloud$/i.test(model.name || '')) return false;
  const tools = model.tools === true || model.capabilities?.includes('tools');
  const vision = model.vision === true || model.capabilities?.includes('vision');
  return Boolean(tools && (!screenshots || vision));
}

export function verifiedDesktopVision(model, health) {
  return localDesktopModel(model, true) && health?.screenshotModelInputVerified === true
    && Array.isArray(health.verifiedVisionModels) && health.verifiedVisionModels.some(entry => typeof entry === 'string'
      ? entry === model.name : entry?.name === model.name && (entry.provider || 'ollama') === 'ollama');
}

export function assertDesktopGrant(session, model, health, now = Date.now()) {
  if (!session || !identifier(session.sessionId) || session.state !== 'active') throw new Error('Select and verify an active desktop grant before starting desktop work.');
  const expiry = timestamp(session.expiresAt);
  if (expiry === null || expiry <= now) throw new Error('The desktop grant has expired or its expiry is unknown. Read its status or select a new window explicitly.');
  if (!localDesktopModel(model)) throw new Error('Desktop work requires a local Ollama model with advertised tool support. Cloud desktop transmission is disabled.');
  if (session.allowScreenshots === true && !verifiedDesktopVision(model, health)) throw new Error('Desktop screenshot model input has not been verified for this exact local model. Revoke this grant and use text-only UIA while the visual path remains unavailable.');
  if (health?.configured !== true || health?.available !== true || health?.localOnly !== true || health?.engine !== 'windows-uia'
    || health?.isolation !== 'none' || health?.approvalRequired !== true) throw new Error('Native desktop access is not verified available under the required approval policy. Refresh its own broker health.');
  return session.sessionId;
}

export function loadDesktopGrant(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(DESKTOP_GRANT_KEY) || 'null');
    return value && identifier(value.requestId) && typeof value.windowId === 'string' && typeof value.allowScreenshots === 'boolean' ? value : null;
  } catch { return null; }
}

export function saveDesktopGrant(value, storage = globalThis.localStorage) {
  try { if (value) storage?.setItem(DESKTOP_GRANT_KEY, JSON.stringify(value)); else storage?.removeItem(DESKTOP_GRANT_KEY); } catch {}
}

export function desktopActionReceipt(tool) {
  const result = tool?.result && typeof tool.result === 'object' ? tool.result : {};
  const durable = tool?.receipt && typeof tool.receipt === 'object' ? tool.receipt : {};
  const value = { ...result, ...durable };
  if (!value.actionId && !value.planId && !value.status) return null;
  const status = text(value.status) || 'not_recorded';
  const observed = typeof value.effectObserved === 'boolean' ? value.effectObserved : null;
  const verified = status === 'value_verified' && observed === true;
  const labels = { outcome_unknown: 'Outcome unknown', input_dispatched: 'Input dispatched · outcome not verified', denied: 'Action denied', stale: 'Stale action rejected' };
  return { ...value, status, effectObserved: observed, verified,
    label: verified ? 'Value verified' : status === 'value_verified' ? 'Value verification not confirmed' : labels[status] || status.replaceAll('_', ' '),
    unknownEffect: !verified && !['denied', 'stale'].includes(status) };
}

export function desktopCurrentValue(target) {
  let value;
  if (target && Object.hasOwn(target, 'currentValue') && target.currentValue !== undefined) value = target.currentValue;
  else if (target && Object.hasOwn(target, 'value') && target.value !== undefined) value = target.value;
  else return 'Not recorded';
  if (value === '') return 'Empty string (blank)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function desktopHealthInvalidationKey(run) {
  if (!run) return '';
  const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
  const receipts = new Map();
  for (const tool of run.tools || []) if (tool.name === 'desktop.act') {
    const receipt = desktopActionReceipt(tool);
    if (receipt?.actionId) receipts.set(receipt.actionId, receipt);
  }
  for (const receipt of run.desktopReceipts || []) if (receipt?.actionId) receipts.set(receipt.actionId, receipt);
  const uncertain = [...receipts.values()].filter(receipt => (receipt.pending !== true || terminal)
    && (['outcome_unknown', 'quarantined'].includes(receipt.status) || receipt.quarantined === true || receipt.sessionState === 'quarantined'
      || receipt.grantState === 'quarantined' || receipt.session?.state === 'quarantined'));
  if (!uncertain.length) return '';
  return JSON.stringify({ runId: run.runId, status: run.status, receipts: uncertain.map(receipt => ({
    actionId: receipt.actionId, sessionId: receipt.sessionId, status: receipt.status, pending: receipt.pending, effectObserved: receipt.effectObserved,
    reason: receipt.reason, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt, completedAt: receipt.completedAt,
    cleanup: receipt.cleanup, quarantined: receipt.quarantined, sessionState: receipt.sessionState, grantState: receipt.grantState
  })) });
}

export function shouldRefreshDesktopHealth(previousKey, nextKey) {
  const previous = previousKey || '', next = nextKey || '';
  return previous !== next && Boolean(previous || next);
}

export function desktopSnapshot(result) {
  const value = result?.after?.snapshotId ? result.after : result?.snapshot?.snapshotId ? result.snapshot : result;
  if (!value || typeof value !== 'object' || !identifier(value.snapshotId) || !identifier(value.sessionId)) return null;
  return { ...value, elements: (Array.isArray(value.elements) ? value.elements : []).filter(item => item && typeof item === 'object'), untrusted: true };
}

export function desktopScreenshotUrl(snapshot) {
  const image = snapshot?.image;
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  if (!image || image.mimeType !== 'image/png' || typeof image.url !== 'string' || !identifier(snapshot.sessionId)
    || typeof image.snapshotId !== 'string' || image.snapshotId !== snapshot.snapshotId) return null;
  const match = image.url.match(new RegExp(`^/api/desktop/snapshots/(${uuid})/image$`, 'i'));
  return match && match[1].toLowerCase() === snapshot.snapshotId.toLowerCase() ? image.url : null;
}

export function canCaptureOperatorPreview(session, { locked = false, busy = false, revoking = false, boundId = session?.sessionId } = {}, now = Date.now()) {
  const expires = timestamp(session?.expiresAt);
  return Boolean(session?.state === 'active' && identifier(session.sessionId) && boundId === session.sessionId
    && expires !== null && expires > now && !locked && !busy && !revoking);
}

export function operatorPreviewSnapshot(value, sessionId) {
  if (!value || typeof value !== 'object' || value.operatorPreview !== true || value.untrusted !== true
    || !identifier(sessionId) || (value.sessionId !== undefined && value.sessionId !== sessionId)) {
    throw new Error('The response was not a human preview bound to this desktop grant.');
  }
  const snapshot = desktopSnapshot({ ...value, sessionId });
  if (!snapshot || !desktopScreenshotUrl(snapshot)) throw new Error('The selected-window preview image route or snapshot binding was invalid.');
  return snapshot;
}
