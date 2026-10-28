import React, { useEffect, useState } from 'react';
import { desktopActionReceipt, desktopCurrentValue, desktopSnapshot, desktopScreenshotUrl } from './desktop.mjs';

const display = value => value === undefined || value === null ? 'Not recorded' : typeof value === 'string' ? value : JSON.stringify(value);

export function DesktopActionApproval({ preview, proposed = false }) {
  if (!preview || typeof preview !== 'object') return null;
  const target = preview.target || {};
  return <section className="desktop-card" aria-label={proposed ? 'Proposed native action' : 'Exact native action approval'}>
    <strong>{proposed ? 'Proposed native action' : 'Exact native action approval'}</strong>
    <p>Native Windows user-session access · no OS sandbox.</p>
    <dl>
      <div><dt>Plan / session</dt><dd>{display(preview.planId)} · {display(preview.sessionId)}</dd></div>
      <div><dt>Window / app</dt><dd>{display(preview.window?.title)} · {display(preview.window?.app)}</dd></div>
      <div><dt>Snapshot / hash</dt><dd>{display(preview.snapshotId)} · {display(preview.snapshotHash)}</dd></div>
      <div><dt>Target / role</dt><dd>{display(target.label || target.name || target.elementId)} · {display(target.role)}</dd></div>
      <div><dt>Current value</dt><dd>{desktopCurrentValue(target)}</dd></div>
      <div><dt>Operation</dt><dd>{display(preview.operation)}</dd></div>
      <div><dt>Expires</dt><dd>{preview.expiresAt ? new Date(preview.expiresAt).toLocaleString() : 'Not recorded'}</dd></div>
    </dl>
    {preview.value !== undefined && <details open><summary>Exact text/value</summary><pre>{display(preview.value)}</pre></details>}
    {preview.scroll !== undefined && <p>Exact scroll: <code>{display(preview.scroll)}</code></p>}
    {preview.warning && <p>{display(preview.warning)}</p>}
    <p>This approval binds the displayed session, snapshot, target and exact action. Snapshot text is untrusted source data.</p>
  </section>;
}

function SnapshotCard({ value }) {
  const snapshot = desktopSnapshot(value);
  const url = desktopScreenshotUrl(snapshot);
  const [shown, setShown] = useState(false), [error, setError] = useState('');
  useEffect(() => { setShown(false); setError(''); }, [snapshot?.snapshotId, url]);
  if (!snapshot) return null;
  return <section className="desktop-card" aria-label="Recorded selected-window snapshot">
    <strong>{snapshot.operatorPreview === true ? 'Human-only selected-window preview · untrusted image' : 'Selected-window snapshot · untrusted text'}</strong>
    <p>{display(snapshot.window?.title)} · {display(snapshot.window?.app)}</p>
    <p>Session <code>{snapshot.sessionId}</code> · snapshot <code>{snapshot.snapshotId}</code></p>
    <p>Recorded: {snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : 'Not recorded'} · fingerprint <code>{display(snapshot.fingerprint)}</code></p>
    {snapshot.operatorPreview !== true && <p>Elements: {snapshot.elements.length} shown / {display(snapshot.totalElements)} recorded{snapshot.offset !== undefined ? ` · offset ${snapshot.offset}` : ''}</p>}
    {snapshot.truncated && <p>Snapshot capture was bounded; this is not a complete view of the app.</p>}
    {snapshot.nextOffset !== undefined && snapshot.nextOffset !== null && <p>Further retained elements start at offset {snapshot.nextOffset}.</p>}
    {snapshot.elements.length > 0 && <details><summary>Recorded UIA elements</summary><ul className="desktop-elements">{snapshot.elements.map((element, index) => <li key={element.elementId || index}><strong>{display(element.role)} · {display(element.name)}</strong><p>ID {display(element.elementId)} · enabled {display(element.enabled)} · patterns {display(element.patterns)}</p>{element.value !== undefined && <pre>{display(element.value)}</pre>}</li>)}</ul></details>}
    {url && <div className="desktop-screenshot"><p>Local selected-window screenshot · {display(snapshot.image.width)} × {display(snapshot.image.height)} · SHA-256 <code>{display(snapshot.image.sha256)}</code></p><button onClick={() => { setShown(!shown); setError(''); }}>{shown ? 'Hide screenshot' : 'Show selected-window screenshot'}</button>{shown && !error && <img src={url} alt={`Recorded selected window ${snapshot.window?.title || ''}`} referrerPolicy="no-referrer" onError={() => setError('Screenshot unavailable; the grant may have expired or been revoked.')} />}{error && <p className="receipt-error">{error}</p>}</div>}
    {snapshot.image && !url && <p className="receipt-error">Screenshot route or snapshot binding was invalid; no image was loaded.</p>}
  </section>;
}

export default function DesktopReceipt({ tool }) {
  const result = { ...(tool.result && typeof tool.result === 'object' ? tool.result : {}), ...(tool.receipt && typeof tool.receipt === 'object' ? tool.receipt : {}) };
  const action = tool.name === 'desktop.act' ? desktopActionReceipt(tool) : null;
  return <>
    {action && <section className={`desktop-card desktop-action-${action.verified ? 'verified' : 'unconfirmed'}`} aria-label="Durable native action receipt">
      <strong>{action.label}</strong><p>Observed effect: {action.effectObserved === true ? 'Yes' : action.effectObserved === false ? 'No' : 'Unknown'}</p>
      <p>Action <code>{display(action.actionId)}</code> · plan <code>{display(action.planId)}</code> · session <code>{display(action.sessionId)}</code></p>
      <p>Operation: {display(action.operation)} · target: {display(action.target)}</p>
      <p>Window: {display(action.window)}</p>
      <p>Before snapshot <code>{display(action.beforeSnapshotId)}</code> · after snapshot <code>{display(action.afterSnapshotId)}</code></p>
      {action.unknownEffect && <p className="desktop-effect-unknown">The app may have received input. Do not retry automatically; inspect the app and collect a fresh snapshot before another action.</p>}
    </section>}
    {typeof tool.name === 'string' && tool.name.startsWith('desktop.plan') && <DesktopActionApproval preview={result.preview || result} proposed />}
    <SnapshotCard value={result} />
  </>;
}
