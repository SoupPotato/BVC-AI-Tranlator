import { APP_CONFIG } from "./config.js";
import { LANGUAGES, SPEECH_LANGS, langByCode, speechLangByCode } from "./languages.js";
import { createTransport } from "./transport.js";
import { translateText, warmUpOnDevice, onDeviceAvailable } from "./translate.js";
import { AudioMixer } from "./audio.js";
import { LiveRecognizer } from "./speech.js";

const $ = (id) => document.getElementById(id);

// ── persisted admin settings ──
const SETTINGS_KEY = "bvc-admin-settings";
const settings = Object.assign(
  {
    speechLang: APP_CONFIG.defaultSpeechLang || "en-US",
    languages: APP_CONFIG.defaultLanguages || ["es"],
    engine: "auto",
    title: "",
    devices: [], // selected deviceIds
    gains: {},
    cleanup: true,
  },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  })()
);
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
};

let transport;
let state = "offline"; // offline | live | paused
let sessionId = null;
const mixer = new AudioMixer();
mixer.voiceCleanup = settings.cleanup;
let recognizer = null;

$("church").textContent = APP_CONFIG.churchName || "";

// ── installable desktop app ──
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js", { scope: "./admin.html" }).catch((err) => console.warn("Service worker:", err));
}
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("installApp").hidden = false;
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  $("installApp").hidden = true;
});
$("installApp").onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("installApp").hidden = true;
};
if (location.protocol === "file:") {
  const p = document.createElement("p");
  p.className = "notice error";
  p.style.margin = "16px";
  p.textContent =
    "This page was opened from a file, so Chrome will keep asking for microphone permission. " +
    "Open the online control page instead and click “Install app” to get a desktop app: " +
    (APP_CONFIG.listenerUrl ? APP_CONFIG.listenerUrl + "admin.html" : "admin.html on your website");
  document.body.prepend(p);
}
$("listenerUrl").value =
  APP_CONFIG.listenerUrl || location.href.replace(/admin\.html.*$/, "").replace(/[?#].*$/, "");

function showError(msg) {
  const n = $("audioNote");
  n.textContent = msg;
  n.className = "notice error small";
  n.hidden = false;
  console.error(msg);
}
function showNotice(msg) {
  const n = $("audioNote");
  n.textContent = msg;
  n.className = "notice small";
  n.hidden = false;
}

// Only one control window may listen at a time (Chrome allows a single active
// speech recognizer, and two would cancel each other endlessly). When one goes
// live, any other control window in this browser pauses itself.
const adminChannel = "BroadcastChannel" in window ? new BroadcastChannel("bvc-admin") : null;
const windowId = Math.random().toString(36).slice(2);
if (adminChannel) {
  adminChannel.onmessage = (e) => {
    if (e.data && e.data.type === "taking-over" && e.data.id !== windowId) {
      // Step aside completely: stop listening and hand the listener room to the other window.
      stopRecognizer();
      state = "offline";
      renderState();
      $("goLive").disabled = true;
      transport && transport.shutdown && transport.shutdown();
      showError("Another control window went live, so this one has stepped aside. Close this window, or reload it to use it again.");
    }
  };
}
const safe = (p) =>
  Promise.resolve(p).catch((err) => {
    const m = String(err && (err.code || err.message || err));
    if (/permission/i.test(m)) {
      showError(
        "Firebase refused the write (permission denied). Make sure your admin UID is in the database rules — see README step 4."
      );
    } else showError("Sync error: " + m);
  });

// ─────────────────────────── broadcast state ───────────────────────────
function statusPayload() {
  return {
    state,
    sessionId,
    title: settings.title || "",
    sourceLang: settings.speechLang,
    languages: settings.languages,
  };
}
const pushStatus = () => safe(transport.setStatus(statusPayload()));

function renderState() {
  const pill = $("statusPill");
  pill.className = "pill " + (state === "live" ? "live" : state === "paused" ? "paused" : "");
  pill.textContent = state === "live" ? "LIVE" : state === "paused" ? "Paused" : "Offline";
  $("goLive").disabled = state === "live";
  $("goLive").textContent = state === "paused" ? "● Resume" : "● Go live";
  $("pause").disabled = state !== "live";
  $("end").disabled = state === "offline";
}

$("goLive").onclick = async () => {
  if (!LiveRecognizer.supported()) {
    alert("Speech recognition isn't available in this browser. Please use Google Chrome or Microsoft Edge on a computer.");
    return;
  }
  if (settings.engine !== "google" && onDeviceAvailable()) warmUpOnDevice(srcTr(), settings.languages);
  if (mixer.ctx && mixer.ctx.state === "suspended") await mixer.ctx.resume();

  if (state === "offline") {
    sessionId = Date.now().toString(36);
    await safe(transport.clearCaptions());
    $("log").innerHTML = "";
    logEntries.clear();
  }
  adminChannel && adminChannel.postMessage({ type: "taking-over", id: windowId });
  state = "live";
  renderState();
  await pushStatus();
  startRecognizer();
};

$("pause").onclick = async () => {
  state = "paused";
  stopRecognizer();
  renderState();
  await pushStatus();
};

$("end").onclick = async () => {
  if (!confirm("End the service? Listeners will see that the translation has ended.")) return;
  state = "offline";
  stopRecognizer();
  renderState();
  await pushStatus();
};

// ─────────────────────────── speech recognition ───────────────────────────
let lastInterimSent = 0;
let interimTimer = null;
function sendInterim(text) {
  $("interim").textContent = text || (state === "live" ? "Listening…" : "Not listening.");
  clearTimeout(interimTimer);
  const now = Date.now();
  const go = () => {
    lastInterimSent = Date.now();
    safe(transport.setInterim(state === "live" ? text : ""));
  };
  if (now - lastInterimSent > 350) go();
  else interimTimer = setTimeout(go, 350);
}

function startRecognizer() {
  stopRecognizer();
  recognizer = new LiveRecognizer({
    lang: settings.speechLang,
    onInterim: sendInterim,
    onFinal: (text) => publishLine(text),
    onState: (s, info) => {
      let text = "idle";
      if (s === "listening") text = "listening 🎙";
      else if (s === "restarting") {
        text = "reconnecting…";
        if (info && info.reason && info.reason !== "no-speech") text += ` (last error: ${info.reason})`;
        if (info && info.delay >= 2000) text += ` — retrying in ${Math.round(info.delay / 1000)}s`;
      }
      $("recState").textContent = "Recognition: " + text;
    },
    onNotice: (msg) => showNotice(msg),
    onError: (e) => {
      if (e === "not-allowed" || e === "service-not-allowed")
        showError("Microphone/speech permission was blocked. Allow it in the address bar (or app window's ⋮ → App info → Permissions) and press Go live again.");
      else if (e === "aborted-loop")
        showError(
          "Speech recognition keeps getting cancelled. Another tab, app window or saved copy of this control page is probably listening at the same time — close all other control pages and keep only this one."
        );
      else if (e === "network")
        showError("Speech recognition can't reach its online service (network error). Check the internet connection — retrying…");
      else if (e === "audio-capture") showError("No audio input found. Check your audio source and Windows sound settings.");
      else if (e === "language-not-supported") showError("This browser doesn't support speech recognition for the selected speaker language.");
      else showError("Speech recognition: " + e);
    },
  });
  recognizer.start(mixer.hasSources ? mixer.outputTrack : null);
}
function stopRecognizer() {
  if (recognizer) recognizer.stop();
  recognizer = null;
  sendInterim("");
}

// ─────────────────────────── publishing lines ───────────────────────────
const logEntries = new Map();
const srcTr = () => speechLangByCode(settings.speechLang).tr;

async function publishLine(text) {
  text = text.trim();
  if (!text) return;
  const id = transport.newCaptionId();
  const from = srcTr();
  addLog(id, text);
  await safe(transport.setCaptionSource(id, text, Date.now()));
  const targets = settings.languages.filter((l) => l !== from);
  await Promise.all(
    targets.map(async (to) => {
      try {
        const out = await translateText(text, from, to, settings.engine);
        updateLog(id, to, out);
        await safe(transport.setCaptionTranslation(id, to, out));
      } catch (err) {
        updateLog(id, to, "⚠ " + (err.message || err));
      }
    })
  );
}

function addLog(id, text) {
  const el = document.createElement("div");
  el.className = "log-entry";
  el.innerHTML = `<div class="src"></div><div class="tr"></div>`;
  el.querySelector(".src").textContent = text;
  $("log").appendChild(el);
  logEntries.set(id, el);
  while (logEntries.size > 200) {
    const [first] = logEntries.keys();
    logEntries.get(first).remove();
    logEntries.delete(first);
  }
  $("log").scrollTop = $("log").scrollHeight;
}
function updateLog(id, lang, text) {
  const el = logEntries.get(id);
  if (!el) return;
  const tr = el.querySelector(".tr");
  const code = document.createElement("code");
  code.textContent = lang;
  const span = document.createElement("span");
  span.textContent = text;
  tr.append(code, span);
}

$("manualForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("manualText").value;
  $("manualText").value = "";
  publishLine(t);
};

// ─────────────────────────── audio sources ───────────────────────────
async function refreshSources() {
  const box = $("sources");
  let devices;
  try {
    devices = await AudioMixer.listInputs();
  } catch (err) {
    showError("Couldn't list audio devices: " + err.message);
    return;
  }
  if (!devices.length || !devices[0].label) {
    box.innerHTML = `<button class="btn primary" id="allowAudio">Allow audio access</button>`;
    $("allowAudio").onclick = allowAudio;
    return;
  }
  box.innerHTML = "";
  for (const d of devices) {
    const row = document.createElement("div");
    row.className = "source";
    const id = d.deviceId;
    const checked = settings.devices.includes(id);
    const gain = settings.gains[id] ?? 1;
    row.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""} aria-label="Use this source" />
      <span class="name"></span>
      <span class="ctl">
        <input type="range" min="0" max="3" step="0.05" value="${gain}" aria-label="Gain" />
        <span class="meter"><i></i></span>
      </span>`;
    row.querySelector(".name").textContent = d.label || "Audio input";
    row.querySelector(".name").title = d.label;
    const cb = row.querySelector("input[type=checkbox]");
    const range = row.querySelector("input[type=range]");
    row.meter = row.querySelector(".meter");
    row.deviceId = id;
    cb.onchange = async () => {
      if (cb.checked) {
        try {
          await mixer.addSource(id, d.label);
          mixer.setGain(id, +range.value);
          if (!settings.devices.includes(id)) settings.devices.push(id);
        } catch (err) {
          cb.checked = false;
          showError(`Couldn't open "${d.label}": ${err.message}`);
        }
      } else {
        mixer.removeSource(id);
        settings.devices = settings.devices.filter((x) => x !== id);
      }
      saveSettings();
      if (state === "live") startRecognizer(); // re-attach to new mix
    };
    range.oninput = () => {
      mixer.setGain(id, +range.value);
      settings.gains[id] = +range.value;
      saveSettings();
    };
    box.appendChild(row);
    if (checked && !mixer.sources.has(id)) {
      mixer
        .addSource(id, d.label)
        .then(() => mixer.setGain(id, gain))
        .catch(() => {
          cb.checked = false;
        });
    }
  }
  const note = $("audioNote");
  note.className = "notice small";
  note.textContent =
    "Tip: some browser versions send only the system default microphone to speech recognition. If the transcript doesn't follow your selected source, also set it as the default recording device in Windows Sound settings.";
  note.hidden = false;
}

