// Lint config for @seazn/engine.
//
// Deliberately NOT the apps/web config: that one is built on
// eslint-config-next (core-web-vitals + typescript), which pulls in React,
// JSX, hooks and Next-router rules. The engine is a dependency-free pure
// library — no React, no DOM, no Next — so it gets its own flat config from
// @eslint/js + typescript-eslint and nothing else.
//
// Type-AWARE linting is on (`recommendedTypeChecked`, not `recommended`).
// It costs ~16 s over 179 files, and it is what makes the rules that actually
// matter for this package work at all: no-floating-promises and
// await-thenable over the async z3 bridge, and no-unnecessary-type-assertion,
// which matters more here than anywhere else in the repo — a stale `as X` in a
// kernel silently swallows exactly the type regression the frozen-golden
// corpora exist to catch.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

// The `any` boundary rules. These are correct rules that this package cannot
// satisfy at three specific seams, listed at each use below. Kept ON for the
// ~150 pure files where an `any` really is a defect.
const ANY_BOUNDARY_RULES = {
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  "@typescript-eslint/no-unsafe-return": "off",
  "@typescript-eslint/no-unsafe-call": "off",
};

export default defineConfig([
  globalIgnores([
    // Recorded corpora — data, never linted, and never rewritten (see the
    // frozen-golden regime in src/testkit/golden.ts).
    "**/*.golden.json",
    "node_modules/**",
    "coverage/**",
    ".vite/**",
    ".vite-temp/**",
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // tsconfig.json covers src/**, test/** and vitest.config.ts. The
          // three scripts/ benchmarks are deliberately outside it (they are
          // run by hand with --experimental-strip-types, never type-checked
          // by `npm run typecheck`), and this config file is .mjs. Both still
          // get linted, just against the default compiler options.
          // Deliberately shallower than the `scripts/**/*.ts` override below,
          // and NOT by preference: typescript-eslint rejects `**` in
          // allowDefaultProject outright ("contains a disallowed '**'") as a
          // performance guard, so this is the only legal form.
          //
          // The asymmetry has one consequence worth knowing: add a nested
          // script such as scripts/bench/x.ts and it will fail to lint with
          // "was not found by the project service". The fix is to add its
          // directory here explicitly (e.g. "scripts/bench/*.ts") — or, if
          // scripts/ ever grows enough to want real type-checking, to give it
          // a tsconfig and drop it from allowDefaultProject entirely.
          allowDefaultProject: ["*.mjs", "scripts/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // A suppression that stopped being needed is a suppression nobody will
      // ever remove. Fail on it rather than warn.
      reportUnusedDisableDirectives: "error",
    },
  },

  {
    rules: {
      // `_`-prefixed bindings are this package's existing convention for the
      // "signature requires it, implementation does not use it" case — kernel
      // hooks such as (_cfg, _stage) must keep their positional shape.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // The engine is a pure library: it returns values, it does not print.
      // Two harnesses legitimately report progress and already carry the
      // `eslint-disable-next-line no-console` comments that predate this
      // config; scripts/ is exempted below.
      "no-console": "error",
      // A suppression must announce itself. `@ts-ignore` silently absorbs
      // whatever error appears under it; `@ts-expect-error` errors when it
      // stops being needed, which is what makes a compiler upgrade report a
      // behaviour delta instead of swallowing it. Zero of either existed when
      // this rule went in — it is a ratchet, not a cleanup.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
    },
  },

  {
    // Specs. They parse recorded JSON and reach into vitest matchers, and are
    // routinely declared async for symmetry across a table of cases even when
    // a given case has nothing to await.
    //
    // Scoped to specs ONLY. src/testkit/** is deliberately NOT here: it is
    // ~3.8k lines of non-test code and `src/testkit/index.ts` is a public
    // entrypoint (`"./testkit"` in package.json exports), so it is held to the
    // same standard as the rest of src.
    files: ["**/*.test.ts", "test/**/*.ts"],
    rules: {
      ...ANY_BOUNDARY_RULES,
      // Fires on `expect(obj.method)` / passing kernel methods as callbacks,
      // which is the normal shape of a conformance spec here.
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    // The two reflective walkers. schema-fields.ts walks zod schemas through
    // `_def` and golden.ts walks recorded JSON of a shape it is specifically
    // trying NOT to assume — typing either would mean asserting the structure
    // the walker exists to discover.
    files: ["src/testkit/schema-fields.ts", "src/testkit/golden.ts"],
    rules: ANY_BOUNDARY_RULES,
  },

  {
    // The z3-solver bridge proper: z3-solver 5.0.0 ships its WASM API
    // essentially untyped, so every value crossing back is `any`, and
    // `no-base-to-string` fires on the solver's own stringifiable AST nodes.
    // repair.ts is NOT here — it is the orchestrator above the bridge and
    // imports only types plus loadZ3/withZ3Lock, so the handful of solver
    // returns it does touch carry per-site disables instead.
    files: ["src/scheduling/z3-*.ts"],
    rules: {
      ...ANY_BOUNDARY_RULES,
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  {
    // Hand-run benchmarks: printing the table IS their output.
    files: ["scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
]);
