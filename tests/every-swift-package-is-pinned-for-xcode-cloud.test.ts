// Xcode Cloud archives with automatic package resolution OFF, so
// ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
// has to already name every remote Swift package the graph needs, at a
// version every requirement accepts. If it does not, the archive stops at
// "Resolve Package Graph":
//
//     an out-of-date resolved file was detected at .../Package.resolved, which
//     is not allowed when automatic dependency resolution is disabled ...
//     the following dependencies were added: 'stripe-terminal-ios'
//
// That is what happened after Tap to Pay (#757) added
// @capacitor-community/stripe-terminal. Its Package.swift asks for
// stripe-terminal-ios, and nobody had opened the project in Xcode to write the
// pin, so TestFlight archives failed on main.
//
// ── WHY THIS READS node_modules AND NOT ONLY project.pbxproj ──────────────
//
// project.pbxproj has a single LOCAL package reference, CapApp-SPM. Every
// Capacitor plugin is a `path:` package inside node_modules, and the remote
// packages come in through THOSE manifests (stripe-terminal-ios, the ion-ios-*
// libraries). A check that read only the pbxproj would have passed while the
// archive failed. So this walks the graph the way SwiftPM does: from the
// project's package references, through every local manifest, collecting each
// `.package(url:)` and its requirement. It needs `npm ci` to have run, which
// every test job does. postinstall (scripts/patch-native-plugins.mjs) has to
// have run too, because it rewrites one of those requirements.
//
// What it cannot see offline is what a REMOTE package depends on in turn. None
// of the five pinned today depend on anything else. If one ever does, Xcode
// Cloud's error names the package, and the fix is to add a pin by hand the
// same way.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");
const PROJECT = join(root, "ios/App/App.xcodeproj/project.pbxproj");
const RESOLVED = join(
  root,
  "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
);

type Requirement =
  { kind: "exact"; version: string } | { kind: "range"; lower: string; upper: string };

type RemoteDep = { url: string; requirement: Requirement; declaredIn: string };

type Pin = {
  identity: string;
  kind: string;
  location: string;
  state: { revision: string; version?: string };
};

const parseVersion = (v: string): [number, number, number] => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a plain semantic version: "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const compare = (a: string, b: string) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const satisfies = (version: string, r: Requirement) =>
  r.kind === "exact"
    ? compare(version, r.version) === 0
    : compare(version, r.lower) >= 0 && compare(version, r.upper) < 0;

/** SwiftPM's identity for a remote package: the last path component, minus .git, lowercased. */
const identityOf = (url: string) =>
  url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .pop()!
    .toLowerCase();

const normaliseUrl = (url: string) =>
  url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();

/** The requirement spellings in use here. Anything else fails, rather than being guessed at. */
function parseSwiftRequirement(text: string, where: string): Requirement {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^exact:\s*"([^"]+)"$/.exec(t)) || (m = /^\.exact\(\s*"([^"]+)"\s*\)$/.exec(t)))
    return { kind: "exact", version: m[1] };
  if (
    (m = /^from:\s*"([^"]+)"$/.exec(t)) ||
    (m = /^\.upToNextMajor\(\s*from:\s*"([^"]+)"\s*\)$/.exec(t))
  ) {
    const [major] = parseVersion(m[1]);
    return { kind: "range", lower: m[1], upper: `${major + 1}.0.0` };
  }
  if ((m = /^\.upToNextMinor\(\s*from:\s*"([^"]+)"\s*\)$/.exec(t))) {
    const [major, minor] = parseVersion(m[1]);
    return { kind: "range", lower: m[1], upper: `${major}.${minor + 1}.0` };
  }
  if ((m = /^"([^"]+)"\s*\.\.<\s*"([^"]+)"$/.exec(t)))
    return { kind: "range", lower: m[1], upper: m[2] };
  throw new Error(
    `${where}: unrecognised package requirement \`${t}\` — teach this test to read it`,
  );
}

