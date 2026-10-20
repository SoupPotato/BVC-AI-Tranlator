// ─────────────────────────────────────────────────────────────
//  App configuration — edit this file, then push to GitHub.
// ─────────────────────────────────────────────────────────────
export const APP_CONFIG = {
  churchName: "BVC",
  appTitle: "Live Sermon Translation",

  // How the admin page reaches listeners:
  //   "peer"     – peer-to-peer, no account needed (admin page must stay open while live)
  //   "firebase" – Firebase Realtime Database (fill in `firebase` below; see README)
  //   "local"    – demo: admin + listener tabs in the same browser only
  transport: "peer",

  // Peer-to-peer settings. roomId must be unique to your church. Change it if you
  // ever need to (e.g. someone else is squatting it); listeners pick it up on refresh.
  peer: {
    roomId: "bvc-live-translator-0dxwq68psr",
    // Optional: your own STUN/TURN servers. Leave empty to use PeerJS's defaults
    // (which include free STUN + TURN relays for phones on strict mobile networks).
    iceServers: [],
  },

  // Firebase web config (used when transport is "firebase"). From:
  //   Firebase console → Project settings → General → Your apps → Web app → SDK setup (Config)
  firebase: null,
  // firebase: {
  //   apiKey: "AIza...",
  //   authDomain: "your-project.firebaseapp.com",
  //   databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  //   projectId: "your-project",
  //   appId: "1:123:web:abc",
  // },

  // Languages pre-selected on the admin page (codes from js/languages.js)
  defaultLanguages: ["es", "ko", "zh-CN", "vi", "fr", "pt"],

  // Speaker language pre-selected on the admin page
  defaultSpeechLang: "en-US",
};
