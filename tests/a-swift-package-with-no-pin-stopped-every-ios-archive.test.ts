// A Swift package that nobody pinned stopped every Xcode Cloud archive.
//
// #688 added @capacitor/filesystem to ios/App/CapApp-SPM/Package.swift. That
// plugin's own Package.swift depends on ion-ios-filesystem `exact: "2.0.1"`,
// and the Package.resolved that Xcode reads was not updated with it. Xcode
// Cloud resolves packages with automatic resolution DISABLED — only versions
// already in the resolved file may be used — so from that commit on, every
// "Archive to TestFlight" run stopped at dependency resolution (#723):
//
//   an out-of-date resolved file was detected at .../swiftpm/Package.resolved,
//   which is not allowed when automatic dependency resolution is disabled ...
//   Running resolver because the following dependencies were added:
//   'ion-ios-filesystem' (https://github.com/ionic-team/ion-ios-filesystem.git)
//
// The locked resolution is the right setting and stays: it is what makes an
// archive build the same graph twice. What was missing is a check that runs
// before Xcode Cloud does. Nothing on Linux can run Xcode, but the question
// "does every remote package the plugins ask for have a pin, at a version they
// accept" needs only the manifests, and this file asks it.
//
// It happened again in #844. #757 added @capacitor-community/stripe-terminal,
// whose Package.swift asks for stripe-terminal-ios as
// `.upToNextMinor(from: "5.8.0")`. The first version of this file matched only
// `.package(url:, exact:)` and `.package(url:, from:)`, so that line was not a
// non-match it complained about — it was simply not there, and the scan stayed
// green on the commit Xcode Cloud then refused (Build 519, main a2d7e9da).
// A guard that silently skips what it cannot read is a guard with a hole the
// shape of the next dependency. So now every `.package(url:` is found first
// and its requirement parsed second, and a requirement the parser does not
// know FAILS the test instead of vanishing. The same goes for any
// XCRemoteSwiftPackageReference in project.pbxproj: a package added in Xcode's
// own UI lands there, not in a Package.swift, and needs a pin just the same.
//
// Reads node_modules, like a-plugin-still-on-capacitor-7-stopped-every-ios-
// build.test.ts: a plugin's dependencies live in its own Package.swift, which
// only exists after `npm ci` (and its postinstall patch) has run.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const CAP_APP_SPM = join(root, "ios/App/CapApp-SPM");
const PBXPROJ_REL = "ios/App/App.xcodeproj/project.pbxproj";
const RESOLVED_REL =
  "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";

/**
 * What a dependency accepts. Versions are a half-open range [min, max), which
 * is what every SwiftPM version requirement reduces to: `from:` and
 * `.upToNextMajor` go to the next major, `.upToNextMinor` to the next minor,
 * `exact:` is a range of one.
 */
type Requirement =
  | { kind: "range"; min: string; max: string; spelled: string }
  | { kind: "branch"; branch: string; spelled: string }
  | { kind: "revision"; revision: string; spelled: string };
type RemoteDep = { url: string; requirement: Requirement; declaredIn: string };

/** SwiftPM's identity for a remote package: last path component, no `.git`, lowercased. */
const identity = (url: string) =>
  url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .pop()!
    .toLowerCase();

