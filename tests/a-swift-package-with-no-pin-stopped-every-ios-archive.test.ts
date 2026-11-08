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
// Reads node_modules, like a-plugin-still-on-capacitor-7-stopped-every-ios-
// build.test.ts: a plugin's dependencies live in its own Package.swift, which
// only exists after `npm ci` (and its postinstall patch) has run.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const CAP_APP_SPM = join(root, "ios/App/CapApp-SPM");
const RESOLVED_REL =
  "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
const RESOLVED = join(root, RESOLVED_REL);

type Requirement = { kind: "exact" | "from"; version: string };
type RemoteDep = { url: string; requirement: Requirement; declaredIn: string };

/** SwiftPM's identity for a remote package: last path component, no `.git`, lowercased. */
const identity = (url: string) =>
  url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .pop()!
    .toLowerCase();

const REMOTE = /\.package\(\s*url:\s*"([^"]+)"\s*,\s*(exact|from):\s*"([^"]+)"\s*\)/g;
const LOCAL = /\.package\(\s*name:\s*"[^"]+"\s*,\s*path:\s*"([^"]+)"\s*\)/g;

function remoteDeps(packageSwift: string, declaredIn: string): RemoteDep[] {
  return [...packageSwift.matchAll(REMOTE)].map((m) => ({
    url: m[1],
    requirement: { kind: m[2] as Requirement["kind"], version: m[3] },
    declaredIn,
  }));
}

const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
function satisfies(version: string, req: Requirement): boolean {
  if (req.kind === "exact") return version === req.version;
  // `from: "X.Y.Z"` is X.Y.Z..<(X+1).0.0
  const [a, b] = [parse(version), parse(req.version)];
  if (a[0] !== b[0]) return false;
  for (let i = 1; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

const capAppSwift = readFileSync(join(CAP_APP_SPM, "Package.swift"), "utf8");
const localPaths = [...capAppSwift.matchAll(LOCAL)].map((m) => m[1]);
const allDeps: RemoteDep[] = [
  ...remoteDeps(capAppSwift, "ios/App/CapApp-SPM/Package.swift"),
  ...localPaths.flatMap((p) =>
    remoteDeps(
      readFileSync(join(CAP_APP_SPM, p, "Package.swift"), "utf8"),
      `${p.replace(/^(\.\.\/)+/, "")}/Package.swift`,
    ),
  ),
];

const resolved = JSON.parse(readFileSync(RESOLVED, "utf8")) as {
  version: number;
  pins: { identity: string; location: string; state: { revision: string; version?: string } }[];
};
const pins = new Map(resolved.pins.map((p) => [p.identity, p]));

describe("Package.resolved pins every remote package the iOS app depends on", () => {
  it("found the plugins and their remote dependencies (the scan is not looking at nothing)", () => {
    expect(localPaths.length).toBeGreaterThan(10);
    expect(allDeps.map((d) => identity(d.url))).toEqual(
      expect.arrayContaining(["capacitor-swift-pm", "ion-ios-filesystem"]),
    );
  });

  it.each(allDeps.map((d) => [identity(d.url), d] as const))(
    "%s has a pin that satisfies %o",
    (id, dep) => {
      const pin = pins.get(id);
      expect(
        pin,
        `${dep.declaredIn} depends on ${dep.url} (${dep.requirement.kind}: ${dep.requirement.version}), ` +
          `but ${RESOLVED_REL} has no pin for '${id}'. ` +
          `Xcode Cloud resolves with automatic resolution disabled, so the archive stops ` +
          `before it builds anything (#723). Resolve packages in Xcode and commit the file.`,
      ).toBeDefined();
      expect(identity(pin!.location)).toBe(id);
      expect(pin!.state.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(pin!.state.version, `pin for '${id}' has no version`).toBeDefined();
      expect(
        satisfies(pin!.state.version!, dep.requirement),
        `pin '${id}' is ${pin!.state.version}, but ${dep.declaredIn} asks for ` +
          `${dep.requirement.kind}: ${dep.requirement.version}`,
      ).toBe(true);
    },
  );
});

describe("the version check itself", () => {
  it("reads `from:` as up to the next major and `exact:` as exact", () => {
    expect(satisfies("2.1.1", { kind: "from", version: "2.1.0" })).toBe(true);
    expect(satisfies("2.0.9", { kind: "from", version: "2.1.0" })).toBe(false);
    expect(satisfies("3.0.0", { kind: "from", version: "2.1.0" })).toBe(false);
    expect(satisfies("2.0.1", { kind: "exact", version: "2.0.1" })).toBe(true);
    expect(satisfies("2.0.2", { kind: "exact", version: "2.0.1" })).toBe(false);
  });
});
