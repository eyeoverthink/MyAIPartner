import { assertDesktopGrant } from './desktop.mjs';
import { resolveInteractiveRunOptions, validThinkingValue } from './run-options.mjs';

export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function isCloudModel(model) {
  return Boolean(model?.cloud || model?.isCloud || model?.provider === 'cloud' || model?.provider === 'openai' || /:cloud$/i.test(model?.name || ''));
}

export function modelIdentity(model) {
  return `${model?.provider || (isCloudModel(model) ? 'openai' : 'ollama')}::${model?.name || ''}`;
}

export function selectDefaultModel(models, currentKey, preferredModel) {
  const eligible = models.filter(model => model.allowed !== false && model.available !== false && model.configured !== false);
  if (eligible.some(model => modelIdentity(model) === currentKey)) return currentKey;
  const local = eligible.filter(model => !isCloudModel(model));
  const preferred = preferredModel && local.find(model => modelIdentity(model) === modelIdentity(preferredModel));
  if (preferred) return modelIdentity(preferred);
  const hasTools = model => model.tools === true || model.capabilities?.includes('tools');
  const toolModels = local.filter(hasTools);
  const bySize = (a, b) => {
    const bytes = model => Number.isFinite(model.size) && model.size > 0 ? model.size : Infinity;
    return (bytes(a) - bytes(b)) || a.name.localeCompare(b.name);
  };
  const candidates = (toolModels.length ? toolModels : local).slice().sort(bySize);
  return candidates[0] ? modelIdentity(candidates[0]) : '';
}

export function describeModel(model) {
  const size = Number.isFinite(model.size) && model.size > 0 ? `${(model.size / 1e9).toFixed(1)} GB` : 'size unknown';
  const tools = model.tools === true || model.capabilities?.includes('tools');
  const capability = tools ? 'tools + chat' : model.tools === false || Array.isArray(model.capabilities) ? 'chat' : 'chat · tool support unknown';
  return `${model.name} · ${model.provider || 'ollama'} · ${isCloudModel(model) ? 'cloud' : 'local'} · ${size} · ${capability}${model.vision || model.capabilities?.includes('vision') ? ' · vision' : ''}`;
}

export function directChatHistory(messages) {
  return messages.filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string'
    && message.kind !== 'greeting' && message.kind !== 'demo' && !message.desktopSessionId && message.privateContextLocalOnly !== true)
    .slice(-8).map(message => ({ role: message.role, content: message.text.slice(0, 1800) }));
}

export function localVisionConfigured(capabilities) {
  return capabilities?.localVision?.configured === true && capabilities.localVision.model === 'gemma3:latest';
}
export const isLocalImageMode = value => value === 'local-tool' || value === 'local-ocr';
export function localOcrConfigured(capabilities) {
  return capabilities?.localOcr?.available === true && capabilities.localOcr.engine === 'windows-media-ocr'
    && capabilities.localOcr.imageMode === 'local-ocr' && capabilities.localOcr.languages?.includes('en-US') === true;
}

export function resolveImageMode({ imageMode, model, capabilities } = {}) {
  if (imageMode === undefined || imageMode === 'direct') return undefined;
  if (!isLocalImageMode(imageMode)) throw new Error('Choose Direct vision model or explicit Local vision helper / Local OCR image handling.');
  if (imageMode === 'local-tool' && !localVisionConfigured(capabilities)) throw new Error('The local Gemma3 vision helper is not configured. Refresh connection, choose a direct vision model, or remove the images.');
  if (imageMode === 'local-ocr' && !localOcrConfigured(capabilities)) throw new Error('English local OCR is unavailable. Refresh connection or choose another image mode.');
  const current = Array.isArray(capabilities?.models)
    ? availableModels(capabilities, false).find(candidate => modelIdentity(candidate) === modelIdentity(model)) : model;
  if (!model?.name || isCloudModel(model) || (model.provider || 'ollama') !== 'ollama' || model.local === false
    || !current || isCloudModel(current) || current.local === false || (current.provider || 'ollama') !== 'ollama') throw new Error('Choose a local Ollama chat model to use the image helper. Cloud providers are disabled for this conversation.');
  return imageMode;
}

