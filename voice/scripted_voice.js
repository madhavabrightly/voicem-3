/**
 * Scripted voice source — DEVELOPMENT / TESTING ONLY.
 *
 * Implements the VoiceInterface surface but emits a fixed transcript instead of
 * using a microphone or AssemblyAI. Used by `--simulate`. It is never selected
 * by a normal launch (see `parseStartArgs`: production is the default).
 */
export const SCRIPTED_PARTIALS = ["Open WhatsApp", "Open WhatsApp and search", "Open WhatsApp and search for Dad"];
export const SCRIPTED_FINAL = "Open WhatsApp and search for Dad";

export function createScriptedVoice({
  partials = SCRIPTED_PARTIALS,
  final = SCRIPTED_FINAL,
  initialDelayMs = 350,
  stepMs = 400,
  finalDelayMs = 350,
} = {}) {
  const handlers = { audio: [], partial: [], error: [], transcript: null };
  let timers = [];

  const clearAll = () => {
    for (const timer of timers) clearInterval(timer);
    timers = [];
  };

  return {
    onAudio(cb) { handlers.audio.push(cb); },
    onPartial(cb) { handlers.partial.push(cb); },
    onError(cb) { handlers.error.push(cb); },
    onTranscript(cb) { handlers.transcript = cb; },

    async start() {
      let phase = 0;
      timers.push(setInterval(() => {
        phase += 0.35;
        const level = 0.25 + 0.22 * Math.abs(Math.sin(phase)) + Math.random() * 0.08;
        for (const cb of handlers.audio) cb(level);
      }, 50));

      partials.forEach((partial, i) => {
        timers.push(setTimeout(() => {
          for (const cb of handlers.partial) cb(partial);
          if (i === partials.length - 1) {
            timers.push(setTimeout(async () => {
              clearAll();
              await handlers.transcript?.(final);
            }, finalDelayMs));
          }
        }, initialDelayMs + i * stepMs));
      });
    },

    async stop() {
      clearAll();
    },
  };
}
