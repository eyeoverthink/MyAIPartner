import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { initialRun, mergeRunUsage, pollAgentRun, reconcileRun, reduceRunEvent } from '../src/protocol.mjs';

const snapshot = extra => ({ inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: 0, ...extra });
const event = (sequence, type, data) => ({ runId: 'run-1', sequence, type, data });

test('actual usage stays monotonic while explicit reservation snapshots can rise, release or settle', () => {
  let usage = mergeRunUsage(null, snapshot({ auxiliaryInputTokens: 20, reservedInputTokens: 50, auxiliaryUsageKnown: false,
    ticketId: 'PRIVATE_TICKET_SENTINEL', privateReasoning: 'PRIVATE_TRACE_SENTINEL' }));
  assert.equal(usage.totalTokens, 110);
  assert.equal(usage.auxiliaryInputTokens, 20);
  assert.equal(usage.reservedInputTokens, 50);
  assert.equal(JSON.stringify(usage).includes('PRIVATE_'), false);
  usage = mergeRunUsage(usage, snapshot({ auxiliaryInputTokens: 20, reservedInputTokens: 75, auxiliaryUsageKnown: false }));
  assert.equal(usage.reservedInputTokens, 75);
  usage = mergeRunUsage(usage, snapshot({ inputTokens: 130, totalTokens: 140, auxiliaryInputTokens: 50, reservedInputTokens: 0, auxiliaryUsageKnown: true }));
  assert.equal(usage.totalTokens, 140, 'Reservation estimates are not added to actual totals.');
  assert.equal(usage.reservedInputTokens, 0);
  assert.equal(usage.auxiliaryUsageKnown, true);
  const older = mergeRunUsage(usage, snapshot({ auxiliaryInputTokens: 20, reservedInputTokens: 75, auxiliaryUsageKnown: false }));
  assert.deepEqual(older, usage, 'An older snapshot must not resurrect the hold or regress actual totals.');
});

test('usage and auxiliary_usage remain ordered/deduplicated after every terminal status without reviving work', () => {
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    let state = reduceRunEvent(initialRun('run-1'), event(1, terminal, { output: 'Terminal output', error: 'Terminal error', reason: 'Cancelled' }));
    const original = { status: state.status, output: state.output, error: state.error, approvals: state.approvals };
    state = reduceRunEvent(state, event(2, 'usage', snapshot({ reservedInputTokens: 40, auxiliaryUsageKnown: false })));
    state = reduceRunEvent(state, event(3, 'auxiliary_usage', snapshot({ inputTokens: 125, totalTokens: 135, auxiliaryInputTokens: 25, reservedInputTokens: 0, auxiliaryUsageKnown: true })));
    assert.equal(state.sequence, 3);
    assert.deepEqual({ status: state.status, output: state.output, error: state.error, approvals: state.approvals }, original);
    assert.equal(state.usage.totalTokens, 135);
    assert.equal(state.usage.reservedInputTokens, 0);
    assert.equal(reduceRunEvent(state, event(3, 'auxiliary_usage', snapshot())), state);
    assert.equal(reduceRunEvent(state, event(2, 'usage', snapshot())), state);
    assert.equal(reduceRunEvent(state, { ...event(4, 'usage', snapshot()), runId: 'another-run' }), state);
    assert.equal(reduceRunEvent(state, event(4, 'status', { status: 'running' })), state);
    assert.equal(reduceRunEvent(state, event(5, 'completed', { output: 'False replacement' })), state);
  }
});

test('terminal GET reconciliation updates fresh usage but cannot regress actual totals or settle unknown by omission', () => {
  let state = reduceRunEvent(initialRun('run-1'), event(1, 'cancelled', { reason: 'User cancelled' }));
  state = reconcileRun(state, { status: 'cancelled', usage: snapshot({ auxiliaryInputTokens: 10, reservedInputTokens: 30, auxiliaryUsageKnown: false }) });
  assert.equal(state.usage.reservedInputTokens, 30);
  state = reconcileRun(state, { status: 'cancelled', usage: snapshot({ inputTokens: 120, totalTokens: 130, auxiliaryInputTokens: 30, reservedInputTokens: 0, auxiliaryUsageKnown: true }) });
  assert.equal(state.status, 'cancelled');
  assert.equal(state.error, 'User cancelled');
  assert.equal(state.usage.totalTokens, 130);
  const settled = state.usage;
  state = reconcileRun(state, { status: 'running', usage: snapshot({ auxiliaryInputTokens: 10, reservedInputTokens: 30, auxiliaryUsageKnown: false }) });
  assert.equal(state.status, 'cancelled');
  assert.deepEqual(state.usage, settled);
  state = reconcileRun(state, { status: 'cancelled', usage: { totalTokens: 130 } });
  assert.equal(state.usage.auxiliaryUsageKnown, true);
  assert.equal(state.usage.reservedInputTokens, 0);
});

