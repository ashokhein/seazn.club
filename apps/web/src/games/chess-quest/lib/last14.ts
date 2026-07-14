// The 14-day activity strip for the progress panel (port of js/app.js
// last14Days). Pure: caller passes the activity dates and "today".
export function last14Days(
  activity: string[],
  todayISO: string,
): { iso: string; wd: string; on: boolean }[] {
  const played = new Set(activity);
  const out: { iso: string; wd: string; on: boolean }[] = [];
  const d = new Date(todayISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 13);
  for (let i = 0; i < 14; i++) {
    const iso =
      d.getUTCFullYear() +
      "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getUTCDate()).padStart(2, "0");
    out.push({ iso, wd: "SMTWTFS"[d.getUTCDay()], on: played.has(iso) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
