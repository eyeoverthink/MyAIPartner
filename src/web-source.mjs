export function safeWebHref(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

const text = value => typeof value === 'string' ? value : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const fingerprint = value => typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value) ? value : null;
const positiveCount = value => Number.isSafeInteger(value) && value > 0 ? value : null;

function searchProvider(value) {
  const provider = value && typeof value === 'object' ? value : {};
  return { id: text(provider.id), label: text(provider.label), url: text(provider.url), href: safeWebHref(provider.url) };
}

function parentSearch(value) {
  if (!value || typeof value !== 'object') return null;
  return { provider: searchProvider(value.provider), query: text(value.query), rank: positiveCount(value.rank) };
}

export function webSourceReceipt(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (!result.sourceId && !result.url && !Array.isArray(result.lines) && !Array.isArray(result.matches) && !Array.isArray(result.links) && result.truncated !== true) return null;
  const fetched = typeof result.fetchedAt === 'number' || typeof result.fetchedAt === 'string' ? new Date(result.fetchedAt) : null;
  const sourceId = text(result.sourceId);
  function lineItems(values, key) {
    return (Array.isArray(values) ? values : []).filter(item => item && Number.isSafeInteger(item.line) && item.line >= 1 && typeof item[key] === 'string')
      .map(item => ({ line: item.line, charOffset: count(item.charOffset), text: item[key], reference: `${sourceId || 'source'}:L${item.line}` }));
  }
  return {
    sourceId, url: text(result.url), href: safeWebHref(result.url), title: text(result.title) || text(result.url) || 'Recorded web source',
    status: count(result.status), contentType: text(result.contentType), bytes: count(result.bytes),
    fetchedAt: fetched && Number.isFinite(fetched.getTime()) ? fetched.toISOString() : null,
    rawSha256: fingerprint(result.rawSha256), snapshotSha256: fingerprint(result.snapshotSha256),
    totalChars: count(result.totalChars), totalLines: count(result.totalLines), totalLinks: count(result.totalLinks),
    truncated: result.truncated === true, untrusted: result.untrusted === true,
    htmlTextOnly: /html/i.test(text(result.contentType)),
    warnings: (Array.isArray(result.warnings) ? result.warnings : []).filter(value => typeof value === 'string'),
    lines: lineItems(result.lines, 'text'), matches: lineItems(result.matches, 'excerpt'),
    links: (Array.isArray(result.links) ? result.links : []).filter(link => link && typeof link.url === 'string').map(link => ({
      id: typeof link.id === 'string' || Number.isSafeInteger(link.id) ? String(link.id) : '',
      url: link.url, href: safeWebHref(link.url), text: text(link.text) || link.url
    })),
    next: result.nextCursor ?? result.next ?? null
  };
}

export function webFollowReceipt(preview) {
  if (!preview || typeof preview !== 'object') return null;
  return {
    method: text(preview.method) || 'Method not recorded', url: text(preview.url), href: safeWebHref(preview.url),
    label: text(preview.label), parentUrl: text(preview.parentUrl), parentHref: safeWebHref(preview.parentUrl),
    parentSourceId: text(preview.parentSourceId), parentSnapshotSha256: fingerprint(preview.parentSnapshotSha256),
    parentSearch: parentSearch(preview.parentSearch),
    sendsCookies: typeof preview.sendsCookies === 'boolean' ? preview.sendsCookies : null,
    redirectsFollowed: typeof preview.redirectsFollowed === 'boolean' ? preview.redirectsFollowed : null
  };
}

export function webSearchApproval(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
  return {
    action: text(preview.action), method: text(preview.method), provider: searchProvider(preview.provider),
    query: text(preview.query), url: text(preview.url), href: safeWebHref(preview.url), maxResults: positiveCount(preview.maxResults),
    sendsCookies: typeof preview.sendsCookies === 'boolean' ? preview.sendsCookies : null,
    redirectsFollowed: typeof preview.redirectsFollowed === 'boolean' ? preview.redirectsFollowed : null,
    fetchesResultPages: typeof preview.fetchesResultPages === 'boolean' ? preview.fetchesResultPages : null
  };
}

export function webSearchReceipt(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const source = webSourceReceipt(result);
  if (result.ok === false || result.error) return { state: 'failed', source,
    error: typeof result.error === 'string' ? result.error : text(result.error?.message) || 'Public search did not complete.' };
  const search = result.search;
  if (!search || typeof search !== 'object' || !Array.isArray(result.results)
    || typeof search.query !== 'string' || !search.query.trim() || !search.provider || typeof search.provider !== 'object') return { state: 'incomplete', source };
  const results = result.results.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map(item => {
    const startLine = positiveCount(item.startLine), end = positiveCount(item.endLine);
    const endLine = startLine !== null && end !== null && end >= startLine ? end : null;
    return {
      rank: positiveCount(item.rank), linkId: typeof item.linkId === 'string' || Number.isSafeInteger(item.linkId) ? String(item.linkId) : '',
      title: text(item.title), snippet: text(item.snippet), url: text(item.url), href: safeWebHref(item.url), startLine, endLine,
      reference: startLine !== null ? `${source?.sourceId || 'source'}:L${startLine}${endLine !== null && endLine !== startLine ? `–L${endLine}` : ''}` : ''
    };
  });
  const recordedCount = count(search.resultCount);
  const resultCount = recordedCount !== null && recordedCount >= results.length ? recordedCount : null;
  const malformedPage = result.results.length > 0 && results.length === 0;
  const state = malformedPage || (resultCount === null && results.length === 0) ? 'incomplete'
    : results.length ? 'results' : resultCount === 0 ? 'empty' : 'page-empty';
  return {
    state, source, provider: searchProvider(search.provider), query: text(search.query), maxResults: positiveCount(search.maxResults),
    resultCount, resultsLimited: typeof search.resultsLimited === 'boolean' ? search.resultsLimited : null,
    results, offset: count(result.offset), nextOffset: count(result.nextOffset), untrusted: true
  };
}
