// Confetti burst on a throwaway fullscreen canvas. Skipped under reduced
// motion. Port of the standalone app's FX.
const COLORS = ["#58B586", "#F2C14E", "#E8734A", "#7BB3E0", "#C77FC9", "#F6F1E3"];

function reduced(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function burst(originEl?: Element | null, count = 90): void {
  if (typeof window === "undefined" || reduced()) return;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;z-index:60;pointer-events:none";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }

  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2.5;
  const r = originEl?.getBoundingClientRect();
  if (r) {
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }

  const parts = Array.from({ length: count }, (_, i) => {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 7;
    return {
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 4,
      s: 4 + Math.random() * 5,
      c: COLORS[i % COLORS.length],
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      life: 60 + Math.random() * 30,
    };
  });

  let frame = 0;
  const tick = () => {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of parts) {
      if (frame > p.life) continue;
      alive++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.25;
      p.vx *= 0.99;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - frame / p.life);
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    if (alive > 0) requestAnimationFrame(tick);
    else canvas.remove();
  };
  tick();
}
