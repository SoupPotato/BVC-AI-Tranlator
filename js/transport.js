// Realtime link between the admin console and listeners. Pick one in js/config.js → `transport`:
//  - "peer":     peer-to-peer (PeerJS / WebRTC). No account. The admin page hosts a room and
//                every listener connects directly to it. The admin page must stay open.
//  - "firebase": Firebase Realtime Database (free tier). Admin sign-in, most reliable.
//  - "local":    demo only — admin + listener tabs in the same browser (BroadcastChannel).
//
// Every transport exposes the same methods, so the pages don't care which one is used.
//
// Data model:
//   status   { state: offline|live|paused, sessionId, title, sourceLang, languages[], updatedAt }
//   interim  "words currently being spoken…"
//   captions {id} → { src, ts, t: { es: "...", ko: "..." } }
//   presence one { lang } per open listener page

import { APP_CONFIG } from "./config.js";

const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
const PEERJS_SDK = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";

/** @param {"admin"|"listener"} role */
export async function createTransport(role) {
  const kind = APP_CONFIG.transport || (APP_CONFIG.firebase ? "firebase" : "local");
  if (kind === "firebase") {
    const cfg = APP_CONFIG.firebase;
    if (!cfg || !cfg.apiKey || !cfg.databaseURL) throw new Error('transport is "firebase" but js/config.js has no Firebase config');
    return createFirebaseTransport(cfg);
  }
  if (kind === "peer") {
    const cfg = APP_CONFIG.peer || {};
    if (!cfg.roomId) throw new Error('transport is "peer" but js/config.js has no peer.roomId');
    return role === "admin" ? createPeerHost(cfg) : createPeerClient(cfg);
  }
  return createLocalTransport();
}

// ───────────────────────────── shared in-memory store ─────────────────────────────
// Used by the local and peer transports. Messages:
//   {type:"status", data} {type:"src", id, src, ts} {type:"tr", id, lang, text}
//   {type:"cap", id, c}  {type:"interim", text}  {type:"clear"}
function makeStore() {
  const state = { status: { state: "offline" }, captions: {}, interim: "" };
  const subs = { status: new Set(), caption: new Set(), interim: new Set() };

  function trim() {
    const ids = Object.keys(state.captions).sort();
    for (const id of ids.slice(0, Math.max(0, ids.length - 60))) delete state.captions[id];
  }

  function apply(m) {
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "status":
        state.status = { ...state.status, ...m.data };
        subs.status.forEach((f) => f(state.status));
        break;
      case "src":
      case "tr":
      case "cap": {
        if (typeof m.id !== "string") return;
        let c = state.captions[m.id] || {};
        if (m.type === "src") c = { ...c, src: String(m.src), ts: m.ts };
        else if (m.type === "tr") c = { ...c, t: { ...(c.t || {}), [m.lang]: String(m.text) } };
        else c = m.c || {};
        state.captions[m.id] = c;
        trim();
        subs.caption.forEach((f) => f(m.id, c));
        break;
      }
      case "interim":
        state.interim = String(m.text || "");
        subs.interim.forEach((f) => f(state.interim));
        break;
      case "clear":
        state.captions = {};
        state.interim = "";
        subs.interim.forEach((f) => f(""));
        break;
    }
  }

  // Messages that rebuild the full state on a newly connected listener
  function snapshot() {
    const out = [{ type: "status", data: state.status }];
    for (const id of Object.keys(state.captions).sort().slice(-40)) out.push({ type: "cap", id, c: state.captions[id] });
    out.push({ type: "interim", text: state.interim });
    return out;
  }

  const listeners = {
    onStatus(cb) {
      subs.status.add(cb);
      cb(state.status);
      return () => subs.status.delete(cb);
    },
    onInterim(cb) {
      subs.interim.add(cb);
      cb(state.interim);
      return () => subs.interim.delete(cb);
    },
    onCaptions(cb) {
      subs.caption.add(cb);
      for (const id of Object.keys(state.captions).sort().slice(-40)) cb(id, state.captions[id]);
      return () => subs.caption.delete(cb);
    },
  };

  return { state, apply, snapshot, listeners };
}

let seq = 0;
const newCaptionId = () => `${Date.now().toString().padStart(15, "0")}-${String(seq++ % 10000).padStart(4, "0")}`;

function writerApi(send) {
  return {
    setStatus: async (s) => send({ type: "status", data: { ...s, updatedAt: Date.now() } }),
    newCaptionId,
    setCaptionSource: async (id, src, ts) => send({ type: "src", id, src, ts }),
    setCaptionTranslation: async (id, lang, text) => send({ type: "tr", id, lang, text }),
    setInterim: async (text) => send({ type: "interim", text: text || "" }),
    clearCaptions: async () => send({ type: "clear" }),
  };
}

// ───────────────────────────── Peer-to-peer (PeerJS) ─────────────────────────────
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Peer) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load " + src));
    document.head.appendChild(s);
  });
}

