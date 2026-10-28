import React from 'react';
import { codeExecutionReceipt } from './code-receipts.mjs';

const booleanFact = value => value === true ? 'Yes' : value === false ? 'No' : 'Not recorded';
const shown = value => value === null ? 'Not recorded' : value;

export default function CodeExecutionReceipt({ receipt }) {
  const value = codeExecutionReceipt(receipt);
  if (!value) return <section aria-label="Incomplete code execution audit"><strong>Code outcome unconfirmed.</strong><p>The independent audit is incomplete. Review its raw JSON; no execution or cleanup success can be inferred.</p></section>;
  return <section className="execution-details" aria-label="Independent code execution audit">
    <strong>{value.label}</strong>
    <p>This independent receipt records the code call separately from the source run. A finished execution does not imply a successful code result.</p>
    <p>Execution intent records the engine invocation attempt. It does not prove that the source code was submitted or ran.</p>
    <dl>
      <div><dt>Effect</dt><dd><code>{value.effectId}</code></dd></div>
      <div><dt>Engine / language</dt><dd>{value.engine} / {shown(value.language)}</dd></div>
      <div><dt>Settled audit</dt><dd>{value.complete ? 'Recorded complete' : 'Not confirmed complete'}</dd></div>
      <div><dt>Execution intent / engine call attempted</dt><dd>{booleanFact(value.dispatchAttempted)}</dd></div>
      <div><dt>Code may have run</dt><dd>{booleanFact(value.codeMayHaveRun)}</dd></div>
      <div><dt>Recorded isolation</dt><dd>{value.isolationVerified ? 'Docker isolation verified in this audit' : 'Not confirmed'}</dd></div>
      <div><dt>Recorded network / host mounts</dt><dd>{value.network === false ? 'Disabled' : value.network === true ? 'Allowed' : 'Not recorded'} / {value.hostMounts === false ? 'None' : value.hostMounts === true ? 'Allowed' : 'Not recorded'}</dd></div>
      {value.image && <div><dt>Recorded runtime image</dt><dd><code style={{ overflowWrap: 'anywhere' }}>{value.image}</code></dd></div>}
      <div><dt>Cleanup</dt><dd>{value.cleanupConfirmed ? 'Confirmed in settled audit' : 'Unconfirmed · do not infer the process or container is gone'}</dd></div>
      <div><dt>Container removal / absence</dt><dd>{booleanFact(value.cleanupRemoved)} / {booleanFact(value.cleanupVerifiedAbsent)}</dd></div>
      <div><dt>Termination / exit status</dt><dd>{shown(value.termination)} / {shown(value.exitCode)}</dd></div>
      {value.errorCode && <div><dt>Execution error code</dt><dd><code>{value.errorCode}</code></dd></div>}
      <div><dt>Reported code result</dt><dd>{value.notStarted ? 'No program execution recorded' : value.reportedOk === true ? 'Reported success' : value.reportedOk === false ? 'Reported failure' : 'Not recorded'}</dd></div>
      {Object.entries(value.limits).map(([key, limit]) => <div key={key}><dt>{({ timeoutMs: 'Time limit · ms', maxOutputBytes: 'Output limit · bytes', memoryBytes: 'Memory limit · bytes', pids: 'Process limit', maxConcurrent: 'Concurrent calls', cpus: 'CPU limit · cores' })[key]}</dt><dd>{limit.toLocaleString('en-US')}</dd></div>)}
    </dl>
    {value.issues.length > 0 && <ul>{value.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
    {value.uncertain && <p className="receipt-error">Execution or cleanup remains uncertain. Do not retry the code automatically. Read refreshed code health and the durable audit before deciding on further work.</p>}
    <p>Source-run cancellation does not prove that code never ran or that cleanup finished. This view performs no execution, retry or cleanup action.</p>
  </section>;
}
