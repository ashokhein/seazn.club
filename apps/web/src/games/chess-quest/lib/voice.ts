// Coach voice via the browser's built-in speech synthesis — offline, no
// network. Port of the standalone app's Voice; enabled state comes from the
// store. say() takes rich/plain strings and strips markup + emoji first.
let enabled = true;
let chosenVoice: SpeechSynthesisVoice | null = null;

function pickVoice() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const all = speechSynthesis.getVoices();
  chosenVoice =
    all.find((v) => /Samantha|Google US English|Zira/i.test(v.name)) ??
    all.find((v) => v.lang?.startsWith("en")) ??
    null;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  pickVoice();
  speechSynthesis.addEventListener("voiceschanged", pickVoice);
}

function plain(html: string): string {
  const text = html.replace(/<[^>]*>/g, " ");
  // Drop emoji/symbols the voice would read out; collapse whitespace.
  return text
    .replace(/[^\p{L}\p{N}\p{P}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const voice = {
  setEnabled(on: boolean): void {
    enabled = on;
    if (!on && typeof window !== "undefined" && window.speechSynthesis) speechSynthesis.cancel();
  },
  isEnabled(): boolean {
    return enabled;
  },
  say(html: string): void {
    if (!enabled || typeof window === "undefined" || !window.speechSynthesis) return;
    const text = plain(html);
    if (!text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (chosenVoice) u.voice = chosenVoice;
    u.rate = 0.95;
    u.pitch = 1.1;
    u.volume = 0.9;
    speechSynthesis.speak(u);
  },
  stop(): void {
    if (typeof window !== "undefined" && window.speechSynthesis) speechSynthesis.cancel();
  },
};