function peerOptions(cfg) {
  const opts = { debug: 1 };
  if (cfg.iceServers && cfg.iceServers.length) opts.config = { iceServers: cfg.iceServers };
  if (cfg.server) Object.assign(opts, cfg.server); // optional self-hosted PeerJS server {host, port, path, secure}
  return opts;
}

// Admin side: owns the room ID and fans every message out to all listeners.
async function createPeerHost(cfg) {
  await loadScript(PEERJS_SDK);
  const store = makeStore();
  // Survive an admin page reload mid-service: restore status + recent captions from this PC.
  const SAVE_KEY = "bvc-peer-host-state";
  try {
    Object.assign(store.state, JSON.parse(localStorage.getItem(SAVE_KEY)) || {});
  } catch {}
  store.state.interim = "";
  const save = () => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(store.state));
    } catch {}
  };
  const conns = new Map(); // DataConnection -> { lang }
  const presenceSubs = new Set();
  const netSubs = new Set();
  let net = "connecting";
  let peer = null;

  const setNet = (s, detail) => {
    net = s;
    netSubs.forEach((f) => f(s, detail));
  };
  const emitPresence = () => {
    const list = [...conns.values()].filter((x) => x.lang).map((x) => ({ lang: x.lang }));
    presenceSubs.forEach((f) => f(list));
  };

  function open() {
    peer = new window.Peer(cfg.roomId, peerOptions(cfg));
    peer.on("open", () => setNet("online"));
    peer.on("connection", (conn) => {
      conns.set(conn, { lang: null });
      conn.on("open", () => {
        for (const m of store.snapshot()) conn.send(m);
      });
      conn.on("data", (d) => {
        if (d && d.type === "presence" && typeof d.lang === "string" && conns.has(conn)) {
          conns.get(conn).lang = d.lang.slice(0, 12);
          emitPresence();
        }
      });
      const drop = () => {
        if (conns.delete(conn)) emitPresence();
      };
      conn.on("close", drop);
      conn.on("error", drop);
    });
    peer.on("disconnected", () => {
      // Lost the signalling server. Existing listeners stay connected; new ones can't join until we're back.
      setNet("reconnecting");
      setTimeout(() => peer && !peer.destroyed && peer.disconnected && peer.reconnect(), 1500);
    });
    peer.on("error", (err) => {
      if (err.type === "unavailable-id") {
        setNet("id-taken");
        peer.destroy();
        setTimeout(open, 5000);
      } else if (peer.destroyed) {
        setNet("reconnecting", err.type);
        setTimeout(open, 3000);
      } else {
        console.warn("PeerJS:", err.type, err);
      }
    });
  }
  open();

  const send = (m) => {
    store.apply(m);
    if (m.type !== "interim") save();
    for (const conn of conns.keys()) {
      if (conn.open) {
        try {
          conn.send(m);
        } catch {}
      }
    }
  };
  addEventListener("pagehide", () => peer && peer.destroy());

  return {
    mode: "peer",
    needsAuth: false,
    ...writerApi(send),
    ...store.listeners,
    onPresence(cb) {
      presenceSubs.add(cb);
      emitPresence();
      return () => presenceSubs.delete(cb);
    },
    onNetwork(cb) {
      netSubs.add(cb);
      cb(net);
      return () => netSubs.delete(cb);
    },
  };
}

// Listener side: connects to the admin's room and keeps retrying until it's there.
async function createPeerClient(cfg) {
  await loadScript(PEERJS_SDK);
  const store = makeStore();
  const netSubs = new Set();
  let net = "connecting";
  let peer = null;
  let conn = null;
  let myLang = null;
  let retryTimer = null;

  const setNet = (s) => {
    if (s === net) return;
    net = s;
    netSubs.forEach((f) => f(s));
  };
  const retry = (ms = 4000) => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  };

  function connect() {
    clearTimeout(retryTimer);
    if (conn && conn.open) return;
    if (!peer || peer.destroyed) {
      peer = new window.Peer(peerOptions(cfg));
      peer.on("open", connect);
      peer.on("disconnected", () => !peer.destroyed && peer.reconnect());
      peer.on("error", (err) => {
        if (err.type === "peer-unavailable") {
          // Admin page isn't open (yet). Keep waiting.
          setNet("waiting");
          retry(5000);
        } else if (peer.destroyed) {
          peer = null;
          setNet("connecting");
          retry(3000);
        } else {
          retry(4000);
        }
      });
      return;
    }
    if (!peer.open) return; // will be called again on "open"
    if (conn) {
      const old = conn;
      conn = null;
      try {
        old.close();
      } catch {}
    }
    const c = peer.connect(cfg.roomId, { reliable: true });
    conn = c;
    c.on("open", () => {
      setNet("connected");
      if (myLang) c.send({ type: "presence", lang: myLang });
    });
    c.on("data", (m) => store.apply(m));
    const lost = () => {
      if (conn !== c) return;
      conn = null;
      setNet("waiting");
      retry(2000);
    };
    c.on("close", lost);
    c.on("error", lost);
    // If the data channel never opens (e.g. blocked network), try again.
    setTimeout(() => conn === c && !c.open && (c.close(), lost()), 15000);
  }
  connect();

  // Phones suspend background tabs; reconnect as soon as the page is visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !(conn && conn.open)) connect();
  });

  return {
    mode: "peer",
    needsAuth: false,
    ...store.listeners,
    joinPresence(lang) {
      myLang = lang;
      if (conn && conn.open) conn.send({ type: "presence", lang });
      return {
        update(l) {
          myLang = l;
          if (conn && conn.open) conn.send({ type: "presence", lang: l });
        },
        leave() {},
      };
    },
    onNetwork(cb) {
      netSubs.add(cb);
      cb(net);
      return () => netSubs.delete(cb);
    },
  };
}

