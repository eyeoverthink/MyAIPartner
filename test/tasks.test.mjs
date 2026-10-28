import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskMutation, buildTaskSpec, cancelTaskRequest, defaultTaskForm, loadTaskRequest, localTaskModels,
  postTaskMutation, readTaskRequestStatus, resolvedTaskRequest, saveTaskRequest, taskDate, taskFormFromRecord,
  taskChangeReceipt, taskPreviewFromResponse, taskReceiptRefreshKey, taskRunHistory, taskScheduleLabel, validateTaskSpec } from '../src/tasks.mjs';
import { directChatHistory, initialRun, pollAgentRun, reconcileRun, reduceRunEvent } from '../src/protocol.mjs';

const models = [{ name: 'tested-local', provider: 'ollama', tools: true }];
const spec = () => ({ title: 'Authored task', goal: 'AUTHORED_TASK_GOAL', model: models[0].name,
  schedule: { kind: 'once', at: '2030-01-01T12:00:00Z' }, budget: { maxTotalTokens: 24000, maxInputTokens: 16384, maxCostUsd: 0 },
  limits: { maxRuns: 1, maxTotalTokens: 72000 } });
const preview = () => taskPreviewFromResponse({ spec: spec(), firstRunAt: Date.parse('2030-01-01T12:00:00Z'), nextRuns: [Date.parse('2030-01-01T12:00:00Z')], localOnly: true, requiresAppRunning: true }, models);
const request = (operation = 'create', task = undefined) => buildTaskMutation({ operation, requestId: 'task-request-1', preview: preview(), task });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };

test('task models and separate spec cannot inherit cloud, desktop, attachments or browser context', () => {
  const candidates = localTaskModels({ cloudEnabled: true, models: [...models, { name: 'remote:cloud' }, { name: 'remote', provider: 'openai', cloud: true }, { name: 'off', allowed: false }, { name: 'nonlocal', local: false }] });
  assert.deepEqual(candidates, models);
  const form = { ...defaultTaskForm(models[0].name), title: ' Task ', goal: ' AUTHORED_TASK_GOAL ', at: '2030-01-01T12:00:00Z',
    desktopSessionId: 'PRIVATE_GRANT', attachments: ['PRIVATE_ASSET'], messages: ['PRIVATE_CHAT'] };
  const actual = buildTaskSpec(form, models);
  assert.equal(actual.goal, 'AUTHORED_TASK_GOAL');
  assert.equal(actual.model, 'tested-local');
  assert.equal(/PRIVATE_/.test(JSON.stringify(actual)), false);
  assert.throws(() => validateTaskSpec({ ...spec(), desktopSessionId: 'private' }, models), /inherit/);
  assert.throws(() => validateTaskSpec({ ...spec(), model: 'remote:cloud' }, models), /local Ollama/);
  assert.throws(() => validateTaskSpec({ ...spec(), budget: { maxCostUsd: 1 } }, models), /zero API cost/);
});

test('backend-sized titles and goals remain editable at exact 120/20,000 limits', () => {
  const original = { ...spec(), title: 'T'.repeat(120), goal: 'G'.repeat(20000) };
  assert.doesNotThrow(() => validateTaskSpec(original, models));
  const form = taskFormFromRecord(original);
  assert.equal(form.goal.length, 20000);
  assert.equal(buildTaskSpec(form, models).goal, original.goal);
  assert.equal(buildTaskSpec(form, models).title.length, 120);
  assert.throws(() => validateTaskSpec({ ...original, title: 'T'.repeat(121) }, models), /120 printable/);
  assert.throws(() => validateTaskSpec({ ...original, goal: 'G'.repeat(20001) }, models), /20,000/);
  assert.throws(() => validateTaskSpec({ ...spec(), title: 'Bad\nTitle' }, models), /printable/);
  assert.throws(() => validateTaskSpec({ ...spec(), goal: 'Bad\u0000goal' }, models), /20,000/);
});

