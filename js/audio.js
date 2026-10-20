// Mixes one or more audio input devices into a single track
// (for speech recognition) and exposes level meters.

export class AudioMixer {
  constructor() {
    this.ctx = null;
    this.sources = new Map();
    this.voiceCleanup = true;
  }

  static async requestPermission() {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  }

  static async listInputs() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput" && d.deviceId);
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 1024;
      this.dest = this.ctx.createMediaStreamDestination();
      this.master.connect(this.masterAnalyser);
      this.master.connect(this.dest);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  async addSource(deviceId, label) {
    await this.ensureContext();
    if (this.sources.has(deviceId)) return this.sources.get(deviceId);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: this.voiceCleanup,
        autoGainControl: this.voiceCleanup,
      },
    });
    const node = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(gain);
    gain.connect(analyser);
    gain.connect(this.master);
    const src = { deviceId, label, stream, node, gain, analyser };
    this.sources.set(deviceId, src);
    return src;
  }

  removeSource(deviceId) {
    const src = this.sources.get(deviceId);
    if (!src) return;
    src.node.disconnect();
    src.gain.disconnect();
    src.stream.getTracks().forEach((t) => t.stop());
    this.sources.delete(deviceId);
  }

  setGain(deviceId, value) {
    const src = this.sources.get(deviceId);
    if (src) src.gain.gain.value = value;
  }

  // Returns 0..1 (RMS scaled so normal speech sits around 0.3–0.7)
  static level(analyser) {
    if (!analyser) return 0;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  get outputTrack() {
    return this.dest ? this.dest.stream.getAudioTracks()[0] : null;
  }

  get hasSources() {
    return this.sources.size > 0;
  }
}
