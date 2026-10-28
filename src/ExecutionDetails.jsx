import React from 'react';
import { executionStatus, executionFacts } from './execution.mjs';

export default function ExecutionDetails({ execution, receipt = false, checkedAt }) {
  const status = executionStatus(execution, { receipt });
  const observedAt = execution?.checkedAt || checkedAt;
  return <section className={`execution-details execution-${status.tone}`} aria-label={receipt ? 'Recorded code execution isolation' : 'Code execution health'}>
    <strong>{status.title}</strong>
    <p>{status.description}</p>
    {observedAt && <p>{receipt ? 'Execution metadata recorded' : 'Health response checked'} at {new Date(observedAt).toLocaleTimeString()}.</p>}
    {execution?.reason && <p>{execution.reason}</p>}
    {execution && <dl>{executionFacts(execution, { receipt }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {execution?.images && <details><summary>Configured image IDs</summary><pre>{JSON.stringify(execution.images, null, 2)}</pre></details>}
  </section>;
}
