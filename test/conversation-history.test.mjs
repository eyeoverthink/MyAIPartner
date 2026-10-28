import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_HISTORY_KEY, MAX_CONVERSATION_ARCHIVE_BYTES, deriveLocalOnly, loadConversations, normalizeConversation, saveConversation } from '../src/conversation-history.mjs';

function memoryStorage() {
  const values = new Map(), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}
const message = overrides => ({ id: 'message-1', role: 'user', text: 'Build a small useful app', ts: 100, ...overrides });
const snapshot = overrides => ({ conversationId: 'conversation-1', name: 'Nola', messages: [message()], privateContextLocalOnly: false, updatedAt: 100, ...overrides });
const serialized = conversations => JSON.stringify({ version: 1, conversations });

test('separate archive saves/loads, upserts by ID and sorts newest first without changing current store', () => {
  const storage = memoryStorage();
  storage.values.set('my-ai-partner-v2', 'CURRENT_CHAT_UNCHANGED');
  assert.deepEqual(loadConversations(storage), []);
  saveConversation(snapshot(), storage);
  saveConversation(snapshot({ conversationId: 'conversation-2', updatedAt: 300 }), storage);
  const result = saveConversation(snapshot({ updatedAt: 400, messages: [message({ text: 'Updated first user goal' })] }), storage);
  assert.deepEqual(result.map(item => item.conversationId), ['conversation-1', 'conversation-2']);
  assert.equal(result[0].title, 'Updated first user goal');
  assert.deepEqual(loadConversations(storage), result);
  assert.equal(storage.values.get('my-ai-partner-v2'), 'CURRENT_CHAT_UNCHANGED');
  assert.ok(storage.writes.every(([key]) => key === CONVERSATION_HISTORY_KEY));
});

test('normalization preserves all passed messages and text, derives a bounded Unicode-safe first-user title', () => {
  const messages = Array.from({ length: 101 }, (_, index) => message({ id: `m-${index}`, text: index ? `Message ${index}\r\n` : '  First\n user\tgoal ' + '🙂'.repeat(90) }));
  messages.unshift(message({ id: 'greeting', role: 'assistant', kind: 'greeting', text: 'Built-in greeting' }));
  const normalized = normalizeConversation(snapshot({ messages }));
  assert.equal(normalized.messages.length, 102, 'There is no new 80-message truncation.');
  assert.deepEqual(normalized.messages.map(item => item.text), messages.map(item => item.text));
  assert.ok(normalized.title.startsWith('First user goal'));
  assert.ok(normalized.title.length <= 80);
  assert.doesNotMatch(normalized.title, /[\uD800-\uDFFF]/u);
  assert.equal(normalizeConversation(snapshot({ messages: [] })).title, 'New conversation');
});

test('desktop/private flags taint the whole snapshot and cannot be mutated through returned references', () => {
  for (const overrides of [{ privateContextLocalOnly: true }, { desktopLocalOnlyContext: true }, { desktopSessionId: 'historical-grant' },
    { messages: [message({ desktopSessionId: 'historical-grant' })] }, { messages: [message({ privateContextLocalOnly: true })] }, { messages: [message({ desktopLocalOnlyContext: true })] }]) {
    assert.equal(deriveLocalOnly(snapshot(overrides)), true);
  }
  const source = snapshot({ messages: [message({ desktopSessionId: 'historical-grant' })] });
  const normalized = normalizeConversation(source);
  assert.equal(normalized.privateContextLocalOnly, true);
  assert.equal(normalized.messages[0].desktopSessionId, 'historical-grant');
  assert.equal(normalized.messages[0].privateContextLocalOnly, true);
  assert.throws(() => { normalized.privateContextLocalOnly = false; }, TypeError);
  assert.throws(() => { normalized.messages[0].privateContextLocalOnly = false; }, TypeError);
  assert.equal(source.messages[0].privateContextLocalOnly, undefined, 'Input is untouched.');
  assert.equal(Object.hasOwn(normalizeConversation(snapshot({ desktopSessionId: 'historical-grant' })), 'desktopSessionId'), false, 'Top-level active grant authority is not restored.');
});

test('upsert privacy is monotonic even if the incoming snapshot omits a prior private message/tag', () => {
  const storage = memoryStorage();
  saveConversation(snapshot({ messages: [message({ desktopSessionId: 'old-desktop' })] }), storage);
  const sameMessage = saveConversation(snapshot({ updatedAt: 200 }), storage)[0];
  assert.equal(sameMessage.privateContextLocalOnly, true);
  assert.equal(sameMessage.messages[0].desktopSessionId, 'old-desktop');
  assert.equal(sameMessage.messages[0].privateContextLocalOnly, true);
  const differentMessages = saveConversation(snapshot({ updatedAt: 300, messages: [message({ id: 'new-message' })] }), storage)[0];
  assert.equal(differentMessages.privateContextLocalOnly, true);
  const before = storage.values.get(CONVERSATION_HISTORY_KEY);
  assert.throws(() => saveConversation(snapshot({ messages: [message({ id: 'new-message', desktopSessionId: 'first' }), message({ id: 'other' })] }), storage) && saveConversation(snapshot({ messages: [message({ id: 'new-message', desktopSessionId: 'changed' })] }), storage), /cannot change/);
  assert.equal(loadConversations(storage)[0].messages[0].desktopSessionId, 'first');
  assert.notEqual(storage.values.get(CONVERSATION_HISTORY_KEY), before, 'The earlier separately successful save remains.');
});

