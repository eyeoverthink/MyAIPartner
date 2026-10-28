import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/ResponseContent.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }]
});
const { default: ResponseContent, copyResponseCode, safeResponseHref } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const render = text => renderToStaticMarkup(React.createElement(ResponseContent, { text }));

test('actual response SSR renders CommonMark structure rather than flattening useful response formatting', () => {
  const html = render('# A useful answer\n\nTwo **important** words and *emphasis*.\n\n1. First\n2. Second\n   - Nested\n\n> A quotation\n\n---\n\nUse `inline()` here.');
  for (const content of ['<h1>A useful answer</h1>', '<strong>important</strong>', '<em>emphasis</em>', '<ol>', '<ul>', '<blockquote>', '<hr/>', '<code>inline()</code>']) assert.ok(html.includes(content), content);
  assert.equal(html.includes('style='), false, 'Message text cannot introduce inline styling.');
});

test('GFM tables, task lists, strike-through and footnotes retain readable semantic structure', () => {
  const html = render('| Name | State |\n| :--- | ---: |\n| Alpha | Ready |\n\n- [x] Complete\n- [ ] Pending\n\n~~Old~~ New. A note.[^1]\n\n[^1]: Supporting text.');
  assert.match(html, /role="region" aria-label="Response table" tabindex="0"><table>/);
  assert.match(html, /<th[^>]*>Name<\/th>/);
  assert.match(html, /<td[^>]*>Ready<\/td>/);
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /<del>Old<\/del>/);
  assert.match(html, /href="#user-content-fn-1"/);
  assert.match(html, /id="user-content-fnref-1"/);
  assert.match(html, /Supporting text\./);
});

test('fenced and indented code remain literal escaped text with selectable scroll regions and explicit Copy buttons', () => {
  const source = 'const label = "<script> & café 🧪";\n\tconsole.log(label);';
  const html = render('```javascript\n' + source + '\n```\n\n    indented <b>literal</b>\n');
  assert.match(html, /<pre tabindex="0" aria-label="javascript code"><code class="language-javascript">/);
  assert.match(html, /const label = &quot;&lt;script&gt; &amp; café 🧪&quot;;\n\tconsole.log\(label\);\n<\/code>/);
  assert.match(html, /indented &lt;b&gt;literal&lt;\/b&gt;/);
  assert.equal((html.match(/aria-label="Copy code"/g) || []).length, 2);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.equal(html.includes('<script>'), false);
});

test('raw HTML is skipped and never gains script, event-handler, media, form or style authority', () => {
  const html = render('Before\n\n<script>fetch("https://attacker.invalid")</script>\n\n<img src="https://attacker.invalid/pixel" onerror="alert(1)">\n\n<iframe src="https://attacker.invalid"></iframe>\n\n<style>body{display:none}</style>\n\n<form action="https://attacker.invalid"><input autofocus></form>\n\nAfter <b>plain</b> text.');
  assert.match(html, /Before/);
  assert.match(html, /After plain text/);
  assert.equal(/<(?:script|img|iframe|style|form|input|object|embed|video|audio)\b/i.test(html), false);
  assert.equal(/onerror|autofocus|attacker\.invalid|display:none/i.test(html), false);
});

test('response URL policy rejects executable, credentialed, relative and control-obfuscated destinations', () => {
  assert.equal(safeResponseHref('https://example.com/a?q=one#part'), 'https://example.com/a?q=one#part');
  assert.equal(safeResponseHref('http://example.com'), 'http://example.com/');
  for (const url of [null, {}, '', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<svg/onload=alert(1)>',
    'vbscript:msgbox(1)', 'file:///C:/private', 'blob:https://example.com/id', '//attacker.invalid', '/api/private', '../private',
    'https://user:password@example.com', 'https://user%40private@example.com', 'https://example.com\\@attacker.invalid',
    ' https://example.com', 'https://example.com/\nsecret', 'https://example.com/\u200Dhidden', 'https://example.com/\u0085hidden', 'https://example.com/\u2028hidden']) {
    assert.equal(safeResponseHref(url), null, String(url));
  }
  const html = render('[Safe](https://example.com) [Unsafe](javascript:alert%281%29) [Encoded](javascript&#x3A;alert%281%29) [Private](https://user:password@example.com) [Relative](/api/agent/runs)');
  assert.match(html, /href="https:\/\/example.com\/"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*referrerPolicy="no-referrer"/i);
  assert.equal((html.match(/<a /g) || []).length, 1);
  for (const label of ['Unsafe', 'Encoded', 'Private', 'Relative']) assert.ok(html.includes(label));
});

