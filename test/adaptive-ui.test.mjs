import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdaptiveImageMode } from '../src/adaptive-ui.mjs';
import { buildAgentRequest, recordedRunSettings, serializeRetainedAgentRequest } from '../src/protocol.mjs';

const text = Object.freeze({ name: 'gpt-oss:20b', provider: 'ollama', local: true, tools: true, vision: false });
const direct = Object.freeze({ name: 'local-vision', provider: 'ollama', local: true, vision: true });
const cloud = Object.freeze({ name: 'explicit-cloud', provider: 'openai', cloud: true, local: false, vision: true });
const helper = Object.freeze({ configured: true, model: 'gemma3:latest' });
const ocr = Object.freeze({ available: true, engine: 'windows-media-ocr', imageMode: 'local-ocr', languages: Object.freeze(['en-US']) });
const caps = overrides => ({ models: [text, direct, cloud], cloudEnabled: true, cloud: { enabled: true, maxRunCostUsd: 1 }, localVision: helper, localOcr: ocr, ...overrides });
const route = overrides => resolveAdaptiveImageMode({ preference: 'automatic', model: text, capabilities: caps(), imageCount: 1, ...overrides });
const image = { assetId: 'owned-image', mimeType: 'image/png', name: 'synthetic.png' };
const request = overrides => buildAgentRequest({ requestId: 'unsent-1', conversationId: 'conversation-1', goal: 'Inspect the attached image', model: text, attachments: [image], capabilities: caps(), ...overrides });

test('Automatic uses current direct vision first without selecting either available helper', () => {
  assert.equal(route({ model: direct }).imageMode, 'direct');
  const byCapability = { ...text, vision: false, capabilities: ['tools', 'vision'] };
  assert.equal(route({ model: byCapability, capabilities: caps({ models: [byCapability] }) }).imageMode, 'direct');
});

test('Automatic keeps the selected local primary and chooses configured vision before OCR', () => {
  const selected = route();
  assert.equal(selected.imageMode, 'local-tool');
  assert.ok(selected.reason.includes('local vision helper'));
  const built = request({ imageMode: selected.imageMode });
  assert.equal(built.model, text.name);
  assert.equal(built.provider, 'ollama');
  assert.equal(built.budget.maxCostUsd, 0);
  assert.equal(Object.hasOwn(built, 'allowCloud'), false);
  assert.equal(Object.hasOwn(built, 'helperModel'), false);
  assert.equal(Object.hasOwn(built, 'helperBudget'), false);
});

test('Automatic falls back to the exact English OCR capability schema only', () => {
  const selected = route({ capabilities: caps({ localVision: null }) });
  assert.equal(selected.imageMode, 'local-ocr');
  assert.match(selected.reason, /verify/);
  for (const bad of [null, {}, { ...ocr, available: false }, { ...ocr, engine: 'other' }, { ...ocr, imageMode: 'direct' }, { ...ocr, languages: ['fr-FR'] }]) {
    assert.throws(() => route({ capabilities: caps({ localVision: null, localOcr: bad }) }), /no local image helper/);
  }
});

test('wrong or unconfigured vision helper does not count as configured', () => {
  for (const bad of [null, {}, { ...helper, configured: false }, { ...helper, model: 'unreviewed-vision' }]) {
    assert.equal(route({ capabilities: caps({ localVision: bad }) }).imageMode, 'local-ocr');
  }
});

test('Automatic does not silently change a text cloud selection to any local helper or enable cloud', () => {
  const cloudText = { ...cloud, vision: false };
  assert.throws(() => route({ model: cloudText, capabilities: caps({ models: [cloudText] }) }), /explicitly choose a local Ollama model/);
  const selected = route({ model: cloud });
  assert.equal(selected.imageMode, 'direct');
  assert.deepEqual(Object.keys(selected).sort(), ['imageMode', 'reason']);
  assert.throws(() => request({ model: cloud, imageMode: selected.imageMode }), /explicit opt-in/);
  assert.equal(request({ model: cloud, imageMode: selected.imageMode, cloudOptIn: true, maxCostUsd: 0.2 }).model, cloud.name);
});

