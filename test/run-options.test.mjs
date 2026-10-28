import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { advertisedThinking, CUSTOM_RUN_LIMITS, DEFAULT_THINKING_CHOICE, effectiveRunBudget, EXTENDED_RUN_BUDGET,
  resolveInteractiveRunOptions, resolveRunBudget, resolveThinkingChoice, thinkingOptions } from '../src/run-options.mjs';
import { buildAgentRequest, initialRun, loadPendingRun, modelIdentity, PENDING_RUN_KEY, pollAgentRun, reconcileRun, recordedRunSettings, reduceRunEvent, savePendingRun, serializeRetainedAgentRequest } from '../src/protocol.mjs';

const local = { name: 'local-reasoner', provider: 'ollama', local: true, tools: true, vision: true,
  thinking: { values: [false, true, 'false', 'low', 'high'], default: false } };
const cloud = { name: 'priced-cloud', provider: 'openai', cloud: true, local: false, allowed: true,
  thinking: { values: [true] }, rates: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
const capabilities = { models: [local, cloud], defaultBudget: { maxOutputTokens: 2048, maxTotalTokens: 24000, maxDurationMs: 180000 },
  cloudEnabled: true, cloud: { enabled: true, maxRunCostUsd: 0.5 } };
const base = () => ({ requestId: 'request-1', conversationId: 'conversation-1', goal: 'Authored interactive goal', model: local, capabilities });
const chosen = key => ({ thinkingChoice: key, thinkingModelKey: modelIdentity(local) });
const custom = () => ({ maxInputTokens: '24576', maxOutputTokens: '4096', maxTotalTokens: '50000', maxDurationMs: '120000' });
const desktop = () => ({ desktopSession: { sessionId: 'desktop-session-1', state: 'active', allowScreenshots: false, expiresAt: Date.now() + 600000 },
  desktopHealth: { configured: true, available: true, engine: 'windows-uia', isolation: 'none', localOnly: true, approvalRequired: true } });

test('default reasoning and limits add no wire overrides, even when the model advertises default false', () => {
  const previous = buildAgentRequest(base());
  const explicitDefault = buildAgentRequest({ ...base(), runOptions: { thinkingChoice: DEFAULT_THINKING_CHOICE, budgetMode: 'default' } });
  assert.deepEqual(explicitDefault, previous);
  assert.deepEqual(previous.budget, { maxInputTokens: 16384, maxCostUsd: 0 });
  assert.equal(Object.hasOwn(previous, 'thinking'), false);
  assert.equal(resolveThinkingChoice({ model: local, thinkingChoice: null }), undefined);
  assert.equal(resolveThinkingChoice({ model: local, thinkingChoice: undefined }), undefined);
});

test('JSON option keys preserve exact boolean false versus named false and never invent an advertised value', () => {
  const options = thinkingOptions(local);
  assert.deepEqual(options.map(option => option.key), ['false', 'true', '"false"', '"low"', '"high"']);
  const boolean = buildAgentRequest({ ...base(), runOptions: chosen('false') });
  assert.equal(Object.hasOwn(boolean, 'thinking'), true);
  assert.equal(boolean.thinking, false);
  assert.equal(JSON.parse(JSON.stringify(boolean)).thinking, false);
  const named = buildAgentRequest({ ...base(), runOptions: chosen('"false"') });
  assert.equal(named.thinking, 'false');
  assert.equal(typeof named.thinking, 'string');
  assert.throws(() => resolveThinkingChoice({ model: local, thinkingChoice: false }), /JSON-encoded/);
  assert.throws(() => resolveThinkingChoice({ model: local, thinkingChoice: '0' }), /no longer advertised/);
  assert.throws(() => resolveThinkingChoice({ model: local, thinkingChoice: ' false' }), /no longer advertised/);
});

test('malformed or unknown reasoning metadata exposes no explicit controls', () => {
  const malformed = [null, {}, { values: [] }, { values: [0] }, { values: [null] }, { values: [''] }, { values: ['x'.repeat(65)] },
    { values: ['\uD800'] }, { values: ['bad\nvalue'] }, { values: ['low\u202E'] }, { values: ['bad\u0085value'] }, { values: ['bad\u2028value'] }, { values: [false], default: true }, { values: Array(17).fill(false) },
    { values: Array.from({ length: 16 }, (_, index) => `${index}${'"'.repeat(62)}`) }];
  for (const thinking of malformed) {
    assert.equal(advertisedThinking({ ...local, thinking }), null, JSON.stringify(thinking));
    assert.deepEqual(thinkingOptions({ ...local, thinking }), []);
  }
  assert.equal(advertisedThinking(cloud), null);
  assert.deepEqual(thinkingOptions({ ...local, thinking: { values: [false, false, 'false'] } }).map(option => option.value), [false, 'false']);
  assert.equal(advertisedThinking({ ...local, thinking: { values: ['x'.repeat(64)] } }).values[0].length, 64);
  const visibleName = ' é 中 😀 ';
  assert.equal(resolveThinkingChoice({ model: { ...local, thinking: { values: [visibleName] } }, thinkingChoice: JSON.stringify(visibleName) }), visibleName);
});

test('model changes and fresh capability metadata block stale unsupported choices before request construction', () => {
  assert.throws(() => buildAgentRequest({ ...base(), runOptions: { ...chosen('false'), thinkingModelKey: 'ollama::another-model' } }), /another model/);
  const refreshed = { ...local, thinking: { values: ['low'], default: 'low' } };
  assert.throws(() => buildAgentRequest({ ...base(), capabilities: { ...capabilities, models: [refreshed] }, runOptions: chosen('false') }), /no longer advertised/);
  assert.throws(() => buildAgentRequest({ ...base(), capabilities: { ...capabilities, models: [] }, runOptions: chosen('false') }), /no longer advertised/);
  const reset = buildAgentRequest({ ...base(), capabilities: { ...capabilities, models: [refreshed] }, runOptions: { thinkingChoice: '', thinkingModelKey: 'ollama::old-model' } });
  assert.equal(Object.hasOwn(reset, 'thinking'), false);
});

test('cloud omits default reasoning and rejects explicit local thinking without weakening its USD ceiling', () => {
  const request = buildAgentRequest({ ...base(), model: cloud, cloudOptIn: true, maxCostUsd: '0.25', runOptions: { budgetMode: 'extended' } });
  assert.equal(Object.hasOwn(request, 'thinking'), false);
  assert.equal(request.provider, 'openai');
  assert.equal(request.allowCloud, true);
  assert.equal(request.budget.maxCostUsd, 0.25);
  assert.equal(request.budget.maxOutputTokens, 4096);
  assert.throws(() => buildAgentRequest({ ...base(), model: cloud, cloudOptIn: true, maxCostUsd: 0.25, runOptions: { thinkingChoice: 'true' } }), /local Ollama/);
  assert.throws(() => buildAgentRequest({ ...base(), model: cloud, cloudOptIn: true, maxCostUsd: 0.51, runOptions: { budgetMode: 'extended' } }), /positive cloud run budget/);
});

test('Extended explicitly raises input to 32k while Default preserves image/desktop allowances and Custom uses exact ceilings', () => {
  const ordinary = buildAgentRequest({ ...base(), runOptions: { budgetMode: 'extended' } });
  assert.deepEqual(ordinary.budget, { maxCostUsd: 0, ...EXTENDED_RUN_BUDGET });
  assert.equal(ordinary.budget.maxInputTokens, 32768);
  const images = [1, 2, 3].map(index => ({ assetId: `image-${index}`, mimeType: 'image/png' }));
  const imageDefault = buildAgentRequest({ ...base(), attachments: images });
  assert.deepEqual(imageDefault.budget, { maxInputTokens: 32768, maxCostUsd: 0, maxTotalTokens: 64000 });
  const imageExtended = buildAgentRequest({ ...base(), attachments: images, runOptions: { budgetMode: 'extended' } });
  assert.deepEqual(imageExtended.budget, { maxInputTokens: 32768, maxCostUsd: 0, ...EXTENDED_RUN_BUDGET });
  const desktopDefault = buildAgentRequest({ ...base(), ...desktop() });
  assert.deepEqual(desktopDefault.budget, { maxInputTokens: 32768, maxCostUsd: 0, maxDurationMs: 300000, maxTotalTokens: 64000 });
  const desktopCustom = buildAgentRequest({ ...base(), ...desktop(), runOptions: { budgetMode: 'custom', customBudget: custom() } });
  assert.deepEqual(desktopCustom.budget, { maxInputTokens: 24576, maxCostUsd: 0, maxDurationMs: 120000, maxTotalTokens: 50000, maxOutputTokens: 4096 });
  assert.equal(desktopCustom.desktopSessionId, 'desktop-session-1');
});

test('custom numeric ceilings enforce every advertised bound and reject coercion or additional authority', () => {
  for (const [key, [minimum, maximum]] of Object.entries(CUSTOM_RUN_LIMITS)) {
    for (const value of [minimum, maximum, String(minimum), String(maximum)]) {
      assert.equal(resolveRunBudget({ budgetMode: 'custom', customBudget: { ...custom(), [key]: value } })[key], Number(value));
    }
    for (const value of [minimum - 1, maximum + 1, 1.5, Infinity, NaN, false, null, undefined, '', ' ', '1e3', '0x100', '4096.0']) {
      assert.throws(() => resolveRunBudget({ budgetMode: 'custom', customBudget: { ...custom(), [key]: value } }), /must be an integer/);
    }
  }
  for (const key of ['maxToolCalls', 'maxCostUsd', 'allowCloud']) assert.throws(() => resolveRunBudget({ budgetMode: 'custom', customBudget: { ...custom(), [key]: 1 } }), /only per-round input/);
  assert.throws(() => resolveRunBudget({ budgetMode: 'unlimited' }), /Default, Extended or Custom/);
  assert.deepEqual(resolveRunBudget({ budgetMode: 'default', customBudget: { maxCostUsd: 999 } }), {});
});

test('effective labels use actual server defaults and explicit ceilings without guessing unknown defaults', () => {
  assert.deepEqual(effectiveRunBudget({ capabilities }), { maxInputTokens: 16384, maxOutputTokens: 2048, maxTotalTokens: 24000, maxDurationMs: 180000 });
  assert.deepEqual(effectiveRunBudget({}), { maxInputTokens: 16384, maxOutputTokens: null, maxTotalTokens: null, maxDurationMs: null });
  assert.deepEqual(effectiveRunBudget({ capabilities, desktop: true, budgetMode: 'custom', customBudget: custom() }), { maxInputTokens: 24576, maxOutputTokens: 4096, maxTotalTokens: 50000, maxDurationMs: 120000 });
  const first = resolveRunBudget({ budgetMode: 'extended' }); first.maxOutputTokens = 1;
  assert.equal(resolveRunBudget({ budgetMode: 'extended' }).maxOutputTokens, 4096);
});

test('reload recovery serializes the exact retained reasoning/budget even when current metadata and controls differ', () => {
  const options = { ...chosen('false'), budgetMode: 'custom', customBudget: custom() };
  const request = buildAgentRequest({ ...base(), runOptions: options });
  const originalBody = JSON.stringify(request);
  const entries = new Map(), storage = { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  savePendingRun({ request, conversationId: request.conversationId }, storage);
  options.thinkingChoice = '"high"'; options.customBudget.maxInputTokens = '32768'; options.customBudget.maxTotalTokens = '200000';
  const refreshedModel = { ...local, thinking: { values: ['low'] } };
  assert.throws(() => resolveInteractiveRunOptions({ model: refreshedModel, ...chosen('false') }), /no longer advertised/);
  const recovered = loadPendingRun(storage);
  assert.equal(serializeRetainedAgentRequest(recovered), originalBody);
  assert.equal(JSON.parse(serializeRetainedAgentRequest(recovered)).thinking, false);
  assert.equal(recovered.request.budget.maxTotalTokens, 50000);
  assert.equal(recovered.request.budget.maxInputTokens, 24576);
  assert.throws(() => serializeRetainedAgentRequest({ runId: 'run-1' }), /cannot be rebuilt/);
});

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/App.jsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: import.meta.resolve(args.path), external: true })); } }]
});
const { default: App, InteractiveRunOptions, RecordedRunSettings } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('actual controls SSR selects model default and shows only exact typed advertised reasoning options', () => {
  const initial = renderToStaticMarkup(React.createElement(InteractiveRunOptions, { model: local, capabilities }));
  assert.match(initial, /<option value="" selected="">Model default \(advertised false\)/);
  assert.match(initial, /<option value="false">false · boolean/);
  assert.match(initial, /<option value="&quot;false&quot;">&quot;false&quot; · named setting/);
  assert.match(initial, /cumulative output tokens \(includes thinking\)/);
  assert.match(initial, /input per round \(includes private continuation\)/);
  assert.match(initial, /model default reasoning/);
  assert.doesNotMatch(initial, /thinkingTrace|chainOfThought/);
  const explicit = renderToStaticMarkup(React.createElement(InteractiveRunOptions, { model: local, capabilities, thinkingChoice: 'false', thinkingModelKey: modelIdentity(local) }));
  assert.match(explicit, /<option value="false" selected="">false · boolean/);
  const cloudMarkup = renderToStaticMarkup(React.createElement(InteractiveRunOptions, { model: cloud, capabilities }));
  assert.match(cloudMarkup, /Cloud uses its provider default/);
  assert.doesNotMatch(cloudMarkup, /true · boolean/);
});

