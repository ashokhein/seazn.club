// Tiny WebAudio sound effects — no audio files. The AudioContext is created
// lazily on the first play (autoplay policy). Port of the standalone app's
// SFX; muted state is driven from the store via setMuted().
let ctx: AudioContext | null = null;
let muted = false;

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType = "sine", delay = 0, vol = 0.12) {
  const a = ac();
  if (!a || muted) return;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export const sfx = {
  setMuted(m: boolean): void {
    muted = m;
  },
  isMuted(): boolean {
    return muted;
  },
  tap(): void {
    tone(500, 0.06, "sine");
  },
  move(): void {
    tone(240, 0.09, "triangle", 0, 0.16);
  },
  coin(): void {
    tone(880, 0.09, "sine");
    tone(1320, 0.12, "sine", 0.07);
  },
  good(): void {
    tone(523, 0.1, "sine");
    tone(659, 0.12, "sine", 0.06);
  },
  bad(): void {
    tone(160, 0.18, "triangle", 0, 0.08);
  },
  chime(): void {
    tone(659, 0.12, "sine");
    tone(988, 0.22, "sine", 0.1);
  },
  fanfare(): void {
    tone(523, 0.12, "triangle");
    tone(659, 0.12, "triangle", 0.11);
    tone(784, 0.12, "triangle", 0.22);
    tone(1047, 0.3, "triangle", 0.33, 0.14);
  },
};