const parse = (v: string) => {
  const [a = 0, b = 0, c = 0] = v
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  return [a, b, c];
};
const fmt = (v: number[]) => v.join(".");
const nextMajor = (v: string) => fmt([parse(v)[0] + 1, 0, 0]);
const nextMinor = (v: string) => fmt([parse(v)[0], parse(v)[1] + 1, 0]);
/** The smallest version strictly greater than v, so `exact` and `...` close the range. */
const successor = (v: string) => fmt([parse(v)[0], parse(v)[1], parse(v)[2] + 1]);
function compare(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const range = (min: string, max: string, spelled: string): Requirement => ({
  kind: "range",
  min,
  max,
  spelled,
});

/**
 * Every requirement spelling SwiftPM accepts after `url:`. Anything else
 * throws, so a new spelling turns this file red rather than invisible (#844).
 */
function parseSwiftRequirement(rest: string): Requirement {
  const r = rest.trim();
  const spelled = r.replace(/\s+/g, " ");
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^exact:\s*"([^"]+)"$/)) || (m = r.match(/^\.exact\(\s*"([^"]+)"\s*\)$/)))
    return range(m[1], successor(m[1]), spelled);
  if (
    (m = r.match(/^from:\s*"([^"]+)"$/)) ||
    (m = r.match(/^\.upToNextMajor\(\s*from:\s*"([^"]+)"\s*\)$/))
  )
    return range(m[1], nextMajor(m[1]), spelled);
  if ((m = r.match(/^\.upToNextMinor\(\s*from:\s*"([^"]+)"\s*\)$/)))
    return range(m[1], nextMinor(m[1]), spelled);
  if ((m = r.match(/^"([^"]+)"\s*\.\.<\s*"([^"]+)"$/))) return range(m[1], m[2], spelled);
  if ((m = r.match(/^"([^"]+)"\s*\.\.\.\s*"([^"]+)"$/)))
    return range(m[1], successor(m[2]), spelled);
  if ((m = r.match(/^(?:branch:|\.branch\()\s*"([^"]+)"\s*\)?$/)))
    return { kind: "branch", branch: m[1], spelled };
  if ((m = r.match(/^(?:revision:|\.revision\()\s*"([^"]+)"\s*\)?$/)))
    return { kind: "revision", revision: m[1], spelled };
  throw new Error(`cannot read the SwiftPM requirement \`${spelled}\``);
}

/** The text between `.package(` and its matching `)`, for every call in the manifest. */
function packageCalls(swift: string): string[] {
  const calls: string[] = [];
  for (let i = swift.indexOf(".package("); i !== -1; i = swift.indexOf(".package(", i + 1)) {
    let depth = 0;
    let inString = false;
    for (let j = i + ".package".length; j < swift.length; j++) {
      const ch = swift[j];
      if (ch === '"' && swift[j - 1] !== "\\") inString = !inString;
      if (inString) continue;
      if (ch === "(") depth++;
      if (ch === ")" && --depth === 0) {
        calls.push(swift.slice(i + ".package(".length, j));
        break;
      }
    }
  }
  return calls;
}

function swiftRemoteDeps(packageSwift: string, declaredIn: string): RemoteDep[] {
  return packageCalls(packageSwift)
    .filter((args) => /^\s*(?:name:\s*"[^"]*"\s*,\s*)?url:/.test(args))
    .map((args) => {
      const m = args.match(/url:\s*"([^"]+)"\s*,([\s\S]*)$/);
      if (!m) throw new Error(`${declaredIn}: cannot read \`.package(${args})\``);
      try {
        return { url: m[1], requirement: parseSwiftRequirement(m[2]), declaredIn };
      } catch (e) {
        throw new Error(
          `${declaredIn}: ${(e as Error).message} for ${m[1]}. Teach parseSwiftRequirement ` +
            `this spelling — skipping it is how #844 got past this test.`,
        );
      }
    });
}

/** Every XCRemoteSwiftPackageReference in a project.pbxproj, with its requirement. */
function pbxprojRemoteDeps(pbxproj: string, declaredIn: string): RemoteDep[] {
  const objects = [
    ...pbxproj.matchAll(/=\s*\{\s*isa\s*=\s*XCRemoteSwiftPackageReference;([\s\S]*?)\n\t\t\};/g),
  ];
  const declared = (pbxproj.match(/isa\s*=\s*XCRemoteSwiftPackageReference;/g) ?? []).length;
  if (objects.length !== declared)
    throw new Error(
      `${declaredIn}: found ${declared} XCRemoteSwiftPackageReference objects but could read ${objects.length}`,
    );
  return objects.map(([, body]) => {
    const field = (name: string) => body.match(new RegExp(`\\b${name}\\s*=\\s*"?([^";]+)"?;`))?.[1];
    const url = field("repositoryURL");
    const kind = field("kind");
    const spelled = `kind = ${kind}`;
    if (!url || !kind) throw new Error(`${declaredIn}: unreadable XCRemoteSwiftPackageReference`);
    const min = field("minimumVersion");
    let requirement: Requirement;
    if (kind === "exactVersion")
      requirement = range(field("version")!, successor(field("version")!), spelled);
    else if (kind === "upToNextMajorVersion") requirement = range(min!, nextMajor(min!), spelled);
    else if (kind === "upToNextMinorVersion") requirement = range(min!, nextMinor(min!), spelled);
    else if (kind === "versionRange") requirement = range(min!, field("maximumVersion")!, spelled);
    else if (kind === "branch") requirement = { kind: "branch", branch: field("branch")!, spelled };
    else if (kind === "revision")
      requirement = { kind: "revision", revision: field("revision")!, spelled };
    else throw new Error(`${declaredIn}: cannot read requirement kind '${kind}' for ${url}`);
    return { url, requirement, declaredIn };
  });
}

type Pin = {
  identity: string;
  location: string;
  state: { revision: string; version?: string; branch?: string };
};

/** Why `pin` does not satisfy `dep`, or null when it does. */
function pinProblem(dep: RemoteDep, pin: Pin | undefined): string | null {
  const id = identity(dep.url);
  if (!pin)
    return (
      `${dep.declaredIn} depends on ${dep.url} (${dep.requirement.spelled}), ` +
      `but ${RESOLVED_REL} has no pin for '${id}'. ` +
      `Xcode Cloud resolves with automatic resolution disabled, so the archive stops ` +
      `before it builds anything (#723, #844). Resolve packages in Xcode and commit the file.`
    );
  if (identity(pin.location) !== id) return `pin '${id}' points at ${pin.location}`;
  if (!/^[0-9a-f]{40}$/.test(pin.state.revision)) return `pin '${id}' has no 40-hex revision`;
  const req = dep.requirement;
  if (req.kind === "revision")
    return pin.state.revision === req.revision
      ? null
      : `pin '${id}' is not at revision ${req.revision}`;
  if (req.kind === "branch")
    return pin.state.branch === req.branch ? null : `pin '${id}' is not on branch ${req.branch}`;
  const v = pin.state.version;
  if (!v) return `pin '${id}' has no version`;
  if (compare(v, req.min) < 0 || compare(v, req.max) >= 0)
    return `pin '${id}' is ${v}, but ${dep.declaredIn} asks for ${req.spelled} (${req.min}..<${req.max})`;
  return null;
}

const capAppSwift = readFileSync(join(CAP_APP_SPM, "Package.swift"), "utf8");
const localPaths = [
  ...capAppSwift.matchAll(/\.package\(\s*name:\s*"[^"]+"\s*,\s*path:\s*"([^"]+)"\s*\)/g),
].map((m) => m[1]);
const pbxproj = readFileSync(join(root, PBXPROJ_REL), "utf8");
const allDeps: RemoteDep[] = [
  ...swiftRemoteDeps(capAppSwift, "ios/App/CapApp-SPM/Package.swift"),
  ...localPaths.flatMap((p) =>
    swiftRemoteDeps(
      readFileSync(join(CAP_APP_SPM, p, "Package.swift"), "utf8"),
      `${p.replace(/^(\.\.\/)+/, "")}/Package.swift`,
    ),
  ),
  ...pbxprojRemoteDeps(pbxproj, PBXPROJ_REL),
];

const resolved = JSON.parse(readFileSync(join(root, RESOLVED_REL), "utf8")) as {
  version: number;
  pins: Pin[];
};
const pins = new Map(resolved.pins.map((p) => [p.identity, p]));

describe("Package.resolved pins every remote package the iOS app depends on", () => {
  it("found the plugins and their remote dependencies (the scan is not looking at nothing)", () => {
    expect(localPaths.length).toBeGreaterThan(10);
    expect(allDeps.map((d) => identity(d.url))).toEqual(
      expect.arrayContaining([
        "capacitor-swift-pm",
        "ion-ios-filesystem",
        // `.upToNextMinor(from:)` — invisible to this file until #844.
        "stripe-terminal-ios",
      ]),
    );
  });

  it("read every `.package(url:` in every manifest (none skipped for an unknown spelling)", () => {
    const manifests = [
      capAppSwift,
      ...localPaths.map((p) => readFileSync(join(CAP_APP_SPM, p, "Package.swift"), "utf8")),
    ];
    const written = manifests.reduce(
      (n, s) => n + (s.match(/\.package\(\s*(?:name:\s*"[^"]*"\s*,\s*)?url:/g) ?? []).length,
      0,
    );
    const fromSwift = allDeps.filter((d) => d.declaredIn !== PBXPROJ_REL).length;
    expect(fromSwift).toBe(written);
  });

  it.each(allDeps.map((d) => [identity(d.url), d.requirement.spelled, d] as const))(
    "%s has a pin that satisfies %s",
    (id, _spelled, dep) => {
      expect(pinProblem(dep, pins.get(id))).toBeNull();
    },
  );
});

describe("the requirement parser and version check themselves", () => {
  const ok = (version: string, spelling: string) =>
    pinProblem(
      {
        url: "https://example.com/x/pkg.git",
        requirement: parseSwiftRequirement(spelling),
        declaredIn: "t",
      },
      {
        identity: "pkg",
        location: "https://example.com/x/pkg.git",
        state: { revision: "a".repeat(40), version },
      },
    ) === null;

  it("reads `from:` and `.upToNextMajor` as up to the next major", () => {
    expect(ok("2.1.1", 'from: "2.1.0"')).toBe(true);
    expect(ok("2.0.9", 'from: "2.1.0"')).toBe(false);
    expect(ok("3.0.0", 'from: "2.1.0"')).toBe(false);
    expect(ok("2.9.0", '.upToNextMajor(from: "2.1.0")')).toBe(true);
  });

  it("reads `.upToNextMinor` as up to the next minor (#844)", () => {
    expect(ok("5.8.0", '.upToNextMinor(from: "5.8.0")')).toBe(true);
    expect(ok("5.8.1", '.upToNextMinor(from: "5.8.0")')).toBe(true);
    expect(ok("5.9.0", '.upToNextMinor(from: "5.8.0")')).toBe(false);
    expect(ok("5.7.9", '.upToNextMinor(from: "5.8.0")')).toBe(false);
  });

  it("reads `exact:` and `.exact()` as exact, and the two range operators", () => {
    expect(ok("2.0.1", 'exact: "2.0.1"')).toBe(true);
    expect(ok("2.0.2", 'exact: "2.0.1"')).toBe(false);
    expect(ok("2.0.1", '.exact("2.0.1")')).toBe(true);
    expect(ok("1.9.9", '"1.0.0"..<"2.0.0"')).toBe(true);
    expect(ok("2.0.0", '"1.0.0"..<"2.0.0"')).toBe(false);
    expect(ok("2.0.0", '"1.0.0"..."2.0.0"')).toBe(true);
  });

  it("throws on a spelling it does not know rather than skipping it", () => {
    expect(() =>
      swiftRemoteDeps('.package(url: "https://e.com/a.git", someday: "1.0.0")', "t"),
    ).toThrow(/cannot read the SwiftPM requirement/);
  });

  it("catches the exact manifest #757 shipped against the resolved file it shipped with", () => {
    const plugin = `dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/stripe/stripe-terminal-ios.git", .upToNextMinor(from: "5.8.0"))
    ],`;
    const deps = swiftRemoteDeps(plugin, "stripe-terminal/Package.swift");
    expect(deps.map((d) => identity(d.url))).toEqual(["capacitor-swift-pm", "stripe-terminal-ios"]);
    const before = new Map([...pins].filter(([id]) => id !== "stripe-terminal-ios"));
    expect(pinProblem(deps[1], before.get("stripe-terminal-ios"))).toMatch(
      /has no pin for 'stripe-terminal-ios'/,
    );
  });

  it("reads XCRemoteSwiftPackageReference requirements from a pbxproj", () => {
    const pbx = `/* Begin XCRemoteSwiftPackageReference section */
		AAAA /* XCRemoteSwiftPackageReference "foo" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/example/foo.git";
			requirement = {
				kind = upToNextMinorVersion;
				minimumVersion = 1.4.0;
			};
		};
		BBBB /* XCRemoteSwiftPackageReference "bar" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/example/bar";
			requirement = {
				kind = exactVersion;
				version = 3.2.1;
			};
		};
/* End XCRemoteSwiftPackageReference section */`;
    const deps = pbxprojRemoteDeps(pbx, "p");
    expect(deps.map((d) => [identity(d.url), d.requirement])).toEqual([
      [
        "foo",
        { kind: "range", min: "1.4.0", max: "1.5.0", spelled: "kind = upToNextMinorVersion" },
      ],
      ["bar", { kind: "range", min: "3.2.1", max: "3.2.2", spelled: "kind = exactVersion" }],
    ]);
    expect(pinProblem(deps[0], undefined)).toMatch(/has no pin for 'foo'/);
  });
});
