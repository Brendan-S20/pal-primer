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
process.env.NATIVE_BUILD = "1";
const { createBuilder } = await import("vite");
const builder = await createBuilder();
await builder.buildApp();
