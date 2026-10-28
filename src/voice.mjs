import { fetchJson } from './protocol.mjs';

export function createVoiceAdapter({ fetchImpl = fetch, onStatus = () => {} } = {}) {
  let recognition = null;
  let playing = null;
  let objectUrl = null;
  let speechController = null;
  let speechGeneration = 0;
  let health = null;
  let label = 'Voice unchecked';
  const enabled = value => value === true || value?.available === true || value?.enabled === true;
  function stopSpeech() {
    speechGeneration++;
    speechController?.abort();
    speechController = null;
    if (playing) { playing.pause(); playing = null; }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  }
  async function probe() {
    try {
      health = await fetchJson('/api/voice/health', {}, 1500, fetchImpl);
      const caps = health.capabilities || health;
      const tts = caps.tts;
      const ready = health.ready !== false && health.voice_ready !== false;
      label = enabled(tts) && ready
        ? `Bridge TTS${health.engine || tts?.engine ? ': ' + (health.engine || tts.engine) : ''}${enabled(caps.voice_cloning) ? ' · cloning available' : ''}`
        : 'Browser speech synthesis';
    } catch {
      health = null;
      label = 'Browser speech synthesis · bridge unavailable';
    }
    onStatus(label);
    return { label, health };
  }
  function stopListening() {
    try { recognition?.stop(); } catch {}
    recognition = null;
  }
  function listen({ allowed = false, onFinal, onInterim, onEnd, onError }) {
    if (!allowed) { onError?.('Enable browser speech recognition first; the browser may send audio to its speech service.'); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { onError?.('Speech recognition is unavailable in this browser.'); return; }
    stopListening();
    const rec = recognition = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = event => {
      let final = '', interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) final += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      onInterim?.(interim);
      if (final.trim()) onFinal?.(final.trim());
    };
    rec.onend = () => { if (recognition === rec) recognition = null; onEnd?.(); };
    rec.onerror = event => { onError?.(event.error === 'not-allowed' ? 'Microphone permission was denied.' : event.error); onEnd?.(); };
    try { rec.start(); } catch (error) { onError?.(error.message); onEnd?.(); }
  }
  async function speak(text) {
    stopSpeech();
    const current = speechGeneration;
    const caps = health?.capabilities || health;
    if (enabled(caps?.tts) && health.ready !== false && health.voice_ready !== false) {
      const controller = speechController = new AbortController();
      const response = await fetchImpl('/api/voice/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'partner' }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
      });
      if (!response.ok) throw new Error(`Voice bridge: HTTP ${response.status}`);
      const blob = await response.blob();
      if (current !== speechGeneration) return;
      objectUrl = URL.createObjectURL(blob);
      const audio = playing = new Audio(objectUrl);
      audio.onended = () => { if (playing === audio) stopSpeech(); };
      await audio.play();
      return;
    }
    if (!window.speechSynthesis) throw new Error('Speech synthesis is unavailable.');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    window.speechSynthesis.speak(utterance);
  }
  return { probe, listen, stopListening, speak, stopSpeech, get label() { return label; } };
}
