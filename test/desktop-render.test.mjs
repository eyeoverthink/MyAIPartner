import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { DESKTOP_GRANT_KEY } from '../src/desktop.mjs';

// Compile the actual JSX in memory with Vite's existing esbuild dependency.
// Keep React external so the component and server renderer share one hook runtime.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/DesktopAccess.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: import.meta.resolve('react'), external: true }));
  } }]
});
const { default: DesktopAccess } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function renderStartup(retainedRequest) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousFetch = globalThis.fetch;
  const effects = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === DESKTOP_GRANT_KEY && retainedRequest ? JSON.stringify(retainedRequest) : null,
    setItem: () => effects.push('storage write'), removeItem: () => effects.push('storage removal')
  } });
  globalThis.fetch = () => { effects.push('network request'); throw new Error('Initial render must not perform requests.'); };
  try {
    const markup = renderToStaticMarkup(React.createElement(DesktopAccess, {
      session: null, pendingSessionId: undefined, locked: false,
      model: { name: 'tested-local', provider: 'ollama', tools: true, vision: false },
      healthRefreshKey: '', onSessionChange: () => effects.push('grant change'),
      onHealthChange: () => effects.push('health change'), onControlState: () => effects.push('control change')
    }));
    assert.deepEqual(effects, [], 'Rendering must preserve grant state without requests or grant recreation.');
    return markup;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
}

test('actual desktop controls render on first load with no grant or grant check', () => {
  const markup = renderStartup(null);
  assert.match(markup, /Native desktop · health not verified/);
  assert.match(markup, /Select an allowlisted window explicitly before desktop work/);
  assert.match(markup, /<select aria-label="Allowed window"/);
  assert.doesNotMatch(markup, /Revoke desktop access|Selected session:|grant active/);
  assert.doesNotMatch(markup, /<img\b/);
});

test('actual desktop controls render recovery for a retained request without a session', () => {
  const markup = renderStartup({ requestId: 'grant-request-1', windowId: 'allowed-window-1', allowScreenshots: false });
  assert.match(markup, /Native desktop · health not verified/);
  assert.match(markup, /An existing grant request is retained/);
  assert.match(markup, /Read existing grant/);
  assert.match(markup, /Revoke desktop access/);
  assert.match(markup, /<select aria-label="Allowed window" disabled=""/);
  assert.doesNotMatch(markup, /Selected session:|grant active|<img\b/);
});
