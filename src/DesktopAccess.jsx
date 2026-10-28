import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, readAgentJson } from './protocol.mjs';
import { loadDesktopGrant, saveDesktopGrant, localDesktopModel, verifiedDesktopVision, canCaptureOperatorPreview, operatorPreviewSnapshot, shouldRefreshDesktopHealth } from './desktop.mjs';
import DesktopReceipt from './DesktopReceipt.jsx';
import { refreshDesktopHealth, isQuarantinedDesktopHealth } from './desktop-health.mjs';

const appName = app => typeof app === 'string' ? app : app?.name || app?.executable || 'App not recorded';

export default function DesktopAccess({ session, pendingSessionId, locked, model, healthRefreshKey, onSessionChange, onHealthChange, onControlState }) {
  const restored = useMemo(() => loadDesktopGrant(), []);
  const [tracking, setTracking] = useState(restored);
  const trackingRef = useRef(restored);
  const [health, setHealth] = useState(null);
  const [windows, setWindows] = useState([]);
  const [windowId, setWindowId] = useState('');
  const [allowScreenshots, setAllowScreenshots] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [note, setNote] = useState(restored ? 'An existing grant request is retained. Read its status or revoke it; no grant was recreated.' : 'Select an allowlisted window explicitly before desktop work.');
  const [error, setError] = useState('');
  const [operatorPreview, setOperatorPreview] = useState(null);
  const [grantCheck, setGrantCheck] = useState(null);
  const alive = useRef(true), reads = useRef(null), healthReads = useRef(null), changes = useRef(0), previousHealthKey = useRef('');
  const boundId = pendingSessionId || session?.sessionId || tracking?.sessionId;
  const boundRef = useRef(boundId); boundRef.current = boundId;
  const matchingGrantCheck = Boolean(grantCheck && grantCheck.sessionId === boundId);
  const grantState = matchingGrantCheck ? grantCheck.state : session?.state || 'unconfirmed';
  const grantUnverified = Boolean(boundId && matchingGrantCheck && grantCheck.state !== 'active');
  const canUseModel = localDesktopModel(model);
  const canUseImages = verifiedDesktopVision(model, health);
  const ready = health?.configured === true && health?.available === true;
  const canCapture = canCaptureOperatorPreview(session, { locked: locked || grantUnverified, busy, revoking, boundId });

  function remember(value) { trackingRef.current = value; setTracking(value); saveDesktopGrant(value); }
  function acceptGrant(grant) {
    if (!grant?.sessionId) throw new Error('The broker did not return a desktop session ID.');
    setGrantCheck({ sessionId: grant.sessionId, state: grant.state || 'unconfirmed' });
    if (grant.state === 'active') {
      if (trackingRef.current) remember({ ...trackingRef.current, sessionId: grant.sessionId });
      onSessionChange(grant);
      setNote('Selected window grant is active. Every native mutation still requires exact approval.');
    } else {
      onSessionChange(null); remember(null);
      setNote(`Grant is ${grant.state || 'inactive'}. Select a window again explicitly if needed.`);
    }
  }
  async function refreshHealth() {
    const controller = new AbortController(); healthReads.current?.abort(); healthReads.current = controller;
    const selectedId = boundRef.current, change = changes.current;
    let quarantined = false;
    setError('');
    try {
      return await refreshDesktopHealth({ signal: controller.signal, boundSessionId: selectedId, onHealth: value => {
        if (alive.current && healthReads.current === controller) {
          setHealth(value); onHealthChange(value);
          quarantined = isQuarantinedDesktopHealth(value);
          if (quarantined && selectedId && boundRef.current === selectedId && changes.current === change) {
            setGrantCheck({ sessionId: selectedId, state: 'checking' });
            setNote('Native health reports quarantine. Confirming the selected grant status; revoke and recovery remain available.');
          }
        }
      }, onGrant: grant => {
        if (alive.current && healthReads.current === controller && boundRef.current === selectedId && changes.current === change) {
          acceptGrant(grant);
          if (grant.state === 'active') setNote('The broker still reports an active grant, but native health is quarantined. Revoke or inspect the grant before further work.');
        }
      }});
    } catch (caught) {
      if (alive.current && healthReads.current === controller && !controller.signal.aborted) {
        if (!quarantined) { setHealth(null); onHealthChange(null); }
        if (quarantined && selectedId && boundRef.current === selectedId && changes.current === change) setGrantCheck({ sessionId: selectedId, state: 'unconfirmed' });
        setError(quarantined ? `Native health is quarantined; grant status could not be confirmed: ${caught.message}. Revoke or read the retained grant.` : caught.message);
      }
      return null;
    } finally { if (healthReads.current === controller) healthReads.current = null; }
  }
  useEffect(() => {
    alive.current = true; if (!healthRefreshKey) refreshHealth();
    return () => { alive.current = false; reads.current?.abort(); healthReads.current?.abort(); };
  }, []);
  useEffect(() => {
    const previous = previousHealthKey.current;
    previousHealthKey.current = healthRefreshKey || '';
    if (!shouldRefreshDesktopHealth(previous, healthRefreshKey)) return;
    setHealth(null); onHealthChange(null); setOperatorPreview(null);
    setNote(healthRefreshKey ? 'An unconfirmed native outcome was recorded. Desktop health is being refreshed; no action or grant is retried.'
      : 'The final native receipt resolved the prior uncertainty. Refreshing desktop health only; no action or grant is retried.');
    refreshHealth();
  }, [healthRefreshKey]);
  useEffect(() => { if (!canUseImages) setAllowScreenshots(false); }, [canUseImages]);
  useEffect(() => { if (session?.state !== 'active' || operatorPreview?.sessionId !== session?.sessionId) setOperatorPreview(null); }, [session?.sessionId, session?.state]);
  useEffect(() => { onControlState?.({ busy: busy || revoking, unresolved: grantUnverified || Boolean((tracking || pendingSessionId) && session?.state !== 'active') }); }, [busy, revoking, tracking, pendingSessionId, session, grantUnverified, onControlState]);
  useEffect(() => () => onControlState?.({ busy: false, unresolved: false }), [onControlState]);

  async function refreshWindows() {
    if (locked || busy || trackingRef.current || boundId) return;
    setBusy(true); setError('');
    const controller = new AbortController(); reads.current?.abort(); reads.current = controller;
    try {
      const value = await readAgentJson('/api/desktop/windows', { signal: controller.signal, maxReadRetries: 2 });
      if (!Array.isArray(value.windows)) throw new Error('No window inventory was returned.');
      if (alive.current) { setWindows(value.windows.filter(window => typeof window.windowId === 'string')); setWindowId(''); setNote('Only broker-allowlisted windows are listed.'); }
    } catch (caught) { if (alive.current && !controller.signal.aborted) setError(caught.message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function createGrant() {
    if (locked || busy || trackingRef.current || boundId || !windowId || !ready || !canUseModel) return;
    const request = { requestId: crypto.randomUUID(), windowId, allowScreenshots: allowScreenshots && canUseImages };
    const change = ++changes.current;
    remember(request); setBusy(true); setError('');
    try {
      const grant = await fetchJson('/api/desktop/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }, 15000);
      if (!alive.current || change !== changes.current) {
        await fetchJson(`/api/desktop/session-requests/${encodeURIComponent(request.requestId)}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (loadDesktopGrant()?.requestId === request.requestId) saveDesktopGrant(null);
        return;
      }
      acceptGrant(grant.session || grant);
    } catch (caught) {
      if (alive.current && change === changes.current) setError(`Grant creation was not confirmed: ${caught.message}. Read or revoke the retained request; do not create a replacement automatically.`);
    } finally { if (alive.current) setBusy(false); }
  }
  async function readGrant() {
    if (busy || revoking || (!boundId && !trackingRef.current)) return;
    setBusy(true); setError('');
    const controller = new AbortController(); reads.current?.abort(); reads.current = controller;
    const change = changes.current;
    try {
      const url = boundId ? `/api/desktop/sessions/${encodeURIComponent(boundId)}` : `/api/desktop/session-requests/${encodeURIComponent(trackingRef.current.requestId)}`;
      const value = await readAgentJson(url, { signal: controller.signal, maxReadRetries: 2 });
      if (!alive.current || change !== changes.current) return;
      if (value.session) acceptGrant(value.session);
      else if (value.sessionId) acceptGrant(value);
      else if (value.state === 'failed') { onSessionChange(null); remember(null); setError(typeof value.error === 'string' ? value.error : value.error?.message || 'The grant request failed.'); }
      else setNote(`Grant request is ${value.state || 'unconfirmed'}. No replacement request was submitted.`);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) {
        if (caught.status === 404) { onSessionChange(null); remember(null); setNote('The broker no longer has this grant. It was not recreated.'); }
        else setError(caught.message);
      }
    } finally { if (alive.current) setBusy(false); }
  }
  async function revoke() {
    if (revoking || (!boundId && !trackingRef.current)) return;
    changes.current++; setRevoking(true); setError(''); setOperatorPreview(null);
    const url = trackingRef.current?.requestId && (!pendingSessionId || trackingRef.current.sessionId === pendingSessionId || !boundId)
      ? `/api/desktop/session-requests/${encodeURIComponent(trackingRef.current.requestId)}/revoke`
      : `/api/desktop/sessions/${encodeURIComponent(boundId)}/revoke`;
    try {
      const value = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 12000);
      if (!alive.current) return;
      const state = value.session?.state || value.state;
      if (['revoked', 'expired', 'quarantined', 'failed', 'cancelled'].includes(state)) { onSessionChange(null); remember(null); setNote('Grant revoked or inactive. Revocation does not close the target app.'); }
      else setNote(`Revocation returned ${state || 'an unconfirmed state'}. Read the grant status before further work.`);
    } catch (caught) {
      if (alive.current) {
        if (caught.status === 404) { onSessionChange(null); remember(null); setNote('No known grant remains for this request.'); }
        else { if (session) onSessionChange({ ...session, state: 'unknown' }); setError(`Revocation is unconfirmed: ${caught.message}. Retry or read grant status.`); }
      }
    } finally { if (alive.current) setRevoking(false); }
  }

  async function captureOperatorPreview() {
    if (!canCaptureOperatorPreview(session, { locked: locked || grantUnverified, busy, revoking, boundId })) return;
    const change = changes.current;
    const controller = new AbortController(); reads.current?.abort(); reads.current = controller;
    setBusy(true); setError(''); setOperatorPreview(null);
    try {
      const value = await fetchJson(`/api/desktop/sessions/${encodeURIComponent(session.sessionId)}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal
      }, 15000);
      if (!alive.current || change !== changes.current) return;
      setOperatorPreview(operatorPreviewSnapshot(value, session.sessionId));
      setNote('Selected-window human preview captured. No model request was made and model screenshot permission was not changed.');
    } catch (caught) {
      if (alive.current && change === changes.current && !controller.signal.aborted) setError(`Human preview capture failed: ${caught.message}. No other-window or global capture was attempted.`);
    } finally { if (alive.current) setBusy(false); }
  }

  return <section className="desktop-access">
    <div className="desktop-access-status"><strong>Native desktop · {ready ? 'broker available' : health ? 'unavailable' : 'health not verified'}{boundId ? ` · grant ${grantState}${isQuarantinedDesktopHealth(health) && grantState === 'active' ? ' (native access quarantined)' : ''}` : ''}</strong>{(tracking || boundId) && <button className="desktop-revoke" onClick={revoke} disabled={revoking}>{revoking ? 'Revoking…' : 'Revoke desktop access'}</button>}</div>
    {session?.window && <p className="desktop-selected-window">Selected: {appName(session.window.app)} · {session.window.title || 'Untitled window'}</p>}
    <details><summary>Window and grant controls</summary>
    <p><strong>Windows UIA · user-session access · no OS sandbox.</strong> This is separate from Docker code execution. Observations use local inference only. The target app may transmit typed text or other effects through its own network/account.</p>
    {health?.reason && <p>{health.reason}</p>}
    <div className="desktop-controls"><button onClick={refreshHealth} disabled={busy}>Refresh desktop health</button><button onClick={refreshWindows} disabled={locked || busy || Boolean(tracking) || Boolean(boundId) || !ready}>Refresh allowed windows</button></div>
    <label>Allowed window<select aria-label="Allowed window" value={windowId} onChange={event => setWindowId(event.target.value)} disabled={locked || busy || Boolean(tracking) || Boolean(boundId)}><option value="">Choose a window explicitly</option>{windows.map(window => <option key={window.windowId} value={window.windowId}>{appName(window.app)} · {window.title || 'Untitled window'}</option>)}</select></label>
    <label className="check-label"><input type="checkbox" checked={allowScreenshots} disabled={locked || busy || Boolean(tracking) || Boolean(boundId) || !canUseImages} onChange={event => setAllowScreenshots(event.target.checked)} />Allow selected-window screenshots for a verified local desktop-vision model</label>
    {!canUseImages && <p>Desktop screenshot input is not verified for this model. The visual automation path remains unavailable; text-only UIA can still work. A model's advertised vision capability alone is not verification.</p>}
    {!canUseModel && <p>Choose a local Ollama tool model for desktop work. Screenshot access additionally requires advertised local vision.</p>}
    <button onClick={createGrant} disabled={locked || busy || Boolean(tracking) || Boolean(boundId) || !windowId || !ready || !canUseModel}>Grant selected window</button>
    {boundId && <div className="desktop-grant"><strong>Selected session: {boundId}</strong>{session?.window && <p>{appName(session.window.app)} · {session.window.title || 'Untitled window'}</p>}<p>Status: {grantState} · screenshots: {session ? session.allowScreenshots ? 'Allowed' : 'Not allowed' : 'Unconfirmed'}{session?.expiresAt ? ` · expires ${new Date(session.expiresAt).toLocaleString()}` : ''}</p></div>}
    {(tracking || boundId) && <div className="desktop-controls"><button onClick={readGrant} disabled={busy || revoking}>Read existing grant</button></div>}
    <div className="desktop-controls"><button onClick={captureOperatorPreview} disabled={!canCapture}>Capture selected-window preview</button></div>
    <p>This explicit capture is for human review only. It does not enable screenshots for the model or change the grant's screenshot permission.</p>
    {operatorPreview && <div aria-label="Human-only desktop preview"><p><strong>{session?.allowScreenshots && canUseImages ? 'Human preview only; this capture is not sent to the model.' : 'Human preview only; model screenshot input remains disabled.'}</strong></p><DesktopReceipt tool={{ name: 'desktop.operatorPreview', result: operatorPreview }} /></div>}
    <p>{note}</p><p>Grants last at most 15 minutes and expire after 5 minutes idle. Reload never recreates a grant.</p>
    <p>Desktop defaults: 32,768 input tokens · 64,000 cumulative total tokens · 300 seconds. These defaults can be replaced by explicit interactive run limits.</p>
    {error && <p className="receipt-error" role="alert">{error}</p>}
    </details>
  </section>;
}
