import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { buildAgentRequest, directChatHistory, loadPendingRun, localVisionConfigured, PENDING_RUN_KEY, pollAgentRun,
  recordedRunSettings, resolveImageMode, savePendingRun, serializeRetainedAgentRequest, validateRunAttachments } from '../src/protocol.mjs';

const primary = { name: 'gpt-oss:20b', provider: 'ollama', local: true, tools: true, vision: false, thinking: { values: ['low', 'high'] } };
const directVision = { name: 'local-vision', provider: 'ollama', local: true, vision: true };
const cloud = { name: 'cloud-vision', provider: 'openai', cloud: true, local: false, vision: true, allowed: true };
const capabilities = { models: [primary, directVision, cloud], cloudEnabled: true, cloud: { enabled: true, maxRunCostUsd: 0.5 }, localVision: { configured: true, model: 'gemma3:latest' } };
const image = { assetId: 'uploaded-image-1', mimeType: 'image/png', name: 'selected.png', size: 512 };
const base = () => ({ requestId: 'image-request-1', conversationId: 'image-conversation-1', goal: 'Describe the selected image color', model: primary, attachments: [image], capabilities });

test('Direct remains the default and a text primary cannot silently route images to a helper', () => {
  assert.throws(() => buildAgentRequest(base()), /does not advertise vision/);
  assert.throws(() => buildAgentRequest({ ...base(), imageMode: 'direct' }), /does not advertise vision/);
  const direct = buildAgentRequest({ ...base(), model: directVision });
  assert.equal(Object.hasOwn(direct, 'imageMode'), false);
  assert.deepEqual(direct.attachments, ['uploaded-image-1']);
  assert.deepEqual(direct.budget, { maxInputTokens: 16384, maxCostUsd: 0 });
  assert.deepEqual(buildAgentRequest({ ...base(), model: directVision, imageMode: 'direct' }), direct);
});

test('explicit configured local-tool mode accepts images without changing primary vision metadata or sending a helper override', () => {
  const request = buildAgentRequest({ ...base(), imageMode: 'local-tool', runOptions: { thinkingChoice: '"low"', thinkingModelKey: 'ollama::gpt-oss:20b' } });
  assert.equal(request.imageMode, 'local-tool');
  assert.equal(request.provider, 'ollama');
  assert.equal(request.model, 'gpt-oss:20b');
  assert.equal(request.thinking, 'low', 'This remains the primary reasoning request, not a helper override.');
  assert.equal(primary.vision, false);
  assert.deepEqual(request.attachments, ['uploaded-image-1']);
  assert.equal(request.budget.maxCostUsd, 0);
  assert.equal(Object.hasOwn(request, 'allowCloud'), false);
  assert.equal(JSON.stringify(request).includes('gemma3'), false);
  assert.equal(Object.hasOwn(request, 'helperModel'), false);
  assert.deepEqual(validateRunAttachments([image], primary, undefined, { imageMode: 'local-tool', capabilities }), ['uploaded-image-1']);
});

test('explicit available local OCR accepts a text primary while preserving exact pending identity and local-only history',()=>{
  const caps={...capabilities,localOcr:{available:true,engine:'windows-media-ocr',imageMode:'local-ocr',languages:['en-US']}};
  const request=buildAgentRequest({...base(),capabilities:caps,imageMode:'local-ocr'});
  assert.equal(request.imageMode,'local-ocr');assert.equal(request.provider,'ollama');assert.equal(request.allowCloud,undefined);
  assert.deepEqual(request.attachments,[image.assetId]);assert.equal(request.budget.maxCostUsd,0);
  assert.equal(serializeRetainedAgentRequest({request}),JSON.stringify(request));
  assert.equal(recordedRunSettings(request).imageMode,'local-ocr');
  assert.throws(()=>buildAgentRequest({...base(),imageMode:'local-ocr'}),/OCR is unavailable/);
  assert.throws(()=>buildAgentRequest({...base(),capabilities:caps,imageMode:'local-ocr',model:cloud,cloudOptIn:true}),/local Ollama/);
});