test('actual controls SSR handles stale metadata and incomplete custom fields without a crash or hidden fallback', () => {
  const stale = renderToStaticMarkup(React.createElement(InteractiveRunOptions, { model: { ...local, thinking: null }, thinkingChoice: 'false', thinkingModelKey: modelIdentity(local) }));
  assert.match(stale, /no longer advertised/);
  assert.match(stale, /Use model default/);
  assert.doesNotMatch(stale, /<option value="false"/);
  const invalidCustom = renderToStaticMarkup(React.createElement(InteractiveRunOptions, { model: local, budgetMode: 'custom', customBudget: null }));
  assert.match(invalidCustom, /No new request is sent/);
  const locked = renderToStaticMarkup(React.createElement(InteractiveRunOptions, { model: local, disabled: true, budgetMode: 'custom', customBudget: custom() }));
  assert.match(locked, /aria-label="Local model reasoning" disabled=""/);
  assert.match(locked, /aria-label="Interactive Agent limits" disabled=""/);
  assert.match(locked, /<fieldset disabled=""/);
  assert.match(locked, /aria-label="Per-round input-token ceiling including private continuation" type="number" min="1024" max="32768"/);
});

function renderApp(pending, saved = null) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), previousFetch = globalThis.fetch;
  const calls = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === PENDING_RUN_KEY && pending ? JSON.stringify(pending) : key === 'my-ai-partner-v2' && saved ? JSON.stringify(saved) : null,
    setItem: () => calls.push('write'), removeItem: () => calls.push('remove')
  } });
  globalThis.fetch = () => { calls.push('request'); throw new Error('SSR must not request providers or recover a run.'); };
  try { const markup = renderToStaticMarkup(React.createElement(App)); assert.deepEqual(calls, []); return markup; }
  finally { globalThis.fetch = previousFetch; if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage; }
}

