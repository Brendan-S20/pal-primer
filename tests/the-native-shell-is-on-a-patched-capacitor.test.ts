// The native shell runs on a Capacitor that serves no remote page at the app
// origin (GHSA-rvm3-566m-v7fv, #816 item 3).
//
// Through 8.4.2, the WebView's navigation guard compared host and scheme but
// not path, so a frame navigation to `/_capacitor_http_interceptor_` counted
// as same-origin. The native layer then fetched a URL the caller chose and
// ran the response at the app origin, with the app's storage, cookies and
// every Capacitor plugin. The proxy answered even with CapacitorHttp off,
// which is how this app ships.
//
// Vulnerable: >=8.3.5 <8.4.3, and 8.5.0 (fixed in 8.5.1). The four packages
// that carry the native runtime release in lockstep and have to move
// together: @capacitor/core is the JS half of the bridge the other three
// implement, and the iOS runtime is not even taken from node_modules. It
// comes from capacitor-swift-pm, pinned by ios/App/CapApp-SPM/Package.swift
// and ios/App/.../Package.resolved, so an npm bump alone ships the old
// Swift to every iPhone.
//
// A web publish does not close this. The fix lives in Java and Swift, so it
// reaches a phone only with a new native build.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const RUNTIME = [
  "@capacitor/core",
  "@capacitor/cli",
  "@capacitor/android",
  "@capacitor/ios",
] as const;

type V = [number, number, number];
const parse = (v: string): V => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a plain x.y.z version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const cmp = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** GHSA-rvm3-566m-v7fv: >=8.3.5 <8.4.3, and exactly 8.5.0. */
function vulnerable(v: string): boolean {
  return (cmp(v, "8.3.5") >= 0 && cmp(v, "8.4.3") < 0) || v === "8.5.0";
}

/**
 * Whether a package.json range can resolve to a vulnerable version. Only the
 * forms this repo writes: exact, `~x.y.z` (patch line) and `^x.y.z` (8.x).
 */
function rangeAdmitsVulnerable(range: string): boolean {
  const m = /^([~^]?)(\d+\.\d+\.\d+)$/.exec(range);
  if (!m) throw new Error(`unexpected range form: ${range}`);
  const [op, min] = [m[1], m[2]];
  if (vulnerable(min)) return true;
  const [major, minor] = parse(min);
  if (op === "") return false;
  if (op === "~") return major === 8 && minor === 5 && cmp(min, "8.5.0") <= 0;
  // `^8.y.z` reaches 8.5.0 unless it starts above it.
  return major === 8 && cmp(min, "8.5.0") <= 0;
}

const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
const lock = JSON.parse(read("package-lock.json")) as {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};
const bunLock = read("bun.lock");

const npmVersion = (name: string) => lock.packages[`node_modules/${name}`]?.version;
const bunVersion = (name: string) => {
  const esc = name.replace(/[/@.]/g, (c) => `\\${c}`);
  return new RegExp(`^\\s*"${esc}": \\["${esc}@([^"]+)"`, "m").exec(bunLock)?.[1];
};

describe("the advisory check itself", () => {
  it("reads the published ranges", () => {
    expect(vulnerable("8.3.4")).toBe(false);
    expect(vulnerable("8.3.5")).toBe(true);
    expect(vulnerable("8.4.1")).toBe(true);
    expect(vulnerable("8.4.2")).toBe(true);
    expect(vulnerable("8.4.3")).toBe(false);
    expect(vulnerable("8.5.0")).toBe(true);
    expect(vulnerable("8.5.1")).toBe(false);
    expect(vulnerable("8.6.0")).toBe(false);
  });

  it("knows a caret range from below 8.5.0 can land on 8.5.0", () => {
    expect(rangeAdmitsVulnerable("^8.4.1")).toBe(true);
    expect(rangeAdmitsVulnerable("^8.4.3")).toBe(true);
    expect(rangeAdmitsVulnerable("~8.4.3")).toBe(false);
    expect(rangeAdmitsVulnerable("^8.5.1")).toBe(false);
    expect(rangeAdmitsVulnerable("~8.5.0")).toBe(true);
    expect(rangeAdmitsVulnerable("8.4.3")).toBe(false);
  });
});

describe("Capacitor's native runtime is past GHSA-rvm3-566m-v7fv", () => {
  it.each(RUNTIME)("%s: package.json cannot resolve to a vulnerable release", (name) => {
    const range = pkg.dependencies[name];
    expect(range, `${name} is not a dependency`).toBeDefined();
    expect(
      rangeAdmitsVulnerable(range),
      `${name} is declared "${range}", which admits a release GHSA-rvm3-566m-v7fv covers ` +
        `(>=8.3.5 <8.4.3, or 8.5.0). Use ~8.4.3, or ^8.5.1 and up.`,
    ).toBe(false);
  });

  it.each(RUNTIME)(
    "%s: package-lock.json and bun.lock install the same patched release",
    (name) => {
      const npm = npmVersion(name);
      const bun = bunVersion(name);
      expect(npm, `${name} missing from package-lock.json`).toBeDefined();
      expect(bun, `${name} missing from bun.lock`).toBeDefined();
      expect(bun, `bun.lock and package-lock.json disagree on ${name}`).toBe(npm);
      expect(vulnerable(npm!), `${name}@${npm} is vulnerable to GHSA-rvm3-566m-v7fv`).toBe(false);
    },
  );

  it("all four are one release, because they are one runtime", () => {
    const versions = new Set(RUNTIME.map(npmVersion));
    expect([...versions]).toHaveLength(1);
  });

  it("iOS builds the same Swift the npm package names (CapApp-SPM and Package.resolved)", () => {
    const ios = npmVersion("@capacitor/ios")!;
    const swift = read("ios/App/CapApp-SPM/Package.swift");
    const exact = /capacitor-swift-pm\.git", exact: "([^"]+)"/.exec(swift)?.[1];
    expect(
      exact,
      "ios/App/CapApp-SPM/Package.swift must pin capacitor-swift-pm to the @capacitor/ios version; " +
        "Xcode builds that, not node_modules",
    ).toBe(ios);

    const resolved = JSON.parse(
      read("ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"),
    ) as { pins: { identity: string; state: { version?: string; revision: string } }[] };
    const pin = resolved.pins.find((p) => p.identity === "capacitor-swift-pm");
    expect(pin?.state.version).toBe(ios);
  });
});
