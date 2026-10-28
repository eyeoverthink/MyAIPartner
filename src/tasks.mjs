import { availableModels, fetchJson, isCloudModel, readAgentJson } from './protocol.mjs';

export const TASK_REQUEST_KEY = 'my-ai-partner-task-request-v1';
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const budgetKeys = new Set(['maxSteps', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxDurationMs', 'maxToolResultChars', 'maxOutputChars', 'maxCostUsd']);

export function localTaskModels(capabilities) {
  return availableModels(capabilities, false).filter(model => !isCloudModel(model) && model.local !== false && (model.provider || 'ollama') === 'ollama');
}

export function defaultTaskForm(model = '') {
  return { title: '', goal: '', model, kind: 'once', at: '', firstAt: '', everyMinutes: '60', time: '09:00',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', weekdays: [1], maxRuns: '1', maxTotalTokens: '72000' };
}

function validTimeZone(value) {
  try { return typeof value === 'string' && Boolean(new Intl.DateTimeFormat('en', { timeZone: value }).format(0)); } catch { return false; }
}

function validInstant(value) {
  return typeof value === 'string' && /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

export function validateTaskSpec(spec, models) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('The task spec is missing.');
  if (Object.keys(spec).some(key => !['title', 'goal', 'model', 'schedule', 'budget', 'limits'].includes(key))) throw new Error('Scheduled tasks cannot inherit other run authority or context.');
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.trim().length > 120 || /[\x00-\x1f\x7f]/.test(spec.title) || !spec.title.isWellFormed()) throw new Error('Enter a task title of at most 120 printable characters.');
  if (typeof spec.goal !== 'string' || !spec.goal.trim() || spec.goal.length > 20000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(spec.goal) || !spec.goal.isWellFormed()) throw new Error('Enter a separate task goal of at most 20,000 characters.');
  if (typeof spec.model !== 'string' || !models.some(model => model.name === spec.model && !isCloudModel(model) && model.local !== false && (model.provider || 'ollama') === 'ollama')) throw new Error('Select an available local Ollama model for this task.');
  const schedule = spec.schedule;
  if (!schedule || !['once', 'interval', 'daily', 'weekly'].includes(schedule.kind)) throw new Error('Choose a supported task schedule.');
  const allowed = { once: ['kind', 'at'], interval: ['kind', 'everyMinutes', 'firstAt'], daily: ['kind', 'time', 'timeZone'], weekly: ['kind', 'time', 'timeZone', 'weekdays'] }[schedule.kind];
  if (Object.keys(schedule).some(key => !allowed.includes(key))) throw new Error('The schedule contains unsupported fields.');
  if (schedule.kind === 'once' && !validInstant(schedule.at)) throw new Error('Choose a one-time date with a known time zone.');
  if (schedule.kind === 'interval' && (!integer(schedule.everyMinutes, 1, 10080) || !validInstant(schedule.firstAt))) throw new Error('Choose a first date and an interval from 1 to 10,080 minutes.');
  if (['daily', 'weekly'].includes(schedule.kind) && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time || '') || !validTimeZone(schedule.timeZone))) throw new Error('Choose a valid wall time and IANA time zone.');
  if (schedule.kind === 'weekly' && (!Array.isArray(schedule.weekdays) || !schedule.weekdays.length || schedule.weekdays.some(day => !integer(day, 1, 7)) || new Set(schedule.weekdays).size !== schedule.weekdays.length)) throw new Error('Choose at least one weekday (Monday through Sunday).');
  if (!spec.limits || !integer(spec.limits.maxRuns, 1, 1000) || !integer(spec.limits.maxTotalTokens, 1, 1000000)
    || Object.keys(spec.limits).some(key => !['maxRuns', 'maxTotalTokens'].includes(key))) throw new Error('Set 1–1,000 runs and a total token ceiling of at most 1,000,000.');
  if (schedule.kind === 'once' && spec.limits.maxRuns !== 1) throw new Error('A one-time schedule must have exactly one run.');
  if (spec.budget !== undefined) {
    if (!spec.budget || typeof spec.budget !== 'object' || Array.isArray(spec.budget) || Object.entries(spec.budget).some(([key, value]) => !budgetKeys.has(key) || !Number.isFinite(value) || value < 0 || (key !== 'maxCostUsd' && !Number.isSafeInteger(value))) || (spec.budget.maxCostUsd !== undefined && spec.budget.maxCostUsd !== 0)) throw new Error('The per-run budget must contain only bounded local execution limits and zero API cost.');
    if (spec.budget.maxTotalTokens > spec.limits.maxTotalTokens) throw new Error('The total task token ceiling must cover one full per-run reservation.');
  }
  return clone(spec);
}

