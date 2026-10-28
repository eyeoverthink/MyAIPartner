import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceAdapter } from '../src/voice.mjs';

test('generic bridge health never invents Dessa or cloned voice support', async () => {
  const adapter = createVoiceAdapter({ fetchImpl: async () => new Response('{"ok":true}') });
  const { label } = await adapter.probe();
  assert.equal(label, 'Browser speech synthesis');
  assert.doesNotMatch(label, /dessa|clon/i);
});

test('voice labels reflect explicitly advertised TTS and cloning capabilities', async () => {
  const adapter = createVoiceAdapter({ fetchImpl: async () => new Response(JSON.stringify({
    ok: true, capabilities: { tts: { available: true, engine: 'local-test-engine' }, stt: false, voice_cloning: false }
  })) });
  const { label } = await adapter.probe();
  assert.equal(label, 'Bridge TTS: local-test-engine');
});

test('browser microphone recognition cannot start without opt-in', () => {
  let error;
  const adapter = createVoiceAdapter();
  adapter.listen({ allowed: false, onError: message => { error = message; } });
  assert.match(error, /Enable browser speech recognition/);
});