test('helper mode fails explicitly when server configuration is missing, wrong or disabled', () => {
  for (const localVision of [undefined, null, {}, { configured: false, model: 'gemma3:latest' }, { configured: true }, { configured: true, model: 'other-model' }]) {
    const caps = { ...capabilities, localVision };
    assert.equal(localVisionConfigured(caps), false);
    assert.throws(() => buildAgentRequest({ ...base(), capabilities: caps, imageMode: 'local-tool' }), /not configured/);
  }
  for (const imageMode of [null, false, 'automatic', 'cloud-helper']) assert.throws(() => buildAgentRequest({ ...base(), imageMode }), /explicit Local vision helper/);
});

test('local-tool mode cannot use a cloud primary, renamed cloud alias or stale nonlocal model metadata', () => {
  assert.throws(() => buildAgentRequest({ ...base(), model: cloud, imageMode: 'local-tool', cloudOptIn: true, maxCostUsd: 0.25 }), /Cloud providers are disabled/);
  assert.throws(() => resolveImageMode({ imageMode: 'local-tool', model: { ...primary, name: 'renamed:cloud' }, capabilities }), /Cloud providers are disabled/);
  assert.throws(() => buildAgentRequest({ ...base(), capabilities: { ...capabilities, models: [{ ...primary, local: false, cloud: true }] }, imageMode: 'local-tool' }), /Cloud providers are disabled/);
  const publicHistory = directChatHistory([{ role: 'assistant', text: 'PRIVATE_IMAGE_OBSERVATION', privateContextLocalOnly: true }, { role: 'user', text: 'Separate authored text' }]);
  assert.deepEqual(publicHistory, [{ role: 'user', content: 'Separate authored text' }]);
});

test('helper mode retains attachment bounds and modality defaults without adding an independent hidden budget', () => {
  const images = [1, 2, 3].map(index => ({ ...image, assetId: `uploaded-${index}` }));
  const request = buildAgentRequest({ ...base(), attachments: images, imageMode: 'local-tool' });
  assert.deepEqual(request.budget, { maxInputTokens: 32768, maxCostUsd: 0, maxTotalTokens: 64000 });
  assert.equal(Object.hasOwn(request, 'helperBudget'), false);
  assert.throws(() => buildAgentRequest({ ...base(), attachments: [...images, image, image], imageMode: 'local-tool' }), /at most 4/);
});

test('saved request recovery preserves original helper mode even when current mode/configuration differs', () => {
  const request = buildAgentRequest({ ...base(), imageMode: 'local-tool' });
  const values = new Map(), storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  savePendingRun({ request, conversationId: request.conversationId }, storage);
  assert.throws(() => buildAgentRequest({ ...base(), imageMode: 'local-tool', capabilities: { ...capabilities, localVision: null } }), /not configured/);
  const restored = loadPendingRun(storage);
  assert.equal(serializeRetainedAgentRequest(restored), JSON.stringify(request));
  assert.equal(restored.request.imageMode, 'local-tool');
  assert.equal(recordedRunSettings({ budget: request.budget, imageMode: request.imageMode }).imageMode, 'local-tool');
  assert.equal(recordedRunSettings({ budget: request.budget }).imageMode, 'direct');
});

