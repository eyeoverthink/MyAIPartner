import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readOllamaStream, initialRun, reduceRunEvent, reconcileRun, pollAgentRun,
  finalizeReply, submitTranscript, availableModels, recallMemory, loadPendingRun, savePendingRun, readAgentJson
} from '../src/protocol.mjs';

const event = (sequence, type, data = {}) => ({ runId: 'run-1', sequence, type, data });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('NDJSON buffers arbitrary byte splits, Unicode and a final line without newline', async () => {
  const bytes = new TextEncoder().encode([
    JSON.stringify({ message: { content: 'Hello φ ' }, done: false }),
    JSON.stringify({ message: { content: '🎙 世界' }, done: false }),
    JSON.stringify({ done: true })
  ].join('\r\n'));
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  }});
  const deltas = [];
  assert.equal(await readOllamaStream(stream, { onText: text => deltas.push(text) }), 'Hello φ 🎙 世界');
  assert.deepEqual(deltas, ['Hello φ ', 'Hello φ 🎙 世界']);
});

test('truncated and provider-error streams fail instead of becoming successful replies', async () => {
  await assert.rejects(readOllamaStream(new Response('{"message":{"content":"partial"}}\n').body), /before completion/);
  await assert.rejects(readOllamaStream(new Response('{"error":"model unavailable"}\n').body), /model unavailable/);
  await assert.rejects(readOllamaStream(new Response('{"broken":\n').body), SyntaxError);
});

test('durable events deduplicate replay, reject other runs and preserve exact tool/approval previews', () => {
  let state = initialRun('run-1');
  state = reduceRunEvent(state, event(1, 'tool_started', { callId: 'call-1', name: 'write', arguments: { path: 'a.txt' } }));
  state = reduceRunEvent(state, event(2, 'approval_required', { approvalId: 'approve-1', name: 'write', arguments: { path: 'a.txt' }, preview: 'Exact contents' }));
  assert.equal(state.approvals[0].preview, 'Exact contents');
  assert.equal(state.status, 'awaiting_approval');
  assert.equal(reduceRunEvent(state, event(2, 'text_delta', { text: 'duplicate' })), state);
  assert.equal(reduceRunEvent(state, { ...event(3, 'text_delta', { text: 'wrong' }), runId: 'another' }), state);
  state = reduceRunEvent(state, event(3, 'tool_result', { callId: 'call-1', name: 'write', result: { ok: true } }));
  assert.deepEqual(state.tools[0].result, { ok: true });
});

test('failure/cancellation terminal events cannot be overwritten by late text or success', () => {
  for (const terminal of ['failed', 'cancelled']) {
    let state = reduceRunEvent(initialRun('run-1'), event(1, terminal, { error: 'failed', reason: 'requested' }));
    const finished = state;
    state = reduceRunEvent(state, event(2, 'completed', { output: 'false success' }));
    assert.equal(state, finished);
    assert.equal(state.status, terminal);
  }
  assert.equal(reconcileRun(initialRun('run-1'), { status: 'failed', error: 'lost worker' }).error, 'lost worker');
});

test('polling resumes after sequence and produces exactly the durable completed text and usage', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/events')) {
      polls++;
      return json({ events: polls === 1 ? [event(1, 'status', { status: 'running' })] : [
        event(1, 'status', { status: 'running' }),
        event(2, 'usage', { inputTokens: 20, outputTokens: 8, totalTokens: 28, costUsd: null }),
        event(3, 'text_delta', { text: 'One complete answer.' }),
        event(4, 'completed', { output: 'One complete answer.' })
      ] });
    }
    return json({ id: 'run-1', status: 'running' });
  };
  const result = await pollAgentRun('run-1', { fetchImpl, intervalMs: 0 });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'One complete answer.');
  assert.equal(result.usage.totalTokens, 28);
  assert.ok(calls.some(url => url.endsWith('afterSequence=1')));
});

test('polling abort stops requests instead of synthesizing success', async () => {
  const controller = new AbortController();
  const fetchImpl = async url => {
    if (url.includes('/events')) return json({ events: [] });
    controller.abort();
    return json({ status: 'running' });
  };
  await assert.rejects(pollAgentRun('run-1', { fetchImpl, signal: controller.signal, intervalMs: 0 }), { name: 'AbortError' });
});

test('transient reconnect retries only reads, preserves sequence and recovers the terminal reply', async () => {
  const calls = [], states = [];
  let eventReads = 0;
  const result = await pollAgentRun('run-1', { intervalMs: 0, retryBaseMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('/events')) {
      eventReads++;
      if (eventReads === 1) return json({ events: [event(1, 'text_delta', { text: 'First ' })] });
      if (eventReads === 2) throw new TypeError('network disconnected');
      return json({ events: [event(2, 'text_delta', { text: 'and final.' }), event(3, 'completed', { output: 'First and final.' })] });
    }
    return json({ status: 'running' });
  }, onState: state => states.push(state) });
  assert.equal(result.output, 'First and final.');
  assert.equal(result.status, 'completed');
  assert.ok(states.some(state => state.connectionStatus === 'reconnecting' && state.output === 'First '));
  assert.ok(calls.filter(call => call.url.includes('/events')).slice(1).every(call => call.url.endsWith('afterSequence=1')));
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('recent-run history uses the same bounded read-only retry helper', async () => {
  const calls = [], connection = [];
  const runs = [{ id: 'stored-run', status: 'completed', goal: 'Previous work' }];
  const result = await readAgentJson('/api/agent/runs', { retryBaseMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      if (calls.length === 1) return new Response('{"error":"temporarily unavailable"}', { status: 503 });
      return json({ runs });
    }, onConnection: state => connection.push(state.connectionStatus)
  });
  assert.deepEqual(result.runs, runs);
  assert.deepEqual(connection, ['reconnecting', 'connected']);
  assert.ok(calls.every(call => call.url === '/api/agent/runs' && call.method === 'GET'));
});

