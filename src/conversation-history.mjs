export const CONVERSATION_HISTORY_KEY = 'my-ai-partner-conversations-v1';
export const MAX_CONVERSATIONS = 100;
export const MAX_CONVERSATION_ARCHIVE_BYTES = 2 * 1024 * 1024;

const snapshotKeys = new Set(['conversationId', 'name', 'title', 'messages', 'privateContextLocalOnly', 'updatedAt', 'desktopLocalOnlyContext', 'desktopSessionId']);
const messageKeys = new Set(['id', 'role', 'text', 'ts', 'kind', 'desktopSessionId', 'privateContextLocalOnly', 'desktopLocalOnlyContext']);
const fail = message => { throw new Error(message); };
const byteLength = value => new TextEncoder().encode(value).byteLength;

function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail(`Invalid ${label}.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!keys.has(key) || !Object.hasOwn(descriptor, 'value')) fail(`Invalid ${label} field: ${key}.`);
  }
}

function list(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length
    || value.length > MAX_CONVERSATION_ARCHIVE_BYTES) fail(`Invalid ${label}.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) if (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)) fail(`Invalid ${label} field.`);
  for (let index = 0; index < value.length; index++) if (!descriptors[index] || !Object.hasOwn(descriptors[index], 'value')) fail(`Invalid ${label} item.`);
}

function string(value, label, maximum = MAX_CONVERSATION_ARCHIVE_BYTES, nonempty = false) {
  if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.trim()) || /[\uD800-\uDFFF]/u.test(value)) fail(`Invalid ${label}.`);
  return value;
}

function privacyFields(value, label) {
  for (const key of ['privateContextLocalOnly', 'desktopLocalOnlyContext']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') fail(`Invalid ${label} privacy flag.`);
  }
  if (Object.hasOwn(value, 'desktopSessionId')) string(value.desktopSessionId, `${label} desktop reference`, 256, true);
}

function localOnly(value) {
  return value.privateContextLocalOnly === true || value.desktopLocalOnlyContext === true || Boolean(value.desktopSessionId);
}

function normalizeMessage(message) {
  record(message, messageKeys, 'conversation message');
  string(message.id, 'message ID', 256, true);
  if (!['user', 'assistant'].includes(message.role)) fail('Conversation messages must be user or assistant display text.');
  string(message.text, 'message text');
  if (!Number.isSafeInteger(message.ts) || message.ts < 0) fail('Invalid message timestamp.');
  if (Object.hasOwn(message, 'kind') && !['greeting', 'demo', 'reply'].includes(message.kind)) fail('Invalid message kind.');
  privacyFields(message, 'message');
  return Object.freeze({ id: message.id, role: message.role, text: message.text, ts: message.ts,
    ...(Object.hasOwn(message, 'kind') ? { kind: message.kind } : {}),
    ...(Object.hasOwn(message, 'desktopSessionId') ? { desktopSessionId: message.desktopSessionId } : {}),
    ...(Object.hasOwn(message, 'desktopLocalOnlyContext') ? { desktopLocalOnlyContext: message.desktopLocalOnlyContext } : {}),
    ...(Object.hasOwn(message, 'privateContextLocalOnly') || localOnly(message) ? { privateContextLocalOnly: localOnly(message) } : {}) });
}

/** Validated display data only: no provider, run, grant or approval authority. */
export function normalizeConversation(snapshot) {
  record(snapshot, snapshotKeys, 'conversation');
  string(snapshot.conversationId, 'conversation ID', 256, true);
  string(snapshot.name, 'conversation partner name', 256, true);
  if (!Number.isSafeInteger(snapshot.updatedAt) || snapshot.updatedAt < 0) fail('Invalid conversation timestamp.');
  privacyFields(snapshot, 'conversation');
  if (Object.hasOwn(snapshot, 'title')) string(snapshot.title, 'stored conversation title', 80);
  list(snapshot.messages, 'conversation messages');
  const ids = new Set();
  const messages = snapshot.messages.map(message => {
    const normalized = normalizeMessage(message);
    if (ids.has(normalized.id)) fail('Duplicate conversation message ID.');
    ids.add(normalized.id);
    return normalized;
  });
  const firstUser = messages.find(message => message.role === 'user');
  const title = firstUser ? firstUser.text.trim().replace(/\s+/gu, ' ').slice(0, 80).replace(/[\uD800-\uDBFF]$/, '') || 'New conversation' : 'New conversation';
  const normalized = Object.freeze({ conversationId: snapshot.conversationId, name: snapshot.name, title,
    messages: Object.freeze(messages), privateContextLocalOnly: localOnly(snapshot) || messages.some(localOnly), updatedAt: snapshot.updatedAt });
  if (byteLength(JSON.stringify(normalized)) > MAX_CONVERSATION_ARCHIVE_BYTES) fail('Conversation history exceeds the 2 MiB limit. Nothing was saved; keep this chat open.');
  return normalized;
}

