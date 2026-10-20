// Continuous browser speech recognition (Chrome / Edge) that auto-restarts.
// Newer Chrome versions accept a MediaStreamTrack in start(), so the mixed
// audio sources are recognised directly. If that fails repeatedly we fall back
// to the system default microphone. Quick repeated failures back off instead
// of hammering the speech service, and the last error is reported.

const QUICK_FAIL_MS = 3000; // a session shorter than this with no speech counts as a failure

export class LiveRecognizer {
  constructor({ lang, onInterim, onFinal, onState, onError, onNotice }) {
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.onNotice = onNotice || (() => {});
    this.wanted = false;
    this.rec = null;
    this.fails = 0; // consecutive quick failures
    this.abortedRuns = 0;
  }

  static supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start(track) {
    this.wanted = true;
    this.track = track || null;
    this.useTrack = !!track;
    this.fails = 0;
    this.abortedRuns = 0;
    this._spawn();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    const r = this.rec;
    this.rec = null;
    try {
      r && r.abort();
    } catch {}
    this.onInterim("");
    this.onState("stopped");
  }

  _spawn() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new Rec();
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    const run = { startedAt: Date.now(), heard: false, error: null };

    r.onstart = () => this.onState("listening");
    r.onresult = (e) => {
      if (this.rec !== r) return;
      run.heard = true;
      this.fails = 0;
      this.abortedRuns = 0;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (res.isFinal) {
          if (text) this.onFinal(text);
        } else {
          interim += (interim ? " " : "") + text;
        }
      }
      this.onInterim(interim);
    };
    r.onerror = (e) => {
      if (this.rec !== r) return;
      run.error = e.error;
      if (e.error === "no-speech") return; // normal during silence
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "language-not-supported") {
        this.wanted = false;
      }
      if (e.error !== "aborted") this.onError(e.error);
    };
    r.onend = () => {
      if (this.rec !== r) return;
      if (!this.wanted) return this.onState("stopped");

      const quick = !run.heard && Date.now() - run.startedAt < QUICK_FAIL_MS;
      this.fails = quick ? this.fails + 1 : 0;

      // Another page/app in this browser keeps taking the speech service from us.
      if (run.error === "aborted") this.abortedRuns++;
      else if (!quick) this.abortedRuns = 0;
      if (this.abortedRuns >= 3) {
        this.onError("aborted-loop");
        this.abortedRuns = 0;
      }

      // The browser accepted the mixed track but recognition won't run with it.
      if (this.useTrack && this.fails >= 3) {
        this.useTrack = false;
        this.fails = 0;
        this.onNotice(
          "This browser can't run speech recognition on the selected audio mix, so it's using the Windows default microphone instead. Set your source as the default recording device in Windows Sound settings."
        );
      }

      const delay = Math.min(5000, 250 * 2 ** Math.min(this.fails, 5));
      this.onState("restarting", { reason: run.error, delay });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.wanted && this.rec === r && this._spawn(), delay);
    };

    this.rec = r;
    try {
      if (this.useTrack && this.track && this.track.readyState === "live") r.start(this.track);
      else r.start();
    } catch (err) {
      // start(track) unsupported or rejected: fall back to the default microphone.
      this.useTrack = false;
      try {
        r.start();
      } catch (err2) {
        this.onError(err2.message || String(err2));
      }
    }
  }
}