/** `.package(url:)` and `.package(path:)` entries from one Package.swift. */
export function readManifest(text: string, where: string) {
  const remotes: RemoteDep[] = [];
  const locals: string[] = [];
  for (const m of text.matchAll(/\.package\(\s*url:\s*"([^"]+)"\s*,\s*([^\n]*?)\)\s*,?\s*$/gm)) {
    remotes.push({ url: m[1], requirement: parseSwiftRequirement(m[2], where), declaredIn: where });
  }
  for (const m of text.matchAll(/\.package\(\s*(?:name:\s*"[^"]*"\s*,\s*)?path:\s*"([^"]+)"/g)) {
    locals.push(m[1]);
  }
  return { remotes, locals };
}

/** XCRemoteSwiftPackageReference / XCLocalSwiftPackageReference from project.pbxproj. */
export function readProject(text: string) {
  const remotes: RemoteDep[] = [];
  const locals: string[] = [];
  for (const block of text.matchAll(
    /isa = XCRemoteSwiftPackageReference;([\s\S]*?)\r?\n\t\t\};/g,
  )) {
    const body = block[1];
    const url = /repositoryURL = "?([^";\s]+)"?;/.exec(body)?.[1];
    const kind = /kind = (\w+);/.exec(body)?.[1];
    if (!url || !kind) throw new Error(`project.pbxproj: unreadable remote package block:${body}`);
    const field = (name: string) => {
      const v = new RegExp(`${name} = "?([^";\\s]+)"?;`).exec(body)?.[1];
      if (!v) throw new Error(`project.pbxproj: ${url} has kind ${kind} but no ${name}`);
      return v;
    };
    let requirement: Requirement;
    if (kind === "exactVersion") requirement = { kind: "exact", version: field("version") };
    else if (kind === "upToNextMajorVersion") {
      const lower = field("minimumVersion");
      requirement = { kind: "range", lower, upper: `${parseVersion(lower)[0] + 1}.0.0` };
    } else if (kind === "upToNextMinorVersion") {
      const lower = field("minimumVersion");
      const [major, minor] = parseVersion(lower);
      requirement = { kind: "range", lower, upper: `${major}.${minor + 1}.0` };
    } else if (kind === "versionRange")
      requirement = {
        kind: "range",
        lower: field("minimumVersion"),
        upper: field("maximumVersion"),
      };
    else
      throw new Error(`project.pbxproj: ${url} uses requirement kind ${kind} — not supported here`);
    remotes.push({ url, requirement, declaredIn: "ios/App/App.xcodeproj/project.pbxproj" });
  }
  for (const block of text.matchAll(
    /isa = XCLocalSwiftPackageReference;\s*relativePath = "?([^";]+)"?;/g,
  )) {
    locals.push(block[1]);
  }
  return { remotes, locals };
}

/** Every remote dependency reachable from the project through local packages. */
function collectGraph() {
  const project = readProject(readFileSync(PROJECT, "utf8"));
  const remotes = [...project.remotes];
  const missing: string[] = [];
  const seen = new Set<string>();
  // pbxproj relative paths are relative to the directory holding App.xcodeproj.
  const queue = project.locals.map((p) => resolve(dirname(dirname(PROJECT)), p));
  while (queue.length) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = join(dir, "Package.swift");
    if (!existsSync(manifest)) {
      missing.push(repoRelative(manifest, root));
      continue;
    }
    const where = repoRelative(manifest, root);
    const parsed = readManifest(readFileSync(manifest, "utf8"), where);
    remotes.push(...parsed.remotes);
    for (const p of parsed.locals) queue.push(resolve(dir, p));
  }
  return { remotes, missing, localPackages: seen.size };
}

/** Every way the resolved file disagrees with the graph, as sentences. */
export function problems(remotes: RemoteDep[], pins: Pin[]): string[] {
  const out: string[] = [];
  const byIdentity = new Map(pins.map((p) => [p.identity, p]));
  for (const dep of remotes) {
    const id = identityOf(dep.url);
    const pin = byIdentity.get(id);
    if (!pin) {
      out.push(
        `${id} (${dep.url}) is required by ${dep.declaredIn} but has no pin in Package.resolved`,
      );
      continue;
    }
    if (normaliseUrl(pin.location) !== normaliseUrl(dep.url))
      out.push(`${id}: pinned at ${pin.location} but ${dep.declaredIn} asks for ${dep.url}`);
    if (!/^[0-9a-f]{40}$/.test(pin.state.revision))
      out.push(`${id}: pin has no full commit revision`);
    if (!pin.state.version) out.push(`${id}: pin has no version`);
    else if (!satisfies(pin.state.version, dep.requirement))
      out.push(
        `${id}: pinned ${pin.state.version}, which ${dep.declaredIn} does not accept (${JSON.stringify(dep.requirement)})`,
      );
  }
  const required = new Set(remotes.map((d) => identityOf(d.url)));
  for (const pin of pins)
    if (!required.has(pin.identity))
      out.push(
        `${pin.identity} is pinned in Package.resolved but nothing in the graph asks for it`,
      );
  return out;
}

