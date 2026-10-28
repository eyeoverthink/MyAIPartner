import React from 'react';
import { safeWebHref, webSourceReceipt, webFollowReceipt, webSearchApproval, webSearchReceipt } from './web-source.mjs';

function SourceLink({ url, children }) {
  const href = safeWebHref(url);
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children || url} ↗</a>
    : <span>{children || url || 'URL not recorded'} <small>(no valid HTTP(S) link)</small></span>;
}

export default function WebSourceReceipt({ result }) {
  const source = webSourceReceipt(result);
  if (!source) return null;
  const number = value => value === null ? 'Not recorded' : value.toLocaleString();
  return <section className="web-source-card" aria-label="Recorded web source">
    <strong><SourceLink url={source.url}>{source.title}</SourceLink></strong>
    <p className="web-source-kind">Untrusted source data · text snapshot</p>
    <dl>
      <div><dt>Fetched</dt><dd>{source.fetchedAt ? new Date(source.fetchedAt).toLocaleString() : 'Not recorded'}</dd></div>
      <div><dt>HTTP / type</dt><dd>{source.status ?? 'Not recorded'} · {source.contentType || 'Not recorded'}</dd></div>
      <div><dt>Bytes / characters</dt><dd>{number(source.bytes)} / {number(source.totalChars)}</dd></div>
      <div><dt>Source lines / links</dt><dd>{number(source.totalLines)} / {number(source.totalLinks)}</dd></div>
    </dl>
    <p>Source: <code>{source.sourceId || 'Not recorded'}</code></p>
    <details><summary>Source URL and fingerprints</summary><p><SourceLink url={source.url} /></p><p>Raw SHA-256: <code>{source.rawSha256 || 'Not recorded'}</code></p><p>Snapshot SHA-256: <code>{source.snapshotSha256 || 'Not recorded'}</code></p></details>
    {source.truncated && <p className="web-source-warning">Some source text or metadata was omitted during extraction. Reads and searches cover retained text only.</p>}
    {source.htmlTextOnly && <p>HTML text only. Page layout, images and scripts are not rendered.</p>}
    {source.warnings.map((warning, index) => <p className="web-source-warning" key={index}>{warning}</p>)}
    {source.lines.length > 0 && <details open><summary>Recorded source lines</summary><ol className="web-source-lines">{source.lines.map((line, index) => <li key={index}><code>{line.reference}{line.charOffset !== null ? ` · character ${line.charOffset}` : ''}</code><pre>{line.text}</pre></li>)}</ol></details>}
    {source.matches.length > 0 && <details open><summary>Recorded matches</summary><ol className="web-source-lines">{source.matches.map((match, index) => <li key={index}><code>{match.reference}{match.charOffset !== null ? ` · character ${match.charOffset}` : ''}</code><pre>{match.text}</pre></li>)}</ol></details>}
    {source.links.length > 0 && <details><summary>Recorded link index · {source.links.length}</summary><ul className="web-source-links">{source.links.map((link, index) => <li key={index}><code>{link.id || 'Unnumbered'}</code> <SourceLink url={link.url}>{link.text}</SourceLink></li>)}</ul></details>}
    {source.next !== null && <p>Next recorded cursor: <code>{typeof source.next === 'object' ? JSON.stringify(source.next) : String(source.next)}</code></p>}
  </section>;
}

export function WebFollowPreview({ preview }) {
  const follow = webFollowReceipt(preview);
  if (!follow) return null;
  return <section className="web-source-card" aria-label="Exact web follow request">
    <strong>Approve this exact {follow.method} destination</strong>
    <p><SourceLink url={follow.url}>{follow.label || follow.url}</SourceLink></p>
    {follow.label && <p>Exact URL: <code>{follow.url}</code></p>}
    <p>Parent: <SourceLink url={follow.parentUrl} /></p>
    <p>Parent source: <code>{follow.parentSourceId || 'Not recorded'}</code></p>
    <p>Parent snapshot SHA-256: <code>{follow.parentSnapshotSha256 || 'Not recorded'}</code></p>
    {follow.parentSearch && <div className="web-parent-search"><strong>Discovered by search</strong><p>Provider: <SourceLink url={follow.parentSearch.provider.url}>{follow.parentSearch.provider.label || follow.parentSearch.provider.id || 'Provider not recorded'}</SourceLink> · rank {follow.parentSearch.rank ?? 'not recorded'}</p><pre>{follow.parentSearch.query}</pre><p>Rank is provider ordering, not a credibility score.</p></div>}
    <p>Tool request cookies: {follow.sendsCookies === false ? 'Not sent' : follow.sendsCookies === true ? 'Sent' : 'Not recorded'} · Tool redirects: {follow.redirectsFollowed === false ? 'Not followed' : follow.redirectsFollowed === true ? 'Followed' : 'Not recorded'}</p>
  </section>;
}