test('schedule validation bounds once, interval and weekly semantics without guessing DST dates', () => {
  assert.throws(() => validateTaskSpec({ ...spec(), limits: { maxRuns: 2, maxTotalTokens: 72000 } }, models), /exactly one/);
  assert.throws(() => validateTaskSpec({ ...spec(), schedule: { kind: 'once', at: '2030-01-01T12:00' } }, models), /known time zone/);
  const recurring = { ...spec(), limits: { maxRuns: 3, maxTotalTokens: 72000 } };
  for (const everyMinutes of [0, 10081, 1.5]) assert.throws(() => validateTaskSpec({ ...recurring, schedule: { kind: 'interval', everyMinutes, firstAt: spec().schedule.at } }, models), /interval/);
  assert.doesNotThrow(() => validateTaskSpec({ ...recurring, schedule: { kind: 'weekly', weekdays: [1, 7], time: '02:30', timeZone: 'America/Los_Angeles' } }, models));
  assert.throws(() => validateTaskSpec({ ...recurring, schedule: { kind: 'weekly', weekdays: [1, 1], time: '02:30', timeZone: 'America/Los_Angeles' } }, models), /weekday/);
  assert.throws(() => validateTaskSpec({ ...recurring, schedule: { kind: 'daily', time: '09:00', timeZone: 'Invalid/Zone' } }, models), /IANA/);
  assert.throws(() => validateTaskSpec({ ...recurring, limits: { maxRuns: 1001, maxTotalTokens: 1000001 } }, models), /1,000/);
});

test('exact server preview is immutable and carries canonical budget and first-run timestamp into creation', () => {
  const original = spec();
  const firstRunAt = 1893499200000;
  const reviewed = taskPreviewFromResponse({ spec: original, firstRunAt, nextRuns: [firstRunAt], localOnly: true, requiresAppRunning: true }, models);
  original.goal = 'CHANGED_DRAFT';
  assert.equal(reviewed.spec.goal, 'AUTHORED_TASK_GOAL');
  assert.throws(() => { reviewed.spec.goal = 'MUTATION'; }, TypeError);
  const mutation = buildTaskMutation({ operation: 'create', requestId: 'task-request-1', preview: reviewed });
  assert.equal(mutation.body.expectedFirstRunAt, firstRunAt);
  assert.equal(mutation.body.goal, 'AUTHORED_TASK_GOAL');
  assert.equal(mutation.body.budget.maxTotalTokens, 24000);
  assert.throws(() => buildTaskMutation({ operation: 'create', requestId: 'new' }), /Preview/);
  assert.throws(() => taskPreviewFromResponse({ spec: spec(), firstRunAt, localOnly: false, requiresAppRunning: true }, models), /local task preview/);
  assert.throws(() => taskPreviewFromResponse({ spec: { ...spec(), budget: { maxTotalTokens: 80000 } }, firstRunAt, localOnly: true, requiresAppRunning: true }, models), /full per-run/);
});

test('update and scheduling controls bind the exact revision and never transfer other task fields', () => {
  const task = { id: 'task-1', revision: 7, desktopSessionId: 'PRIVATE_GRANT', history: ['PRIVATE_HISTORY'] };
  const update = request('update', task);
  assert.equal(update.url, '/api/tasks/task-1/update');
  assert.equal(update.body.expectedRevision, 7);
  assert.equal(update.body.expectedFirstRunAt, preview().firstRunAt);
  for (const operation of ['pause', 'resume', 'archive']) {
    const mutation = request(operation, task);
    assert.deepEqual(mutation.body, { requestId: 'task-request-1', expectedRevision: 7 });
    assert.equal(mutation.url, `/api/tasks/task-1/${operation}`);
  }
  assert.equal(JSON.stringify(update).includes('PRIVATE_'), false);
  assert.throws(() => request('pause', { id: 'task-1' }), /current revision/);
});

test('lost task writes remain exact and persistent, with no automatic write retries', async () => {
  const saved = storage(), pending = request();
  assert.equal(saveTaskRequest(pending, saved), true);
  const calls = [];
  await assert.rejects(postTaskMutation(pending, { fetchImpl: async (url, options) => { calls.push({ url, options }); throw new TypeError('response lost'); } }), /response lost/);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), pending.body);
  assert.deepEqual(loadTaskRequest(saved), pending);
  await assert.rejects(readTaskRequestStatus(loadTaskRequest(saved), { fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ error: 'not found' }, 404); } }), /not found/);
  assert.equal(calls[1].options.method || 'GET', 'GET');
  assert.equal(calls[1].url, '/api/task-requests/task-request-1');
  assert.deepEqual(loadTaskRequest(saved), pending, '404 must not infer that no schedule exists or erase its request identity.');
  assert.equal(saveTaskRequest(pending, { setItem() { throw new Error('full'); } }), false);
});

