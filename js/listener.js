import { APP_CONFIG } from "./config.js";
import { LANGUAGES, langByCode, speechLangByCode } from "./languages.js";
import { createTransport } from "./transport.js";

const $ = (id) => document.getElementById(id);
const SRC = "__src"; // "original language" option value

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("bvc-" + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("bvc-" + k, JSON.stringify(v));
    } catch {}
  },
};

let status = { state: "offline" };
let sessionId = null;
const captions = new Map(); // id -> { src, ts, t }
let preferred = store.get("lang", null); // what the listener picked
let lang = null; // what's selected now (preferred, if it's offered)
let interim = "";
let presence = null;
let net = "connected"; // transports without onNetwork (Firebase, local) handle reconnects themselves

// ── text size ──
let size = store.get("size", 1.35);
const applySize = () => document.documentElement.style.setProperty("--caption-size", size + "rem");
applySize();
$("smaller").onclick = () => { size = Math.max(0.9, +(size - 0.15).toFixed(2)); applySize(); store.set("size", size); };
$("bigger").onclick = () => { size = Math.min(3, +(size + 0.15).toFixed(2)); applySize(); store.set("size", size); };

$("church").textContent = APP_CONFIG.churchName || "";
document.title = `${APP_CONFIG.appTitle} · ${APP_CONFIG.churchName}`;

// ── helpers ──
const srcCode = () => speechLangByCode(status.sourceLang || "en-US").tr;
const effectiveLang = () => (lang === SRC || !lang ? srcCode() : lang);
const isSourceView = () => effectiveLang() === srcCode();

function textFor(c) {
  if (!c) return null;
  if (isSourceView()) return c.src || null;
  return (c.t && c.t[effectiveLang()]) || null;
}

// ── language select ──
function buildLangOptions() {
  const offered = (status.languages || []).filter((c) => langByCode(c));
  const src = langByCode(srcCode());
  const sel = $("lang");
  const prev = lang;
  sel.innerHTML = "";
  const o = new Option(`${src ? src.native : "Original"} (original)`, SRC);
  sel.add(o);
  for (const code of offered) {
    if (code === srcCode()) continue;
    const l = langByCode(code);
    sel.add(new Option(l.native === l.name ? l.name : `${l.native} — ${l.name}`, code));
  }
  // Pick: listener's saved choice → browser language → original.
  // The saved choice is kept even if it isn't offered right now, so it comes back when it is.
  const values = [...sel.options].map((x) => x.value);
  if (preferred && values.includes(preferred)) lang = preferred;
  else {
    const nav = (navigator.languages || [navigator.language || "en"]).map((x) => x.toLowerCase());
    const match = offered.find((c) => nav.some((n) => n === c.toLowerCase() || n.split("-")[0] === c.split("-")[0].toLowerCase()));
    lang = match && match !== srcCode() ? match : SRC;
  }
  sel.value = lang;
  if (lang !== prev) {
    presence && presence.update(effectiveLang());
    if (prev) (resetSpeechQueue(), checkVoiceAvailable());
  }
}
$("lang").onchange = (e) => {
  lang = preferred = e.target.value;
  store.set("lang", preferred);
  presence && presence.update(effectiveLang());
  resetSpeechQueue();
  checkVoiceAvailable();
  render(true);
};

// ── rendering ──
const feed = $("feed");
let stickToBottom = true;
addEventListener("scroll", () => {
  stickToBottom = innerHeight + scrollY >= document.body.scrollHeight - 120;
  $("jump").hidden = stickToBottom;
});
$("jump").onclick = () => {
  scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
};

function lineEl(id, c) {
  const el = document.createElement("p");
  el.className = "line";
  el.dataset.id = id;
  fillLine(el, c);
  return el;
}
function fillLine(el, c) {
  const t = textFor(c);
  const l = langByCode(effectiveLang());
  el.dir = l && l.rtl ? "rtl" : "auto";
  el.classList.toggle("pending", !t);
  el.textContent = t || "…";
}