export function buildTaskSpec(form, models) {
  const instant = value => {
    if (!value || !Number.isFinite(new Date(value).getTime())) throw new Error('Choose the first run date and time.');
    return new Date(value).toISOString();
  };
  const schedule = form.kind === 'once' ? { kind: 'once', at: instant(form.at) }
    : form.kind === 'interval' ? { kind: 'interval', everyMinutes: Number(form.everyMinutes), firstAt: instant(form.firstAt) }
    : form.kind === 'weekly' ? { kind: 'weekly', time: form.time, timeZone: form.timeZone.trim(), weekdays: [...form.weekdays].sort((a, b) => a - b) }
    : { kind: form.kind, time: form.time, timeZone: form.timeZone.trim() };
  return validateTaskSpec({ title: form.title.trim(), goal: form.goal.trim(), model: form.model, schedule,
    ...(form.budget ? { budget: clone(form.budget) } : {}), limits: { maxRuns: Number(form.maxRuns), maxTotalTokens: Number(form.maxTotalTokens) } }, models);
}

function localDateTime(value) {
  if (!Number.isFinite(new Date(value).getTime())) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

export function taskFormFromRecord(task) {
  const form = defaultTaskForm(typeof task?.model === 'string' ? task.model : '');
  const schedule = task?.schedule || {};
  return { ...form, title: task?.title || '', goal: task?.goal || '', kind: schedule.kind || 'once',
    at: schedule.at ? localDateTime(schedule.at) : '', firstAt: schedule.firstAt ? localDateTime(schedule.firstAt) : '',
    everyMinutes: String(schedule.everyMinutes || 60), time: schedule.time || '09:00', timeZone: schedule.timeZone || form.timeZone,
    weekdays: Array.isArray(schedule.weekdays) ? [...schedule.weekdays] : [1],
    maxRuns: String(task?.limits?.maxRuns || 1), maxTotalTokens: String(task?.limits?.maxTotalTokens || 72000),
    ...(task?.budget && typeof task.budget === 'object' ? { budget: clone(task.budget) } : {}) };
}

export function taskPreviewFromResponse(payload, models) {
  if (!payload || payload.localOnly !== true || payload.requiresAppRunning !== true || !Number.isSafeInteger(payload.firstRunAt) || payload.firstRunAt <= 0) throw new Error('The server did not confirm a local task preview and exact first run time.');
  const spec = validateTaskSpec(payload.spec, models);
  if (!spec.budget?.maxTotalTokens || spec.budget.maxTotalTokens > spec.limits.maxTotalTokens) throw new Error('The preview must reserve a full bounded per-run token allowance.');
  return freeze({ spec, firstRunAt: payload.firstRunAt,
    nextRuns: (Array.isArray(payload.nextRuns) ? payload.nextRuns : []).filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 10),
    summary: typeof payload.summary === 'string' ? payload.summary : '', localOnly: true, requiresAppRunning: true });
}

