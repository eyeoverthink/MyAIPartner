import { attachmentMime } from './protocol.mjs';

export const MAX_AUDIO_TRANSCRIPT_CHARS = 12000;

export function localAudioAssetUrl(asset) {
  const id = asset?.assetId || asset?.id;
  if (attachmentMime({ type: asset?.mimeType, name: asset?.name }) !== 'audio/wav'
    || typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id)) return null;
  return '/api/agent/assets/' + encodeURIComponent(id);
}

export function reviewAudioAttachment(asset) {
  const document = asset?.document;
  if (!document || document.kind !== 'audio') return null;
  const raw = typeof document.transcript === 'string' ? document.transcript : '';
  const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
  const engine = typeof document.engine === 'string' ? document.engine : '';
  const whisper = engine === 'faster-whisper-cpu';
  const modelId = typeof document.model?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(document.model.id) ? document.model.id : null;
  const revision = typeof document.model?.revision === 'string' && /^[a-f0-9]{40}$/i.test(document.model.revision) ? document.model.revision : null;
  return {
    transcript: raw.slice(0, MAX_AUDIO_TRANSCRIPT_CHARS), transcriptTruncated: raw.length > MAX_AUDIO_TRANSCRIPT_CHARS,
    textChars: Number.isSafeInteger(document.textChars) && document.textChars >= 0 ? document.textChars : raw.length,
    untrusted: true,
    engine,
    model: modelId ? { id: modelId, revision } : null,
    scoreKind: whisper ? 'decoder' : 'asr',
    scoreLabel: whisper ? 'Decoder score · uncalibrated' : 'ASR confidence · uncalibrated score',
    confidenceMetric: whisper && document.confidenceMetric === 'exp_avg_logprob' ? 'exp_avg_logprob' : null,
    language: typeof document.language === 'string' ? document.language : '',
    confidence: Number.isFinite(document.confidence) && document.confidence >= 0 && document.confidence <= 1 ? document.confidence : null,
    durationSeconds: nonnegative(document.durationSeconds),
    sampleRate: Number.isFinite(document.sampleRate) && document.sampleRate > 0 ? document.sampleRate : null,
    channels: Number.isSafeInteger(document.channels) && document.channels > 0 ? document.channels : null,
    assetUrl: localAudioAssetUrl(asset)
  };
}

// Calling code must apply this only after an explicit draft action. It never
// submits a run or promotes an attached transcript into the authored goal.
export function audioTranscriptDraft(asset) {
  return reviewAudioAttachment(asset)?.transcript || '';
}