test('missing or malformed token fields stay unknown, explicit zeros stay zeros, and private fields are discarded', () => {
  assert.equal(mergeRunUsage(null, null), null);
  assert.equal(mergeRunUsage(null, { inputTokens: -1, outputTokens: '0', totalTokens: Infinity, reservedInputTokens: NaN }), null);
  const unknown = mergeRunUsage(null, { costUsd: null, auxiliaryUsageKnown: false, ticketIds: ['PRIVATE_TICKET_SENTINEL'], reasoning: 'PRIVATE_TRACE_SENTINEL' });
  assert.equal(Object.hasOwn(unknown, 'inputTokens'), false);
  assert.equal(Object.hasOwn(unknown, 'reservedInputTokens'), false);
  assert.equal(unknown.costUsd, null);
  assert.equal(JSON.stringify(unknown).includes('PRIVATE_'), false);
  const zero = mergeRunUsage(unknown, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, auxiliaryInputTokens: 0, reservedInputTokens: 0, auxiliaryUsageKnown: true });
  assert.equal(zero.reservedInputTokens, 0);
  assert.equal(zero.auxiliaryInputTokens, 0);
  assert.equal(zero.auxiliaryUsageKnown, true);
  const held = mergeRunUsage(null, snapshot({ reservedInputTokens: 15, auxiliaryUsageKnown: false }));
  assert.equal(mergeRunUsage(held, snapshot()).reservedInputTokens, 15, 'Omission is not a release.');
  assert.equal(mergeRunUsage({ costUsd: 0.25 }, { costUsd: 0.1 }).costUsd, 0.25);
});