export function deriveLocalOnly(snapshot) {
  return normalizeConversation(snapshot).privateContextLocalOnly;
}

function newestFirst(conversations) {
  return conversations.sort((a, b) => b.updatedAt - a.updatedAt || (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0));
}

/** Corrupt/nonempty archives throw so callers cannot silently overwrite history. */
export function loadConversations(storage = globalThis.localStorage) {
  if (storage === undefined) return Object.freeze([]); // Server-side rendering has no browser storage.
  if (!storage || typeof storage.getItem !== 'function') fail('Conversation history storage is unavailable.');
  const raw = storage.getItem(CONVERSATION_HISTORY_KEY);
  if (raw === null) return Object.freeze([]);
  if (typeof raw !== 'string' || byteLength(raw) > MAX_CONVERSATION_ARCHIVE_BYTES) fail('Conversation history is invalid or exceeds the 2 MiB limit. It was not changed.');
  let envelope;
  try { envelope = JSON.parse(raw); } catch { fail('Conversation history contains invalid JSON. It was not changed.'); }
  record(envelope, new Set(['version', 'conversations']), 'history archive');
  if (envelope.version !== 1) fail('Unsupported conversation history version. It was not changed.');
  list(envelope.conversations, 'history conversations');
  if (envelope.conversations.length > MAX_CONVERSATIONS) fail('Conversation history exceeds the 100-conversation limit. It was not changed.');
  const ids = new Set();
  const conversations = envelope.conversations.map(item => {
    const conversation = normalizeConversation(item);
    if (ids.has(conversation.conversationId)) fail('Duplicate archived conversation ID. History was not changed.');
    ids.add(conversation.conversationId);
    return conversation;
  });
  return Object.freeze(newestFirst(conversations));
}

/** Archive before clearing/restoring UI state; any failure must leave that UI open. */
export function saveConversation(snapshot, storage = globalThis.localStorage) {
  if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') fail('Conversation history storage is unavailable. Keep this chat open.');
  let normalized = normalizeConversation(snapshot);
  const previous = loadConversations(storage);
  const existing = previous.find(item => item.conversationId === normalized.conversationId);
  if (existing) {
    const oldMessages = new Map(existing.messages.map(message => [message.id, message]));
    const messages = normalized.messages.map(message => {
      const old = oldMessages.get(message.id);
      if (!old) return message;
      if (old.desktopSessionId && message.desktopSessionId && old.desktopSessionId !== message.desktopSessionId) fail('An archived message desktop reference cannot change. History was not changed.');
      return { ...message, ...(old.desktopSessionId ? { desktopSessionId: old.desktopSessionId } : {}),
        ...((localOnly(old) || localOnly(message)) ? { privateContextLocalOnly: true } : {}) };
    });
    normalized = normalizeConversation({ ...normalized, messages,
      privateContextLocalOnly: existing.privateContextLocalOnly || normalized.privateContextLocalOnly });
  }
  const conversations = newestFirst([normalized, ...previous.filter(item => item.conversationId !== normalized.conversationId)]);
  if (conversations.length > MAX_CONVERSATIONS) fail('Conversation history already contains 100 conversations. Nothing was saved; keep this chat open.');
  const serialized = JSON.stringify({ version: 1, conversations });
  if (byteLength(serialized) > MAX_CONVERSATION_ARCHIVE_BYTES) fail('Conversation history exceeds the 2 MiB limit. Nothing was saved; keep this chat open.');
  storage.setItem(CONVERSATION_HISTORY_KEY, serialized);
  if (storage.getItem(CONVERSATION_HISTORY_KEY) !== serialized) fail('Conversation history save could not be verified. Keep this chat open.');
  return Object.freeze(conversations);
}
