// Client i18n runtime (v5 i18n cycle 47). Form-heavy console feature pages can't
// thread per-string props to every island, so the server resolves the active
// locale's dict once and provides it via <DictProvider>; islands read copy with
// useT()/usePlural()/useLocale(). These render through react-dom/server (node
// env, no DOM) exactly like the cycle-46 chrome islands.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider, useT, usePlural, useLocale, useMsg } from "@/components/i18n/dict-provider";
import { buildPseudoDictionary } from "@/lib/pseudo";
import uiEn from "@/dictionaries/en/ui.json";

const dict = {
  greeting: "Bonjour {name}",
  "entrants.one": "{count} entrant",
  "entrants.other": "{count} entrants",
};

function Probe() {
  const t = useT();
  const p = usePlural();
  const locale = useLocale();
  return (
    <div>
      <span id="g">{t("greeting", { name: "Ada" })}</span>
      <span id="one">{p("entrants", 1)}</span>
      <span id="many">{p("entrants", 3)}</span>
      <span id="loc">{locale}</span>
    </div>
  );
}

describe("DictProvider client i18n", () => {
  it("useT() resolves + interpolates from the provided dict", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <Probe />
      </DictProvider>,
    );
    expect(html).toContain("Bonjour Ada");
  });

  it("usePlural() selects the plural category via the provided locale", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <Probe />
      </DictProvider>,
    );
    expect(html).toContain(">1 entrant<");
    expect(html).toContain(">3 entrants<");
  });

  it("useLocale() exposes the resolved locale to islands", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <Probe />
      </DictProvider>,
    );
    expect(html).toContain(">fr<");
  });

  it("only the active locale's dict crosses the boundary (pseudolocale audit)", () => {
    const pseudo = buildPseudoDictionary(dict);
    const html = renderToStaticMarkup(
      <DictProvider dict={pseudo} locale="en">
        <Probe />
      </DictProvider>,
    );
    expect(html).toContain("⟦");
    expect(html).not.toContain(">Bonjour Ada<");
  });

  it("useMsg() reads the ui copy catalog with the provider's localized dict", () => {
    // A fr provider carrying a translated `ui` key: islands convert msg("k") ->
    // const msg = useMsg(); msg("k") with no other change, and get localized copy.
    function MsgProbe() {
      const msg = useMsg();
      return <span id="chip">{msg("chip.draft")}</span>;
    }
    const html = renderToStaticMarkup(
      <DictProvider dict={{ ...uiEn, "chip.draft": "Brouillon" }} locale="fr">
        <MsgProbe />
      </DictProvider>,
    );
    expect(html).toContain(">Brouillon<");
    expect(html).not.toContain(">Draft<");
  });

  it("useMsg() falls back to the English catalog outside a DictProvider", () => {
    // Islands shared between /o (provider present) and public/me/checkin (no
    // provider) can convert to useMsg() safely: off-console they render English,
    // exactly as msg() did, instead of crashing.
    function OrphanMsg() {
      const msg = useMsg();
      return <span id="chip">{msg("chip.live")}</span>;
    }
    const html = renderToStaticMarkup(<OrphanMsg />);
    expect(html).toContain(">Live<");
  });

  it("useT() throws a clear error when used outside a DictProvider", () => {
    function Orphan() {
      useT();
      return null;
    }
    expect(() => renderToStaticMarkup(<Orphan />)).toThrow(/DictProvider/);
  });
});
