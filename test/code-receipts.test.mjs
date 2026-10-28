import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { codeExecutionReceipt, codeHealthInvalidationKey, refreshCodeHealth, shouldRefreshCodeHealth } from '../src/code-receipts.mjs';
import { initialRun, pollAgentRun, reconcileRun, reduceRunEvent } from '../src/protocol.mjs';

const event = (sequence, type, data = {}) => ({ runId: 'code-run', sequence, type, data });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const defaultProof = () => ({ isolation: 'docker-linux', network: false, hostMounts: false, image: `sha256:${'a'.repeat(64)}`,
  programOk: true, limits: { timeoutMs: 1000, maxOutputBytes: 32768, memoryBytes: 268435456, pids: 64 } });
const receipt = extra => {
  const { programOk, ...recorded } = extra || {};
  return { kind: 'code_execution', effectId: 'code-effect-1', engine: 'docker', complete: true,
  outcome: 'finished', dispatchAttempted: true, codeMayHaveRun: true, isolationVerified: true,
  language: 'javascript', termination: 'exit', exitCode: 0,
  cleanup: { confirmed: true, removed: true, verifiedAbsent: true, name: 'generated-owned-container' },
  proof: { ...defaultProof(), ...(Object.hasOwn(extra || {}, 'programOk') ? { programOk } : {}) }, ...recorded };
};
const run = (audit, status = 'running') => ({ ...initialRun('code-run'), status, codeReceipts: [audit] });

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/CodeExecutionReceipt.jsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react$/ }, () => ({ path: import.meta.resolve('react'), external: true })); } }]
});
const { default: CodeExecutionReceipt } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('finished independent audit does not infer a successful code result from cleanup or source completion', () => {
  const normal = codeExecutionReceipt(receipt());
  assert.equal(normal.successfulExit, true);
  assert.equal(normal.cleanupConfirmed, true);
  assert.equal(normal.isolationVerified, true);
  assert.equal(normal.label, 'Code exited · status 0');
  for (const extra of [
    { exitCode: 7, programOk: false }, { exitCode: undefined, programOk: undefined }, { termination: 'timeout', programOk: false, exitCode: null },
    { termination: 'cancelled', programOk: false, exitCode: null }, { termination: 'output_limit', programOk: false, exitCode: null }
  ]) {
    const value = codeExecutionReceipt(receipt(extra));
    assert.equal(value.finished, true);
    assert.equal(value.successfulExit, false, JSON.stringify(extra));
    assert.equal(value.cleanupConfirmed, true, 'Confirmed cleanup is independent of the code result.');
  }
  assert.equal(codeExecutionReceipt(receipt({ programOk: undefined })).reportedOk, null);
  assert.match(codeExecutionReceipt(receipt({ termination: 'timeout', programOk: false })).label, /timed out/);
  assert.match(codeExecutionReceipt(receipt({ termination: 'cancelled', programOk: false })).label, /cancelled/);
});

test('no-start and unknown dispatch states stay distinct and require complete compatible facts', () => {
  const notStarted = receipt({ outcome: 'not_started', dispatchAttempted: false, codeMayHaveRun: false, isolationVerified: false, termination: 'not_started', exitCode: undefined, programOk: false });
  assert.equal(codeExecutionReceipt(notStarted).notStarted, true);
  assert.equal(codeExecutionReceipt(notStarted).label, 'Code did not start');
  assert.equal(codeExecutionReceipt(notStarted).uncertain, false);
  assert.equal(codeExecutionReceipt({ ...notStarted, dispatchAttempted: true }).notStarted, true, 'Attempted engine intent does not imply that source was run.');
  for (const change of [{ complete: undefined }, { complete: false }, { codeMayHaveRun: true }, { dispatchAttempted: undefined }, { cleanup: { confirmed: false } }]) {
    const value = codeExecutionReceipt({ ...notStarted, ...change });
    assert.equal(value.notStarted, false, JSON.stringify(change));
    assert.equal(value.uncertain, true);
    assert.match(value.label, /unconfirmed/);
  }
  const unknown = codeExecutionReceipt(receipt({ outcome: 'unknown', codeMayHaveRun: true, cleanup: { confirmed: false } }));
  assert.equal(unknown.finished, false);
  assert.equal(unknown.successfulExit, false);
  assert.equal(unknown.cleanupConfirmed, false);
  assert.equal(unknown.codeMayHaveRun, true);
});

