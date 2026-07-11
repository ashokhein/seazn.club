"use client";

// Self-hosted Scalar (v3/08 §3): MIT, bundled from node_modules — no CDN,
// no external fonts (withDefaultFonts: false keeps the CSP story clean).
// Vue-under-the-hood, so it must only ever mount client-side. The stylesheet
// is a separate package export — without it the reference renders as a bare
// unstyled document (bitten 2026-07-11).
import "@scalar/api-reference-react/style.css";
import dynamic from "next/dynamic";

const ApiReferenceReact = dynamic(
  () => import("@scalar/api-reference-react").then((m) => m.ApiReferenceReact),
  { ssr: false, loading: () => <p className="p-8 text-sm text-slate-500">Loading reference…</p> },
);

export function ScalarReference() {
  return (
    <ApiReferenceReact
      configuration={{
        url: "/api/v1/openapi.json?published=1",
        withDefaultFonts: false,
        hideDarkModeToggle: true,
        customCss: `:root { --scalar-color-accent: #7c3aed; }`,
        metaData: { title: "seazn.club API reference" },
      }}
    />
  );
}
