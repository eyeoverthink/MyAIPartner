import React from 'react';
import { reviewAudioAttachment, audioTranscriptDraft } from './audio-attachment.mjs';

export default function AudioAttachmentReview({ asset, disabled = false, onUseDraft }) {
  const audio = reviewAudioAttachment(asset);
  if (!audio) return null;
  const number = value => value === null ? 'Not reported' : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return <section className="audio-attachment-review" aria-label="Uploaded WAV transcript review">
    <strong>Machine transcript · untrusted reference text</strong>
    <dl>
      <div><dt>Duration / language</dt><dd>{audio.durationSeconds === null ? 'Not reported' : `${number(audio.durationSeconds)} s`} · {audio.language || 'Not reported'}</dd></div>
      <div><dt>Engine</dt><dd>{audio.engine || 'Not reported'}</dd></div>
      {audio.model && <div><dt>Model / revision</dt><dd><code>{audio.model.id}</code> · <code>{audio.model.revision || 'Revision not recorded'}</code></dd></div>}
      <div><dt>{audio.scoreLabel}</dt><dd>{number(audio.confidence)}</dd></div>
      {audio.scoreKind === 'decoder' && <div><dt>Score metric</dt><dd>{audio.confidenceMetric || 'Not reported or unrecognized'}</dd></div>}
      <div><dt>Sample rate / channels</dt><dd>{audio.sampleRate === null ? 'Not reported' : `${number(audio.sampleRate)} Hz`} · {number(audio.channels)}</dd></div>
    </dl>
    {audio.scoreKind === 'decoder' && <p>The decoder score is not transcription accuracy or a language probability.</p>}
    <details><summary>{audio.transcriptTruncated ? 'Bounded machine transcript' : 'Full machine transcript'} · {audio.transcript.length.toLocaleString()} characters</summary><pre>{audio.transcript || 'No transcript text returned.'}</pre></details>
    {audio.transcriptTruncated && <p>Draft text is limited to 12,000 characters.</p>}
    {audio.assetUrl && <details><summary>Local audio playback</summary><audio controls preload="none" src={audio.assetUrl} aria-label={`Play uploaded WAV ${asset.name || ''}`}>Audio playback is unavailable in this browser.</audio></details>}
    <button type="button" disabled={disabled || !audio.transcript} onClick={() => onUseDraft?.(audioTranscriptDraft(asset))}>Use transcript as draft</button>
    <p>Review and edit the draft, then send it explicitly. Uploading or reviewing a transcript does not submit it as your instruction.</p>
  </section>;
}