test('only the settled known Docker contract can confirm isolation/cleanup; omitted values remain unknown', () => {
  for (const change of [
    { complete: undefined }, { complete: false }, { engine: 'appcontainer' }, { engine: 'Docker' }, { engine: 'host' },
    { proof: { ...defaultProof(), isolation: 'none' } }, { proof: { ...defaultProof(), network: true } }, { proof: { ...defaultProof(), hostMounts: true } }
  ]) {
    const value = codeExecutionReceipt(receipt(change));
    assert.equal(value.isolationVerified, false, JSON.stringify(change));
    assert.equal(value.cleanupConfirmed, false);
    assert.equal(value.finished, false);
    assert.equal(value.uncertain, true);
  }
  for (const cleanup of [undefined, {}, { confirmed: false }, { confirmed: 'true' }, { confirmed: true, removed: false }, { confirmed: true, verifiedAbsent: false }]) {
    const value = codeExecutionReceipt(receipt({ cleanup }));
    assert.equal(value.cleanupConfirmed, false, JSON.stringify(cleanup));
    assert.equal(value.uncertain, true);
  }
  assert.equal(codeExecutionReceipt(receipt({ cleanup: { confirmed: true } })).cleanupConfirmed, true, 'Optional Docker removal facts are not invented or required by this receipt contract.');
  assert.equal(codeExecutionReceipt(receipt({ dispatchAttempted: undefined })).dispatchAttempted, null);
  assert.equal(codeExecutionReceipt(receipt({ isolationVerified: undefined })).isolationVerified, false);
  assert.equal(codeExecutionReceipt(null), null);
  assert.equal(codeExecutionReceipt(receipt({ effectId: 'invalid\u202Eid' })), null);
});

test('receipt normalization bounds plain facts and never imports extra proof/current-health authority', () => {
  const normalized = codeExecutionReceipt(receipt({ language: '<script>', termination: 'exit\u202E',
    proof: { limits: { timeoutMs: -1, maxOutputBytes: '32768', pids: Infinity }, rawSource: 'RAW_SOURCE_SENTINEL', privateTicket: 'PRIVATE_TICKET_SENTINEL' } }));
  assert.equal(normalized.language, null);
  assert.equal(normalized.termination, null);
  assert.deepEqual(normalized.limits, {});
  assert.doesNotMatch(JSON.stringify(normalized), /RAW_SOURCE_SENTINEL|PRIVATE_TICKET_SENTINEL/);
  assert.equal(codeExecutionReceipt(receipt({ isolationVerified: false, execution: { mode: 'docker', available: true, sandboxed: true } })).isolationVerified, false,
    'A health snapshot cannot replace the independent per-call isolation observation.');
});

test('program result and resource facts come only from the exact independent receipt proof', () => {
  const value = codeExecutionReceipt(receipt({ programOk: false, ok: true, limits: { timeoutMs: 9999 },
    execution: { mode: 'host', sandboxed: true, limits: { timeoutMs: 9999 } } }));
  assert.equal(value.reportedOk, false, 'Explicit proof.programOk false is retained despite contradictory unsupported top-level fields.');
  assert.equal(value.successfulExit, false);
  assert.equal(value.limits.timeoutMs, 1000);
  assert.equal(value.network, false); assert.equal(value.hostMounts, false);
  assert.equal(value.image, `sha256:${'a'.repeat(64)}`);
  for (const proof of [undefined, {}, { programOk: 'true', limits: { timeoutMs: '1000' } }]) {
    const missing = codeExecutionReceipt(receipt({ proof, ok: true, limits: { timeoutMs: 9999 }, execution: { network: false, hostMounts: false } }));
    assert.equal(missing.reportedOk, null);
    assert.equal(missing.successfulExit, false, 'Zero exit/outcome never supplies missing programOk.');
    assert.deepEqual(missing.limits, {});
    assert.equal(missing.network, null); assert.equal(missing.hostMounts, null); assert.equal(missing.image, null);
  }
});