test('terminal replay merges late provider accounting and a stale GET using reads only', async () => {
  const methods = [];
  const result = await pollAgentRun('run-1', { intervalMs: 0, fetchImpl: async (url, options) => {
    methods.push(options.method || 'GET');
    const value = url.includes('/events') ? { events: [
      event(1, 'usage', snapshot({ reservedInputTokens: 40, auxiliaryUsageKnown: false })),
      event(2, 'cancelled', { reason: 'Cancelled during auxiliary request' }),
      event(3, 'auxiliary_usage', snapshot({ inputTokens: 125, totalTokens: 135, auxiliaryInputTokens: 25, reservedInputTokens: 0, auxiliaryUsageKnown: true }))
    ] } : { id: 'run-1', status: 'cancelled', usage: snapshot({ reservedInputTokens: 40, auxiliaryUsageKnown: false }) };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.sequence, 3);
  assert.equal(result.usage.totalTokens, 135);
  assert.equal(result.usage.reservedInputTokens, 0);
  assert.equal(result.usage.auxiliaryUsageKnown, true);
  assert.ok(methods.every(method => method === 'GET'));
});

test('a reservation released in the final event drain cannot be resurrected by the earlier terminal GET', async () => {
  let eventReads = 0;
  const result = await pollAgentRun('run-1', { intervalMs: 0, fetchImpl: async url => {
    const value = url.includes('/events') ? { events: ++eventReads === 1
      ? [event(1, 'usage', snapshot({ auxiliaryInputTokens: 0, reservedInputTokens: 40, auxiliaryUsageKnown: false }))]
      : [event(2, 'cancelled', { reason: 'User cancelled' }), event(3, 'auxiliary_usage', snapshot({ auxiliaryInputTokens: 0, reservedInputTokens: 0, auxiliaryUsageKnown: true }))] }
      : { id: 'run-1', status: 'cancelled', usage: snapshot({ auxiliaryInputTokens: 0, reservedInputTokens: 40, auxiliaryUsageKnown: false }) };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.sequence, 3);
  assert.equal(result.usage.totalTokens, 110);
  assert.equal(result.usage.reservedInputTokens, 0);
  assert.equal(result.usage.auxiliaryUsageKnown, true);
});

test('auxiliary output is monotonic and both output/input holds can settle after terminal status without double counting', () => {
  let state = reduceRunEvent(initialRun('run-1'), event(1, 'cancelled', { reason: 'Cancelled helper wait' }));
  state = reduceRunEvent(state, event(2, 'auxiliary_usage', snapshot({ auxiliaryInputTokens: 0, auxiliaryOutputTokens: 0,
    reservedInputTokens: 50, reservedOutputTokens: 40, auxiliaryUsageKnown: false })));
  assert.equal(state.usage.totalTokens, 110);
  state = reduceRunEvent(state, event(3, 'auxiliary_usage', snapshot({ inputTokens: 125, outputTokens: 25, totalTokens: 150,
    auxiliaryInputTokens: 25, auxiliaryOutputTokens: 15, reservedInputTokens: 0, reservedOutputTokens: 0, auxiliaryUsageKnown: true })));
  assert.equal(state.status, 'cancelled');
  assert.equal(state.usage.auxiliaryOutputTokens, 15);
  assert.equal(state.usage.totalTokens, 150);
  assert.equal(state.usage.reservedOutputTokens, 0);
  const stale = reconcileRun(state, { status: 'cancelled', usage: snapshot({ auxiliaryOutputTokens: 0, reservedOutputTokens: 40, auxiliaryUsageKnown: false }) });
  assert.equal(stale.usage.outputTokens, 25);
  assert.equal(stale.usage.auxiliaryOutputTokens, 15);
  assert.equal(stale.usage.reservedOutputTokens, 0);
  assert.equal(mergeRunUsage(state.usage, { reservedOutputTokens: 20 }).reservedOutputTokens, 20);
  assert.equal(mergeRunUsage(state.usage, {}).reservedOutputTokens, 0);
});

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/App.jsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: import.meta.resolve(args.path), external: true })); } }]
});
const { RunUsageDetails } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('actual usage SSR shows auxiliary input as a subset and unknown holds separately from actual totals', () => {
  const usage = snapshot({ auxiliaryInputTokens: 25, reservedInputTokens: 50, auxiliaryUsageKnown: false, ticketId: 'PRIVATE_TICKET_SENTINEL', reasoning: 'PRIVATE_TRACE_SENTINEL' });
  const markup = renderToStaticMarkup(React.createElement(RunUsageDetails, { usage }));
  assert.match(markup, /110 total/);
  assert.match(markup, /25 tokens · already included in actual input/);
  assert.match(markup, /50 tokens/);
  assert.match(markup, /Unknown or pending/);
  assert.match(markup, /not added to actual totals/);
  assert.doesNotMatch(markup, /160 total|PRIVATE_/);
});

test('actual usage SSR distinguishes explicit zero accounting from unreported amounts', () => {
  const unknown = renderToStaticMarkup(React.createElement(RunUsageDetails, { usage: { auxiliaryUsageKnown: false, costUsd: null } }));
  assert.match(unknown, /no amount can be inferred/);
  assert.match(unknown, /Reported cost: Unknown/);
  assert.doesNotMatch(unknown, /0 tokens|\$0\.000000/);
  const zero = renderToStaticMarkup(React.createElement(RunUsageDetails, { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, auxiliaryInputTokens: 0, reservedInputTokens: 0, auxiliaryUsageKnown: true } }));
  assert.match(zero, /0 tokens/);
  assert.match(zero, /Known in this snapshot/);
  const missing = renderToStaticMarkup(React.createElement(RunUsageDetails, { usage: null }));
  assert.match(missing, /has not been reported/);
});

test('actual usage SSR labels auxiliary output and output holds separately from actual output/total', () => {
  const usage = snapshot({ outputTokens: 25, totalTokens: 125, auxiliaryOutputTokens: 15, reservedOutputTokens: 40, auxiliaryUsageKnown: false });
  const markup = renderToStaticMarkup(React.createElement(RunUsageDetails, { usage }));
  assert.match(markup, /25 output · 125 total/);
  assert.match(markup, /Settled auxiliary output: 15 tokens · already included in actual output/);
  assert.match(markup, /output hold: 40 tokens/);
  assert.doesNotMatch(markup, /165 total/);
  const unknown = renderToStaticMarkup(React.createElement(RunUsageDetails, { usage: snapshot({ auxiliaryUsageKnown: false }) }));
  assert.match(unknown, /Settled auxiliary output: Not reported/);
  assert.match(unknown, /output hold: Not reported; no amount can be inferred/);
});
