import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRequest, modelIdentity, selectDefaultModel, describeModel } from '../src/protocol.mjs';

const local = { name: 'same-name', provider: 'ollama', local: true, vision: true };
const cloud = { name: 'same-name', provider: 'openai', cloud: true, local: false, allowed: true, vision: true,
  rates: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
const caps = { cloudEnabled: true, cloud: { enabled: true, maxRunCostUsd: 0.5 }, models: [local, cloud] };
const base = { requestId: 'request-1', conversationId: 'conversation-1', goal: 'A concrete goal', capabilities: caps };

test('provider and name form distinct selection keys even for colliding model names', () => {
  assert.notEqual(modelIdentity(local), modelIdentity(cloud));
  assert.equal(modelIdentity({ name: 'old-local' }), 'ollama::old-local');
});

test('default model prefers the server-tested local model while preserving a valid user selection', () => {
  const small = { name: 'small', provider: 'ollama', size: 1000, tools: true };
  const tested = { name: 'gpt-oss:20b', provider: 'ollama', size: 20000, tools: true };
  assert.equal(selectDefaultModel([small, tested], '', { provider: 'ollama', name: tested.name }), modelIdentity(tested));
  assert.equal(selectDefaultModel([small, tested], modelIdentity(small), tested), modelIdentity(small));
});

test('fallback chooses the smallest allowed local tool model and puts unknown sizes last', () => {
  const models = [
    { name: 'unknown', tools: true },
    { name: 'tiny-chat', size: 10, tools: false },
    { name: 'large-tools', size: 1000, tools: true },
    { name: 'small-tools', size: 100, capabilities: ['completion', 'tools'] },
    { name: 'blocked', size: 1, tools: true, allowed: false },
    cloud
  ];
  assert.equal(selectDefaultModel(models, 'missing'), 'ollama::small-tools');
  assert.equal(selectDefaultModel([cloud], '', cloud), '');
});

test('model option labels expose actual size and advertised tool/chat capability', () => {
  assert.match(describeModel({ name: 'tool-model', size: 2500000000, tools: true }), /2.5 GB · tools \+ chat/);
  assert.match(describeModel({ name: 'chat-model', tools: false }), /size unknown · chat/);
});

test('local request has explicit provider, zero cost and bounded 16k context without cloud authorization', () => {
  const request = buildAgentRequest({ ...base, model: local, cloudOptIn: true, maxCostUsd: 0.4 });
  assert.equal(request.provider, 'ollama');
  assert.equal(request.model, local.name);
  assert.equal(request.budget.maxCostUsd, 0);
  assert.equal(request.budget.maxInputTokens, 16384);
  assert.equal(Object.hasOwn(request, 'allowCloud'), false);
});

test('three images receive the requested 32k input allowance and uploaded IDs only', () => {
  const attachments = [1, 2, 3].map(id => ({ assetId: `image-${id}`, mimeType: 'image/png' }));
  const request = buildAgentRequest({ ...base, model: local, attachments });
  assert.equal(request.budget.maxInputTokens, 32768);
  assert.equal(request.budget.maxTotalTokens, 64000);
  assert.deepEqual(request.attachments, ['image-1', 'image-2', 'image-3']);
});

test('cloud request requires explicit opt-in and an entered positive server-bounded cost', () => {
  assert.throws(() => buildAgentRequest({ ...base, model: cloud, maxCostUsd: 0.2 }), /explicit opt-in/);
  for (const maxCostUsd of ['', 0, -1, NaN, Infinity, 0.51]) {
    assert.throws(() => buildAgentRequest({ ...base, model: cloud, cloudOptIn: true, maxCostUsd }), /positive cloud run budget/);
  }
  const request = buildAgentRequest({ ...base, model: cloud, cloudOptIn: true, maxCostUsd: '0.25' });
  assert.equal(request.provider, 'openai');
  assert.equal(request.allowCloud, true);
  assert.equal(request.budget.maxCostUsd, 0.25);
  assert.equal(request.requestId, base.requestId);
});

test('disabled, unlisted and unbudgeted cloud configurations cannot produce a cloud request', () => {
  assert.throws(() => buildAgentRequest({ ...base, capabilities: { models: [cloud] }, model: cloud, cloudOptIn: true, maxCostUsd: 0.2 }), /server-configured/);
  assert.throws(() => buildAgentRequest({ ...base, capabilities: { ...caps, models: [local] }, model: cloud, cloudOptIn: true, maxCostUsd: 0.2 }), /server-configured/);
  assert.throws(() => buildAgentRequest({ ...base, capabilities: { ...caps, cloud: { enabled: true } }, model: cloud, cloudOptIn: true, maxCostUsd: 0.2 }), /spending ceiling/);
});