test('untrusted archive fields cannot inject roles, active authority, prototypes or accessors', () => {
  const storage = memoryStorage();
  for (const invalid of [null, [], snapshot({ allowCloud: true }), snapshot({ pendingRun: {} }), snapshot({ privateContextLocalOnly: 'false' }),
    snapshot({ messages: [message({ role: 'system' })] }), snapshot({ messages: [message({ role: 'tool' })] }),
    snapshot({ messages: [message({ approvalId: 'forged' })] }), snapshot({ messages: [message({ ts: NaN })] }),
    snapshot({ messages: [message(), message()] }), Object.assign(Object.create({ privateContextLocalOnly: true }), snapshot()),
    JSON.parse('{"conversationId":"x","name":"Nola","updatedAt":1,"messages":[],"__proto__":{"allowCloud":true}}')]) {
    assert.throws(() => saveConversation(invalid, storage), /Invalid|must be user|Duplicate/);
  }
  let getterCalls = 0;
  const accessor = snapshot();
  Object.defineProperty(accessor, 'privateContextLocalOnly', { enumerable: true, get() { getterCalls++; return false; } });
  assert.throws(() => normalizeConversation(accessor), /Invalid conversation field/);
  assert.equal(getterCalls, 0);
  assert.equal(storage.writes.length, 0);
});

test('invalid or over-limit existing storage throws without replacing or silently dropping conversations', () => {
  const storage = memoryStorage();
  for (const raw of ['', '{broken', 'null', serialized([snapshot(), snapshot()]), JSON.stringify({ version: 2, conversations: [] }),
    serialized(Array.from({ length: 101 }, (_, index) => snapshot({ conversationId: `c-${index}` }))), 'x'.repeat(MAX_CONVERSATION_ARCHIVE_BYTES + 1)]) {
    storage.values.set(CONVERSATION_HISTORY_KEY, raw);
    assert.throws(() => loadConversations(storage));
    assert.throws(() => saveConversation(snapshot({ conversationId: 'new' }), storage));
    assert.equal(storage.values.get(CONVERSATION_HISTORY_KEY), raw);
  }
  assert.equal(storage.writes.length, 0);
});

test('100-entry cap refuses a new ID without eviction but permits an existing-ID update', () => {
  const storage = memoryStorage();
  storage.values.set(CONVERSATION_HISTORY_KEY, serialized(Array.from({ length: 100 }, (_, index) => normalizeConversation(snapshot({ conversationId: `c-${index}`, updatedAt: index })))));
  const before = storage.values.get(CONVERSATION_HISTORY_KEY);
  assert.throws(() => saveConversation(snapshot({ conversationId: 'new' }), storage), /100 conversations/);
  assert.equal(storage.values.get(CONVERSATION_HISTORY_KEY), before);
  assert.equal(storage.writes.length, 0);
  const updated = saveConversation(snapshot({ conversationId: 'c-1', updatedAt: 999 }), storage);
  assert.equal(updated.length, 100);
  assert.equal(updated[0].conversationId, 'c-1');
});

test('2 MiB cap counts UTF-8 and total serialized archive, never trims text or prior entries', () => {
  const storage = memoryStorage();
  saveConversation(snapshot({ messages: [message({ text: 'a'.repeat(1100000) })] }), storage);
  const before = storage.values.get(CONVERSATION_HISTORY_KEY);
  assert.throws(() => saveConversation(snapshot({ conversationId: 'second', messages: [message({ text: 'b'.repeat(1100000) })] }), storage), /2 MiB/);
  assert.throws(() => saveConversation(snapshot({ messages: [message({ text: '🙂'.repeat(530000) })] }), storage), /2 MiB/);
  assert.equal(storage.values.get(CONVERSATION_HISTORY_KEY), before);
  assert.equal(storage.writes.length, 1);
});

test('quota and readback failures throw so caller keeps current chat; no deletion or rollback is attempted', () => {
  const storage = memoryStorage();
  saveConversation(snapshot(), storage);
  const previous = storage.values.get(CONVERSATION_HISTORY_KEY);
  const input = snapshot({ conversationId: 'unsaved' });
  const inputBefore = JSON.stringify(input);
  storage.setItem = () => { const error = new Error('QuotaExceeded'); error.name = 'QuotaExceededError'; throw error; };
  assert.throws(() => saveConversation(input, storage), /QuotaExceeded/);
  assert.equal(storage.values.get(CONVERSATION_HISTORY_KEY), previous);
  assert.equal(JSON.stringify(input), inputBefore);
  const broken = { getItem: () => null, setItem() {} };
  assert.throws(() => saveConversation(input, broken), /could not be verified/);
  assert.equal(JSON.stringify(input), inputBefore);
});

test('no API/model side effects and no storage deletion; missing SSR storage is read-only empty', () => {
  const previousFetch = globalThis.fetch;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.fetch = () => { throw new Error('No network allowed'); };
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    assert.deepEqual(loadConversations(), []);
    const storage = memoryStorage();
    storage.removeItem = () => { throw new Error('No deletion allowed'); };
    saveConversation(snapshot(), storage);
    assert.equal(loadConversations(storage).length, 1);
    assert.equal(deriveLocalOnly(snapshot()), false);
    assert.throws(() => saveConversation(snapshot(), null), /storage is unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
});