function render(full) {
  const connected = net === "connected";
  const live = connected && status.state === "live";
  const hasLines = captions.size > 0;
  const statusEl = $("status");
  if (!connected && hasLines && status.state !== "offline") {
    statusEl.className = "pill paused";
    statusEl.textContent = "Reconnecting…";
  } else {
    const paused = connected && status.state === "paused";
    statusEl.className = "pill " + (live ? "live" : paused ? "paused" : "");
    statusEl.textContent = live ? "Live" : paused ? "Paused" : "Offline";
  }
  $("title").textContent = status.title || APP_CONFIG.appTitle;

  $("waiting").hidden = hasLines;
  if (!hasLines) {
    $("waitTitle").textContent = live ? "We're live" : "Translation hasn't started yet";
    $("waitText").textContent = live
      ? "Waiting for the speaker… captions will appear here."
      : "Keep this page open. Captions appear here automatically when the service begins.";
  }

  if (full) {
    feed.innerHTML = "";
    for (const [id, c] of [...captions.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) feed.appendChild(lineEl(id, c));
  }
  renderInterim();
  if (connected && status.state === "offline" && hasLines && !feed.querySelector(".ended")) {
    const p = document.createElement("p");
    p.className = "muted small ended";
    p.textContent = "— The service has ended. Thank you for joining! —";
    feed.appendChild(p);
  } else if (status.state !== "offline") {
    feed.querySelectorAll(".ended").forEach((x) => x.remove());
  }
  if (stickToBottom) scrollTo({ top: document.body.scrollHeight });
}

function renderInterim() {
  let el = feed.querySelector(".interim");
  const show = isSourceView() && interim && status.state === "live";
  if (!show) return el && el.remove();
  if (!el) {
    el = document.createElement("p");
    el.className = "interim";
  }
  el.textContent = interim + " …";
  feed.appendChild(el); // keep at bottom
}

function upsertCaption(id, c) {
  captions.set(id, c);
  let el = feed.querySelector(`.line[data-id="${CSS.escape(id)}"]`);
  if (el) fillLine(el, c);
  else {
    el = lineEl(id, c);
    // insert in id order (ids are time-sortable)
    const after = [...feed.querySelectorAll(".line")].find((x) => x.dataset.id > id);
    feed.insertBefore(el, after || feed.querySelector(".interim, .ended"));
    $("waiting").hidden = true;
  }
  // trim very long sessions
  while (captions.size > 300) {
    const first = [...captions.keys()].sort()[0];
    captions.delete(first);
    feed.querySelector(`.line[data-id="${CSS.escape(first)}"]`)?.remove();
  }
  enqueueSpeech(id);
  if (stickToBottom) scrollTo({ top: document.body.scrollHeight });
}

// ── read aloud ──
let voiceOn = false;
const spoken = new Set();
let queue = []; // [{ id, since }]
let speaking = false;
let wakeLock = null;

function bestVoice(tag) {
  const voices = speechSynthesis.getVoices();
  const lower = tag.toLowerCase();
  const base = lower.split("-")[0];
  return (
    voices.find((v) => v.lang.toLowerCase().replace("_", "-") === lower && v.localService === false) ||
    voices.find((v) => v.lang.toLowerCase().replace("_", "-") === lower) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(base)) ||
    null
  );
}
function ttsTag() {
  const l = langByCode(effectiveLang());
  return l ? l.tts : effectiveLang();
}
function checkVoiceAvailable() {
  const note = $("voiceNote");
  if (!voiceOn || !("speechSynthesis" in window)) return (note.hidden = true);
  const voices = speechSynthesis.getVoices();
  if (voices.length && !bestVoice(ttsTag())) {
    const l = langByCode(effectiveLang());
    note.textContent = `This device doesn't have a ${l ? l.name : ""} voice installed, so read-aloud may not work. Captions will still appear.`;
    note.hidden = false;
  } else note.hidden = true;
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = checkVoiceAvailable;

function resetSpeechQueue() {
  queue = [];
  for (const id of captions.keys()) spoken.add(id);
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  speaking = false;
}

function enqueueSpeech(id) {
  if (!voiceOn || spoken.has(id) || queue.some((q) => q.id === id)) return;
  queue.push({ id, since: Date.now() });
  // If we fall behind, skip ahead so listeners stay close to live.
  while (queue.length > 4) spoken.add(queue.shift().id);
  pump();
}

function pump() {
  if (!voiceOn || speaking || !queue.length) return;
  const head = queue[0];
  const text = textFor(captions.get(head.id));
  if (!text) {
    if (Date.now() - head.since > 8000) {
      spoken.add(queue.shift().id);
      return pump();
    }
    setTimeout(pump, 400);
    return;
  }
  queue.shift();
  spoken.add(head.id);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = ttsTag();
  const v = bestVoice(u.lang);
  if (v) u.voice = v;
  u.rate = queue.length > 1 ? 1.15 : 1.0;
  speaking = true;
  u.onend = u.onerror = () => {
    speaking = false;
    pump();
  };
  speechSynthesis.speak(u);
}

async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) (await wakeLock.release(), (wakeLock = null));
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && voiceOn) keepAwake(true);
});

$("voice").onclick = () => {
  if (!("speechSynthesis" in window)) {
    alert("Sorry, read-aloud isn't supported in this browser.");
    return;
  }
  voiceOn = !voiceOn;
  const b = $("voice");
  b.setAttribute("aria-pressed", String(voiceOn));
  b.textContent = voiceOn ? "🔊 Reading aloud" : "🔈 Read aloud";
  resetSpeechQueue();
  if (voiceOn) {
    // A user-initiated utterance unlocks speech on iPhone/iPad.
    const unlock = new SpeechSynthesisUtterance(" ");
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
  }
  keepAwake(voiceOn);
  checkVoiceAvailable();
};

// ── connect ──
(async () => {
  let transport;
  try {
    transport = await createTransport("listener");
  } catch (err) {
    $("status").textContent = "Connection error";
    $("waitTitle").textContent = "Couldn't connect";
    $("waitText").textContent = "Please check your internet connection and refresh the page.";
    console.error(err);
    return;
  }

  transport.onStatus((s) => {
    const changedSession = sessionId && s.sessionId && s.sessionId !== sessionId;
    status = s || { state: "offline" };
    if (s.sessionId) sessionId = s.sessionId;
    if (changedSession) {
      captions.clear();
      resetSpeechQueue();
    }
    buildLangOptions();
    if (!presence) presence = transport.joinPresence(effectiveLang());
    if (status.state === "offline") queue = [];
    render(true);
  });
  if (transport.onNetwork) {
    transport.onNetwork((s) => {
      net = s;
      render(false);
    });
  }
  transport.onCaptions((id, c) => c && upsertCaption(id, c));
  transport.onInterim((text) => {
    interim = text;
    renderInterim();
    if (stickToBottom && interim) scrollTo({ top: document.body.scrollHeight });
  });
})();