test('request recovery retries only GET and cancellation is an explicit single tombstone POST', async () => {
  const pending = request();
  const calls = [];
  let reads = 0;
  const recovered = await readTaskRequestStatus(pending, { retryBaseMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    if (++reads === 1) return json({ error: 'temporary' }, 503);
    return json({ requestId: pending.requestId, state: 'created', taskId: 'task-1', task: { id: 'task-1', status: 'active', revision: 1 } });
  } });
  assert.equal(recovered.taskId, 'task-1');
  assert.ok(calls.every(call => call.method === 'GET'));
  const cancelled = await cancelTaskRequest(pending, { fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    return json({ requestId: pending.requestId, state: 'cancelled' });
  } });
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(calls.at(-1), { url: '/api/task-requests/task-request-1/cancel', method: 'POST', body: '{}' });
  assert.equal(resolvedTaskRequest({ requestId: 'other', state: 'created', taskId: 'task-1' }, pending.requestId), null);
  assert.equal(resolvedTaskRequest({ requestId: pending.requestId, state: 'creating' }, pending.requestId), null);
});

test('a retained request cannot be replaced or cleared by another task operation or browser tab', () => {
  const saved = storage(), first = request();
  const other = buildTaskMutation({ operation: 'create', requestId: 'task-request-2', preview: preview() });
  assert.equal(saveTaskRequest(first, saved), true);
  assert.equal(saveTaskRequest(other, saved), false);
  assert.equal(saveTaskRequest({ ...first, body: { ...first.body, goal: 'CHANGED_REQUEST' } }, saved), false);
  assert.equal(saveTaskRequest(null, saved, other.requestId), false);
  assert.deepEqual(loadTaskRequest(saved), first);
  assert.equal(saveTaskRequest(null, saved, first.requestId), true);
  assert.equal(loadTaskRequest(saved), null);
});

test('task writes reject mismatched request/task receipts rather than clearing uncertainty', async () => {
  const pending = request('pause', { id: 'task-1', revision: 3 });
  await assert.rejects(postTaskMutation(pending, { fetchImpl: async () => json({ requestId: 'other', state: 'applied', taskId: 'task-1' }) }), /request ID/);
  await assert.rejects(postTaskMutation(pending, { fetchImpl: async () => json({ requestId: pending.requestId, state: 'applied', taskId: 'task-2' }) }), /another task ID/);
  await assert.rejects(postTaskMutation(pending, { fetchImpl: async () => json({ id: 'task-2', revision: 4, status: 'paused' }) }), /another task ID/);
});

test('task display retains schedule timezone, historical run identity and editable local budget', () => {
  const task = { ...spec(), id: 'task-1', revision: 2, history: [{ runId: 'run-1', status: 'completed' }, { runId: 'run-1', status: 'failed' }, { runId: 'bad/path' }], lastRunId: 'run-2', currentRunId: 'run-3' };
  const form = taskFormFromRecord(task);
  assert.equal(form.model, task.model);
  assert.deepEqual(form.budget, task.budget);
  assert.deepEqual(taskRunHistory(task).map(entry => entry.runId), ['run-3', 'run-2', 'run-1']);
  assert.equal(taskRunHistory(task).at(-1).status, 'failed');
  assert.match(taskScheduleLabel({ kind: 'weekly', time: '09:00', timeZone: 'Europe/London', weekdays: [1, 7] }), /Mon, Sun at 09:00 · Europe\/London/);
  assert.equal(taskDate(null), 'Not scheduled');
  assert.equal(taskDate('not-a-date'), 'Not scheduled');
});

test('trusted local-only run context survives terminal replay and is excluded from Direct history', async () => {
  const calls = [];
  const result = await pollAgentRun('task-run-1', { intervalMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    return json(url.includes('/events') ? { events: [{ runId: 'task-run-1', sequence: 1, type: 'completed', data: { output: 'PRIVATE_TASK_DATA' } }] }
      : { id: 'task-run-1', status: 'completed', privateContextLocalOnly: true, provenance: { kind: 'scheduled-task', taskId: 'task-1' } });
  } });
  assert.equal(result.privateContextLocalOnly, true);
  assert.equal(result.provenance.taskId, 'task-1');
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(reconcileRun(result, { privateContextLocalOnly: false }).privateContextLocalOnly, true);
  assert.deepEqual(directChatHistory([{ role: 'assistant', text: 'PRIVATE_TASK_DATA', privateContextLocalOnly: true }, { role: 'user', text: 'Authored public goal' }]), [{ role: 'user', content: 'Authored public goal' }]);
  assert.equal(reconcileRun(initialRun('x'), { status: 'running', privateContextLocalOnly: true }).privateContextLocalOnly, true);
});

