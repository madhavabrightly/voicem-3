/**
 * VoiceConfirmator — Interactive voice consent & confirmation gate.
 *
 * Enforces the user's safety requirement: "no auto doing without my consent".
 * Speaks the confirmation request aloud to the user, waits for a spoken
 * voice command ("yes", "proceed", "cancel", "stop"), and returns a boolean.
 */
export class VoiceConfirmator {
  /**
   * @param {object} p
   * @param {object} p.voice VoiceInterface or WindowsVoiceInterface
   * @param {object} [p.logger] console
   * @param {number} [p.timeoutMs] max time to wait for voice confirmation (default 12s)
   */
  constructor({ voice, logger = console, timeoutMs = 12000 } = {}) {
    this.voice = voice;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Prompts the user for voice confirmation before an action is executed.
   * @param {string} question e.g. "Allow high action: click 'Send'?"
   * @param {object} [context]
   * @returns {Promise<boolean>} true if user spoke consent, false if declined or timed out
   */
  async confirm(question, context = {}) {
    const promptText = `Consent required. ${question}. Say yes to proceed, or no to cancel.`;
    this.logger.log?.(`[consent:prompt] ${promptText}`);

    // Speak the question aloud to the user
    if (typeof this.voice?.speak === "function") {
      this.voice.speak(promptText);
    } else if (typeof this.voice?.tts === "function") {
      this.voice.tts(promptText).catch(() => {});
    }

    return new Promise(async (resolve) => {
      let settled = false;
      let timer = null;

      const finish = (approved, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.voice && typeof this.voice.onTranscript === "function") {
          // Restore normal handler
        }
        this.logger.log?.(`[consent:resolved] approved=${approved} (${reason})`);
        if (typeof this.voice?.speak === "function") {
          this.voice.speak(approved ? "Proceeding." : "Cancelled.");
        }
        resolve(approved);
      };

      // Set timeout fallback
      timer = setTimeout(() => {
        finish(false, "voice_consent_timeout");
      }, this.timeoutMs);

      // Temporary hook on speech transcripts to catch consent
      const originalHandler = this.voice._onTranscript;
      const consentHandler = async (text) => {
        const spoken = String(text || "").toLowerCase().trim();
        if (!spoken) return;

        // Positive consent patterns
        if (/^(?:yes|yeah|yep|yup|proceed|confirm|do\s+it|go\s+ahead|allow|okay|ok|sure|execute|continue)\b/i.test(spoken)) {
          this.voice._onTranscript = originalHandler;
          finish(true, `user_said_${spoken}`);
          return;
        }

        // Negative refusal patterns
        if (/^(?:no|nope|cancel|stop|abort|don't|do\s+not|never|refuse|wait|decline)\b/i.test(spoken)) {
          this.voice._onTranscript = originalHandler;
          finish(false, `user_said_${spoken}`);
          return;
        }
      };

      this.voice.onTranscript(consentHandler);

      // Start listening if not already listening
      try {
        await this.voice.start?.();
      } catch {
        finish(false, "voice_start_failed");
      }
    });
  }
}