describe("Package.resolved pins every Swift package Xcode Cloud will need", () => {
  const resolved = JSON.parse(readFileSync(RESOLVED, "utf8")) as { version: number; pins: Pin[] };
  const graph = collectGraph();

  it("found the plugins, so it is measuring the real graph and not an empty one", () => {
    // If node_modules is missing every local manifest is missing, and "no
    // remote dependency lacks a pin" would be vacuously true.
    expect(graph.missing, "run `npm ci` first — these local packages are not on disk").toEqual([]);
    expect(graph.localPackages).toBeGreaterThan(10);
    expect(graph.remotes.map((d) => identityOf(d.url))).toContain("stripe-terminal-ios");
  });

  it("keeps the format Xcode writes", () => {
    expect(resolved.version).toBe(3);
  });

  it("has a pin, at an acceptable version, for every remote package — and none extra", () => {
    expect(problems(graph.remotes, resolved.pins)).toEqual([]);
  });

  it("fails on the file as it was when the archive broke", () => {
    const before = resolved.pins.filter((p) => p.identity !== "stripe-terminal-ios");
    expect(problems(graph.remotes, before)).toEqual([
      expect.stringMatching(/^stripe-terminal-ios .* has no pin in Package\.resolved$/),
    ]);
  });

  it("fails on a pin outside the requirement (5.9.0 is not upToNextMinor of 5.8.0)", () => {
    const bumped = resolved.pins.map((p) =>
      p.identity === "stripe-terminal-ios" ? { ...p, state: { ...p.state, version: "5.9.0" } } : p,
    );
    expect(problems(graph.remotes, bumped)).toEqual([
      expect.stringMatching(/^stripe-terminal-ios: pinned 5\.9\.0, which .* does not accept/),
    ]);
  });
});

describe("the readers", () => {
  it("reads every requirement spelling used in the plugins", () => {
    const { remotes, locals } = readManifest(
      [
        '        .package(url: "https://github.com/a/one.git", exact: "1.2.3"),',
        '        .package(url: "https://github.com/a/two.git", from: "8.0.0"),',
        '        .package(url: "https://github.com/a/three.git", .upToNextMinor(from: "5.8.0"))',
        '        .package(url: "https://github.com/a/four.git", "1.0.0"..<"3.0.0"),',
        '        .package(name: "X", path: "../../x"),',
      ].join("\n"),
      "fixture",
    );
    expect(remotes.map((r) => r.requirement)).toEqual([
      { kind: "exact", version: "1.2.3" },
      { kind: "range", lower: "8.0.0", upper: "9.0.0" },
      { kind: "range", lower: "5.8.0", upper: "5.9.0" },
      { kind: "range", lower: "1.0.0", upper: "3.0.0" },
    ]);
    expect(locals).toEqual(["../../x"]);
  });

  it("refuses a requirement it does not understand instead of skipping it", () => {
    expect(() =>
      readManifest('.package(url: "https://github.com/a/b.git", branch: "main"),', "fixture"),
    ).toThrow(/unrecognised package requirement/);
  });

  it("reads a remote reference from project.pbxproj, should one ever be added in Xcode", () => {
    const { remotes } = readProject(
      [
        '\t\tAAAA /* XCRemoteSwiftPackageReference "stripe-terminal-ios" */ = {',
        "\t\t\tisa = XCRemoteSwiftPackageReference;",
        '\t\t\trepositoryURL = "https://github.com/stripe/stripe-terminal-ios.git";',
        "\t\t\trequirement = {",
        "\t\t\t\tkind = upToNextMinorVersion;",
        "\t\t\t\tminimumVersion = 5.8.0;",
        "\t\t\t};",
        "\t\t};",
      ].join("\n"),
    );
    expect(remotes).toEqual([
      expect.objectContaining({
        url: "https://github.com/stripe/stripe-terminal-ios.git",
        requirement: { kind: "range", lower: "5.8.0", upper: "5.9.0" },
      }),
    ]);
  });
});
