import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ── GENERATED OUTPUT IS NOT SOURCE ────────────────────────────────────
  //
  // `dist`, `.output` and `.vinxi` were here already. The three added beside
  // them are the native build products, and leaving them out cost a CI run:
  //
  //   * `dist-native/` is what `npm run build:native` emits — 799 files. CI
  //     builds it in the step BEFORE this one, so by the time eslint runs it is
  //     sitting there waiting to be walked.
  //   * `ios/` and `android/` each carry a COPY of that bundle
  //     (`App/App/public`, `app/src/main/assets/public`), plus whatever a local
  //     Xcode or Gradle build has left behind — 1,406 files after one
  //     `assembleDebug`.
  //
  // On 2026-08-22 the CI job passed every hard gate and was then killed at its
  // 45-minute ceiling INSIDE this step, which turns a green run red for the
  // sake of linting files nobody wrote. The step is `continue-on-error: true`,
  // so it could never have failed the build on its own merits — but a job-level
  // timeout does not care which step is non-blocking.
  //
  // Nothing authored is excluded: `ios/UITests` is Swift, and the only
  // JavaScript under these paths is a build artifact or a copy of one.
  { ignores: ["dist", ".output", ".vinxi", "dist-native", "ios", "android"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  eslintPluginPrettier,
);
