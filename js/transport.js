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
const HEARTBEAT_EVERY = 3000; // ms between pings, both directions
const HEARTBEAT_TIMEOUT = 10000; // ms of silence before a link is treated as dead

/** @param {"admin"|"listener"} role */
export async function createTransport(role) {
  const kind = APP_CONFIG.transport || (APP_CONFIG.firebase ? "firebase" : "local");
  if (kind === "firebase") {
    const cfg = APP_CONFIG.firebase;
    if (!cfg || !cfg.apiKey || !cfg.databaseURL) throw new Error('transport is "firebase" but js/config.js has no Firebase config');
    return createFirebaseTransport(cfg);
  }
  if (kind === "peer") {
    const cfg = { ...(APP_CONFIG.peer || {}) };
    // ?room=xyz on both pages runs a separate test room without touching the real one.
    const testRoom = new URLSearchParams(location.search).get("room");
    if (testRoom) cfg.roomId = `${cfg.roomId}-test-${testRoom.replace(/[^a-z0-9-]/gi, "").slice(0, 20)}`;
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
// SHA-256 hex of an admin key (used to authorise taking over a LIVE control page).
export async function hashAdminKey(key) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(key)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const SAVE_KEY = "bvc-peer-host-state:" + cfg.roomId;
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
  let stopped = false;

  const setNet = (s, detail) => {
    net = s;
    netSubs.forEach((f) => f(s, detail));
  };
  const emitPresence = () => {
    const list = [...conns.values()].filter((x) => x.lang).map((x) => ({ lang: x.lang }));
    presenceSubs.forEach((f) => f(list));
  };

  // At most one pending re-open at a time, so retries can't multiply.
  let reopenTimer = null;
  const reopen = (ms) => {
    if (stopped || reopenTimer) return;
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      open();
    }, ms);
  };

  function open() {
    if (stopped) return;
    if (peer && !peer.destroyed) peer.destroy();
    const p = (peer = new window.Peer(cfg.roomId, peerOptions(cfg)));
    const current = () => p === peer; // ignore events from replaced Peer objects
    p.on("open", () => current() && setNet("online"));
    p.on("connection", (conn) => {
      conns.set(conn, { lang: null, seen: Date.now() });
      conn.on("open", () => {
        for (const m of store.snapshot()) conn.send(m);
      });
      conn.on("data", (d) => {
        const info = conns.get(conn);
        if (!info) return;
        info.seen = Date.now();
        if (d && d.type === "takeover") return handleTakeover(conn, d);
        if (d && d.type === "presence" && typeof d.lang === "string" && info.lang !== d.lang.slice(0, 12)) {
          info.lang = d.lang.slice(0, 12);
          emitPresence();
        }
      });
      const drop = () => {
        if (conns.delete(conn)) emitPresence();
      };
      conn.on("close", drop);
      conn.on("error", drop);
    });
    let rejected = false; // the room was taken; PeerJS also fires "disconnected" while tearing down
    p.on("disconnected", () => {
      if (!current() || p.destroyed || rejected) return;
      // Lost the signalling server. Existing listeners stay connected; new ones can't join until we're back.
      setNet("reconnecting");
      setTimeout(() => current() && !p.destroyed && p.disconnected && p.reconnect(), 1500);
    });
    p.on("error", (err) => {
      if (!current()) return;
      if (err.type === "unavailable-id") {
        rejected = true;
        setNet("id-taken");
        p.destroy();
        reopen(3000);
      } else if (p.destroyed) {
        if (net !== "id-taken") setNet("reconnecting", err.type);
        reopen(3000);
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

  // Heartbeat: WebRTC can take a long time to notice a vanished peer, so ping every
  // listener and drop any that have gone quiet (they ping back via presence).
  setInterval(() => {
    const now = Date.now();
    for (const [conn, info] of conns) {
      if (now - info.seen > HEARTBEAT_TIMEOUT) {
        conns.delete(conn);
        try {
          conn.close();
        } catch {}
        emitPresence();
      } else if (conn.open) {
        try {
          conn.send({ type: "ping" });
        } catch {}
      }
    }
  }, HEARTBEAT_EVERY);

  // Give up the room for good (another control page is taking over).
  function shutdown() {
    stopped = true;
    clearTimeout(reopenTimer);
    for (const conn of conns.keys()) {
      try {
        conn.close();
      } catch {}
    }
    conns.clear();
    emitPresence();
    if (peer) peer.destroy();
    setNet("stopped");
  }

  // Another control page (any browser/computer) asks us to release the room.
  // Idle/paused/ended pages always agree. A LIVE page only agrees if the request
  // carries the admin key whose hash is in config (peer.adminKeyHash).
  const takenOverSubs = new Set();
  async function handleTakeover(conn, d) {
    const live = store.state.status && store.state.status.state === "live";
    let ok = !live;
    if (live && cfg.adminKeyHash && typeof d.key === "string" && d.key) {
      ok = (await hashAdminKey(d.key)) === String(cfg.adminKeyHash).toLowerCase();
    }
    if (!ok) {
      const reason = !cfg.adminKeyHash ? "live" : d.key ? "bad-key" : "key-required";
      try {
        conn.send({ type: "takeover-denied", reason });
      } catch {}
      return;
    }
    try {
      conn.send({ type: "takeover-ok" });
    } catch {}
    setTimeout(() => {
      shutdown();
      takenOverSubs.forEach((f) => f());
    }, 300);
  }

  // Ask whoever holds the room to release it. Resolves { ok, reason }.
  function requestTakeover(key) {
    return new Promise((resolve) => {
      const tmp = new window.Peer(peerOptions(cfg));
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        setTimeout(() => tmp.destroy(), 200);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: "no-answer" }), 10000);
      tmp.on("error", (err) => finish({ ok: false, reason: err.type === "peer-unavailable" ? "gone" : "error: " + err.type }));
      tmp.on("open", () => {
        const c = tmp.connect(cfg.roomId, { reliable: true });
        c.on("open", () => c.send({ type: "takeover", key: key || "" }));
        c.on("data", (m) => {
          if (m && m.type === "takeover-ok") finish({ ok: true });
          else if (m && m.type === "takeover-denied") finish({ ok: false, reason: m.reason });
        });
      });
    }).then((r) => {
      if (r.ok || r.reason === "gone") {
        // Room is (about to be) free: claim it now instead of waiting for the next retry.
        clearTimeout(reopenTimer);
        reopenTimer = null;
        stopped = false;
        reopenTimer = setTimeout(() => {
          reopenTimer = null;
          open();
        }, 800);
      }
      return r;
    });
  }

  return {
    mode: "peer",
    needsAuth: false,
    ...writerApi(send),
    ...store.listeners,
    shutdown,
    requestTakeover,
    onTakenOver(cb) {
      takenOverSubs.add(cb);
      return () => takenOverSubs.delete(cb);
    },
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
  let lastHeard = 0;

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
      lastHeard = Date.now();
      setNet("connected");
      if (myLang) c.send({ type: "presence", lang: myLang });
    });
    c.on("data", (m) => {
      lastHeard = Date.now();
      store.apply(m);
    });
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

  // Heartbeat: the host pings every few seconds. If it goes quiet (admin page closed,
  // PC asleep, network dropped) treat the link as dead and start reconnecting.
  setInterval(() => {
    if (!conn || !conn.open) return;
    if (Date.now() - lastHeard > HEARTBEAT_TIMEOUT) {
      const dead = conn;
      conn = null;
      try {
        dead.close();
      } catch {}
      setNet("waiting");
      retry(500);
    } else {
      try {
        conn.send({ type: "ping" });
      } catch {}
    }
  }, HEARTBEAT_EVERY);

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