export function buildAgentRequest({ requestId, conversationId, goal, model, attachments = [], capabilities,
  cloudOptIn = false, maxCostUsd, desktopSession, desktopHealth, runOptions = {}, imageMode } = {}) {
  if (!model?.name) throw new Error('Select an available model first.');
  const resolvedImageMode = resolveImageMode({ imageMode, model, capabilities });
  const imageCount = attachments.filter(asset => asset.mimeType?.startsWith('image/')).length;
  const request = {
    requestId, conversationId, goal, model: model.name,
    provider: model.provider || (isCloudModel(model) ? 'openai' : 'ollama'),
    attachments: validateRunAttachments(attachments, model, getAttachmentLimits(capabilities), { imageMode: resolvedImageMode, capabilities }),
    budget: { maxInputTokens: imageCount >= 3 ? 32768 : 16384, maxCostUsd: 0 }
  };
  if (resolvedImageMode) request.imageMode = resolvedImageMode;
  if (desktopSession) {
    request.desktopSessionId = assertDesktopGrant(desktopSession, model, desktopHealth);
    request.budget.maxDurationMs = 300000;
    request.budget.maxInputTokens = 32768;
    request.budget.maxTotalTokens = 64000;
  }
  if (imageCount >= 3) request.budget.maxTotalTokens = 64000;
  if (isCloudModel(model)) {
    const allowed = availableModels(capabilities, cloudOptIn).some(candidate => modelIdentity(candidate) === modelIdentity(model));
    const cost = Number(maxCostUsd), maximum = Number(capabilities?.cloud?.maxRunCostUsd);
    if (!cloudOptIn || !allowed) throw new Error('Cloud requires explicit opt-in and an available server-configured model.');
    if (request.provider !== 'openai') throw new Error('This cloud provider is not supported.');
    if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(maximum) || maximum <= 0 || cost > maximum) {
      throw new Error(`Enter a positive cloud run budget${Number.isFinite(maximum) && maximum > 0 ? ` up to $${maximum}` : '; the server has not configured a spending ceiling'}.`);
    }
    request.allowCloud = true;
    request.budget.maxCostUsd = cost;
  } else if (request.provider !== 'ollama') throw new Error('Unsupported local provider.');
  const currentModel = Array.isArray(capabilities?.models)
    ? availableModels(capabilities, cloudOptIn).find(candidate => modelIdentity(candidate) === modelIdentity(model)) : model;
  const controls = resolveInteractiveRunOptions({ ...runOptions, model: currentModel || { ...model, thinking: undefined } });
  if (Object.hasOwn(controls, 'thinking')) request.thinking = controls.thinking;
  Object.assign(request.budget, controls.budget);
  return request;
}

export function availableModels(capabilities, cloudOptIn = false) {
  const cloudEnabled = capabilities?.cloudEnabled === true || capabilities?.allowCloud === true || capabilities?.cloud?.enabled === true;
  return (capabilities?.models || []).map(m => typeof m === 'string' ? { name: m } : m)
    .filter(m => m && typeof m.name === 'string' && m.allowed !== false && m.available !== false && m.configured !== false)
    .filter(m => !isCloudModel(m) || (cloudEnabled && cloudOptIn && m.affordable !== false));
}

export async function fetchJson(url, options = {}, timeoutMs = 6000, fetchImpl = fetch) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { ...options, signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || body?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (body === null) throw new Error('The server returned invalid JSON.');
  return body;
}

// A transport chunk need not end on a JSON line or a UTF-8 character boundary.
export async function readOllamaStream(body, { onText = () => {}, signal } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '', output = '', completed = false;
  function accept(line) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.error) throw new Error(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
    const piece = event.message?.content ?? event.response ?? '';
    if (piece) { output += piece; onText(output); }
    if (event.done === true) completed = true;
  }
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        accept(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) accept(pending);
    signal?.throwIfAborted();
    if (!completed) throw new Error('The model stream ended before completion.');
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function initialRun(runId = null) {
  return { runId, sequence: 0, status: 'running', output: '', tools: [], desktopReceipts: [], taskReceipts: [], workspaceReceipts: [], codeReceipts: [], approvals: [], usage: null, error: null, recordedSettings: null };
}

