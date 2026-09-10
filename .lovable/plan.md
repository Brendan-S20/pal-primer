# Why `/sw.js` and `/workbox-*.js` 404 in production

## Finding

The two files are not being dropped after upload — in the hosted build they are
written to a directory the deploy never looks at.

`@lovable.dev/vite-tanstack-config` (node_modules/.../dist/index.js, lines
~640–690) branches on whether it is running inside the Lovable build
environment (`LOVABLE_SANDBOX=1` or `DEV_SERVER__PROJECT_PATH` set). In that
branch it **overrides Nitro's output paths**:

```js
nitroOpts.preset = "cloudflare-module";
nitroOpts.output = { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" };
```

Outside that environment (a laptop, plain CI) the override does not apply and
Nitro's cloudflare-module defaults produce `.output/server` + `.output/public`.

`vite.config.ts` hardcodes `VitePWA({ outDir: ".output/public" })`.

So in the hosted build:

- Everything Rollup emits (hashed `/assets/*`, `manifest.webmanifest` via
  `emitFile`, files copied from `public/`) lands wherever Nitro's client
  publicDir is — `dist/client` — and is deployed.
- `sw.js` and `workbox-<hash>.js`, the only two files `vite-plugin-pwa` writes
  **directly to disk** in `closeBundle` using its own `outDir`, land in
  `.output/public`, which the hosted build does not produce or ship.

This matches every measurement already taken: the local build is correct (local
paths agree), the deployment is current, head content and all other static
files are live, and the 404 comes from the SSR worker because the asset layer
genuinely never had the file. It also explains the one distinguishing property
exactly — emitted-through-Rollup vs written-to-disk is precisely the line
between "follows Nitro's configured publicDir" and "follows VitePWA's
hardcoded outDir".

The timestamp race observed locally is a red herring; locally both directories
are the same directory.

## Answers to the four questions

a) **Asset list.** Not a snapshot and not derived from the Rollup graph — the
   deploy ships Nitro's build output directory. The relevant list is "what
   Nitro put in its client publicDir", and Nitro only knows about files that
   went through the bundle or its own public-dir copy.

b) **Timing.** Not applicable in the way suspected. There is no earlier
   snapshot racing `closeBundle`; the issue is directory identity, not
   ordering.

c) **Filtering.** No ignore list found in the wrapper. Nothing filters
   `sw.js`.

d) **Termination.** The build runs `vite build` to completion; `closeBundle`
   does run. The worker is written — to the wrong place in this environment.

## Confirming before changing anything

One command, no code edits:

```
LOVABLE_SANDBOX=1 npm run build
```

Expected if the diagnosis is right: `dist/client/` holds `manifest.webmanifest`
and `assets/` but **no** `sw.js`, while `.output/public/` holds only `sw.js`
and `workbox-*.js`. (`npm run build`'s trailing `check-pwa-output.mjs` reads
`.output/public` and will report against the wrong directory too.)

## Proposed fix (for review with the repo owner — not applied)

In `vite.config.ts`, derive the PWA `outDir` from the same environment the
wrapper branches on instead of hardcoding it:

```ts
const HOSTED_BUILD = process.env.LOVABLE_SANDBOX === "1" || !!process.env.DEV_SERVER__PROJECT_PATH;
outDir: NATIVE_BUILD ? "dist-native/client" : HOSTED_BUILD ? "dist/client" : ".output/public",
```

and make `scripts/check-pwa-output.mjs` resolve its `OUT` the same way, so the
build-time check inspects the directory that is actually deployed. Without the
second half the check keeps passing on a directory the deploy ignores — the
same "validated the artifact, not the running thing" shape the existing PWA
checks were written to avoid.

A sturdier variant, if preferred: read the resolved Nitro output path rather
than re-deriving the environment test, so a future change to the wrapper's
branch cannot silently split them apart again.

## Risk

The change is confined to a build-time output path and the check script. No
runtime code, no registration logic, no Nitro/preset change. If it is wrong,
`sw.js` continues to 404 exactly as today.
