import test from 'node:test';
import assert from 'node:assert/strict';
import { safeWebHref, webSourceReceipt, webFollowReceipt, webSearchApproval, webSearchReceipt } from '../src/web-source.mjs';

const rawHash = 'a'.repeat(64), snapshotHash = 'b'.repeat(64);

test('web links require absolute HTTP(S) without credentials, control characters or scheme obfuscation', () => {
  assert.equal(safeWebHref('https://example.com/source?q=test#section'), 'https://example.com/source?q=test#section');
  assert.equal(safeWebHref('http://example.com'), 'http://example.com/');
  for (const url of [undefined, {}, '', '/relative', '//example.com', 'javascript:alert(1)', 'data:text/html,test',
    'file:///private', 'https://', 'https://user:secret@example.com', 'https://user%40private@example.com',
    'https://example.com\n/hidden', ' https://example.com', 'https://example.com\\@other.example']) {
    assert.equal(safeWebHref(url), null, String(url));
  }
});

test('source cards preserve historical identity, timestamps, fingerprints and exact line references', () => {
  const source = webSourceReceipt({ sourceId: 'source-previous', title: '<img src=x onerror=alert(1)>', url: 'https://example.com/source',
    status: 200, contentType: 'text/html; charset=utf-8', bytes: 240, fetchedAt: '2026-10-26T10:00:00Z',
    rawSha256: rawHash, snapshotSha256: snapshotHash, totalChars: 120, totalLines: 4, totalLinks: 1,
    truncated: true, untrusted: true, warnings: ['<script>untrusted warning</script>'],
    lines: [{ line: 3, charOffset: 47, text: '<b>source text</b>' }], matches: [{ line: 4, charOffset: 82, excerpt: 'matched words' }], nextCursor: { line: 4 } });
  assert.equal(source.title, '<img src=x onerror=alert(1)>');
  assert.equal(source.sourceId, 'source-previous');
  assert.equal(source.fetchedAt, '2026-10-26T10:00:00.000Z');
  assert.equal(source.rawSha256, rawHash);
  assert.equal(source.snapshotSha256, snapshotHash);
  assert.equal(source.lines[0].reference, 'source-previous:L3');
  assert.equal(source.lines[0].text, '<b>source text</b>');
  assert.equal(source.matches[0].charOffset, 82);
  assert.equal(source.htmlTextOnly, true);
  assert.equal(source.truncated, true);
  assert.deepEqual(source.next, { line: 4 });
});

test('malformed source metadata cannot become recorded fingerprints, dates or source line references', () => {
  const source = webSourceReceipt({ sourceId: 'source-1', url: 'javascript:alert(1)', fetchedAt: 'not a date',
    rawSha256: 'invented hash', snapshotSha256: {}, bytes: -1, totalLines: '100',
    lines: [{ line: -1, charOffset: 0, text: 'bad' }, { line: '1', text: 'bad' }, { line: 2, charOffset: -1, text: 'valid line, unknown offset' }] });
  assert.equal(source.href, null);
  assert.equal(source.fetchedAt, null);
  assert.equal(source.rawSha256, null);
  assert.equal(source.snapshotSha256, null);
  assert.equal(source.bytes, null);
  assert.equal(source.totalLines, null);
  assert.equal(source.lines.length, 1);
  assert.equal(source.lines[0].charOffset, null);
  assert.equal(webSourceReceipt({ ok: false, error: 'no source was fetched' }), null);
});

test('link indexes retain untrusted labels while invalid destinations remain non-clickable', () => {
  const source = webSourceReceipt({ sourceId: 'source-1', links: [
    { id: 0, url: 'https://example.com/valid', text: '<iframe>label</iframe>' },
    { id: 'link-private', url: 'https://owner:password@example.com', text: 'Misleading safe label' },
    { id: 'link-js', url: 'javascript:alert(1)', text: 'Click me' }, { id: 'missing-url' }
  ] });
  assert.equal(source.links.length, 3);
  assert.equal(source.links[0].id, '0');
  assert.equal(source.links[0].text, '<iframe>label</iframe>');
  assert.equal(source.links[0].href, 'https://example.com/valid');
  assert.equal(source.links[1].href, null);
  assert.equal(source.links[2].href, null);
});

test('follow approval keeps the exact destination and parent snapshot evidence with explicit cookie/redirect facts', () => {
  const preview = webFollowReceipt({ action: 'follow', method: 'GET', url: 'https://example.com/next?exact=1', label: 'Next page',
    parentUrl: 'https://example.com/start', parentSourceId: 'source-parent', parentSnapshotSha256: snapshotHash,
    sendsCookies: false, redirectsFollowed: false });
  assert.equal(preview.method, 'GET');
  assert.equal(preview.href, 'https://example.com/next?exact=1');
  assert.equal(preview.parentSourceId, 'source-parent');
  assert.equal(preview.parentSnapshotSha256, snapshotHash);
  assert.equal(preview.sendsCookies, false);
  assert.equal(preview.redirectsFollowed, false);
  const unknown = webFollowReceipt({ url: 'https://user:secret@example.com' });
  assert.equal(unknown.href, null);
  assert.equal(unknown.sendsCookies, null);
  assert.equal(unknown.redirectsFollowed, null);
});