export function buildTaskMutation({ operation, requestId, preview, task }) {
  if (!identifier(requestId)) throw new Error('A task request ID is required.');
  let url, body;
  if (operation === 'create' || operation === 'update') {
    if (!preview?.spec || !Number.isSafeInteger(preview.firstRunAt)) throw new Error('Preview the exact task before saving it.');
    body = { requestId, ...clone(preview.spec), expectedFirstRunAt: preview.firstRunAt };
    url = '/api/tasks';
  } else if (!['pause', 'resume', 'archive'].includes(operation)) throw new Error('Unsupported task operation.');
  if (operation !== 'create') {
    if (!identifier(task?.id) || !integer(task.revision, 1, Number.MAX_SAFE_INTEGER)) throw new Error('Read the task and its current revision before changing it.');
    url = `/api/tasks/${encodeURIComponent(task.id)}/${operation}`;
    body = { ...(body || { requestId }), expectedRevision: task.revision };
  }
  return freeze({ requestId, operation, url, method: 'POST', body, createdAt: Date.now() });
}

function validPending(value) {
  return value && identifier(value.requestId) && value.method === 'POST' && value.body?.requestId === value.requestId
    && ['create', 'update', 'pause', 'resume', 'archive'].includes(value.operation)
    && (value.operation === 'create' ? value.url === '/api/tasks' : /^\/api\/tasks\/[a-zA-Z0-9_.:%-]+\/(update|pause|resume|archive)$/.test(value.url));
}

export function loadTaskRequest(storage = globalThis.localStorage) {
  try { const value = JSON.parse(storage?.getItem(TASK_REQUEST_KEY) || 'null'); return validPending(value) ? freeze(value) : null; } catch { return null; }
}

export function saveTaskRequest(value, storage = globalThis.localStorage, expectedRequestId) {
  try {
    if (!storage) return false;
    const retained = loadTaskRequest(storage);
    if (value) {
      if (!validPending(value) || (retained && (retained.requestId !== value.requestId || retained.url !== value.url || JSON.stringify(retained.body) !== JSON.stringify(value.body)))) return false;
      const serialized = JSON.stringify(value); storage.setItem(TASK_REQUEST_KEY, serialized); return storage.getItem(TASK_REQUEST_KEY) === serialized;
    }
    if (expectedRequestId && retained && retained.requestId !== expectedRequestId) return false;
    storage.removeItem(TASK_REQUEST_KEY); return !storage.getItem(TASK_REQUEST_KEY);
  } catch { return false; }
}

export function resolvedTaskRequest(payload, requestId) {
  if (!payload || payload.requestId !== requestId || !['created', 'applied', 'cancelled'].includes(payload.state)) return null;
  if (payload.state !== 'cancelled' && !identifier(payload.task?.id || payload.taskId)) return null;
  return { state: payload.state, task: payload.task && typeof payload.task === 'object' ? payload.task : null, taskId: payload.task?.id || payload.taskId || null };
}

export async function postTaskMutation(request, { signal, fetchImpl = fetch } = {}) {
  if (!validPending(request)) throw new Error('The exact retained task request is invalid.');
  // Mutations are deliberately single-shot. Only the read helpers retry.
  const payload = await fetchJson(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), signal }, 15000, fetchImpl);
  if (payload?.requestId && payload.requestId !== request.requestId) throw new Error('The task response did not match the retained request ID.');
  const recorded = resolvedTaskRequest(payload, request.requestId);
  if (recorded) {
    if (request.operation !== 'create' && recorded.taskId && recorded.taskId !== decodeURIComponent(request.url.split('/')[3])) throw new Error('The task write returned another task ID.');
    return recorded;
  }
  const task = payload?.task || payload;
  if (!identifier(task?.id) || !integer(task.revision, 1, Number.MAX_SAFE_INTEGER) || typeof task.status !== 'string') throw new Error('The task write was not confirmed.');
  if (request.operation !== 'create' && task.id !== decodeURIComponent(request.url.split('/')[3])) throw new Error('The task write returned another task ID.');
  return { state: request.operation === 'create' ? 'created' : 'applied', task, taskId: task.id };
}

