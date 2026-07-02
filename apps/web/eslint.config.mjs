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
  // Override default ignores of eslint-config-next.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