test('current allowed identity and server vision metadata govern new automatic routing', () => {
  const stale = { ...text, vision: true };
  assert.equal(route({ model: stale }).imageMode, 'local-tool', 'A stale caller vision flag is not current advertisement.');
  for (const current of [{ ...text, allowed: false }, { ...text, available: false }, { ...text, configured: false }]) {
    assert.throws(() => route({ capabilities: caps({ models: [current] }) }), /no longer available/);
  }
  assert.throws(() => route({ capabilities: caps({ models: [{ ...text, provider: 'other' }] }) }), /no longer available/);
  assert.throws(() => route({ capabilities: null }), /Refresh the Agent connection/);
});

test('both selected and current metadata must be local before choosing either local helper', () => {
  for (const changed of [{ ...text, local: false }, { ...text, cloud: true }, { ...text, isCloud: true }]) {
    assert.throws(() => route({ model: changed }), /does not advertise vision/);
    assert.throws(() => route({ capabilities: caps({ models: [changed] }) }), /does not advertise vision/);
  }
  const alias = { ...text, name: 'renamed:cloud' };
  assert.throws(() => route({ model: alias, capabilities: caps({ models: [alias] }) }), /does not advertise vision/);
});

test('manual OCR/helper/direct choices are never replaced by a preferred automatic route', () => {
  assert.equal(route({ preference: 'local-ocr', model: direct }).imageMode, 'local-ocr');
  assert.equal(route({ preference: 'local-tool', model: direct }).imageMode, 'local-tool');
  assert.equal(route({ preference: 'direct', model: direct }).imageMode, 'direct');
  assert.throws(() => route({ preference: 'direct' }), /Direct image handling requires/);
  assert.throws(() => route({ preference: 'local-tool', capabilities: caps({ localVision: null }) }), /not configured/);
  assert.throws(() => route({ preference: 'local-ocr', capabilities: caps({ localOcr: null }) }), /OCR is unavailable/);
  assert.throws(() => route({ preference: 'local-tool', model: cloud }), /local Ollama/);
});

test('zero attached images does not introduce a helper or model requirement, while explicit modes remain explicit', () => {
  assert.equal(resolveAdaptiveImageMode().imageMode, 'direct');
  assert.equal(route({ imageCount: 0, model: undefined, capabilities: null }).imageMode, 'direct');
  assert.equal(route({ imageCount: 0, preference: 'local-ocr' }).imageMode, 'local-ocr');
  for (const imageCount of [-1, 0.5, NaN, Infinity, '1']) assert.throws(() => route({ imageCount }), /image count is invalid/);
  for (const preference of [null, false, 'auto', 'cloud-helper']) assert.throws(() => route({ preference }), /Choose Automatic/);
});

test('routing is pure and request construction retains existing attachment and reasoning identity bounds', () => {
  const input = Object.freeze({ preference: 'automatic', model: text, capabilities: Object.freeze(caps({ models: Object.freeze([text]) })), imageCount: 1 });
  const before = JSON.stringify(input), previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('No routing network calls'); };
  try {
    const selected = resolveAdaptiveImageMode(input);
    assert.equal(Object.isFrozen(selected), true);
    assert.equal(JSON.stringify(input), before);
    assert.equal(calls, 0);
    assert.throws(() => request({ imageMode: selected.imageMode, attachments: Array.from({ length: 5 }, () => image) }), /at most 4/);
    assert.throws(() => request({ imageMode: selected.imageMode, runOptions: { thinkingChoice: 'false', thinkingModelKey: 'ollama::other' } }), /belongs to another model/);
  } finally { globalThis.fetch = previousFetch; }
});

test('retained requests preserve recorded actual routing even when fresh Automatic would now choose another route', () => {
  const retained = { request: request({ imageMode: 'local-ocr' }) };
  const original = serializeRetainedAgentRequest(retained);
  assert.equal(route().imageMode, 'local-tool');
  assert.equal(route({ model: direct }).imageMode, 'direct');
  assert.equal(serializeRetainedAgentRequest(retained), original);
  assert.equal(recordedRunSettings(retained.request).imageMode, 'local-ocr');
  assert.equal(JSON.parse(original).imageMode, 'local-ocr');
});
