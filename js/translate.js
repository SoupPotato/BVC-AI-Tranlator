// Free translation engines.
//  - "google": Google Translate's public web endpoint (no key; best quality).
//  - "chrome": Chrome's built-in on-device Translator API (desktop Chrome 138+).
//  - "auto":   Google first, falls back to on-device if Google fails.

const chromeTranslators = new Map();

// Chrome's on-device API uses slightly different codes.
const CHROME_CODES = { "zh-CN": "zh", "zh-TW": "zh-Hant", tl: "fil" };

export function onDeviceAvailable() {
  return "Translator" in self;
}

export async function translateText(text, from, to, engine = "auto") {
  if (!text || from === to) return text;
  if (engine === "chrome") return chromeTranslate(text, from, to);
  try {
    return await googleTranslate(text, from, to);
  } catch (err) {
    if (engine === "auto" && onDeviceAvailable()) return chromeTranslate(text, from, to);
    throw err;
  }
}

async function googleTranslate(text, from, to) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t" +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
      const data = await res.json();
      return data[0].map((seg) => seg[0]).join("");
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function chromeTranslate(text, from, to) {
  if (!onDeviceAvailable()) throw new Error("On-device translation not available in this browser");
  const sourceLanguage = CHROME_CODES[from] || from;
  const targetLanguage = CHROME_CODES[to] || to;
  const key = `${sourceLanguage}>${targetLanguage}`;
  if (!chromeTranslators.has(key)) {
    chromeTranslators.set(key, self.Translator.create({ sourceLanguage, targetLanguage }));
  }
  try {
    const translator = await chromeTranslators.get(key);
    return await translator.translate(text);
  } catch (err) {
    chromeTranslators.delete(key);
    throw err;
  }
}

// Call from a click handler so Chrome is allowed to download language packs.
export async function warmUpOnDevice(from, targets) {
  if (!onDeviceAvailable()) return;
  await Promise.allSettled(targets.filter((t) => t !== from).map((t) => chromeTranslate("Hello", from, t)));
}