async function allowAudio() {
  try {
    await AudioMixer.requestPermission();
    await mixer.ensureContext();
  } catch (err) {
    showError("Audio permission denied: " + err.message);
    return;
  }
  refreshSources();
}
$("allowAudio").onclick = allowAudio;
navigator.mediaDevices?.addEventListener?.("devicechange", refreshSources);

$("cleanup").checked = settings.cleanup;
$("cleanup").onchange = async (e) => {
  settings.cleanup = mixer.voiceCleanup = e.target.checked;
  saveSettings();
  // re-open active sources with the new processing setting
  for (const id of [...mixer.sources.keys()]) {
    const label = mixer.sources.get(id).label;
    mixer.removeSource(id);
    await mixer.addSource(id, label).catch(() => {});
    mixer.setGain(id, settings.gains[id] ?? 1);
  }
  if (state === "live") startRecognizer();
};

function meterLoop() {
  for (const row of document.querySelectorAll(".source")) {
    const src = mixer.sources.get(row.deviceId);
    const lvl = src ? AudioMixer.level(src.analyser) : 0;
    row.meter.firstElementChild.style.width = lvl * 100 + "%";
    row.meter.classList.toggle("hot", lvl > 0.9);
  }
  const m = mixer.ctx ? AudioMixer.level(mixer.masterAnalyser) : 0;
  $("mixMeter").firstElementChild.style.width = m * 100 + "%";
  $("mixMeter").classList.toggle("hot", m > 0.9);
  requestAnimationFrame(meterLoop);
}