const ACTUAL_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'auxiliaryInputTokens', 'auxiliaryOutputTokens', 'costUsd'];
function usageSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const key of [...ACTUAL_USAGE_FIELDS, 'reservedInputTokens', 'reservedOutputTokens']) {
    const number = value[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && (key === 'costUsd' || Number.isSafeInteger(number))) result[key] = number;
    else if (key === 'costUsd' && number === null) result.costUsd = null;
  }
  if (typeof value.auxiliaryUsageKnown === 'boolean') result.auxiliaryUsageKnown = value.auxiliaryUsageKnown;
  return result;
}

export function mergeRunUsage(previous, incoming) {
  const before = usageSnapshot(previous), after = usageSnapshot(incoming), result = { ...before };
  const stale = ACTUAL_USAGE_FIELDS.some(key => typeof before[key] === 'number' && typeof after[key] === 'number' && after[key] < before[key]);
  for (const key of ACTUAL_USAGE_FIELDS) {
    if (typeof after[key] === 'number') result[key] = typeof before[key] === 'number' ? Math.max(before[key], after[key]) : after[key];
    else if (key === 'costUsd' && after.costUsd === null && before.costUsd === undefined) result.costUsd = null;
  }
  // Reservations are not cumulative usage. Only an explicit current amount can
  // replace a hold; omission is unknown, never an inferred zero/release.
  if (!stale) for (const key of ['reservedInputTokens', 'reservedOutputTokens', 'auxiliaryUsageKnown']) if (Object.hasOwn(after, key)) result[key] = after[key];
  return Object.keys(result).length ? result : null;
}

export function reduceRunEvent(state, event) {
  if (!event || (state.runId && event.runId && event.runId !== state.runId)) return state;
  if (!Number.isInteger(event.sequence) || event.sequence <= state.sequence || (TERMINAL.has(state.status) && !['desktop_receipt', 'task_receipt', 'workspace_receipt', 'code_receipt', 'usage', 'auxiliary_usage'].includes(event.type))) return state;
  const data = event.data || {};
  const next = { ...state, sequence: event.sequence, runId: state.runId || event.runId };
  switch (event.type) {
    case 'status': {
      const status = data.status || data.state || 'running';
      // A terminal status notice is not the completed/failed event receipt.
      if (!TERMINAL.has(status)) next.status = status;
      if (status === 'running') next.approvals = [];
      break;
    }
    case 'text_delta': next.output += data.text || ''; break;
    case 'tool_started': next.status = 'running'; next.approvals = []; next.tools = [...state.tools, { ...data, status: 'running' }]; break;
    case 'tool_result': {
      const matched = state.tools.some(t => t.callId === data.callId);
      const status = data.error || data.result?.error || data.result?.ok === false ? 'failed' : 'completed';
      next.tools = matched
        ? state.tools.map(t => t.callId === data.callId ? { ...t, ...data, status } : t)
        : [...state.tools, { ...data, status }];
      break;
    }
    case 'approval_required':
      next.status = 'awaiting_approval';
      next.approvals = [...state.approvals.filter(a => a.approvalId !== data.approvalId), data];
      break;
    case 'usage':
    case 'auxiliary_usage': next.usage = mergeRunUsage(state.usage, data); break;
    case 'desktop_receipt': {
      const receipt = data.receipt;
      if (!receipt || typeof receipt.actionId !== 'string') break;
      const previous = state.desktopReceipts || [];
      next.desktopReceipts = previous.some(item => item.actionId === receipt.actionId)
        ? previous.map(item => item.actionId === receipt.actionId ? receipt : item) : [...previous, receipt];
      next.tools = state.tools.map(tool => tool.name === 'desktop.act' && (tool.receipt?.actionId === receipt.actionId || tool.result?.actionId === receipt.actionId)
        ? { ...tool, receipt } : tool);
      break;
    }
    case 'task_receipt': {
      const receipt = data.receipt;
      if (!receipt || receipt.kind !== 'task_change' || typeof receipt.requestId !== 'string' || !receipt.requestId) break;
      const previous = state.taskReceipts || [];
      next.taskReceipts = previous.some(item => item.requestId === receipt.requestId)
        ? previous.map(item => item.requestId === receipt.requestId ? receipt : item) : [...previous, receipt];
      break;
    }
    case 'workspace_receipt': {
      const receipt = data.receipt;
      if (!receipt || !['workspace_edit', 'workspace_patch'].includes(receipt.kind) || typeof receipt.effectId !== 'string' || !receipt.effectId) break;
      const previous = state.workspaceReceipts || [];
      next.workspaceReceipts = previous.some(item => item.effectId === receipt.effectId)
        ? previous.map(item => item.effectId === receipt.effectId ? receipt : item) : [...previous, receipt];
      break;
    }
    case 'code_receipt': {
      const receipt = data.receipt;
      if (!receipt || receipt.kind !== 'code_execution' || typeof receipt.effectId !== 'string' || !receipt.effectId) break;
      const previous = state.codeReceipts || [];
      next.codeReceipts = previous.some(item => item.effectId === receipt.effectId)
        ? previous.map(item => item.effectId === receipt.effectId ? receipt : item) : [...previous, receipt];
      break;
    }
    case 'completed': next.status = 'completed'; next.output = data.output ?? state.output; next.approvals = []; break;
    case 'failed': next.status = 'failed'; next.error = data.error || 'Agent failed'; next.approvals = []; break;
    case 'cancelled': next.status = 'cancelled'; next.error = data.reason || 'Cancelled'; next.approvals = []; break;
    default: break;
  }
  return next;
}