test('actual App SSR ignores saved controls/trace fields and starts with Settings outside the chat workspace', () => {
  const markup = renderApp(null, { mode: 'agent', thinkingSelection: { key: 'RAW_TRACE_SENTINEL' }, budgetMode: 'extended', thinkingTrace: 'RAW_TRACE_SENTINEL' });
  assert.ok(markup.includes('<span>Settings</span></button>'));
  assert.ok(markup.includes('class="scheduled-tasks standalone"'), 'Agent mode retains its functional task controls.');
  assert.equal(markup.includes('RAW_TRACE_SENTINEL'), false);
  assert.match(markup, /<section class="workspace-page" hidden="" aria-label="Settings">/);
  assert.match(markup, /<details aria-label="New interactive Agent run options"/);
  const direct = renderApp(null, { mode: 'direct' });
  assert.equal(direct.includes('class="scheduled-tasks standalone"'), false);
  assert.equal(direct.includes('aria-label="New interactive Agent run options"'), false);
});

test('actual App SSR keeps restored request reasoning/limits visible without reopening Settings or resubmitting', () => {
  const request = buildAgentRequest({ ...base(), runOptions: { ...chosen('false'), budgetMode: 'extended' } });
  const markup = renderApp({ request, conversationId: request.conversationId });
  assert.match(markup, /Retained model and run options/);
  assert.match(markup, /&quot;thinking&quot;: false/);
  assert.match(markup, /&quot;maxOutputTokens&quot;: 4096/);
  assert.match(markup, /&quot;maxInputTokens&quot;: 32768/);
  assert.match(markup, /Unresolved request retained/);
  assert.match(markup, /<section class="workspace-page" hidden="" aria-label="Settings">/);
  assert.match(markup, /aria-label="Interactive Agent limits" disabled=""/);
  const freshLocked = renderToStaticMarkup(React.createElement(InteractiveRunOptions, { disabled: true, model: local, capabilities }));
  assert.match(freshLocked, /aria-label="Interactive Agent limits" disabled=""/);
  assert.match(freshLocked, /<option value="default" selected="">Default/);
});