export function WebSearchApproval({ preview }) {
  const search = webSearchApproval(preview);
  if (!search) return null;
  return <section className="web-source-card" aria-label="Exact outbound search disclosure">
    <strong>This exact query will be sent to the search provider</strong>
    <p>Provider: <SourceLink url={search.provider.url}>{search.provider.label || search.provider.id || 'Not recorded'}</SourceLink></p>
    <p>Provider URL: <code>{search.provider.url || 'Not recorded'}</code></p>
    <pre className="web-search-query">{search.query}</pre>
    <p>{search.method || 'Method not recorded'} request: <SourceLink url={search.url} /></p>
    <p>Requested result limit: {search.maxResults ?? 'Not recorded'}</p>
    <p>Tool request cookies: {search.sendsCookies === false ? 'Not sent' : search.sendsCookies === true ? 'Sent' : 'Not recorded'} · Tool redirects: {search.redirectsFollowed === false ? 'Not followed' : search.redirectsFollowed === true ? 'Followed' : 'Not recorded'}</p>
    <p>Destination-page fetching: {search.fetchesResultPages === false ? 'No result pages will be fetched by this search' : search.fetchesResultPages === true ? 'Result pages may be fetched' : 'Not recorded'}</p>
  </section>;
}

export function WebSearchReceipt({ result }) {
  const search = webSearchReceipt(result);
  if (!search) return null;
  if (search.state === 'failed') return <section className="web-source-card" aria-label="Failed public search"><strong>Public search failed</strong><p className="web-source-warning">{search.error}</p></section>;
  if (search.state === 'incomplete') return <section className="web-source-card" aria-label="Incomplete search receipt"><strong>Search receipt incomplete</strong><p>The recorded data does not establish a complete result list or a provider-returned empty result. Inspect the raw receipt JSON.</p></section>;
  return <section className="web-source-card web-search-card" aria-label="Recorded public search discovery">
    <strong>Search discovery · <SourceLink url={search.provider.url}>{search.provider.label || search.provider.id || 'Provider not recorded'}</SourceLink></strong>
    <p className="web-source-kind">Untrusted search-engine previews · rank is provider ordering, not credibility</p>
    <pre className="web-search-query">{search.query}</pre>
    <p>Provider URL: <code>{search.provider.url || 'Not recorded'}</code></p>
    <p>Fetched: {search.source?.fetchedAt ? new Date(search.source.fetchedAt).toLocaleString() : 'Not recorded'} · source <code>{search.source?.sourceId || 'Not recorded'}</code></p>
    <p>{search.resultCount === null ? 'Retained result count not recorded' : `${search.resultCount} retained ranked result${search.resultCount === 1 ? '' : 's'}`}{search.offset !== null ? ` · offset ${search.offset}` : ''}</p>
    {search.state === 'empty' && <p>The provider returned no retained results for this query. This does not establish that no relevant pages exist.</p>}
    {search.state === 'page-empty' && <p>This retained-results page contains no entries. Earlier entries may still be available.</p>}
    {search.resultsLimited && <p className="web-source-warning">Only a bounded set of ranked results was retained.</p>}
    {search.results.length > 0 && <ol className="web-search-results">{search.results.map((item, index) => <li key={index}>
      <div><span className="web-search-rank">Rank {item.rank ?? 'not recorded'}</span> <SourceLink url={item.url}>{item.title || item.url || 'Untitled result'}</SourceLink></div>
      <p className="web-search-destination"><code>{item.url || 'Destination not recorded'}</code></p>
      <p>{item.snippet || 'No search-engine preview was recorded.'}</p>
      <p className="web-source-kind">Search snapshot lines: <code>{item.reference || 'Not recorded'}</code>{item.linkId ? ` · link ID ${item.linkId}` : ''}</p>
    </li>)}</ol>}
    {search.nextOffset !== null && <p>More retained results are available through web.results at offset <code>{search.nextOffset}</code>.</p>}
    <p>Snippets are search-engine previews, not full destination-page evidence. Links open only when clicked; this view does not fetch result pages.</p>
    {search.source && <details><summary>Search source snapshot and fingerprints</summary><WebSourceReceipt result={result} /></details>}
  </section>;
}
