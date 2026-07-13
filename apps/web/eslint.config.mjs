// Next 16: `next lint` is removed and eslint-config-next ships flat configs —
// import them directly; FlatCompat over "next/*" shareable configs breaks
// (see node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md).
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Legal/marketing pages are prose-heavy; escaping every apostrophe hurts
      // readability more than it helps.
      "react/no-unescaped-entities": "off",
      // React-Compiler-era rules (new defaults in eslint-config-next 16).
      // Existing components predate them; kept visible as warnings until the
      // refactor tracked in development/DEFERRED.md.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
    },
  },
  {
    // v3/03 §3: native dialogs are banned — use useConfirm() from
    // components/ui/confirm-provider (regression gate for PROMPT-32).
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "confirm", message: "Use useConfirm() from components/ui/confirm-provider." },
        { name: "alert", message: "Render inline feedback, not alert()." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "confirm", message: "Use useConfirm() from components/ui/confirm-provider." },
        { object: "window", property: "alert", message: "Render inline feedback, not window.alert()." },
      ],
    },
  },
  {
    // v3/01 §6 (PROMPT-30): console URLs come from routes.* — string-built
    // paths break when the URL scheme changes. Excluded: the builder itself,
    // legacy redirect resolution + stub pages, API path docs, robots.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/routes.ts",
      "src/server/legacy-routes.ts",
      "src/server/api-v1/**",
      "src/app/competitions/**",
      "src/app/divisions/**",
      "src/app/fixtures/**",
      "src/app/robots.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["JSXAttribute[name.name='href'] Literal",
          "JSXAttribute[name.name='href'] TemplateLiteral > TemplateElement:first-child",
          "CallExpression[callee.name=/^(redirect|permanentRedirect)$/] > Literal",
          "CallExpression[callee.name=/^(redirect|permanentRedirect)$/] > TemplateLiteral > TemplateElement:first-child",
          "CallExpression[callee.property.name=/^(push|replace|prefetch)$/] > Literal",
          "CallExpression[callee.property.name=/^(push|replace|prefetch)$/] > TemplateLiteral > TemplateElement:first-child",
        ].map((base) => ({
          selector: `${base}[value${base.includes("TemplateElement") ? ".raw" : ""}=/^\\u002F(o|competitions|divisions|fixtures)\\u002F/]`,
          message: "Build console hrefs with routes.* from @/lib/routes (PROMPT-30).",
        })),
      ],
    },
  },
  {
    // Console pages are fully dynamic (private, no-store) with no loading.tsx
    // boundaries: next/link's default viewport prefetch renders the whole
    // target page (DB queries included) per visible link, and re-runs after
    // every router.refresh(). Console surfaces must use ConsoleLink, which
    // pins prefetch off (regression gate for the 2026-07-13 HAR finding:
    // one division view = 26 full renders).
    files: ["src/app/o/**/*.{ts,tsx}", "src/app/admin/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/link",
              message:
                "Console surfaces: import Link from @/components/ui/console-link (prefetch off by default).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