test('proof resource limits and immutable image identities are validated instead of coerced or inherited', () => {
  const invalid = codeExecutionReceipt(receipt({ proof: { ...defaultProof(), image: 'node:latest', limits: {
    timeoutMs: -1, maxOutputBytes: '32768', memoryBytes: 1e13, pids: 1.5, maxConcurrent: 0, cpus: Infinity
  } } }));
  assert.deepEqual(invalid.limits, {}); assert.equal(invalid.image, null);
  const audit = receipt({ proof: { ...defaultProof(), limits: { ...defaultProof().limits, cpus: 0.5, maxConcurrent: 1 } } });
  const value = codeExecutionReceipt(audit);
  assert.equal(value.limits.cpus, 0.5); assert.equal(value.limits.maxConcurrent, 1);
  const markup = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: audit }));
  assert.match(markup, /Recorded network \/ host mounts<\/dt><dd>Disabled \/ None/);
  assert.match(markup, /Recorded runtime image/); assert.ok(markup.includes(audit.proof.image));
  assert.match(markup, /CPU limit · cores<\/dt><dd>0.5/);
  assert.match(markup, /Time limit · ms<\/dt><dd>1,000/);
  assert.doesNotMatch(markup, /<(img|a|iframe|button)\b/i);
});

test('attempted engine intent and zero runtime exit do not mean source code ran before stdin delivery', () => {
  const audit = receipt({ outcome: 'not_started', dispatchAttempted: true, codeMayHaveRun: false, isolationVerified: false,
    termination: 'runtime_exited_before_stdin', exitCode: 0, programOk: false });
  const value = codeExecutionReceipt(audit);
  assert.equal(value.notStarted, true); assert.equal(value.finished, false); assert.equal(value.successfulExit, false);
  assert.equal(value.dispatchAttempted, true); assert.equal(value.codeMayHaveRun, false);
  assert.equal(value.cleanupConfirmed, true); assert.equal(value.uncertain, false);
  assert.equal(codeHealthInvalidationKey(run(audit)), '', 'A settled no-source execution is not mislabeled unknown cleanup.');
  const markup = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: audit }));
  assert.match(markup, /Code did not start/);
  assert.match(markup, /Execution intent \/ engine call attempted<\/dt><dd>Yes/);
  assert.match(markup, /Code may have run<\/dt><dd>No/);
  assert.match(markup, /does not prove that the source code was submitted or ran/);
  assert.match(markup, /No program execution recorded/);
  assert.match(markup, /runtime_exited_before_stdin \/ 0/);
  assert.doesNotMatch(markup, /Code exited · status 0|Reported success/);
});