// ─────────────────────────── language settings ───────────────────────────
function buildLanguageUI() {
  const sl = $("speechLang");
  for (const l of SPEECH_LANGS) sl.add(new Option(l.label, l.code));
  sl.value = settings.speechLang;
  sl.onchange = () => {
    settings.speechLang = sl.value;
    saveSettings();
    if (state !== "offline") pushStatus();
    if (state === "live") startRecognizer();
  };

  $("engine").value = settings.engine;
  $("engine").onchange = (e) => {
    settings.engine = e.target.value;
    saveSettings();
    if (settings.engine !== "google") warmUpOnDevice(srcTr(), settings.languages);
  };

  const grid = $("langGrid");
  for (const l of LANGUAGES) {
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" value="${l.code}" ${settings.languages.includes(l.code) ? "checked" : ""}/> <span></span>`;
    lab.querySelector("span").textContent = l.name;
    lab.querySelector("input").onchange = () => {
      settings.languages = [...grid.querySelectorAll("input:checked")].map((x) => x.value);
      saveSettings();
      if (state !== "offline") pushStatus();
    };
    grid.appendChild(lab);
  }

  $("svcTitle").value = settings.title;
  $("svcTitle").onchange = () => {
    settings.title = $("svcTitle").value.trim();
    saveSettings();
    if (state !== "offline") pushStatus();
  };
}