test('cancellation while disconnected aborts backoff with the durable run ID still available', async () => {
  const controller = new AbortController();
  let disconnectedState, calls = 0;
  await assert.rejects(pollAgentRun('run-1', {
    signal: controller.signal, retryBaseMs: 10000,
    fetchImpl: async () => { calls++; throw new TypeError('offline'); },
    onState: state => { disconnectedState = state; controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(disconnectedState.runId, 'run-1');
  assert.equal(disconnectedState.connectionStatus, 'reconnecting');
  assert.equal(calls, 1);
});

test('exhausted bounded reconnect exposes a recoverable durable run rather than false completion', async () => {
  let calls = 0;
  await assert.rejects(pollAgentRun('run-1', {
    retryBaseMs: 0, maxReadRetries: 2,
    fetchImpl: async () => { calls++; return new Response('{"error":"temporarily unavailable"}', { status: 503 }); }
  }), error => error.recoverableRun === true && error.runId === 'run-1' && error.runState.connectionStatus === 'disconnected');
  assert.equal(calls, 3);
});

test('terminal record recovery drains final events after an interrupted event read', async () => {
  let events = 0;
  const result = await pollAgentRun('run-1', { retryBaseMs: 0, fetchImpl: async url => {
    if (!url.includes('/events')) return json({ status: 'completed', output: 'Recovered answer', usage: { totalTokens: 12 } });
    events++;
    if (events === 1) throw new TypeError('temporary disconnect');
    if (events === 2) return json({ events: [] });
    return json({ events: [event(1, 'usage', { totalTokens: 12 }), event(2, 'completed', { output: 'Recovered answer' })] });
  }});
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Recovered answer');
  assert.equal(result.usage.totalTokens, 12);
});

test('resume recovers durable failed and cancelled terminal records without any POST', async () => {
  for (const status of ['failed', 'cancelled']) {
    const calls = [];
    const result = await pollAgentRun('run-1', { fetchImpl: async (url, options) => {
      calls.push(options.method || 'GET');
      return json(url.includes('/events') ? { events: [] } : { status, error: { message: 'Durable terminal reason' } });
    }});
    assert.equal(result.status, status);
    assert.equal(result.error.message, 'Durable terminal reason');
    assert.ok(calls.every(method => method === 'GET'));
  }
});

test('reconnect preserves the exact pending approval while the server is unreachable', async () => {
  let stateAtDisconnect;
  await assert.rejects(pollAgentRun('run-1', { maxReadRetries: 0,
    fetchImpl: async url => {
      if (url.includes('/events')) return json({ events: [event(1, 'approval_required', { approvalId: 'approval-1', name: 'write', arguments: { path: 'exact.txt' }, preview: 'Exact preview' })] });
      throw new TypeError('offline');
    }, onState: state => { stateAtDisconnect = state; }
  }), /offline/);
  assert.equal(stateAtDisconnect.status, 'awaiting_approval');
  assert.equal(stateAtDisconnect.runId, 'run-1');
  assert.equal(stateAtDisconnect.approvals[0].preview, 'Exact preview');
});

test('reload persistence retains the exact request identity and clears only explicitly', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const pending = { runId: 'run-1', conversationId: 'conversation-1', request: { requestId: 'request-1', goal: 'original goal', model: 'local' } };
  savePendingRun(pending, storage);
  assert.deepEqual(loadPendingRun(storage), pending);
  savePendingRun({ ...pending, runId: null }, storage);
  assert.equal(loadPendingRun(storage).request.requestId, 'request-1');
  savePendingRun(null, storage);
  assert.equal(loadPendingRun(storage), null);
});

test('only successful full replies trigger speech and memory, exactly once per finalization', async () => {
  const spoken = [], stored = [];
  const effects = { speak: text => spoken.push(text), observe: text => stored.push(text) };
  for (const status of ['running', 'failed', 'cancelled']) {
    assert.equal(await finalizeReply({ status, output: 'partial' }, effects), false);
  }
  await finalizeReply({ status: 'completed', output: 'Full answer φ 🎙.' }, effects);
  assert.deepEqual(spoken, ['Full answer φ 🎙.']);
  assert.deepEqual(stored, ['Full answer φ 🎙.']);
});

test('microphone submits the recognized payload without reading stale composer state', () => {
  let composer = 'stale composer';
  const received = [];
  submitTranscript('  actual recognized question  ', text => received.push(text));
  submitTranscript(' ', text => received.push(text));
  assert.equal(composer, 'stale composer');
  assert.deepEqual(received, ['actual recognized question']);
});

test('cloud requires both explicit server eligibility and user opt-in', () => {
  const caps = { models: [{ name: 'local:3b' }, { name: 'remote:cloud' }, { name: 'blocked', available: false }] };
  assert.deepEqual(availableModels(caps, true).map(m => m.name), ['local:3b']);
  assert.deepEqual(availableModels({ ...caps, cloudEnabled: true }, false).map(m => m.name), ['local:3b']);
  assert.deepEqual(availableModels({ ...caps, cloudEnabled: true }, true).map(m => m.name), ['local:3b', 'remote:cloud']);
});

test('optional recall bounds retrieved notes and propagates user cancellation', async () => {
  const notes = await recallMemory('question', undefined, async () => json({ hits: Array.from({ length: 10 }, () => ({ content: 'x'.repeat(900) })) }));
  assert.equal(notes.length, 700 * 3 + 2);
  assert.equal(await recallMemory('question', undefined, async () => { throw new Error('offline'); }), '');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recallMemory('question', controller.signal, async () => { throw new Error('offline'); }), { name: 'AbortError' });
});
