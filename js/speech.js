// Continuous browser speech recognition (Chrome / Edge) that auto-restarts.
// Newer Chrome versions accept a MediaStreamTrack in start(), so the mixed
// audio sources are recognised directly. Older versions ignore the track and
// use the system default microphone.

export class LiveRecognizer {
  constructor({ lang, onInterim, onFinal, onState, onError }) {
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.wanted = false;
    this.rec = null;
  }

  static supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start(track) {
    this.wanted = true;
    this.track = track || null;
    this._spawn();
  }

  stop() {
    this.wanted = false;
    const r = this.rec;
    this.rec = null;
    try {
      r && r.stop();
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

    r.onstart = () => this.onState("listening");
    r.onresult = (e) => {
      if (this.rec !== r) return;
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
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.wanted = false;
      this.onError(e.error);
    };
    r.onend = () => {
      if (this.rec !== r) return;
      if (this.wanted) {
        this.onState("restarting");
        setTimeout(() => this.wanted && this.rec === r && this._spawn(), 200);
      } else {
        this.onState("stopped");
      }
    };

    this.rec = r;
    try {
      if (this.track) r.start(this.track);
      else r.start();
    } catch (err) {
      try {
        r.start();
      } catch (err2) {
        this.onError(err2.message || String(err2));
      }
    }
  }
}