test('late code receipt replaces its own effect after every terminal status without changing tools/output/approvals', () => {
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    let state = reduceRunEvent(initialRun('code-run'), event(1, 'tool_result', { name: 'code.run', callId: 'historical-call', result: { ok: false, error: 'original result' } }));
    state = reduceRunEvent(state, event(2, terminal, { output: 'Final output', error: 'Final error', reason: 'Stopped' }));
    const saved = { status: state.status, error: state.error, output: state.output, tools: state.tools, approvals: state.approvals };
    state = reduceRunEvent(state, event(3, 'code_receipt', { receipt: receipt({ outcome: 'unknown', cleanup: { confirmed: false } }) }));
    assert.equal(state.codeReceipts.length, 1);
    state = reduceRunEvent(state, event(4, 'code_receipt', { receipt: receipt() }));
    assert.equal(state.codeReceipts.length, 1);
    assert.equal(state.codeReceipts[0].cleanup.confirmed, true);
    assert.deepEqual({ status: state.status, error: state.error, output: state.output, tools: state.tools, approvals: state.approvals }, saved);
    assert.equal(reduceRunEvent(state, event(4, 'code_receipt', { receipt: receipt({ outcome: 'unknown' }) })), state);
    assert.equal(reduceRunEvent(state, { ...event(5, 'code_receipt', { receipt: receipt() }), runId: 'other-run' }), state);
    assert.equal(reduceRunEvent(state, event(5, 'tool_started', { name: 'code.run' })), state);
    assert.deepEqual(reconcileRun(state, { status: 'completed' }).codeReceipts, state.codeReceipts);
  }
});

test('complete unknown settlement invalidates code health during a running source and terminal replay deduplicates the same state', () => {
  const uncertain = receipt({ outcome: 'unknown', cleanup: { confirmed: false } });
  const activeKey = codeHealthInvalidationKey(run(uncertain));
  assert.ok(activeKey);
  assert.equal(codeHealthInvalidationKey(run(uncertain, 'cancelled')), activeKey, 'Source completion alone does not trigger a duplicate health read.');
  assert.equal(shouldRefreshCodeHealth('', activeKey), true);
  assert.equal(shouldRefreshCodeHealth(activeKey, activeKey), false);
  assert.equal(codeHealthInvalidationKey(run(receipt())), '');
  assert.equal(shouldRefreshCodeHealth(activeKey, ''), true, 'A later resolved audit can refresh stale unavailable health.');
  assert.equal(shouldRefreshCodeHealth('', ''), false);
});

test('incomplete audit does not refresh against a running executor; terminal uncertainty is never treated as no execution', () => {
  for (const complete of [undefined, false]) {
    const incomplete = receipt({ complete, outcome: 'unknown', cleanup: { confirmed: false } });
    assert.equal(codeHealthInvalidationKey(run(incomplete)), '');
    assert.ok(codeHealthInvalidationKey(run(incomplete, 'cancelled')));
  }
  const noStart = receipt({ outcome: 'not_started', dispatchAttempted: false, codeMayHaveRun: false, isolationVerified: false, termination: 'not_started', exitCode: null, programOk: false });
  assert.equal(codeHealthInvalidationKey(run(noStart)), '');
  assert.equal(codeHealthInvalidationKey(null), '');
});

test('health refresh clears cached readiness first and sends only a bounded GET with no mutation or code replay', async () => {
  const received = [], calls = [];
  const health = { mode: 'docker', available: false, sandboxed: false, reason: 'Cleanup unconfirmed; executor quarantined' };
  const result = await refreshCodeHealth({ onHealth: value => received.push(value), fetchImpl: async (url, options) => {
    assert.deepEqual(received, [null]); calls.push({ url, method: options.method || 'GET', body: options.body });
    return json({ codeExecution: health, models: [{ name: 'not-copied-into-controls' }] });
  } });
  assert.deepEqual(result, health);
  assert.deepEqual(received, [null, health]);
  assert.deepEqual(calls, [{ url: '/api/agent/capabilities', method: 'GET', body: undefined }]);
});

test('failed or aborted health reads leave readiness unconfirmed and never retry an action', async () => {
  const received = [], calls = [];
  await assert.rejects(refreshCodeHealth({ onHealth: value => received.push(value), fetchImpl: async (url, options) => {
    calls.push(options.method || 'GET'); return json({ error: 'Read unavailable' }, 401);
  } }), /Read unavailable/);
  assert.deepEqual(received, [null]); assert.deepEqual(calls, ['GET']);
  const controller = new AbortController(); controller.abort(new Error('Mode changed'));
  await assert.rejects(refreshCodeHealth({ signal: controller.signal, fetchImpl: async () => assert.fail('An aborted read must not fetch') }), /Mode changed/);
  await assert.rejects(refreshCodeHealth({ fetchImpl: async () => json({ models: [] }) }), /health snapshot/);
});

