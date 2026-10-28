import React from 'react';
import { validateWorkspaceEditPreview, workspaceEditReceipt } from './workspace-edits.mjs';

const styles = {
  card: { border: '1px solid var(--border, #c8c8c8)', borderRadius: 8, padding: 12, margin: '9px 0', background: 'var(--bg, #fff)', fontSize: 12, minWidth: 0 },
  facts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px 14px', margin: '10px 0' },
  label: { color: 'var(--muted, #555)', fontSize: 11 },
  value: { margin: '2px 0 0', overflowWrap: 'anywhere' },
  note: { margin: '7px 0', overflowWrap: 'anywhere' },
  edit: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border, #c8c8c8)' },
  scroll: { overflow: 'auto', maxHeight: 440, border: '1px solid var(--border, #c8c8c8)', borderRadius: 6, margin: '7px 0' },
  table: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 11, textAlign: 'left' },
  heading: { padding: 6, background: 'var(--surface-2, #eee)', fontWeight: 600 },
  cell: { padding: '5px 7px', verticalAlign: 'top', borderTop: '1px solid #d6d6d6' },
  removed: { background: '#fff0ee', color: '#741d1d' },
  added: { background: '#edf8f0', color: '#15572d' },
  literal: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', tabSize: 4, fontFamily: 'monospace', unicodeBidi: 'plaintext' },
  marker: { fontSize: 10, marginLeft: 6, color: '#555', fontFamily: 'sans-serif', whiteSpace: 'normal' }
};
const endingLabel = ending => ({ '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR', '': 'no line break at fragment end' })[ending];