export function recordedRunSettings(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || (!Object.hasOwn(record, 'budget') && !Object.hasOwn(record, 'thinking') && !Object.hasOwn(record, 'imageMode'))) return null;
  const hasThinking = Object.hasOwn(record, 'thinking') && record.thinking !== null;
  const explicitThinking = hasThinking && validThinkingValue(record.thinking);
  const sourceBudget = record.budget && typeof record.budget === 'object' && !Array.isArray(record.budget) ? record.budget : null;
  const entries = sourceBudget ? Object.entries(sourceBudget).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
    && typeof value === 'number' && Number.isFinite(value) && value >= 0) : [];
  return { thinkingMode: !hasThinking ? 'model_default' : explicitThinking ? 'explicit' : 'unrecorded',
    ...(explicitThinking ? { thinking: record.thinking } : {}),
    imageMode: !Object.hasOwn(record, 'imageMode') ? 'direct' : isLocalImageMode(record.imageMode) ? record.imageMode : 'unrecorded',
    budget: entries.length ? Object.fromEntries(entries) : null,
    budgetComplete: Boolean(sourceBudget && entries.length && entries.length === Object.keys(sourceBudget).length) };
}

export function reconcileRun(state, record, { usageIsOlder = false } = {}) {
  const settings = recordedRunSettings(record);
  if (settings) state = { ...state, recordedSettings: settings };
  if (record?.privateContextLocalOnly === true) state = { ...state, privateContextLocalOnly: true };
  if (record?.provenance && typeof record.provenance === 'object') state = { ...state, provenance: record.provenance };
  if (record?.usage) state = { ...state, usage: usageIsOlder ? mergeRunUsage(record.usage, state.usage) : mergeRunUsage(state.usage, record.usage) };
  if (TERMINAL.has(state.status)) return state;
  const status = record?.status || record?.state;
  if (!TERMINAL.has(status)) return state;
  return { ...state, status, output: record.output ?? state.output,
    error: record.error || (status === 'cancelled' ? 'Cancelled' : null), approvals: [] };
}

export function pollDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener('abort', aborted); resolve(); };
    const timer = setTimeout(finish, ms);
    const aborted = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export async function readAgentJson(url, { signal, fetchImpl = fetch, timeoutMs = 10000,
  maxReadRetries = 5, retryBaseMs = 500, retryMaxMs = 5000, onConnection } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const data = await fetchJson(url, { signal }, timeoutMs, fetchImpl);
      onConnection?.({ connectionStatus: 'connected', connectionError: null, retryAttempt: 0 });
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      const transient = !error.status || error.status >= 500 || error.status === 408 || error.status === 429;
      const retryDelayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** attempt));
      const exhausted = !transient || attempt >= maxReadRetries;
      onConnection?.({ connectionStatus: exhausted ? 'disconnected' : 'reconnecting',
        connectionError: error.message, retryAttempt: attempt + 1, retryDelayMs });
      if (exhausted) throw error;
      await pollDelay(retryDelayMs, signal);
    }
  }
}

