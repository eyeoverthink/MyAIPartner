import { readAgentJson } from './protocol.mjs';

// Refreshing native health never dispatches an action, creates a grant, or
// retries a mutation. Availability is cleared before the read begins.
export function isQuarantinedDesktopHealth(health) {
  const reason = typeof health?.reason === 'string' ? health.reason : health?.reason?.code;
  return health?.available === false && (health.quarantined === true || health.state === 'quarantined'
    || (typeof reason === 'string' && /\bquarantin(?:e|ed)\b/i.test(reason)));
}

export async function refreshDesktopHealth({ signal, onHealth, boundSessionId, onGrant, fetchImpl = fetch } = {}) {
  signal?.throwIfAborted();
  onHealth?.(null);
  const health = await readAgentJson('/api/desktop/health', { signal, fetchImpl, maxReadRetries: 2 });
  if (!health || typeof health !== 'object' || Array.isArray(health)) throw new Error('The desktop broker returned invalid health data.');
  signal?.throwIfAborted();
  onHealth?.(health);
  if (isQuarantinedDesktopHealth(health) && typeof boundSessionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(boundSessionId)) {
    let grant;
    try {
      const payload = await readAgentJson(`/api/desktop/sessions/${encodeURIComponent(boundSessionId)}`, { signal, fetchImpl, maxReadRetries: 2 });
      grant = payload && typeof payload === 'object' ? payload.session || payload : null;
      if (!grant || grant.sessionId !== boundSessionId || !['active', 'revoked', 'expired', 'quarantined', 'failed', 'cancelled'].includes(grant.state)) throw new Error('The broker did not return a confirmed status bound to the selected desktop grant.');
    } catch (error) {
      if (error.status !== 404) throw error;
      grant = { sessionId: boundSessionId, state: 'missing', confirmedMissing: true };
    }
    signal?.throwIfAborted();
    onGrant?.(grant);
  }
  return health;
}
