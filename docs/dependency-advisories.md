# Dependency advisory exceptions

Refs [#816](https://github.com/Brendan-S20/pal-primer/issues/816).

## Audit snapshot and scope

Audited on November 11, 2026 with Node 24.19.0 / npm 11.9.0 after the targeted `react-email` 6.6.5 → 6.11.10 update and `npm ci`, based on `main` at `ec78b176bc86577b5800b1f28fef779525ad2f71`. Reproduce with `npm ci` followed by `npm audit --json`. No `npm audit fix` was run.

`npm audit` exits 1: **39 package findings: 1 critical, 17 high, 15 moderate, 6 low**. These are npm package-level counts, including inherited findings, not distinct advisories or proven reachable vulnerabilities. Every high/critical package finding is recorded below, with every high/critical advisory URL, installed location/version, exposure rationale, and future upgrade disposition. Inherited findings explicitly point to their underlying advisory. These are documented exceptions for review, not fixes or an assertion of zero risk.

Only react-email and its required dependency subtree change. Both npm and Bun lockfiles are synchronized with the exact direct pin. This snapshot describes the npm-installed tree; Bun’s independently resolved tree differs, and `bun audit` was not run. Moderate/low findings are outside this exception inventory.

## Runtime acceptance checks from #816

The npm lockfile already contains the following versions on the base branch; this PR does not upgrade them:

| Package | Installed version | npm high/critical finding |
| --- | --- | --- |
| @tanstack/react-start | 1.168.61 | None |
| @tanstack/start-server-core | 1.169.40 | None |
| seroval | 1.7.10 | None |
| @capacitor/android | 8.4.3 | None |
| @capacitor/ios | 8.4.3 | None |
| @capacitor/core | 8.4.3 | None |
| @capacitor/cli | 8.4.3 | None |

These satisfy #816’s version floors and exclude Capacitor 8.5.0. Producing and shipping fresh Android/iOS binaries is a separate acceptance requirement; this dependency/documentation PR does not produce binaries or establish their release status. It uses `Refs #816` rather than closing the issue.

## Documented exceptions

### @capacitor-community/stripe-terminal — high

Installed npm locations:

- `node_modules/@capacitor-community/stripe-terminal`: **8.3.0**.

Advisories:

- [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) (high): ws: Memory exhaustion DoS from tiny fragments and data chunks.

Inherited through: `@stripe/terminal-js`; see those exception entries for the affected dependency location.

**Exposure / exception rationale:** The plugin is shipped for Tap to Pay, but this finding is inherited from @stripe/terminal-js → ws. The native SDK handles native payments; the web adapter loads Stripe’s browser script, rather than starting a Node ws server. See src/lib/tap-to-pay-terminal.ts and the installed terminal.esm.js loader. This is a narrow exception for the unused Node ws implementation, not for all payment code.

**Later upgrade:** Review the plugin/Terminal dependency chain in a separate tested change; do not apply npm’s suggested major downgrade to 6.1.0.

### @stripe/terminal-js — high

Installed npm locations:

- `node_modules/@stripe/terminal-js`: **0.24.0**.

Advisories:

- [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) (high): ws: Memory exhaustion DoS from tiny fragments and data chunks.

Inherited through: `ws`; see those exception entries for the affected dependency location.

**Exposure / exception rationale:** Pulled by the Capacitor Stripe Terminal plugin. Its browser loader injects https://js.stripe.com/terminal/v1 and resolves null on the server; its distributed loader does not import ws. No Node ws server is started by this integration.

**Later upgrade:** Plan a separate plugin/Terminal dependency review; retain the current integration until a compatible fix is validated.

### @xmldom/xmldom — high

Installed npm locations:

- `node_modules/@xmldom/xmldom`: **0.9.10**.

Advisories:

- [GHSA-6mj3-qw4j-hgrw](https://github.com/advisories/GHSA-6mj3-qw4j-hgrw) (high): xmldom: HTML raw-text closing-tag case mismatch causes output amplification.
- [GHSA-g53g-w8rj-fmg7](https://github.com/advisories/GHSA-g53g-w8rj-fmg7) (high): xmldom PI grammar regex ReDoS: quadratic backtracking on unterminated processing instructions.
- [GHSA-w2rr-34g9-rvrj](https://github.com/advisories/GHSA-w2rr-34g9-rvrj) (high): xmldom: Element name injection via createElement() bypasses requireWellFormed.
- [GHSA-4w3w-2rp5-g8jm](https://github.com/advisories/GHSA-4w3w-2rp5-g8jm) (high): xmldom: Attribute name injection via setAttribute() bypasses requireWellFormed.
- [GHSA-c7q8-3ch8-vqpv](https://github.com/advisories/GHSA-c7q8-3ch8-vqpv) (high): xmldom: Processing Instruction Target Injection Bypasses requireWellFormed.
- [GHSA-27p8-2357-5qqv](https://github.com/advisories/GHSA-27p8-2357-5qqv) (high): xmldom: DocType name Injection Bypasses requireWellFormed.
- [GHSA-3px3-54cx-rmw9](https://github.com/advisories/GHSA-3px3-54cx-rmw9) (high): xmldom: Creation-time XML Name/QName validation is bypassable via an embedded line terminator, allowing injection on the default serialization path.
- [GHSA-vr34-hp96-76pp](https://github.com/advisories/GHSA-vr34-hp96-76pp) (high): xmldom: requireWellFormed DocType publicId/systemId validation is bypassable via an embedded line terminator.
- [GHSA-8344-3jmq-59r6](https://github.com/advisories/GHSA-8344-3jmq-59r6) (high): xmldom: Quadratic-time attribute deduplication.
- [GHSA-965w-775f-mr7g](https://github.com/advisories/GHSA-965w-775f-mr7g) (high): xmldom: Quadratic-memory consumption.
- [GHSA-93r5-fhx6-vmg9](https://github.com/advisories/GHSA-93r5-fhx6-vmg9) (high): xmldom: Quadratic-time parsing via the malformed-input recovery path — parseElementStartPart re-scan and normalize() adjacent-text merge.

**Exposure / exception rationale:** @capacitor/cli → plist uses this XML parser for native project tooling. It is not used by application request handlers or shipped native WebViews. Malicious project XML remains a tooling risk.

**Later upgrade:** Plan a compatible transitive update in a separate dependency change; deferred by this PR’s react-email-only scope.

### brace-expansion — high

Installed npm locations:

- `node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion`: **5.0.7**.
- `node_modules/brace-expansion`: **1.1.15**.
- `node_modules/filelist/node_modules/brace-expansion`: **2.1.1**.
- `node_modules/glob/node_modules/brace-expansion`: **5.0.7**.
- `node_modules/workbox-build/node_modules/brace-expansion`: **5.0.7**.

Advisories:

- [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) (high): brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups.
- [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (high): brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash.
- [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) (high): brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation.
- [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) (high): brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion.
- [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) (high): brace-expansion: DoS via uncontrolled recursion in parseCommaParts causing stack exhaustion.

**Exposure / exception rationale:** Glob/minimatch chains used by ESLint/TypeScript tooling, filelist and Workbox build tooling perform expansion during development/builds. These expansion APIs are not used by shipped request handlers. Untrusted build inputs remain a tooling risk.

**Later upgrade:** Plan compatible transitive updates separately; no unrelated lockfile refresh in this PR.

### browserslist — high

Installed npm locations:

- `node_modules/browserslist`: **4.28.4**.

Advisories:

- [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) (high): Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM.
- [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) (high): Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats).

**Exposure / exception rationale:** Browser-target queries run in the Babel/CSS build pipeline; request handlers do not accept or evaluate Browserslist queries or custom statistics files.

**Later upgrade:** Plan a compatible build-tool transitive update separately.

### engine.io — high

Installed npm locations:

- `node_modules/engine.io`: **6.6.9**.

Advisories:

- [GHSA-2gc4-cqfq-p2gv](https://github.com/advisories/GHSA-2gc4-cqfq-p2gv) (high): Socket.IO: Engine.IO Protocol Revision Mismatch DoS.

**Exposure / exception rationale:** react-email → socket.io supplies the email CLI preview server. Application email paths import render() and do not run that Socket.IO preview server (including src/lib/digest.server.ts and src/routes/email/*).

**Later upgrade:** Plan a separate compatible socket.io/engine.io lockfile update; react-email 6.11.10 alone does not remove it.

### fast-uri — high

Installed npm locations:

- `node_modules/fast-uri`: **3.1.3**.

Advisories:

- [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) (high): fast-uri vulnerable to host confusion via literal backslash authority delimiter.
- [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) (high): fast-uri vulnerable to host confusion via backslash authority introducer.
- [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8) (high): fast-uri vulnerable to host confusion via skipped IDN canonicalization on scheme-relative references.
- [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc) (high): fast-uri vulnerable to server-side request forgery via malformed IPv6 normalization.
- [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) (high): fast-uri vulnerable to server-side request forgery via repeated hostname percent-decoding.
- [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) (high): fast-uri vulnerable to host confusion via percent-encoded scheme normalization.
- [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) (high): fast-uri vulnerable to authority injection via an unvalidated port in serialize.

**Exposure / exception rationale:** Used by ajv through Workbox build configuration and react-email’s conf CLI configuration. Application mail rendering does not use that CLI configuration parser, and application request handlers do not use fast-uri to fetch attacker-controlled URLs.

**Later upgrade:** Plan compatible transitive updates separately.

### js-yaml — high

Installed npm locations:

- `node_modules/js-yaml`: **4.3.0**.

Advisories:

- [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) (high): JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) — CVE-2026-59870 fix not backported.
- [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) (high): js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources.

**Exposure / exception rationale:** Direct devDependency used in tests and by xmlbuilder2 through TanStack build plugins. Production request handlers do not parse user YAML with this dependency.

**Later upgrade:** Plan the non-breaking 4.3.2 update separately; no 5.x migration in this PR.

### launch-editor — high

Installed npm locations:

- `node_modules/launch-editor`: **2.14.1**.

Advisories:

- [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) (high): launch-editor: fs.existsSync() existence check can be bypassed on Windows.

**Exposure / exception rationale:** Used by @tanstack/devtools-vite from the Lovable Vite development configuration to open an editor. Production handlers do not provide this development editor-launch endpoint.

**Later upgrade:** Plan compatible development-tool updates separately; review Windows editor-launch behavior when updating.

### nanoid — high

Installed npm locations:

- `node_modules/nanoid`: **3.3.15**.

Advisories:

- [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) (high): nanoid: non-secure generators can loop indefinitely with negative size.
- [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) (high): nanoid: custom generators can loop indefinitely when size is zero.

**Exposure / exception rationale:** This audited copy comes through postcss in the CSS build pipeline. The application does not pass request data to nanoid non-secure/custom generators.

**Later upgrade:** Plan a compatible PostCSS/build-tool transitive update separately.

### postcss — high

Installed npm locations:

- `node_modules/postcss`: **8.5.16**.

Advisories:

- [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) (high): PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure.

**Exposure / exception rationale:** Vite/Workbox process CSS and source maps at build time. The shipped server does not run a PostCSS service on user-supplied CSS or sourceMappingURL values.

**Later upgrade:** Plan compatible build-tool updates separately; treat untrusted source CSS/maps as a build-time risk.

### shell-quote — critical

Installed npm locations:

- `node_modules/shell-quote`: **1.9.0**.

Advisories:

- [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) (critical): shell-quote: quote() command injection via a line terminator in a token after a { comment } token.

**Exposure / exception rationale:** @lovable.dev/vite-tanstack-config → @tanstack/devtools-vite → launch-editor → shell-quote runs only in development editor tooling. Production request handlers do not quote attacker tokens into shell commands with this API. The command-injection severity remains critical for affected tooling use.

**Later upgrade:** Plan a compatible development-tool transitive update separately; deferred solely to preserve the requested dependency scope.

### socket.io-parser — high

Installed npm locations:

- `node_modules/socket.io-parser`: **4.2.6**.

Advisories:

- [GHSA-2m8v-j782-fhvr](https://github.com/advisories/GHSA-2m8v-j782-fhvr) (high): Socket.IO: Zero-attachment Memory Exhaustion.

**Exposure / exception rationale:** react-email → socket.io uses this parser for the CLI preview server. The application imports render() for email output and never starts that preview Socket.IO server.

**Later upgrade:** Plan a separate compatible socket.io/parser lockfile update.

### source-map-js — high

Installed npm locations:

- `node_modules/source-map-js`: **1.2.1**.

Advisories:

- [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high): source-map-js allows event-loop denial of service through indexed source-map section offsets.

**Exposure / exception rationale:** PostCSS consumes this copy for CSS source-map processing during builds. Request handlers do not parse attacker-supplied indexed source maps with it.

**Later upgrade:** Plan a compatible PostCSS/source-map dependency update separately.

### tar — high

Installed npm locations:

- `node_modules/tar`: **7.5.19**.

Advisories:

- [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m) (high): node-tar: Uncontrolled recursion in mapHas/filesFilter allows uncatchable stack-overflow DoS via crafted long-path tar with member selection.

**Exposure / exception rationale:** @capacitor/cli uses tar for native tooling, not in production web handlers or the shipped WebView. The reported member-selection recursion requires processing crafted archive input in that tooling.

**Later upgrade:** Plan a compatible CLI/transitive update separately; no Capacitor changes in this PR.

### vite — high

Installed npm locations:

- `node_modules/vite`: **8.1.3**.

Advisories:

- [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) (high): launch-editor: fs.existsSync() existence check can be bypassed on Windows.

**Exposure / exception rationale:** The direct devDependency is the bundler/development server, not the deployed request server. The reported high editor-launch behavior requires development tooling.

**Later upgrade:** Plan the non-breaking 8.3.7 update separately; no Vite upgrade here.

### ws — high

Installed npm locations:

- `node_modules/@stripe/terminal-js/node_modules/ws`: **6.2.3**.

Advisories:

- [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) (high): ws: Memory exhaustion DoS from tiny fragments and data chunks.

**Exposure / exception rationale:** The affected 6.2.3 copy exists only under @stripe/terminal-js. The shipped integration uses native Terminal SDKs or the browser script loader, whose distributed code does not import ws or create a Node WebSocket server. The vulnerable Node frame parser is therefore not on the shipped request path.

**Later upgrade:** Resolve through a separately tested Terminal/plugin update; no forced override or major downgrade in this PR.

### zod — high

Installed npm locations:

- `node_modules/zod`: **3.25.76**.

Advisories:

- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high): Zod can exhaust memory while validating oversized constrained collections.

**Exposure / exception rationale:** This is an advisory applicability exception, not a claim that Zod is absent from runtime: app code uses Zod 3.25.76. npm’s range flags all versions <4.6.6, while #816 identifies the described issue as Zod 4 $ZodArray issue accumulation. Migrating the app to Zod 4 would be breaking. Nested npm Zod 4 copies are already 4.6.7 and not flagged. Reassess this exception if Zod 3 impact is established.

**Later upgrade:** A Zod 4 migration requires its own compatibility work; not scheduled by this PR. Revisit on advisory clarification or a compatible Zod 3 fix.

## Review policy

Re-run the audit whenever dependencies change and update this inventory against the resolved npm tree. Review these exceptions during the next dependency maintenance pass; development/build-only exposure is not permission to process untrusted inputs. Upgrade plans above are follow-up recommendations, not a promise of a scheduled release. Do not suppress findings in CI or change feature flags, environment settings, or migrations to hide them.
