// Languages listeners can choose. `code` is the Google Translate code,
// `tts` is the BCP-47 tag used for the phone's read-aloud voice.
export const LANGUAGES = [
  { code: "en", name: "English", native: "English", tts: "en-US" },
  { code: "es", name: "Spanish", native: "Español", tts: "es-ES" },
  { code: "pt", name: "Portuguese", native: "Português", tts: "pt-BR" },
  { code: "fr", name: "French", native: "Français", tts: "fr-FR" },
  { code: "ht", name: "Haitian Creole", native: "Kreyòl ayisyen", tts: "fr-HT" },
  { code: "de", name: "German", native: "Deutsch", tts: "de-DE" },
  { code: "it", name: "Italian", native: "Italiano", tts: "it-IT" },
  { code: "ro", name: "Romanian", native: "Română", tts: "ro-RO" },
  { code: "pl", name: "Polish", native: "Polski", tts: "pl-PL" },
  { code: "ru", name: "Russian", native: "Русский", tts: "ru-RU" },
  { code: "uk", name: "Ukrainian", native: "Українська", tts: "uk-UA" },
  { code: "ko", name: "Korean", native: "한국어", tts: "ko-KR" },
  { code: "zh-CN", name: "Chinese (Simplified)", native: "简体中文", tts: "zh-CN" },
  { code: "zh-TW", name: "Chinese (Traditional)", native: "繁體中文", tts: "zh-TW" },
  { code: "ja", name: "Japanese", native: "日本語", tts: "ja-JP" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", tts: "vi-VN" },
  { code: "tl", name: "Tagalog / Filipino", native: "Tagalog", tts: "fil-PH" },
  { code: "th", name: "Thai", native: "ไทย", tts: "th-TH" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", tts: "id-ID" },
  { code: "hi", name: "Hindi", native: "हिन्दी", tts: "hi-IN" },
  { code: "ne", name: "Nepali", native: "नेपाली", tts: "ne-NP" },
  { code: "ar", name: "Arabic", native: "العربية", tts: "ar-SA", rtl: true },
  { code: "fa", name: "Persian (Farsi)", native: "فارسی", tts: "fa-IR", rtl: true },
  { code: "am", name: "Amharic", native: "አማርኛ", tts: "am-ET" },
  { code: "sw", name: "Swahili", native: "Kiswahili", tts: "sw-KE" },
  { code: "my", name: "Burmese", native: "မြန်မာ", tts: "my-MM" },
];

// Languages the speaker (pastor) may be speaking. `tr` = translation source code.
export const SPEECH_LANGS = [
  { code: "en-US", tr: "en", label: "English (US)" },
  { code: "en-GB", tr: "en", label: "English (UK)" },
  { code: "es-MX", tr: "es", label: "Spanish (Mexico)" },
  { code: "es-ES", tr: "es", label: "Spanish (Spain)" },
  { code: "pt-BR", tr: "pt", label: "Portuguese (Brazil)" },
  { code: "fr-FR", tr: "fr", label: "French" },
  { code: "ko-KR", tr: "ko", label: "Korean" },
  { code: "zh-CN", tr: "zh-CN", label: "Chinese (Mandarin)" },
  { code: "vi-VN", tr: "vi", label: "Vietnamese" },
  { code: "ru-RU", tr: "ru", label: "Russian" },
];

export function langByCode(code) {
  return LANGUAGES.find((l) => l.code === code);
}

export function speechLangByCode(code) {
  return SPEECH_LANGS.find((l) => l.code === code) || SPEECH_LANGS[0];
}