test('terminal replay preserves recorded imageMode from the GET record, not current controls or event output', async () => {
  const methods = [];
  const result = await pollAgentRun('image-run-1', { fetchImpl: async (url, options) => {
    methods.push(options.method || 'GET');
    const value = url.includes('/events') ? { events: [{ runId: 'image-run-1', sequence: 1, type: 'completed', data: { output: 'Untrusted observations', imageMode: 'direct' } }] }
      : { id: 'image-run-1', status: 'completed', imageMode: 'local-tool', privateContextLocalOnly: true, budget: { maxInputTokens: 16384, maxTotalTokens: 64000 } };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(result.recordedSettings.imageMode, 'local-tool');
  assert.equal(result.privateContextLocalOnly, true);
  assert.ok(methods.every(method => method === 'GET'));
});

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/App.jsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) { builder.onResolve({ filter: /^react$/ }, () => ({ path: import.meta.resolve('react'), external: true })); } }]
});
const { default: App, ImageHandlingControl, RecordedRunSettings } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('actual image handling SSR defaults to Direct and exposes configuration/caveats without capturing or loading images', () => {
  const direct = renderToStaticMarkup(React.createElement(ImageHandlingControl, { capabilities, model: primary }));
  assert.match(direct, /<option value="direct" selected="">Direct vision model/);
  assert.match(direct, /Uploading an image stores it locally; it does not start vision inspection/);
  const helper = renderToStaticMarkup(React.createElement(ImageHandlingControl, { imageMode: 'local-tool', capabilities, model: primary }));
  assert.match(helper, /Local vision helper \(Gemma3\)/);
  assert.match(helper, /may misread details or exact text/);
  assert.match(helper, /Verify important values against the original image/);
  assert.match(helper, /When available, local Gemma3/);
  assert.match(helper, /No screenshot capture is performed/);
  assert.match(helper, /Input and output both count/);
  assert.match(helper, /Cloud providers are disabled for this conversation/);
  assert.doesNotMatch(helper, /cross-inference|desktop-vision verification|Configuration does not establish/);
  assert.doesNotMatch(helper, /<(img|iframe|video|audio)\b/);
  const unavailable = renderToStaticMarkup(React.createElement(ImageHandlingControl, { capabilities: null, model: primary, imageMode: 'local-tool' }));
  assert.match(unavailable, /not configured/);
  assert.match(unavailable, /<option value="local-tool" disabled="" selected=""/);
  const history = renderToStaticMarkup(React.createElement(RecordedRunSettings, { settings: recordedRunSettings({ imageMode: 'local-tool', budget: { maxInputTokens: 16384 } }) }));
  assert.match(history, /Local vision helper \(local-tool\)/);
  assert.match(history, /does not prove that any image was inspected/);
});

test('actual local OCR control exposes availability and accuracy limits without inspecting files or claiming vision',()=>{
  const caps={...capabilities,localOcr:{available:true,engine:'windows-media-ocr',imageMode:'local-ocr',languages:['en-US']}};
  const text=renderToStaticMarkup(React.createElement(ImageHandlingControl,{capabilities:caps,model:primary,imageMode:'local-ocr'}));
  assert.match(text,/<option value="local-ocr" selected=""/);assert.match(text,/OCR can misread numbers/);
  assert.match(text,/No helper model runs/);assert.match(text,/does not interpret diagrams or capture the desktop/);
  assert.doesNotMatch(text,/<(img|iframe|video|audio)\b/);
});

test('actual App SSR defaults image mode independently of saved preferences and retains unresolved mode without requests', () => {
  const request = buildAgentRequest({ ...base(), imageMode: 'local-tool' });
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), previousFetch = globalThis.fetch;
  let pending = null;
  const calls = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => key === PENDING_RUN_KEY && pending ? JSON.stringify(pending)
    : key === 'my-ai-partner-v2' ? JSON.stringify({ mode: 'agent', imageMode: 'local-tool' }) : null, setItem: () => calls.push('write'), removeItem: () => calls.push('remove') } });
  globalThis.fetch = () => { calls.push('request'); throw new Error('No SSR inference/upload/recovery request is allowed.'); };
  try {
    const fresh = renderToStaticMarkup(React.createElement(App));
    assert.ok(fresh.includes('<option value="direct" selected="">Direct vision model'));
    pending = { request, conversationId: request.conversationId };
    const restored = renderToStaticMarkup(React.createElement(App));
    assert.ok(restored.includes('&quot;imageMode&quot;: &quot;local-tool&quot;'));
    assert.ok(restored.includes('aria-label="Image handling" disabled=""'));
    assert.ok(restored.includes('<option value="direct" selected="">Direct vision model'));
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = previousFetch; if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage; }
});
