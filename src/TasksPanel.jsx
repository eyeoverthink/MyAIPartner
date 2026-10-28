import React, { useEffect, useMemo, useRef, useState } from 'react';
import { describeModel, fetchJson, readAgentJson, selectDefaultModel } from './protocol.mjs';
import { buildTaskMutation, buildTaskSpec, cancelTaskRequest, defaultTaskForm, loadTaskRequest, localTaskModels, postTaskMutation, readTaskRequestStatus,
  saveTaskRequest, taskDate, taskFormFromRecord, taskPreviewFromResponse, taskRunHistory, taskScheduleLabel } from './tasks.mjs';

const textError = value => typeof value === 'string' ? value : value?.message || (value ? JSON.stringify(value) : '');
const isTask = value => value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && value.revision >= 1 && typeof value.status === 'string';

export default function TasksPanel({ capabilities, locked = false, onInspectRun, receiptsRefreshKey = '', standalone = false, active = true }) {
  const restored = useMemo(() => loadTaskRequest(), []);
  const [pending, setPending] = useState(restored);
  const pendingRef = useRef(restored);
  const models = useMemo(() => localTaskModels(capabilities), [capabilities]);
  const [form, setForm] = useState(() => defaultTaskForm(''));
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [opened, setOpened] = useState(standalone);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState(restored ? 'An unresolved task request is retained. Read its status or cancel that request before another change. Nothing was resubmitted.' : 'No task is created until you preview it and explicitly save.');
  const alive = useRef(true), reads = useRef(null), writes = useRef(null), cancellation = useRef(null), generation = useRef(0);
  const formRevision = useRef(0);
  const lastReceiptRefresh = useRef('');
  const writeBlocked = locked || busy || cancelling || Boolean(pending);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const modelName = form.model || selectDefaultModel(models, '', capabilities?.preferredModel).replace(/^ollama::/, '');

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; reads.current?.abort(); writes.current?.abort(); cancellation.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!active || !opened || busy || cancelling || !receiptsRefreshKey || lastReceiptRefresh.current === receiptsRefreshKey) return;
    lastReceiptRefresh.current = receiptsRefreshKey;
    refreshTasks();
  }, [active, opened, busy, cancelling, receiptsRefreshKey]);
  useEffect(() => { if (standalone && active && !loaded && !busy && !cancelling) refreshTasks(); }, [standalone, active]);

  function change(values) {
    formRevision.current++; reads.current?.abort(); setBusy(false); setPreview(null);
    setForm(previous => ({ ...previous, ...values })); setError('');
    setNote('Draft changed. Preview again before saving.');
  }
  function mergeTask(task) {
    if (!isTask(task)) return;
    setTasks(previous => previous.some(item => item.id === task.id) ? previous.map(item => item.id === task.id ? task : item) : [task, ...previous]);
    setSelectedId(task.id); setSelected(task);
  }
  function finishRequest(result) {
    if (!saveTaskRequest(null, globalThis.localStorage, pendingRef.current?.requestId)) throw new Error('The server answered, but the retained request could not be cleared from browser storage. Read it again before further changes.');
    pendingRef.current = null; setPending(null); setPreview(null);
    mergeTask(result.task);
    setNote(`Request ${result.state}${result.taskId ? ` · task ${result.taskId}` : ''}. Review the authoritative task status below; cancelling a request does not imply that a running job was stopped.`);
  }
  function beginRead() {
    const controller = new AbortController(); reads.current?.abort(); reads.current = controller;
    setBusy(true); setError(''); return controller;
  }
  function endRead(controller) { if (alive.current && reads.current === controller) { reads.current = null; setBusy(false); } }
  const readOptions = controller => ({ signal: controller.signal, maxReadRetries: 2, onConnection: connection => {
    if (alive.current && !controller.signal.aborted && connection.connectionStatus === 'reconnecting') setNote(`Reconnecting to task records · attempt ${connection.retryAttempt}. No write is retried.`);
  } });

  async function refreshTasks() {
    if (busy || cancelling) return;
    const controller = beginRead();
    try {
      const value = await readAgentJson('/api/tasks', readOptions(controller));
      if (!Array.isArray(value.tasks)) throw new Error('The server returned no task list.');
      if (alive.current && !controller.signal.aborted) {
        const records = value.tasks.filter(isTask); setTasks(records); setLoaded(true);
        setSelected(previous => records.find(task => task.id === previous?.id) || previous);
        setNote(`${records.length} stored task${records.length === 1 ? '' : 's'} read. Refresh to see later status changes.`);
      }
    } catch (caught) { if (alive.current && !controller.signal.aborted) setError(caught.message); }
    finally { endRead(controller); }
  }
  async function readTask(id = selectedId) {
    if (!id || busy || cancelling) return;
    const controller = beginRead();
    try {
      const payload = await readAgentJson(`/api/tasks/${encodeURIComponent(id)}`, readOptions(controller));
      const task = payload.task || payload;
      if (!isTask(task) || task.id !== id) throw new Error('The selected task record was not confirmed.');
      if (alive.current && !controller.signal.aborted) { mergeTask(task); setNote('Task details and up to 20 run-history records were read.'); }
    } catch (caught) { if (alive.current && !controller.signal.aborted) setError(caught.message); }
    finally { endRead(controller); }
  }
  async function previewTask() {
    if (writeBlocked || pendingRef.current) return;
    setPreview(null); const revision = formRevision.current;
    const controller = beginRead();
    try {
      const spec = buildTaskSpec({ ...form, model: modelName }, models);
      const payload = await fetchJson('/api/tasks/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec), signal: controller.signal }, 15000);
      const result = taskPreviewFromResponse(payload, models);
      if (alive.current && !controller.signal.aborted && formRevision.current === revision) { setForm(previous => ({ ...previous, model: spec.model })); setPreview(result); setNote('Preview only. Check the exact goal, model, limits and next times, then save explicitly.'); }
    } catch (caught) { if (alive.current && !controller.signal.aborted) setError(caught.message); }
    finally { endRead(controller); }
  }
  async function submit(operation, task = editing) {
    if (writeBlocked || pendingRef.current) return;
    let request;
    try {
      if (['create', 'update'].includes(operation) && !models.some(model => model.name === preview?.spec?.model)) throw new Error('The previewed local model is no longer available. Refresh capabilities and preview again.');
      request = buildTaskMutation({ operation, requestId: crypto.randomUUID(), preview, task });
      if (!saveTaskRequest(request)) {
        const retained = loadTaskRequest();
        if (retained) { pendingRef.current = retained; setPending(retained); }
        throw new Error(retained ? 'Another unresolved task request is retained. Read or cancel it first; no replacement was sent.' : 'Browser storage could not retain the exact request. No task change was sent.');
      }
    } catch (caught) { setError(caught.message); return; }
    pendingRef.current = request; setPending(request); setBusy(true); setError('');
    const current = ++generation.current;
    const controller = new AbortController(); writes.current = controller;
    try {
      const resolved = await postTaskMutation(request, { signal: controller.signal });
      if (!alive.current || current !== generation.current) return;
      finishRequest(resolved);
      if (operation === 'create' || operation === 'update') { setEditing(null); setForm(defaultTaskForm(modelName)); formRevision.current++; }
    } catch (caught) {
      if (alive.current && current === generation.current) setError(`Request outcome is unresolved: ${caught.message}. Read or cancel the retained request. No replacement was submitted.`);
    } finally { if (alive.current && current === generation.current) { writes.current = null; setBusy(false); } }
  }
  async function recoverRequest() {
    const request = pendingRef.current;
    if (!request || busy || cancelling) return;
    const controller = beginRead();
    try {
      const resolved = await readTaskRequestStatus(request, readOptions(controller));
      if (!alive.current || controller.signal.aborted || pendingRef.current?.requestId !== request.requestId) return;
      finishRequest(resolved);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) setError(`Request remains unresolved: ${caught.message}. A missing response or HTTP 404 does not prove that no task exists. Cancel the retained request or read again.`);
    } finally { endRead(controller); }
  }
  async function cancelRequest() {
    const request = pendingRef.current;
    if (!request || cancelling) return;
    const current = ++generation.current;
    reads.current?.abort(); writes.current?.abort(); setBusy(false); setCancelling(true); setError('');
    const controller = new AbortController(); cancellation.current = controller;
    try {
      const resolved = await cancelTaskRequest(request, { signal: controller.signal });
      if (!alive.current || current !== generation.current) return;
      finishRequest(resolved);
    } catch (caught) { if (alive.current && current === generation.current) setError(`Request cancellation is unresolved: ${caught.message}. The original request is retained.`); }
    finally { if (alive.current && current === generation.current) { cancellation.current = null; setCancelling(false); } }
  }
  function newDraft() {
    if (writeBlocked) return;
    setEditing(null); setPreview(null); setForm(defaultTaskForm(modelName)); formRevision.current++; setError('');
    setNote('New empty task draft. Conversation history and attachments are not copied.');
  }
  function editSelected() {
    if (!selected || writeBlocked || selected.status === 'archived') return;
    setEditing({ id: selected.id, revision: selected.revision }); setForm(taskFormFromRecord(selected)); setPreview(null); formRevision.current++; setError('');
    setNote(`Editing ${selected.title} at revision ${selected.revision}. Preview again before applying an update.`);
  }

  return <details className={`scheduled-tasks ${standalone ? 'standalone' : ''}`} open={standalone ? true : undefined} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Scheduled tasks{pending ? ' · unresolved request retained' : ''}</summary>
    <p><strong>Local Ollama only · app must remain running.</strong> Give the task its own goal, preview the schedule, then save.</p>
    <details className="task-guidance"><summary>How scheduled work is bounded</summary><p>Goals run within explicit run/token limits. Missed intervals coalesce into one run; they do not burst. Approval-needed work pauses future runs. Code execution remains subject to Docker availability and the tool approval policy.</p><p>This is a separate goal. Chat history, attachments, desktop access and cloud authorization are never copied into it.</p></details>
    {pending && <section className="task-recovery" aria-label="Unresolved scheduled task request">
      <strong>Unresolved {pending.operation} request</strong><code>{pending.requestId}</code>
      <p>The exact original URL and body are retained. Reload did not create, update, or retry a task. New changes are blocked until this request is resolved.</p>
      <div className="task-controls"><button onClick={recoverRequest} disabled={busy || cancelling}>Read request status</button><button onClick={cancelRequest} disabled={cancelling}>{cancelling ? 'Cancelling request…' : 'Cancel unresolved request'}</button></div>
      <p>Cancellation records a tombstone for this request. Review any returned task state separately; this is not a claim that an already-running job stopped.</p>
      <details><summary>Retained exact request</summary><pre>{JSON.stringify({ url: pending.url, body: pending.body }, null, 2)}</pre></details>
    </section>}
    <div className="task-controls"><button onClick={refreshTasks} disabled={busy || cancelling}>{busy ? 'Reading or saving…' : 'Refresh tasks'}</button><button onClick={newDraft} disabled={writeBlocked}>New empty draft</button></div>
    <label>Stored task<select aria-label="Stored task" value={selectedId} disabled={busy || cancelling} onChange={event => { setSelectedId(event.target.value); setSelected(tasks.find(task => task.id === event.target.value) || null); }}>
      <option value="">Choose a stored task</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title} · {task.status} · {task.model}</option>)}
    </select></label>
    {loaded && !tasks.length && <p>No stored tasks were returned.</p>}
    {!loaded && <p>Task records have not been read. Refresh to see stored schedules.</p>}
    {selected && <section className="task-record" aria-label="Stored scheduled task">
      <strong>{selected.title} · {selected.status}</strong><p>{selected.goal}</p>
      <dl><div><dt>Task / revision / generation</dt><dd>{selected.id} · {selected.revision} · {selected.generation ?? 'Not recorded'}</dd></div>
        <div><dt>Local model</dt><dd>{selected.model}</dd></div><div><dt>Schedule</dt><dd>{taskScheduleLabel(selected.schedule)}</dd></div>
        <div><dt>Next run</dt><dd>{taskDate(selected.nextRunAt, selected.schedule?.timeZone)}</dd></div>
        <div><dt>Run limit / started</dt><dd>{selected.limits?.maxRuns ?? '?'} / {selected.runsStarted ?? '?'}</dd></div>
        <div><dt>Task tokens · used / reserved / ceiling</dt><dd>{selected.usedTokens ?? '?'} / {selected.reservedTokens ?? '?'} / {selected.limits?.maxTotalTokens ?? '?'}</dd></div></dl>
      {selected.error && <p role="status" className="receipt-error">{textError(selected.error)}</p>}
      <div className="task-controls"><button onClick={() => readTask()} disabled={busy || cancelling}>Read details and history</button><button onClick={editSelected} disabled={writeBlocked || selected.status === 'archived'}>Edit draft</button>
        <button onClick={() => submit('pause', selected)} disabled={writeBlocked || selected.status !== 'active'}>Pause future runs</button>
        <button onClick={() => submit('resume', selected)} disabled={writeBlocked || !['paused', 'attention'].includes(selected.status)}>Resume future runs</button>
        <button onClick={() => submit('archive', selected)} disabled={writeBlocked || selected.status === 'archived'}>Archive task</button></div>
      <p>Pause/archive manage future scheduling. A current run keeps its own cancellation and approval controls.</p>
      <details><summary>Run history · {taskRunHistory(selected).length} retained references</summary>
        <ul>{taskRunHistory(selected).map(entry => <li key={entry.runId}><code>{entry.runId}</code> · {entry.status || 'Read run for status'} · {taskDate(entry.startedAt || entry.createdAt)} <button onClick={() => onInspectRun?.(entry.runId)} disabled={locked || busy || cancelling || !onInspectRun}>Inspect run receipts</button></li>)}</ul>
      </details>
    </section>}
    <section className="task-draft" aria-label="Scheduled task draft">
      <strong>{editing ? `Update draft · ${editing.id} · revision ${editing.revision}` : 'New task draft'}</strong>
      <fieldset disabled={writeBlocked}>
        <label>Task title<input aria-label="Task title" value={form.title} maxLength={120} onChange={event => change({ title: event.target.value })} /></label>
        <label>Separate task goal<textarea aria-label="Separate task goal" rows={3} maxLength={20000} value={form.goal} onChange={event => change({ goal: event.target.value })} /></label>
        <label>Task local model<select aria-label="Task local model" value={modelName} onChange={event => change({ model: event.target.value })}><option value="">Choose a local model</option>{models.map(model => <option key={model.name} value={model.name}>{describeModel(model)}</option>)}</select></label>
        {!models.length && <p>No available local task models are advertised. Refresh Agent capabilities in Connection.</p>}
        <div className="task-form-grid"><label>Schedule<select aria-label="Schedule kind" value={form.kind} onChange={event => change({ kind: event.target.value })}><option value="once">Once</option><option value="interval">Interval</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
          {form.kind === 'once' && <label>Run at · {browserZone}<input aria-label="One-time local date" type="datetime-local" step="1" value={form.at} onChange={event => change({ at: event.target.value })} /></label>}
          {form.kind === 'interval' && <><label>First run · {browserZone}<input aria-label="Interval first local date" type="datetime-local" step="1" value={form.firstAt} onChange={event => change({ firstAt: event.target.value })} /></label><label>Every minutes<input type="number" min="1" max="10080" value={form.everyMinutes} onChange={event => change({ everyMinutes: event.target.value })} /></label></>}
          {['daily', 'weekly'].includes(form.kind) && <><label>Wall time<input type="time" value={form.time} onChange={event => change({ time: event.target.value })} /></label><label>IANA time zone<input value={form.timeZone} placeholder="America/Los_Angeles" onChange={event => change({ timeZone: event.target.value })} /></label></>}
        </div>
        {form.kind === 'weekly' && <div className="task-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => <label key={day}><input type="checkbox" checked={form.weekdays.includes(index + 1)} onChange={event => change({ weekdays: event.target.checked ? [...form.weekdays, index + 1] : form.weekdays.filter(value => value !== index + 1) })} />{day}</label>)}</div>}
        <p>Daily/weekly DST policy: a skipped wall time moves forward by the gap; a repeated wall time uses its first occurrence, once per day. Preview shows the server's exact dates.</p>
        <div className="task-form-grid"><label>Maximum runs<input type="number" min="1" max={form.kind === 'once' ? '1' : '1000'} value={form.maxRuns} onChange={event => change({ maxRuns: event.target.value })} /></label><label>Total task token ceiling<input type="number" min="24000" max="1000000" step="1" value={form.maxTotalTokens} onChange={event => change({ maxTotalTokens: event.target.value })} /></label></div>
        <p>The total ceiling must fit one full per-run reservation (default 24,000 tokens). Unused reservations and consumed tokens are reported by the server. No API cloud spending is authorized.</p>
      </fieldset>
      <div className="task-controls"><button onClick={previewTask} disabled={writeBlocked || !models.length}>Preview schedule</button><button onClick={() => submit(editing ? 'update' : 'create')} disabled={writeBlocked || !preview}>{editing ? 'Apply previewed update' : 'Create previewed task'}</button></div>
    </section>
    {preview && <section className="task-preview" aria-label="Exact scheduled task preview"><strong>Preview only · local · app must remain running</strong>{preview.summary && <p>{preview.summary}</p>}
      <p>First run: {taskDate(preview.firstRunAt, preview.spec.schedule.timeZone)}</p><ol>{preview.nextRuns.map((at, index) => <li key={`${at}-${index}`}>{taskDate(at, preview.spec.schedule.timeZone)}</li>)}</ol>
      <p>Saving sends this immutable spec and exact first-run timestamp. Any draft edit invalidates this preview.</p><pre>{JSON.stringify(preview.spec, null, 2)}</pre>
    </section>}
    {note && <p role="status">{note}</p>}{error && <p role="alert" className="receipt-error">{error}</p>}
  </details>;
}
