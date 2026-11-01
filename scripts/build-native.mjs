// `npm run build:native`: the Capacitor bundle, which is `vite build` with
// NATIVE_BUILD set (vite.config.ts reads it to swap the SPA prerender, the
// absolute API origin and the store-binary module aliases in).
//
// This used to be the script `NATIVE_BUILD=1 vite build`. That is sh syntax:
// PowerShell, which npm uses on the Windows runner, reads `NATIVE_BUILD=1` as
// a command and fails before vite starts ("'NATIVE_BUILD' is not recognized",
// CI 2026-10-02). The main test job runs on whichever runner is free, so the
// build has to start the same way under both shells. Setting the variable
// here and calling vite's own builder does, with no dependency and no child
// process.
//
// The builder, not `build()`: since Vite 6 the CLI's `vite build` builds
// every environment through createBuilder().buildApp(), which is where the
// TanStack Start prerender writes index.html. `build()` builds one
// environment and the bundle comes out with no index.html at all --
// check:native-bundle refuses it ("nothing a WebView could boot").
//
// `--staging` (npm run build:native:staging) sets NATIVE_TARGET=staging, for
// the same PowerShell reason. A staging build must be given its backends
// (NATIVE_API_ORIGIN, NATIVE_SUPABASE_URL, NATIVE_SUPABASE_PUBLISHABLE_KEY;
// vite.config.ts refuses one that is not), and after it is built the bundle
// is scanned and the build fails if any production host is in it (#623).
import { join } from "node:path";
import { assertNoProdHosts } from "./native-prod-hosts.mjs";

process.env.NATIVE_BUILD = "1";
if (process.argv.includes("--staging")) process.env.NATIVE_TARGET = "staging";
const { createBuilder } = await import("vite");
const builder = await createBuilder();
await builder.buildApp();

if (process.env.NATIVE_TARGET === "staging") {
  assertNoProdHosts(join(process.cwd(), "dist-native", "client"));
}