export async function readTaskRequestStatus(request, options = {}) {
  if (!validPending(request)) throw new Error('The retained task request is invalid.');
  const payload = await readAgentJson(`/api/task-requests/${encodeURIComponent(request.requestId)}`, { maxReadRetries: 2, ...options });
  const result = resolvedTaskRequest(payload, request.requestId);
  if (!result) throw new Error('The server has not confirmed a final request outcome.');
  return result;
}

export async function cancelTaskRequest(request, { signal, fetchImpl = fetch } = {}) {
  if (!validPending(request)) throw new Error('The retained task request is invalid.');
  const payload = await fetchJson(`/api/task-requests/${encodeURIComponent(request.requestId)}/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal
  }, 15000, fetchImpl);
  const result = resolvedTaskRequest(payload, request.requestId);
  if (!result) throw new Error('Cancellation was not confirmed.');
  return result;
}

export function taskDate(value, timeZone) {
  if (value === undefined || value === null || !Number.isFinite(new Date(value).getTime())) return 'Not scheduled';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long', ...(timeZone ? { timeZone } : {}) }).format(new Date(value)); }
  catch { return new Date(value).toISOString(); }
}

export function taskScheduleLabel(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'Schedule not recorded';
  if (schedule.kind === 'once') return `Once · ${taskDate(schedule.at)}`;
  if (schedule.kind === 'interval') return `Every ${schedule.everyMinutes} minutes · first ${taskDate(schedule.firstAt)}`;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (schedule.kind === 'daily') return `Daily at ${schedule.time} · ${schedule.timeZone}`;
  if (schedule.kind === 'weekly') return `${(schedule.weekdays || []).map(day => days[day - 1] || '?').join(', ')} at ${schedule.time} · ${schedule.timeZone}`;
  return 'Schedule not recorded';
}

export function taskRunHistory(task) {
  const runs = new Map();
  for (const item of Array.isArray(task?.history) ? task.history : []) {
    const entry = typeof item === 'string' ? { runId: item } : item;
    if (identifier(entry?.runId)) runs.set(entry.runId, entry);
  }
  for (const runId of [task?.lastRunId, task?.currentRunId]) if (identifier(runId) && !runs.has(runId)) runs.set(runId, { runId });
  return [...runs.values()].slice(-20).reverse();
}

export function taskChangeReceipt(receipt) {
  if (!receipt || receipt.kind !== 'task_change' || !identifier(receipt.requestId) || !identifier(receipt.taskId)) return null;
  return {
    requestId: receipt.requestId, taskId: receipt.taskId,
    operation: typeof receipt.operation === 'string' ? receipt.operation : 'Not recorded',
    status: typeof receipt.status === 'string' ? receipt.status : 'Not recorded',
    revision: integer(receipt.revision, 1, Number.MAX_SAFE_INTEGER) ? receipt.revision : null,
    generation: integer(receipt.generation, 0, Number.MAX_SAFE_INTEGER) ? receipt.generation : null,
    nextRunAt: Number.isSafeInteger(receipt.nextRunAt) && receipt.nextRunAt > 0 ? receipt.nextRunAt : null,
    nextRunRecorded: receipt.nextRunAt === null || (Number.isSafeInteger(receipt.nextRunAt) && receipt.nextRunAt > 0),
    limits: {
      maxRuns: integer(receipt.limits?.maxRuns, 1, 1000) ? receipt.limits.maxRuns : null,
      maxTotalTokens: integer(receipt.limits?.maxTotalTokens, 1, 1000000) ? receipt.limits.maxTotalTokens : null
    }, localOnly: receipt.localOnly === true
  };
}

export function taskReceiptRefreshKey(run) {
  const receipts = new Map();
  for (const raw of Array.isArray(run?.taskReceipts) ? run.taskReceipts : []) {
    const receipt = taskChangeReceipt(raw);
    if (receipt) receipts.set(receipt.requestId, receipt);
  }
  return receipts.size ? JSON.stringify([...receipts.values()].sort((a, b) => a.requestId.localeCompare(b.requestId))) : '';
}