const provider = { id: 'duckduckgo-lite', label: 'DuckDuckGo Lite', url: 'https://lite.duckduckgo.com/lite/' };
function searchResult(overrides = {}) {
  return { sourceId: 'search-source-previous', url: 'https://lite.duckduckgo.com/lite/?q=recorded', title: 'Recorded search',
    fetchedAt: '2026-10-26T10:00:00Z', snapshotSha256: snapshotHash, untrusted: true,
    search: { provider, query: 'recorded query', maxResults: 5, resultCount: 1, resultsLimited: false },
    results: [{ rank: 1, linkId: 4, title: 'Result title', snippet: 'Search-engine preview.', url: 'https://example.com/page', startLine: 4, endLine: 7 }],
    offset: 0, nextOffset: null, ...overrides };
}

test('search approval discloses the exact outbound query, provider and encoded request without inventing privacy flags', () => {
  const query = 'AUTHORED_QUERY_SENTINEL + "literal" <text>';
  const url = provider.url + '?q=' + encodeURIComponent(query);
  const preview = webSearchApproval({ action: 'Search public web', method: 'GET', provider, query, url, maxResults: 5,
    sendsCookies: false, redirectsFollowed: false, fetchesResultPages: false });
  assert.equal(preview.query, query);
  assert.equal(preview.url, url);
  assert.equal(preview.href, url);
  assert.deepEqual(preview.provider, { ...provider, href: provider.url });
  assert.equal(preview.fetchesResultPages, false);
  const unknown = webSearchApproval({ query, provider, url });
  assert.equal(unknown.sendsCookies, null);
  assert.equal(unknown.redirectsFollowed, null);
  assert.equal(unknown.fetchesResultPages, null);
});

test('search receipts distinguish provider-returned empty results, failed requests and incomplete records', () => {
  const empty = webSearchReceipt(searchResult({ search: { provider, query: 'recorded query', resultCount: 0 }, results: [] }));
  assert.equal(empty.state, 'empty');
  assert.equal(webSearchReceipt({ ok: false, error: 'provider request failed' }).state, 'failed');
  assert.equal(webSearchReceipt({ truncated: true, preview: '{"search":' }).state, 'incomplete');
  assert.equal(webSearchReceipt(searchResult({ results: ['malformed'] })).state, 'incomplete');
  assert.equal(webSearchReceipt(searchResult({ search: { resultCount: 0 }, results: [] })).state, 'incomplete');
  assert.equal(webSearchReceipt(searchResult({ results: [], offset: 5 })).state, 'page-empty');
});

test('ranked search results preserve their own preview text, safe destinations and retained snapshot line references', () => {
  const result = webSearchReceipt(searchResult({ results: [{ rank: 2, linkId: 4, title: '<img src=x>', snippet: '<script>untrusted</script>',
    url: 'https://user:secret@example.com/private', startLine: 4, endLine: 7 }] }));
  assert.equal(result.state, 'results');
  assert.equal(result.untrusted, true);
  assert.equal(result.source.sourceId, 'search-source-previous');
  assert.equal(result.source.snapshotSha256, snapshotHash);
  assert.equal(result.results[0].title, '<img src=x>');
  assert.equal(result.results[0].snippet, '<script>untrusted</script>');
  assert.equal(result.results[0].href, null);
  assert.equal(result.results[0].rank, 2);
  assert.equal(result.results[0].reference, 'search-source-previous:L4–L7');
});

test('bounded discovery and retained-results pagination remain distinct from extraction truncation', () => {
  const result = webSearchReceipt(searchResult({ truncated: true, search: { provider, query: 'recorded query', maxResults: 5, resultCount: 5, resultsLimited: true }, nextOffset: 1 }));
  assert.equal(result.resultsLimited, true);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.source.truncated, true);
  assert.equal(result.resultCount, 5);
});

test('follow approval retains parent search query and rank without making an unsafe provider URL clickable', () => {
  const preview = webFollowReceipt({ method: 'GET', url: 'https://example.com/page', parentSearch: {
    provider: { ...provider, url: 'https://user:secret@lite.duckduckgo.com/lite/' }, query: 'ORIGINAL_QUERY_SENTINEL', rank: 3
  } });
  assert.equal(preview.parentSearch.query, 'ORIGINAL_QUERY_SENTINEL');
  assert.equal(preview.parentSearch.rank, 3);
  assert.equal(preview.parentSearch.provider.href, null);
  assert.equal(preview.href, 'https://example.com/page');
});