$("copyUrl").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("listenerUrl").value);
    $("copyUrl").textContent = "Copied";
    setTimeout(() => ($("copyUrl").textContent = "Copy"), 1500);
  } catch {
    $("listenerUrl").select();
  }
};

// ─────────────────────────── startup ───────────────────────────
let started = false;
function startApp() {
  if (started) return;
  started = true;
  $("app").hidden = false;
  buildLanguageUI();
  renderState();

  // Pick up existing status (e.g. after a page reload mid-service)
  let first = true;
  transport.onStatus((s) => {
    if (!first) return;
    first = false;
    if (s && s.state && s.state !== "offline") {
      sessionId = s.sessionId || Date.now().toString(36);
      state = "paused"; // we're not listening yet after a reload
      renderState();
      pushStatus();
      $("recState").textContent = "Recognition: idle — press Resume to continue the service.";
    }
  });

  transport.onPresence((list) => {
    if (list === null) {
      $("listenerCount").textContent = "–";
      return;
    }
    $("listenerCount").textContent = list.length;
    const counts = {};
    for (const p of list) counts[p.lang] = (counts[p.lang] || 0) + 1;
    $("langCounts").textContent = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${langByCode(c)?.name || c}: ${n}`)
      .join(" · ");
  });

  // If permission was granted before, list devices straight away.
  AudioMixer.listInputs()
    .then((d) => d.length && d[0].label && refreshSources())
    .catch(() => {});
  requestAnimationFrame(meterLoop);

  addEventListener("beforeunload", (e) => {
    if (state === "live") {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

(async () => {
  try {
    transport = await createTransport("admin");
  } catch (err) {
    const p = document.createElement("p");
    p.className = "notice error";
    p.style.margin = "16px";
    p.textContent = "Couldn't start the connection: " + err.message;
    document.body.appendChild(p);
    return;
  }
  const badge = $("modeBadge");
  if (transport.mode === "peer") {
    const labels = {
      connecting: ["Peer-to-peer · connecting…", "paused"],
      online: ["Peer-to-peer · online", "ok"],
      reconnecting: ["Peer-to-peer · reconnecting…", "paused"],
      "id-taken": ["Room in use · retrying…", "live"],
      stopped: ["Inactive", ""],
    };
    transport.onNetwork((s) => {
      const [text, cls] = labels[s] || [s, ""];
      badge.textContent = text;
      badge.className = "pill " + cls;
      if (s === "id-taken") {
        showError(
          "This room ID is already being hosted — probably another admin tab or computer. Close it and this page will take over automatically within a few seconds."
        );
      } else if (s === "online" && $("audioNote").textContent.startsWith("This room ID")) {
        $("audioNote").hidden = true;
      }
    });
    badge.title = "Listeners connect directly to this computer. Keep this page open while live.";
    startApp();
    return;
  }
  if (transport.mode === "local") {
    badge.textContent = "Local demo mode";
    badge.className = "pill paused";
    badge.title = "Firebase isn't configured. Only listener tabs in this same browser will receive captions. See README.";
    startApp();
    return;
  }
  badge.textContent = "Firebase connected";
  badge.className = "pill";
  transport.onAuth((user) => {
    if (user) {
      $("loginCard").hidden = true;
      $("who").textContent = user.email;
      $("who").title = "UID: " + user.uid;
      $("signOut").hidden = false;
      console.info("Admin UID (put this in your database rules):", user.uid);
      startApp();
    } else {
      $("loginCard").hidden = false;
      $("app").hidden = true;
      $("signOut").hidden = true;
      $("who").textContent = "";
    }
  });
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("loginErr").hidden = true;
    try {
      await transport.signIn($("email").value, $("password").value);
    } catch (err) {
      $("loginErr").textContent = "Sign in failed: " + (err.code || err.message);
      $("loginErr").hidden = false;
    }
  };
  $("signOut").onclick = () => {
    if (state === "live" && !confirm("You're live. Sign out anyway?")) return;
    stopRecognizer();
    transport.signOut();
    location.reload();
  };
})();