test('Markdown images are click-only references with alt text and never create automatic loads or preload hints', () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests += 1; throw new Error('Rendering must not fetch images.'); };
  try {
    const html = render('![An uploaded chart](https://example.com/chart.png "Chart")\n\n![Unavailable](data:image/png;base64,AAAA)\n\n![Private](https://owner:secret@example.com/pixel)');
    assert.match(html, /Image: An uploaded chart/);
    assert.match(html, /href="https:\/\/example.com\/chart.png"/);
    assert.match(html, />Open image link<\/a>/);
    assert.match(html, /Image link unavailable/);
    assert.match(html, /Not loaded automatically/);
    assert.equal(/<(?:img|source|link|iframe)\b|\bsrc(?:set)?=/i.test(html), false);
    assert.equal((html.match(/<a /g) || []).length, 1);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('long messages retain their beginning, end and long code without truncation or hidden automatic clipboard writes', () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let writes = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText() { writes += 1; } } } });
  try {
    const code = 'x'.repeat(24000);
    const html = render('BEGIN_SENTINEL\n\n' + 'A complete paragraph.\n\n'.repeat(1000) + '```text\n' + code + '\n```\n\nEND_SENTINEL');
    assert.ok(html.includes('BEGIN_SENTINEL'));
    assert.ok(html.includes('END_SENTINEL'));
    assert.ok(html.includes(code));
    assert.equal(writes, 0, 'Rendering never copies code; only the user click handler does.');
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});

test('linked images expose both destinations as separate controls rather than invalid nested links', () => {
  const html = render('[![A diagram](https://images.example/diagram.png)](https://example.com/context)');
  assert.match(html, /href="https:\/\/images.example\/diagram.png"[^>]*>Open image link<\/a>/);
  assert.match(html, /href="https:\/\/example.com\/context"[^>]*>Open linked destination<\/a>/);
  assert.equal(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/i.test(html), false);
  assert.equal(/<img\b|\bsrc=/i.test(html), false);
});

test('unfinished Markdown from a partial answer remains readable without losing code at the message end', () => {
  const html = render('Still working on **this\n\n```python\nprint("tail remains visible")');
  assert.match(html, /Still working on \*\*this/);
  assert.match(html, /print\(&quot;tail remains visible&quot;\)/);
  assert.match(html, /aria-label="Copy code"/);
});

test('copy helper writes the complete literal once and reports success only after the clipboard promise resolves', async () => {
  const text = '<unsafe-looking>\n\tUnicode café 🧪\n';
  const calls = [];
  let resolve;
  const clipboard = { writeText(value) { assert.equal(this, clipboard); calls.push(value); return new Promise(done => { resolve = done; }); } };
  let settled = false;
  const pending = copyResponseCode(text, clipboard).then(value => { settled = true; return value; });
  assert.deepEqual(calls, [text]);
  assert.equal(settled, false);
  resolve();
  assert.deepEqual(await pending, { ok: true, message: 'Code copied.' });
});

test('clipboard denial and unavailable APIs give actionable failure without leaking provider error details or claiming success', async () => {
  const denied = await copyResponseCode('retained literal', { async writeText() { throw new Error('PRIVATE_DEVICE_DETAIL'); } });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /Could not copy.*manually/);
  assert.equal(denied.message.includes('PRIVATE_DEVICE_DETAIL'), false);
  for (const clipboard of [null, {}, { writeText: false }]) {
    const result = await copyResponseCode('retained literal', clipboard);
    assert.equal(result.ok, false);
    assert.match(result.message, /Clipboard unavailable.*manually/);
  }
  const inaccessible = await copyResponseCode('retained literal', { get writeText() { throw new Error('PRIVATE_PERMISSION_DETAIL'); } });
  assert.equal(inaccessible.ok, false);
  assert.equal(inaccessible.message.includes('PRIVATE_PERMISSION_DETAIL'), false);
});

test('empty or non-string response data does not stringify untrusted objects or crash initial rendering', () => {
  for (const text of [undefined, null, 42, { toString() { throw new Error('must not coerce objects'); } }]) {
    assert.equal(render(text), '<div class="response-content"></div>');
  }
});