const recordedBudget = () => ({ maxSteps: 8, maxToolCalls: 12, maxInputTokens: 32768, maxOutputTokens: 4096,
  maxTotalTokens: 64000, maxDurationMs: 300000, maxToolResultChars: 12000, maxOutputChars: 32000, maxCostUsd: 0 });

test('trusted run settings preserve typed false and full numeric budget without copying traces or current controls', () => {
  const record = { id: 'stored-run', status: 'running', thinking: false, budget: recordedBudget(), privateContinuation: 'RAW_TRACE_SENTINEL' };
  const live = reconcileRun(initialRun('stored-run'), record);
  assert.equal(live.recordedSettings.thinking, false);
  assert.equal(live.recordedSettings.thinkingMode, 'explicit');
  assert.deepEqual(live.recordedSettings.budget, record.budget);
  assert.equal(live.recordedSettings.budgetComplete, true);
  record.budget.maxInputTokens = 1024;
  assert.equal(live.recordedSettings.budget.maxInputTokens, 32768, 'Recorded facts are a snapshot, not a reference to current controls.');
  assert.equal(JSON.stringify(live.recordedSettings).includes('RAW_TRACE_SENTINEL'), false);
  const partial = reconcileRun(live, { status: 'running' });
  assert.equal(partial.recordedSettings.thinking, false, 'A partial status read does not relabel an earlier explicit false as default.');
  const invalid = recordedRunSettings({ thinking: 'RAW_TRACE_SENTINEL'.repeat(10), budget: { ...recordedBudget(), privateTrace: 'RAW_TRACE_SENTINEL' } });
  assert.equal(invalid.thinkingMode, 'unrecorded');
  assert.equal(Object.hasOwn(invalid, 'thinking'), false);
  assert.equal(invalid.budgetComplete, false);
  assert.equal(JSON.stringify(invalid).includes('RAW_TRACE_SENTINEL'), false);
});

