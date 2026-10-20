# BVC Live Sermon Translator

A free, two-part live translation app for church services, hosted on **GitHub Pages**:

| Page | Who | What it does |
|---|---|---|
| `index.html` | Congregation (phones) | Pick a language and read live captions, with optional **read aloud** in that language. |
| `admin.html` | You (sound booth PC) | Pick and mix audio sources, choose languages, then **Go live / Pause / End** the broadcast. |

```
 Audio sources ──► admin.html (Chrome/Edge) ══ peer-to-peer ══► index.html (any phone)
 (mic, mixer,      speech-to-text (browser)    (or Firebase)     captions + phone's voice
  USB interface)   + Google Translate (free)
```

**Cost: $0, and no accounts needed.** Speech recognition runs in the browser. Translation uses Google Translate's free web endpoint, with Chrome's on-device translator as a backup. Captions go **peer-to-peer** from the admin page to each phone, using the free public PeerJS service to make the introductions.

## How the connection works (`transport` in `js/config.js`)

| Mode | Account? | Notes |
|---|---|---|
| **`"peer"`** (current) | None | The admin page hosts a "room" and each phone connects straight to your PC. **The admin page must stay open** while live. Comfortable up to roughly 50 listeners at once. |
| `"firebase"` | Free Google account | Captions go through Firebase's servers. Most reliable, about 100 listeners at once on the free plan, and the admin page is password-protected. See [Switching to Firebase](#switching-to-firebase-later). |
| `"local"` | None | Demo only: admin and listener tabs in the same browser. |

---

## Setup (peer-to-peer, about 5 minutes)

1. **(Optional)** Edit [`js/config.js`](js/config.js) to set `churchName`, `defaultLanguages` and `defaultSpeechLang`. `peer.roomId` is already set to a random, unique name. Leave it alone unless you need a new one.
2. **Publish on GitHub Pages:**
   1. Commit and push this repo to GitHub.
   2. In the repo, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then **`main` / `(root)`** → **Save**.
   3. After about a minute your site is live:
      - Listeners: `https://<your-username>.github.io/<repo-name>/`
      - You: `https://<your-username>.github.io/<repo-name>/admin.html`
3. Turn the listener link into a QR code for the bulletin or screens. The admin page shows the link with a **Copy** button.

---

## Running a service

1. On the sound-booth PC, open `admin.html` in **Google Chrome** (or Microsoft Edge). The badge at the top should turn green: **Peer-to-peer · online**.
2. **Audio sources:** click *Allow audio access*, then tick the inputs to use (pulpit mic, mixer USB feed, virtual audio cable, etc.). Use each slider to balance levels, and watch the meters.
   - A clean feed from the soundboard (aux or matrix out → USB interface) gives the best accuracy. Avoid a room mic that picks up music or the congregation.
3. **Languages:** set what the speaker is speaking and tick the languages to offer.
4. Press **● Go live**. Listeners' pages switch to *Live* automatically. Phones that opened the page early connect on their own once your admin page is online.
   - **Pause** during worship songs or other parts you don't want translated. Nothing is sent while paused.
   - **Resume** continues the same service.
   - **End** tells listeners the service is over. The next **Go live** starts a fresh, empty session.
5. Use the box under the transcript to **type a line** (announcements, corrections, scripture references). It gets translated and sent like speech.
6. **Keep the admin tab open** while live. Keep the PC awake (no sleep) and connected to the internet. If the page reloads or the network blips, listeners see *Reconnecting…*, then *Paused* with their captions kept. Press **Resume** to carry on.

### Tips
- **"Recognition: reconnecting…"** is normal. The browser's speech service restarts every minute or so, and the app reconnects automatically.
- **Which source is recognised:** newer Chrome versions recognise the mixed sources you tick. Some browser versions only use the **Windows default recording device**. If the transcript doesn't follow your chosen input, right-click the speaker icon → *Sound settings* → set that device as the default input.
- **"Room in use"** on the admin page means another tab or computer is already hosting. Close the other one and this page takes over within a few seconds.
- **Listeners using read aloud** should keep the page open with the screen on. The app asks the phone to stay awake, but iPhones may stop speaking when locked. Earbuds are recommended.
- **Phones that won't connect:** some phones on strict cellular networks can't connect directly to the PC. PeerJS's default free relay (TURN) servers usually handle this. Asking people to join the church Wi-Fi helps too.

### Peer-to-peer limitations to know about
- **The PC is the server.** If the admin page is closed, nobody receives captions.
- **The room ID is public** (it's in `config.js`). Someone determined could open their own copy of the admin page with the same room ID *while yours isn't running* and broadcast to listeners. Your admin page would show **Room in use**. If that ever happens, change `peer.roomId` and push. Firebase mode doesn't have this weakness, because only your signed-in account can broadcast.
- **Free public infrastructure.** PeerJS's free cloud server is used to introduce phones to your PC. It's widely used but has no uptime guarantee. To remove that dependency, you can self-host a PeerJS server and set `peer.server` in `config.js`.

---

## Switching to Firebase later

The pages work the same with either connection. Only `js/config.js` changes.

1. Go to <https://console.firebase.google.com> → **Add project** (Google Analytics is not needed).
2. **Build → Realtime Database → Create database**. Pick the location nearest you and start in **locked mode**.
3. **Build → Authentication → Get started → Email/Password → Enable**.
4. In **Authentication → Users → Add user**, create your admin login. Copy the **User UID** it shows.
5. Go to **Project settings (⚙) → General → Your apps → `</>` (Web)** and register an app. Copy its `firebaseConfig` into `js/config.js`:
   ```js
   transport: "firebase",
   firebase: {
     apiKey: "AIza...",
     authDomain: "your-project.firebaseapp.com",
     databaseURL: "https://your-project-default-rtdb.firebaseio.com",
     projectId: "your-project",
     appId: "1:123:web:abc",
   },
   ```
   This config is safe to publish. If `databaseURL` is missing, copy it from the top of the Realtime Database page.
6. In [`database.rules.json`](database.rules.json), replace both `PASTE_YOUR_ADMIN_UID_HERE` with your UID. Paste the file into **Realtime Database → Rules → Publish**. Anyone can read captions, but only your account can broadcast.
7. Push to GitHub. The admin page now asks you to sign in.

Firebase free-tier limits: about 100 simultaneous listeners and 10 GB/month of downloads. A service uses only a few MB.

---

## Testing locally

Any static web server works, for example `npx serve` or `python -m http.server`. Open `/admin.html` in one tab and `/` in another. Peer mode works across tabs and devices on a local server too. Set `transport: "local"` to test with no internet relay at all.

## Files
```
index.html            listener page
admin.html            control console
css/style.css         styles (light + dark)
js/config.js          ← your settings: transport, room ID, Firebase config, languages
js/languages.js       language list (add or remove languages here)
js/listener.js        listener logic (captions, read-aloud queue, presence)
js/admin.js           console logic (go live, publishing, settings)
js/audio.js           multi-source audio mixer + level meters
js/speech.js          continuous browser speech recognition
js/translate.js       free translation (Google web endpoint / Chrome on-device)
js/transport.js       realtime link: peer-to-peer, Firebase, or local demo
database.rules.json   Firebase security rules (Firebase mode only)
```

## Upgrading quality later
The free engines are good but not perfect: names, scripture references and theological terms can trip them up. Because every piece is a separate module, you can later swap in paid services without changing the pages. For example, put a premium speech-to-text service in `speech.js` or a context-aware AI translator in `translate.js`. Either one needs a small server to keep the API keys secret.
