import { readAgentJson } from './protocol.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bool = value => typeof value === 'boolean' ? value : null;
const text = value => typeof value === 'string' && value.length <= 300 && !/[\uD800-\uDFFF\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value : null;

// This independent audit is deliberately limited to the deployed Docker
// contract. New engine names do not inherit isolation or cleanup claims.
export function codeExecutionReceipt(receipt) {
  if (!plain(receipt) || receipt.kind !== 'code_execution' || !identifier(receipt.effectId)) return null;
  const complete = receipt.complete === true, knownEngine = receipt.engine === 'docker';
  const proof = plain(receipt.proof) ? receipt.proof : {};
  const conflictingProof = (proof.isolation !== undefined && proof.isolation !== 'docker-linux')
    || (proof.network !== undefined && proof.network !== false) || (proof.hostMounts !== undefined && proof.hostMounts !== false);
  const dispatchAttempted = bool(receipt.dispatchAttempted), codeMayHaveRun = bool(receipt.codeMayHaveRun);
  const outcome = ['finished', 'not_started', 'unknown'].includes(receipt.outcome) ? receipt.outcome : 'unknown';
  const cleanup = plain(receipt.cleanup) ? receipt.cleanup : {};
  const cleanupConsistent = cleanup.removed !== false && cleanup.verifiedAbsent !== false;
  const recognized = complete && knownEngine && !conflictingProof;
  const cleanupConfirmed = recognized && cleanup.confirmed === true && cleanupConsistent;
  const isolationVerified = recognized && receipt.isolationVerified === true;
  const notStarted = recognized && outcome === 'not_started' && dispatchAttempted !== null && codeMayHaveRun === false && cleanupConfirmed;
  const finished = recognized && outcome === 'finished' && dispatchAttempted === true && codeMayHaveRun === true;
  const termination = text(receipt.termination), exitCode = Number.isSafeInteger(receipt.exitCode) ? receipt.exitCode : null;
  const reportedOk = bool(proof.programOk), issues = [];
  if (!complete) issues.push('A complete settled audit was not supplied. No finished or not-started outcome is confirmed.');
  if (!knownEngine || conflictingProof) issues.push('The engine identity or proof is not the recognized Docker isolation contract.');
  if (outcome === 'finished' && !finished || outcome === 'not_started' && !notStarted) issues.push('The declared outcome conflicts with missing or inconsistent dispatch facts.');
  if (!cleanupConsistent) issues.push('Cleanup confirmation conflicts with the recorded removal or absence evidence.');
  if (reportedOk === true && (termination !== 'exit' || exitCode !== 0)) issues.push('The reported successful code result has no matching normal zero exit status.');
  let label = 'Code outcome unknown or unconfirmed';
  if (notStarted) label = 'Code did not start';
  else if (finished) {
    if (termination === 'timeout') label = 'Code timed out';
    else if (termination === 'cancelled') label = 'Code execution cancelled';
    else if (termination === 'output_limit') label = 'Code stopped · output limit';
    else if (termination === 'exit' && exitCode !== null) label = `Code exited · status ${exitCode}`;
    else label = 'Execution finished · code result not confirmed';
  }
  const limits = {};
  for (const key of ['timeoutMs', 'maxOutputBytes', 'memoryBytes', 'pids', 'maxConcurrent']) {
    if (integer(proof.limits?.[key]) && proof.limits[key] > 0 && proof.limits[key] <= 1e12) limits[key] = proof.limits[key];
  }
  if (Number.isFinite(proof.limits?.cpus) && proof.limits.cpus > 0 && proof.limits.cpus <= 1e6) limits.cpus = proof.limits.cpus;
  return { effectId: receipt.effectId, engine: knownEngine ? 'docker' : 'Unrecognized engine', outcome, complete, label,
    dispatchAttempted, codeMayHaveRun, isolationVerified, cleanupConfirmed, reportedCleanupConfirmed: bool(cleanup.confirmed),
    cleanupRemoved: bool(cleanup.removed), cleanupVerifiedAbsent: bool(cleanup.verifiedAbsent),
    language: ['javascript', 'python'].includes(receipt.language) ? receipt.language : null,
    termination, exitCode, errorCode: identifier(receipt.errorCode) ? receipt.errorCode : null, reportedOk, limits, issues, notStarted, finished,
    network: bool(proof.network), hostMounts: bool(proof.hostMounts),
    image: typeof proof.image === 'string' && /^sha256:[a-f0-9]{64}$/.test(proof.image) ? proof.image : null,
    successfulExit: finished && termination === 'exit' && exitCode === 0 && reportedOk === true,
    uncertain: !complete || !knownEngine || conflictingProof || outcome === 'unknown' || !cleanupConfirmed
      || !isolationVerified && !notStarted || issues.length > 0 };
}

// A final audit can arrive before source-run completion, after cancellation,
// or during history replay. Incomplete records wait for a terminal source run.
// A later confirmed receipt clears the key, causing a read to resolve stale
// unavailable health without repeating any execution.
export function codeHealthInvalidationKey(run) {
  if (!run) return '';
  const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
  const receipts = (run.codeReceipts || []).map(codeExecutionReceipt).filter(receipt => receipt && receipt.uncertain && (receipt.complete || terminal));
  return receipts.length ? JSON.stringify({ runId: run.runId, receipts: receipts.map(receipt => ({
    effectId: receipt.effectId, engine: receipt.engine, outcome: receipt.outcome, complete: receipt.complete,
    dispatchAttempted: receipt.dispatchAttempted, codeMayHaveRun: receipt.codeMayHaveRun,
    cleanupConfirmed: receipt.cleanupConfirmed, reportedCleanupConfirmed: receipt.reportedCleanupConfirmed,
    cleanupRemoved: receipt.cleanupRemoved, cleanupVerifiedAbsent: receipt.cleanupVerifiedAbsent,
    isolationVerified: receipt.isolationVerified, issues: receipt.issues
  })) }) : '';
}

export function shouldRefreshCodeHealth(previousKey, nextKey) {
  return (previousKey || '') !== (nextKey || '') && Boolean(previousKey || nextKey);
}

export async function refreshCodeHealth({ signal, onHealth, fetchImpl = fetch } = {}) {
  signal?.throwIfAborted();
  onHealth?.(null);
  const payload = await readAgentJson('/api/agent/capabilities', { signal, fetchImpl, timeoutMs: 15000, maxReadRetries: 2 });
  signal?.throwIfAborted();
  if (!plain(payload) || !plain(payload.codeExecution)) throw new Error('The server did not return a code execution health snapshot.');
  onHealth?.(payload.codeExecution);
  return payload.codeExecution;
}