const changeReceipt = () => ({ kind: 'task_change', requestId: 'taskop:run-1:approval-1', taskId: 'task-1', revision: 1, generation: 1,
  operation: 'create', status: 'active', nextRunAt: 1893499200000, limits: { maxRuns: 1, maxTotalTokens: 72000 }, localOnly: true });

test('late durable task acknowledgements merge by request ID without reviving a cancelled source run', () => {
  const event = (sequence, type, data) => ({ runId: 'run-1', sequence, type, data });
  const cancelled = reduceRunEvent(initialRun('run-1'), event(1, 'cancelled', { reason: 'User cancelled source' }));
  assert.equal(taskReceiptRefreshKey(cancelled), '');
  const first = reduceRunEvent(cancelled, event(2, 'task_receipt', { receipt: changeReceipt() }));
  assert.equal(first.status, 'cancelled');
  assert.equal(first.error, 'User cancelled source');
  assert.equal(first.output, '');
  assert.deepEqual(first.approvals, []);
  assert.equal(first.taskReceipts.length, 1);
  assert.notEqual(taskReceiptRefreshKey(first), '');
  assert.equal(reduceRunEvent(first, event(2, 'task_receipt', { receipt: changeReceipt() })), first);
  assert.equal(reduceRunEvent(first, { ...event(3, 'task_receipt', { receipt: changeReceipt() }), runId: 'other' }), first);
  const updated = reduceRunEvent(first, event(3, 'task_receipt', { receipt: { ...changeReceipt(), revision: 2, status: 'paused', nextRunAt: null } }));
  assert.equal(updated.taskReceipts.length, 1);
  assert.equal(updated.taskReceipts[0].revision, 2);
  assert.equal(updated.status, 'cancelled');
  assert.notEqual(taskReceiptRefreshKey(first), taskReceiptRefreshKey(updated));
  assert.equal(reduceRunEvent(updated, event(4, 'completed', { output: 'Wrong success' })), updated);
  assert.equal(reconcileRun(updated, { status: 'completed' }).taskReceipts[0].revision, 2);
});

test('terminal polling drains late task receipts as read-only audit facts and retains source cancellation', async () => {
  let eventReads = 0;
  const calls = [];
  const result = await pollAgentRun('run-1', { intervalMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('/events')) return json({ events: ++eventReads === 1 ? [] : [
      { runId: 'run-1', sequence: 1, type: 'cancelled', data: { reason: 'Cancelled while saving' } },
      { runId: 'run-1', sequence: 2, type: 'task_receipt', data: { receipt: changeReceipt() } }
    ] });
    return json({ id: 'run-1', status: 'cancelled', privateContextLocalOnly: true });
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.taskReceipts[0].requestId, changeReceipt().requestId);
  assert.equal(result.privateContextLocalOnly, true);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('task receipt refresh identity uses recorded facts and ignores malformed or unrelated metadata', () => {
  const receipt = changeReceipt();
  const key = taskReceiptRefreshKey({ taskReceipts: [receipt] });
  assert.equal(taskReceiptRefreshKey({ taskReceipts: [receipt, { ...receipt, irrelevant: 'unused' }] }), key);
  assert.equal(taskReceiptRefreshKey({ taskReceipts: [{ ...receipt, requestId: 'bad/path' }] }), '');
  assert.equal(taskChangeReceipt({ ...receipt, kind: 'unrelated' }), null);
  const incomplete = taskChangeReceipt({ ...receipt, revision: -1, generation: '1', nextRunAt: 'tomorrow', localOnly: false, limits: {} });
  assert.equal(incomplete.revision, null);
  assert.equal(incomplete.generation, null);
  assert.equal(incomplete.nextRunRecorded, false);
  assert.equal(incomplete.localOnly, false);
  assert.equal(incomplete.limits.maxRuns, null);
  assert.notEqual(taskReceiptRefreshKey({ taskReceipts: [{ ...receipt, limits: { ...receipt.limits, maxRuns: 2 } }] }), key);
});