function VisibleLiteral({ text }) {
  const controls = /[\u0001-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(controls)) {
    parts.push(text.slice(offset, match.index));
    const point = match[0].codePointAt(0), label = `U+${point.toString(16).toUpperCase().padStart(4, '0')}${point === 9 ? ' TAB' : ''}`;
    parts.push(<span key={match.index} style={styles.marker} title={`${label} is present in this exact text`}>⟨{label}⟩</span>);
    offset = match.index + match[0].length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

function LiteralRows({ rows, added }) {
  if (!rows.length) return <p style={styles.note}>{added ? 'Added literal is empty: no added text or line break.' : 'Removed literal is empty: no removed text or line break.'}</p>;
  return <div style={styles.scroll}>
    <table style={styles.table} aria-label={added ? 'Added literal fragment' : 'Removed literal fragment'}>
      <colgroup><col style={{ width: 32 }} /><col style={{ width: 96 }} /><col /></colgroup>
      <thead><tr><th style={styles.heading} scope="col">{added ? '+' : '−'}</th><th style={styles.heading} scope="col">Line : column</th><th style={styles.heading} scope="col">{added ? 'Added literal' : 'Removed literal'} · control/line-ending markers</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index} style={added ? styles.added : styles.removed}>
        <td style={styles.cell} aria-label={added ? 'Added' : 'Removed'}>{added ? '+' : '−'}</td>
        <td style={{ ...styles.cell, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{row.line} : {row.column}</td>
        <td style={styles.cell}><code style={styles.literal}><VisibleLiteral text={row.text} /></code><span style={styles.marker}>⟨{endingLabel(row.ending)}⟩</span></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export default function WorkspaceEditPreview({ preview }) {
  const validation = validateWorkspaceEditPreview(preview);
  if (!validation.valid) return <section style={styles.card} aria-label="Invalid workspace edit preview">
    <strong>Complete edit preview unavailable. Do not approve this change.</strong>
    <ul>{validation.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
    <p style={styles.note}>The structured preview was rejected without truncation. Review the exact raw preview and arguments; the server must supply a complete valid preview before approval.</p>
  </section>;
  const value = validation.preview;
  return <section style={styles.card} aria-label="Exact workspace edit preview">
    <strong>Exact literal replacements · <code style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><VisibleLiteral text={value.path} /></code></strong>
    <dl style={styles.facts}>
      <div><dt style={styles.label}>Expected current SHA-256</dt><dd style={styles.value}><code>{value.expectedHash}</code></dd></div>
      <div><dt style={styles.label}>Proposed SHA-256</dt><dd style={styles.value}><code>{value.newHash}</code></dd></div>
      <div><dt style={styles.label}>UTF-8 bytes · before → after</dt><dd style={styles.value}>{value.bytesBefore} → {value.bytesAfter}</dd></div>
      <div><dt style={styles.label}>Original file UTF-8 BOM</dt><dd style={styles.value}>{value.utf8Bom ? 'Present' : 'Absent'}</dd></div>
      <div><dt style={styles.label}>Original file line endings</dt><dd style={styles.value}>LF {value.lineEndings.lf} · CRLF {value.lineEndings.crlf} · CR {value.lineEndings.cr}</dd></div>
      <div><dt style={styles.label}>Write atomicity</dt><dd style={styles.value}>Non-atomic</dd></div>
    </dl>
    <p style={styles.note}>These are exact replacement fragments, not whole source lines. Surrounding source is not included. Line/column anchors are one-based; columns and original offsets count UTF-16 code units.</p>
    <p style={styles.note}>All literal text is shown without truncation. Scroll or wrap long fragments. Angle-bracket markers identify line endings, TAB, control characters, bidirectional/zero-width controls and U+FEFF; these visual labels are not inserted into the file. A fragment ending without a line break does not imply the end of the file.</p>
    {value.edits.map((edit, index) => <section style={styles.edit} key={index} aria-label={`Literal replacement ${index + 1}`}>
      <strong>Replacement {index + 1}</strong>
      <p style={styles.note}>Original {edit.startLine}:{edit.startColumn} → proposed {edit.newStartLine}:{edit.newStartColumn} · original UTF-16 offset {edit.offsetUtf16}</p>
      <LiteralRows rows={edit.removed} added={false} />
      <LiteralRows rows={edit.added} added />
    </section>)}
    <p style={styles.note}>Approval binds the exact path, hashes and literal edits. Hashes here are recorded preview facts; the server must verify the current file again when applying the change. This native workspace edit is not an atomic transaction.</p>
  </section>;
}

const recorded = value => value === null ? 'Not recorded' : value;
export function WorkspaceEditReceipt({ receipt }) {
  const value = workspaceEditReceipt(receipt);
  if (!value) return <section style={styles.card} aria-label="Incomplete workspace edit audit"><strong>Workspace edit outcome is not confirmed.</strong><p>Durable receipt metadata is incomplete. Review the raw audit; no successful edit can be inferred.</p></section>;
  return <section style={styles.card} aria-label="Durable workspace edit receipt">
    <strong style={value.unknownEffect ? { color: '#8c2020' } : undefined}>{value.label} · workspace edit</strong>
    <dl style={styles.facts}>
      <div><dt style={styles.label}>Effect / path</dt><dd style={styles.value}>{value.effectId} · <code><VisibleLiteral text={recorded(value.path)} /></code></dd></div>
      <div><dt style={styles.label}>Recorded outcome / verification</dt><dd style={styles.value}>{value.outcome} / {value.recordedVerified === null ? 'Not recorded' : String(value.recordedVerified)}</dd></div>
      <div><dt style={styles.label}>Dispatch attempted</dt><dd style={styles.value}>{value.dispatchAttempted === null ? 'Not recorded' : value.dispatchAttempted ? 'Yes' : 'No'}</dd></div>
      <div><dt style={styles.label}>Expected current SHA-256</dt><dd style={styles.value}><code>{recorded(value.expectedHash)}</code></dd></div>
      <div><dt style={styles.label}>Proposed SHA-256</dt><dd style={styles.value}><code>{recorded(value.newHash)}</code></dd></div>
      <div><dt style={styles.label}>Observed SHA-256</dt><dd style={styles.value}><code>{recorded(value.observedHash)}</code></dd></div>
      <div><dt style={styles.label}>UTF-8 bytes · before / proposed / observed</dt><dd style={styles.value}>{recorded(value.bytesBefore)} / {recorded(value.bytesAfter)} / {recorded(value.observedBytes)}</dd></div>
      <div><dt style={styles.label}>Edit count / atomicity</dt><dd style={styles.value}>{recorded(value.editCount)} / {value.atomic === false ? 'Non-atomic' : 'Not recorded'}</dd></div>
      {value.code && <div><dt style={styles.label}>Recorded code</dt><dd style={styles.value}>{value.code}</dd></div>}
    </dl>
    {value.unknownEffect && <p style={{ ...styles.note, color: '#8c2020' }}>The file effect is uncertain. Do not infer success or retry this edit automatically. Inspect the current file before deciding what to do next.</p>}
    <p style={styles.note}>This durable audit keeps its own effect ID even after the source run ends. Source-run cancellation does not imply that a dispatched file change was undone. No automatic retry or undo is performed.</p>
  </section>;
}
