import React from 'react';
import { taskChangeReceipt, taskDate } from './tasks.mjs';

export default function TaskChangeReceipt({ receipt }) {
  const value = taskChangeReceipt(receipt);
  if (!value) return <p>Task-change receipt metadata is incomplete. Review the raw durable receipt.</p>;
  return <section className="task-change-receipt" aria-label="Durable scheduled task change">
    <strong>Task change acknowledged · {value.operation} · {value.status}</strong>
    <dl>
      <div><dt>Task / request</dt><dd>{value.taskId} · {value.requestId}</dd></div>
      <div><dt>Revision / generation</dt><dd>{value.revision ?? 'Not recorded'} / {value.generation ?? 'Not recorded'}</dd></div>
      <div><dt>Next run at acknowledgement</dt><dd>{value.nextRunRecorded ? taskDate(value.nextRunAt) : 'Not recorded'}</dd></div>
      <div><dt>Lifetime run / token limits</dt><dd>{value.limits.maxRuns ?? 'Not recorded'} / {value.limits.maxTotalTokens ?? 'Not recorded'}</dd></div>
      <div><dt>Local-only scope</dt><dd>{value.localOnly ? 'Confirmed in this receipt' : 'Not confirmed in this receipt'}</dd></div>
    </dl>
    <p>This records a saved task change, including when its source run was cancelled. It does not report an occurrence's execution outcome. Read the current task for its latest state.</p>
  </section>;
}