// ───────────────────────────── Firebase ─────────────────────────────
async function createFirebaseTransport(cfg) {
  const [appMod, db, auth] = await Promise.all([
    import(FIREBASE_SDK + "firebase-app.js"),
    import(FIREBASE_SDK + "firebase-database.js"),
    import(FIREBASE_SDK + "firebase-auth.js"),
  ]);
  const app = appMod.initializeApp(cfg);
  const d = db.getDatabase(app);
  const a = auth.getAuth(app);
  const live = (p = "") => db.ref(d, "live" + (p ? "/" + p : ""));

  return {
    mode: "firebase",
    needsAuth: true,

    onAuth: (cb) => auth.onAuthStateChanged(a, cb),
    signIn: (email, pw) => auth.signInWithEmailAndPassword(a, email, pw),
    signOut: () => auth.signOut(a),

    setStatus: (s) => db.update(live("status"), { ...s, updatedAt: db.serverTimestamp() }),
    newCaptionId: () => db.push(live("captions")).key,
    setCaptionSource: (id, src, ts) => db.update(live("captions/" + id), { src, ts }),
    setCaptionTranslation: (id, lang, text) => db.set(live(`captions/${id}/t/${lang}`), text),
    setInterim: (text) => db.set(live("interim"), text || ""),
    clearCaptions: () => Promise.all([db.remove(live("captions")), db.set(live("interim"), "")]),

    onStatus: (cb) => db.onValue(live("status"), (s) => cb(s.val() || { state: "offline" })),
    onInterim: (cb) => db.onValue(live("interim"), (s) => cb(s.val() || "")),
    onCaptions(cb) {
      const q = db.query(live("captions"), db.limitToLast(40));
      const off1 = db.onChildAdded(q, (s) => cb(s.key, s.val()));
      const off2 = db.onChildChanged(q, (s) => cb(s.key, s.val()));
      return () => (off1(), off2());
    },

    joinPresence(lang) {
      const me = db.push(db.ref(d, "presence"));
      let current = lang;
      const write = () => db.set(me, { lang: current, at: db.serverTimestamp() }).catch(() => {});
      db.onValue(db.ref(d, ".info/connected"), (s) => {
        if (s.val() === true) {
          db.onDisconnect(me).remove();
          write();
        }
      });
      return {
        update(l) {
          current = l;
          write();
        },
        leave: () => db.remove(me).catch(() => {}),
      };
    },
    onPresence(cb) {
      return db.onValue(
        db.ref(d, "presence"),
        (s) => cb(Object.values(s.val() || {})),
        () => cb(null) // no permission (not signed in as admin)
      );
    },
  };
}

// ───────────────────────────── Local demo ─────────────────────────────
function createLocalTransport() {
  const ch = new BroadcastChannel("bvc-translator");
  const KEY = "bvc-translator-demo";
  const store = makeStore();
  try {
    Object.assign(store.state, JSON.parse(localStorage.getItem(KEY)) || {});
  } catch {}

  const presence = new Map();
  const presenceSubs = new Set();
  const emitPresence = () => presenceSubs.forEach((f) => f([...presence.values()]));
  let announceMe = null;

  ch.onmessage = (e) => {
    const m = e.data;
    if (m.type === "presence") (presence.set(m.id, { lang: m.lang }), emitPresence());
    else if (m.type === "presence-leave") (presence.delete(m.id), emitPresence());
    else if (m.type === "presence-ping") announceMe && announceMe();
    else store.apply(m);
  };
  const send = (m) => {
    store.apply(m);
    try {
      localStorage.setItem(KEY, JSON.stringify(store.state));
    } catch {}
    ch.postMessage(m);
  };

  return {
    mode: "local",
    needsAuth: false,
    ...writerApi(send),
    ...store.listeners,
    joinPresence(lang) {
      const id = Math.random().toString(36).slice(2);
      let current = lang;
      announceMe = () => ch.postMessage({ type: "presence", id, lang: current });
      announceMe();
      addEventListener("pagehide", () => ch.postMessage({ type: "presence-leave", id }));
      return {
        update(l) {
          current = l;
          announceMe();
        },
        leave: () => ch.postMessage({ type: "presence-leave", id }),
      };
    },
    onPresence(cb) {
      presenceSubs.add(cb);
      cb([...presence.values()]);
      ch.postMessage({ type: "presence-ping" });
      return () => presenceSubs.delete(cb);
    },
  };
}