test('terminal durable replay gets requested reasoning/budget from the run record rather than event text', async () => {
  const calls = [];
  const result = await pollAgentRun('stored-run', { intervalMs: 0, fetchImpl: async (url, options) => {
    calls.push(options.method || 'GET');
    const payload = url.includes('/events') ? { events: [{ runId: 'stored-run', sequence: 1, type: 'completed', data: {
      output: 'Stored reply', thinking: true, budget: { maxInputTokens: 1024 }, privateContinuation: 'RAW_TRACE_SENTINEL'
    } }] } : { id: 'stored-run', status: 'completed', thinking: false, budget: recordedBudget() };
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(result.status, 'completed');
  assert.equal(result.recordedSettings.thinking, false);
  assert.deepEqual(result.recordedSettings.budget, recordedBudget());
  assert.equal(JSON.stringify(result.recordedSettings).includes('RAW_TRACE_SENTINEL'), false);
  assert.ok(calls.every(method => method === 'GET'));
  const late = reduceRunEvent(result, { runId: 'stored-run', sequence: 2, type: 'workspace_receipt', data: { receipt: { kind: 'workspace_edit', effectId: 'effect-1', outcome: 'unknown' } } });
  assert.deepEqual(late.recordedSettings, result.recordedSettings);
  assert.equal(late.status, 'completed');
});

test('actual recorded-settings SSR distinguishes false, named false, omission and unread records', () => {
  const explicit = renderToStaticMarkup(React.createElement(RecordedRunSettings, { settings: recordedRunSettings({ thinking: false, budget: recordedBudget() }) }));
  assert.match(explicit, /Recorded run settings/);
  assert.match(explicit, /false \(boolean\)/);
  assert.match(explicit, /&quot;maxInputTokens&quot;: 32768/);
  assert.match(explicit, /&quot;maxOutputTokens&quot;: 4096/);
  assert.doesNotMatch(explicit, /Model default|RAW_TRACE_SENTINEL/);
  const named = renderToStaticMarkup(React.createElement(RecordedRunSettings, { settings: recordedRunSettings({ thinking: 'false', budget: recordedBudget() }) }));
  assert.match(named, /&quot;false&quot; \(string\)/);
  const omitted = renderToStaticMarkup(React.createElement(RecordedRunSettings, { settings: recordedRunSettings({ budget: recordedBudget() }) }));
  assert.match(omitted, /Model default/);
  const unread = renderToStaticMarkup(React.createElement(RecordedRunSettings, { settings: null }));
  assert.match(unread, /have not been read/);
  assert.doesNotMatch(unread, /Model default/);
});
