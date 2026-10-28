import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { TASK_REQUEST_KEY, buildTaskMutation, taskPreviewFromResponse } from '../src/tasks.mjs';

// Render the entire real companion tree, including TasksPanel and DesktopAccess.
// No browser services, DOM automation, new dependencies or requests are needed.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/App.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }]
});
const { default: App } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function renderStartup(pending = null) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousFetch = globalThis.fetch;
  const effects = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === TASK_REQUEST_KEY && pending ? JSON.stringify(pending) : null,
    setItem: () => effects.push('storage write'), removeItem: () => effects.push('storage removal')
  } });
  globalThis.fetch = () => { effects.push('request'); throw new Error('Initial render must not contact services.'); };
  try {
    const markup = renderToStaticMarkup(React.createElement(App));
    assert.deepEqual(effects, [], 'Initial/recovery rendering must not submit or retry a schedule, run, grant or model call.');
    return markup;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
}

test('actual App starts with scheduled tasks in a separate hidden page without submitting requests', () => {
  const markup = renderStartup();
  assert.match(markup, /<section class="workspace-page" hidden="" aria-label="Tasks">/);
  assert.match(markup, /<details class="scheduled-tasks standalone" open=""><summary>Scheduled tasks<\/summary>/);
  assert.match(markup, /Task records have not been read/);
  assert.match(markup, /No task is created until you preview it and explicitly save/);
  assert.match(markup, /Attach up to 4 files, 4 MiB each/);
  assert.match(markup, /<textarea aria-label="Separate task goal"[^>]*><\/textarea>/);
  assert.match(markup, /aria-label="Task title" maxLength="120"/);
  assert.match(markup, /aria-label="Separate task goal" rows="3" maxLength="20000"/);
  assert.doesNotMatch(markup, /aria-label="Unresolved scheduled task request"/);
});

test('actual App renders an unresolved restored task write without a task object or auto-recreation', () => {
  const models = [{ name: 'local-test', provider: 'ollama' }];
  const preview = taskPreviewFromResponse({ spec: { title: 'Retained task', goal: 'AUTHORED_TASK_GOAL', model: 'local-test',
    schedule: { kind: 'once', at: '2030-01-01T12:00:00Z' }, budget: { maxTotalTokens: 24000, maxCostUsd: 0 }, limits: { maxRuns: 1, maxTotalTokens: 72000 } },
    firstRunAt: 1893499200000, nextRuns: [1893499200000], localOnly: true, requiresAppRunning: true }, models);
  const pending = buildTaskMutation({ operation: 'create', requestId: 'retained-request-1', preview });
  const markup = renderStartup(pending);
  assert.match(markup, /aria-label="Unresolved scheduled task request"/);
  assert.match(markup, /retained-request-1/);
  assert.match(markup, /Read request status/);
  assert.match(markup, /Cancel unresolved request/);
  assert.match(markup, /Nothing was resubmitted/);
  assert.match(markup, /<fieldset disabled="">/);
  assert.doesNotMatch(markup, /aria-label="Stored scheduled task"/);
});