test('read-only terminal replay recovers late independent code evidence and keeps the separate tool-result audit', async () => {
  const methods = []; let reads = 0;
  const audit = receipt({ termination: 'cancelled', programOk: false, exitCode: null });
  const result = await pollAgentRun('code-run', { intervalMs: 0, fetchImpl: async (url, options) => {
    methods.push(options.method || 'GET');
    if (url.includes('/events')) return json({ events: ++reads === 1
      ? [event(1, 'tool_result', { name: 'code.run', callId: 'call-1', result: { truncated: true }, receipt: { engine: 'docker', sandboxed: true } })]
      : [event(2, 'cancelled', { reason: 'User cancelled' }), event(3, 'code_receipt', { receipt: audit })] });
    return json({ id: 'code-run', status: 'cancelled' });
  } });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.codeReceipts, [audit]);
  assert.equal(result.tools[0].receipt.sandboxed, true);
  assert.equal(result.output, '');
  assert.ok(methods.every(method => method === 'GET'));
});

test('actual audit SSR separates nonzero exit/timeout/cancellation, code result and confirmed cleanup', () => {
  for (const extra of [{ exitCode: 5, programOk: false }, { termination: 'timeout', programOk: false, exitCode: null }, { termination: 'cancelled', programOk: false, exitCode: null }]) {
    const markup = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: receipt(extra) }));
    assert.match(markup, /Independent code execution audit/);
    assert.match(markup, /Reported failure/);
    assert.match(markup, /Confirmed in settled audit/);
    assert.match(markup, /A finished execution does not imply a successful code result/);
    assert.doesNotMatch(markup, /Reported success/);
    assert.doesNotMatch(markup, /<(button|a|script|img|iframe)\b/i);
  }
  const timeout = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: receipt({ termination: 'timeout', programOk: false }) }));
  assert.match(timeout, /Code timed out/);
  const exited = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: receipt({ exitCode: 5, programOk: false }) }));
  assert.match(exited, /Code exited · status 5/);
  const absentResult = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: receipt({ programOk: undefined, errorCode: 'sandbox_launch_failed' }) }));
  assert.doesNotMatch(absentResult, /Reported success/);
  assert.match(absentResult, /sandbox_launch_failed/);
  assert.match(absentResult, /Reported code result<\/dt><dd>Not recorded/);
});

test('actual audit SSR keeps unknown cleanup, missing completion and unrecognized engines explicitly unconfirmed', () => {
  for (const audit of [receipt({ outcome: 'unknown', cleanup: { confirmed: false } }), receipt({ complete: undefined }), receipt({ engine: 'appcontainer' })]) {
    const markup = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: audit }));
    assert.match(markup, /Code outcome unknown or unconfirmed/);
    assert.match(markup, /Unconfirmed · do not infer the process or container is gone/);
    assert.match(markup, /Do not retry the code automatically/);
    if (audit.complete !== true || audit.engine !== 'docker') assert.doesNotMatch(markup, /Docker isolation verified in this audit/);
    else assert.match(markup, /Docker isolation verified in this audit/, 'Recorded isolation remains independent of unknown cleanup.');
    assert.doesNotMatch(markup, /Confirmed in settled audit/);
  }
  const untrusted = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: receipt({ termination: '<script>fake</script>', proof: '<img src=remote>' }) }));
  assert.match(untrusted, /&lt;script&gt;fake&lt;\/script&gt;/);
  assert.doesNotMatch(untrusted, /<(script|img|a|button|iframe)\b/i);
  const absent = renderToStaticMarkup(React.createElement(CodeExecutionReceipt, { receipt: null }));
  assert.match(absent, /Code outcome unconfirmed/);
});