export async function pollAgentRun(runId, { signal, onState, fetchImpl = fetch, intervalMs = 700,
  maxReadRetries = 5, retryBaseMs = 500, retryMaxMs = 5000 } = {}) {
  let state = initialRun(runId);
  async function read(url, timeoutMs = 10000) {
    try {
      return await readAgentJson(url, { signal, fetchImpl, timeoutMs, maxReadRetries, retryBaseMs, retryMaxMs,
        onConnection: connection => {
          state = { ...state, ...connection };
          if (connection.connectionStatus !== 'connected') onState?.(state);
        }
      });
    } catch (error) {
      error.recoverableRun = true;
      error.runId = runId;
      error.runState = state;
      throw error;
    }
  }
  for (;;) {
    signal?.throwIfAborted();
    const payload = await read(`/api/agent/runs/${encodeURIComponent(runId)}/events?afterSequence=${state.sequence}`);
    const events = Array.isArray(payload) ? payload : payload.events || [];
    for (const event of events) state = reduceRunEvent(state, event);
    // The trusted record carries privacy/provenance facts even when this event
    // batch already contains completion. Do not infer those facts from output.
    const record = payload.run || await read(`/api/agent/runs/${encodeURIComponent(runId)}`, 6000);
    const actual = record?.run || record;
    let usageIsOlder = false;
    if (!TERMINAL.has(state.status)) {
      if (TERMINAL.has(actual?.status || actual?.state)) {
        // The run can finish between the event query and record query. Drain
        // its final receipts before reconciling, so usage/tools aren't lost.
        const tail = await read(`/api/agent/runs/${encodeURIComponent(runId)}/events?afterSequence=${state.sequence}`);
        const usageBeforeTail = state.usage;
        for (const event of Array.isArray(tail) ? tail : tail.events || []) state = reduceRunEvent(state, event);
        // A same-total reservation release may be newer than the GET above.
        // Never restore its older hold after draining the authoritative event.
        usageIsOlder = state.usage !== usageBeforeTail;
      }
    }
    state = reconcileRun(state, actual, { usageIsOlder });
    onState?.(state);
    if (TERMINAL.has(state.status)) return state;
    await pollDelay(intervalMs, signal);
  }
}

export const PENDING_RUN_KEY = 'my-ai-partner-pending-run-v1';

export function serializeRetainedAgentRequest(pending) {
  if (!pending?.request || typeof pending.request.requestId !== 'string' || !pending.request.requestId || typeof pending.request.goal !== 'string') throw new Error('The exact original Agent request is unavailable. It cannot be rebuilt from current controls.');
  return JSON.stringify(pending.request);
}

export function loadPendingRun(storage = globalThis.localStorage) {
  try {
    const pending = JSON.parse(storage?.getItem(PENDING_RUN_KEY) || 'null');
    if (!pending || typeof pending !== 'object') return null;
    if (typeof pending.runId === 'string' && pending.runId) return pending;
    if (pending.request && typeof pending.request.requestId === 'string' && typeof pending.request.goal === 'string') return pending;
    return null;
  } catch { return null; }
}

export function savePendingRun(pending, storage = globalThis.localStorage) {
  try {
    if (pending) storage?.setItem(PENDING_RUN_KEY, JSON.stringify(pending));
    else storage?.removeItem(PENDING_RUN_KEY);
  } catch { /* The active in-memory run remains available if storage is full. */ }
}

export async function recallMemory(text, signal, fetchImpl = fetch) {
  try {
    const response = await fetchJson('/api/voice/memory?q=' + encodeURIComponent(text.slice(0, 1200)), { signal }, 1200, fetchImpl);
    const hits = Array.isArray(response.hits) ? response.hits.slice(0, 3) : [];
    return hits.map(h => typeof h.content === 'string' ? h.content.slice(0, 700) : '').filter(Boolean).join('\n');
  } catch (error) {
    signal?.throwIfAborted();
    return '';
  }
}

