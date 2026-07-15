// Dev-only builder: fetches real 2026 FIFA World Cup data from Wikipedia raw
// wikitext (deterministic parse, no LLM) and writes scripts/data/fifa2026.json,
// which the seed (scripts/seed-fifa2026.ts) consumes. Re-run to refresh:
//   node --experimental-strip-types scripts/build-fifa2026-data.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const UA = { "User-Agent": "seazn-demo-seed/1.0 (dev; contact ashokhein@gmail.com)" };
const raw = async (title: string): Promise<string> => {
  const u = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`;
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error(`${title}: HTTP ${r.status}`);
  return r.text();
};

const GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

// Country header (on the squads page) → FIFA 3-letter code used everywhere else.
const NAME_TO_CODE: Record<string, string> = {
  Mexico: "MEX", "South Africa": "RSA", "South Korea": "KOR", "Czech Republic": "CZE",
  Switzerland: "SUI", Canada: "CAN", "Bosnia and Herzegovina": "BIH", Qatar: "QAT",
  Brazil: "BRA", Morocco: "MAR", Scotland: "SCO", Haiti: "HAI",
  "United States": "USA", Australia: "AUS", Paraguay: "PAR", Turkey: "TUR",
  Germany: "GER", "Ivory Coast": "CIV", Ecuador: "ECU", "Curaçao": "CUW",
  Netherlands: "NED", Japan: "JPN", Sweden: "SWE", Tunisia: "TUN",
  Belgium: "BEL", Egypt: "EGY", Iran: "IRN", "New Zealand": "NZL",
  Spain: "ESP", "Cape Verde": "CPV", Uruguay: "URU", "Saudi Arabia": "KSA",
  France: "FRA", Norway: "NOR", Senegal: "SEN", Iraq: "IRQ",
  Argentina: "ARG", Austria: "AUT", Algeria: "ALG", Jordan: "JOR",
  Colombia: "COL", Portugal: "POR", "DR Congo": "COD", Uzbekistan: "UZB",
  England: "ENG", Croatia: "CRO", Ghana: "GHA", Panama: "PAN",
};

// FIFA code → ISO 3166-1 alpha-2 (lowercase) for flagcdn image URLs. GB nations
// use the flagcdn subdivision codes.
const CODE_TO_ISO2: Record<string, string> = {
  MEX: "mx", RSA: "za", KOR: "kr", CZE: "cz", SUI: "ch", CAN: "ca", BIH: "ba", QAT: "qa",
  BRA: "br", MAR: "ma", SCO: "gb-sct", HAI: "ht", USA: "us", AUS: "au", PAR: "py", TUR: "tr",
  GER: "de", CIV: "ci", ECU: "ec", CUW: "cw", NED: "nl", JPN: "jp", SWE: "se", TUN: "tn",
  BEL: "be", EGY: "eg", IRN: "ir", NZL: "nz", ESP: "es", CPV: "cv", URU: "uy", KSA: "sa",
  FRA: "fr", NOR: "no", SEN: "sn", IRQ: "iq", ARG: "ar", AUT: "at", ALG: "dz", JOR: "jo",
  COL: "co", POR: "pt", COD: "cd", UZB: "uz", ENG: "gb-eng", CRO: "hr", GHA: "gh", PAN: "pa",
};

interface Match { group: string; date: string; home: string; away: string; hs: number; as: number }
interface Player { n: number; pos: string; name: string }

// Extract "CODE" from {{#invoke:flag|fb-rt|MEX}} / {{fbicon|MEX}} etc.
function teamCode(field: string): string | null {
  const m = field.match(/\|\s*([A-Z]{3})\s*}}/);
  return m ? m[1] : null;
}

function parseGroup(letter: string, wikitext: string): Match[] {
  const out: Match[] = [];
  // Each match is a football box invocation; slice on the template opener.
  const boxes = wikitext.split(/{{#invoke:football box/i).slice(1);
  for (const box of boxes) {
    const body = box.slice(0, box.indexOf("\n|report") >= 0 ? box.indexOf("\n|report") + 4000 : 4000);
    const date = body.match(/\|\s*date\s*=\s*{{\s*Start date\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i);
    const t1 = body.match(/\|\s*team1\s*=([^\n]*)/i)?.[1] ?? "";
    const t2 = body.match(/\|\s*team2\s*=([^\n]*)/i)?.[1] ?? "";
    const score = body.match(/\|\s*score\s*=[^\n]*?(\d+)\s*[–-]\s*(\d+)/i);
    const home = teamCode(t1), away = teamCode(t2);
    if (!date || !home || !away || !score) continue; // unplayed / malformed → skip
    out.push({
      group: letter,
      date: `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`,
      home, away, hs: Number(score[1]), as: Number(score[2]),
    });
  }
  return out;
}

function parseSquads(wikitext: string): Record<string, Player[]> {
  const squads: Record<string, Player[]> = {};
  // Section headers delimit teams; take text between a country header and the next header.
  const headerRe = /^==+\s*(.+?)\s*==+\s*$/gm;
  const heads = [...wikitext.matchAll(headerRe)];
  for (let i = 0; i < heads.length; i++) {
    const name = heads[i][1].trim();
    const code = NAME_TO_CODE[name];
    if (!code) continue;
    const start = heads[i].index! + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : wikitext.length;
    const block = wikitext.slice(start, end);
    const players: Player[] = [];
    for (const m of block.matchAll(/{{\s*nat fs g player\s*\|([^]*?)}}\s*(?:\n|$)/gi)) {
      const f = m[1];
      const no = f.match(/\|?\s*no\s*=\s*(\d+)/i);
      const pos = f.match(/\|\s*pos\s*=\s*([A-Z]{2})/i);
      // name is [[Link|Display]] / [[Name]] / plain — grab the whole wikilink so
      // the inner pipe of a disambiguated link ([[X (footballer)|X]]) isn't cut.
      const nm = f.match(/\|\s*name\s*=\s*(\[\[[^\]]*\]\]|[^|\n]+)/i)?.[1] ?? "";
      const disp = nm.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/'''?/g, "").trim();
      if (!no || !disp) continue;
      players.push({ n: Number(no[1]), pos: pos ? pos[1] : "MF", name: disp });
    }
    if (players.length) squads[code] = players;
  }
  return squads;
}

const here = dirname(fileURLToPath(import.meta.url));

console.log("Fetching group pages…");
const matches: Match[] = [];
const teamsByGroup: Record<string, Set<string>> = {};
for (const g of GROUPS) {
  const wt = await raw(`2026 FIFA World Cup Group ${g}`);
  const ms = parseGroup(g, wt);
  teamsByGroup[g] = new Set(ms.flatMap((m) => [m.home, m.away]));
  matches.push(...ms);
  console.log(`  Group ${g}: ${ms.length} matches, ${teamsByGroup[g].size} teams`);
}

console.log("Fetching squads page…");
const squads = parseSquads(await raw("2026 FIFA World Cup squads"));
console.log(`  ${Object.keys(squads).length} squads parsed`);

// Assemble the flat team catalogue (code, iso2, group).
const teams: Record<string, { code: string; iso2: string; group: string }> = {};
for (const g of GROUPS) for (const code of teamsByGroup[g]) {
  teams[code] = { code, iso2: CODE_TO_ISO2[code] ?? "", group: g };
}

const data = {
  meta: { source: "en.wikipedia.org", built: new Date().toISOString(), note: "2026 FIFA World Cup — real group data + squads. Knockout generated by engine." },
  teams, groupMatches: matches, squads,
};
const outPath = join(here, "data", "fifa2026.json");
writeFileSync(outPath, JSON.stringify(data, null, 2));

// Sanity summary.
const missingSquads = Object.keys(teams).filter((c) => !squads[c] || squads[c].length < 20);
const missingFlags = Object.keys(teams).filter((c) => !teams[c].iso2);
console.log(`\nWrote ${outPath}`);
console.log(`teams=${Object.keys(teams).length} groupMatches=${matches.length} squads=${Object.keys(squads).length}`);
if (missingSquads.length) console.log(`⚠ squads missing/short: ${missingSquads.join(", ")}`);
if (missingFlags.length) console.log(`⚠ flags missing: ${missingFlags.join(", ")}`);