// Called only after a verified successful terminal result, never on a delta.
export async function finalizeReply(result, { speak, observe } = {}) {
  if (result.status !== 'completed' || !result.output?.trim()) return false;
  await Promise.allSettled([
    Promise.resolve().then(() => speak?.(result.output)),
    Promise.resolve().then(() => observe?.(result.output))
  ]);
  return true;
}

export function submitTranscript(final, send) {
  const text = typeof final === 'string' ? final.trim() : '';
  if (text) return send(text);
}

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'text/plain', 'text/markdown', 'application/json', 'application/pdf', 'application/zip', 'audio/wav']);

export function getAttachmentLimits(capabilities) {
  const supplied = capabilities?.limits || {};
  const bounded = (fallback, ...values) => Math.min(fallback, ...values.filter(value => Number.isFinite(value) && value > 0));
  return {
    maxAttachments: bounded(4, supplied.maxAttachments),
    maxImages: bounded(4, supplied.maxImages),
    maxFileBytes: bounded(MAX_ATTACHMENT_BYTES, supplied.maxFileBytes, supplied.maxAttachmentBytes, supplied.maxAssetBytes),
    maxImageBytes: bounded(MAX_ATTACHMENT_BYTES, supplied.maxImageBytes, supplied.maxFileBytes, supplied.maxAttachmentBytes, supplied.maxAssetBytes)
  };
}

export function attachmentMime(file) {
  const declared = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (declared === 'application/x-zip-compressed') return 'application/zip';
  if (declared === 'application/x-pdf') return 'application/pdf';
  if (['audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(declared)) return 'audio/wav';
  if (declared && declared !== 'application/octet-stream') return declared;
  const extension = file.name?.toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', md: 'text/markdown', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip', wav: 'audio/wav' })[extension] || declared;
}

export function validateAttachmentSelection(files, existingCount = 0, limits = getAttachmentLimits(), existingImages = 0) {
  if (existingCount + files.length > limits.maxAttachments) throw new Error(`Attach at most ${limits.maxAttachments} files per run.`);
  if (existingImages + files.filter(file => attachmentMime(file).startsWith('image/')).length > limits.maxImages) throw new Error(`Attach at most ${limits.maxImages} images per run.`);
  for (const file of files) {
    if (!ATTACHMENT_TYPES.has(attachmentMime(file))) throw new Error(`${file.name}: unsupported file type. Use PNG, JPEG, UTF-8 text, Markdown, JSON, PDF, ZIP or WAV.`);
    const maximum = attachmentMime(file).startsWith('image/') ? limits.maxImageBytes : limits.maxFileBytes;
    if (file.size > maximum) throw new Error(`${file.name}: exceeds the ${maximum / (1024 * 1024)} MiB file limit.`);
  }
}

export async function prepareAttachment(file) {
  validateAttachmentSelection([file]);
  const mimeType = attachmentMime(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${file.name}: text must be valid UTF-8.`); }
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { name: file.name, mimeType, dataBase64: btoa(binary) };
}

export function validateRunAttachments(attachments, model, limits = getAttachmentLimits(), { imageMode, capabilities } = {}) {
  if (attachments.length > limits.maxAttachments) throw new Error(`Attach at most ${limits.maxAttachments} files per run.`);
  if (attachments.filter(a => a.mimeType?.startsWith('image/')).length > limits.maxImages) throw new Error(`Attach at most ${limits.maxImages} images per run.`);
  const image = attachments.some(a => a.mimeType?.startsWith('image/'));
  const vision = model?.vision === true || model?.capabilities?.includes('vision');
  const localTool = isLocalImageMode(resolveImageMode({ imageMode, model, capabilities }));
  if (image && !vision && !localTool) throw new Error('This model does not advertise vision. Choose a direct vision model, explicitly enable the configured local vision helper or local OCR, or remove the images.');
  return attachments.map(a => {
    const id = a.assetId || a.id;
    if (!id) throw new Error('An attachment has no uploaded asset ID. Please upload it again.');
    return id;
  });
}
