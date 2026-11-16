// The Release, signed-in iPad launch check is opt-in, and carries no secret.
//
// #726: Apple rejected 1.0 (465) for a launch crash on an iPad Air 11-inch
// (M4), iPadOS 27.2.1, signed in as a demo owner. ios-launch.yml can now
// build Release and launch signed in on that device, but only by hand: pull
// requests, pushes and the weekly run must do exactly what they did. And the
// signed-in half reads HS_EMAIL / HS_PASSWORD from the self-hosted runner's
// own environment, so nothing in the repo may name a secret, a variable or
// an input for them, and nothing the job keeps may contain them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const wfText = read(".github/workflows/ios-launch.yml");
const wf = load(wfText) as {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } };
  jobs: {
    launch: { steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[] };
  };
};
const script = read("scripts/ios-launch-smoke.sh");
const steps = wf.jobs.launch.steps;

describe("the workflow step", () => {
  const step = steps.find((s) => s.env?.SMOKE_RELEASE_SIGNED_IN);

  it("is a boolean dispatch input, off by default", () => {
    const input = wf.on.workflow_dispatch.inputs.release_signed_in;
    expect(input.type).toBe("boolean");
    expect(input.default).toBe(false);
  });

  it("runs only from workflow_dispatch with the input ticked", () => {
    expect(step, "no step sets SMOKE_RELEASE_SIGNED_IN").toBeTruthy();
    expect(step!.if).toMatch(/github\.event_name == 'workflow_dispatch'/);
    expect(step!.if).toMatch(/inputs\.release_signed_in/);
    expect(step!.run).toBe("scripts/ios-launch-smoke.sh");
  });

  it("leaves the normal launch step as it was", () => {
    const normal = steps.find((s) => s.name === "Launch on simulators");
    expect(normal?.if).toBeUndefined();
    expect(normal?.env?.SMOKE_RELEASE_SIGNED_IN).toBeUndefined();
  });

  it("names no credential: no secret, no variable, no HS_ value", () => {
    expect(wfText).not.toMatch(/secrets\./);
    expect(wfText).not.toMatch(/vars\.(?!IOS_LAUNCH_RUNNER_JSON\b)/);
    for (const s of steps) {
      for (const [k, v] of Object.entries(s.env ?? {})) {
        expect(k).not.toMatch(/HS_EMAIL|HS_PASSWORD/);
        expect(String(v)).not.toMatch(/HS_EMAIL|HS_PASSWORD/);
      }
    }
  });
});

describe("the script's Release, signed-in mode", () => {
  const block = (from: string, to: string) =>
    script.slice(script.indexOf(from), script.indexOf(to));

  it("pins the reviewer's iPad unless another pair is pinned", () => {
    expect(script).toMatch(/SMOKE_PIN_RUNTIME="com\.apple\.CoreSimulator\.SimRuntime\.iOS-27-2"/);
    expect(script).toMatch(
      /SMOKE_PIN_DEVICE_TYPE="com\.apple\.CoreSimulator\.SimDeviceType\.iPad-Air-11-inch-M4"/,
    );
  });

  it("builds Release, unsigned, and Debug otherwise", () => {
    expect(script).toMatch(/CONFIG=Debug\n/);
    expect(script).toMatch(/CONFIG=Release\n/);
    expect(script).toMatch(/-configuration "\$CONFIG" -sdk iphonesimulator/);
    expect(script).toMatch(/-derivedDataPath "\$APP_DD" CODE_SIGNING_ALLOWED=NO build/);
  });

  it("runs the cold launches, then SignIn, then the signed-in relaunches", () => {
    const warm = script.indexOf("attempt_class ColdLaunchWarmUp warmup");
    const cold = script.indexOf("attempt_class ColdLaunch launches");
    const signIn = script.indexOf("attempt_class SignIn signin");
    const relaunch = script.indexOf("attempt_class SignedInColdLaunch signed-in-launches");
    expect(warm).toBeGreaterThan(-1);
    expect(cold).toBeGreaterThan(warm);
    expect(signIn).toBeGreaterThan(cold);
    expect(relaunch).toBeGreaterThan(signIn);
    const swift = read("ios/UITests/HoundStackUITests/SignIn.swift");
    expect(swift).toMatch(/final class SignIn: XCTestCase/);
    expect(swift).toMatch(/final class SignedInColdLaunch: XCTestCase/);
    expect(swift).toMatch(/for attempt in 1\.\.\.5 \{\s*ColdLaunch\.relaunch\(app\)/);
  });

  it("skips the signed-in half cleanly without both values, and says so", () => {
    expect(script).toMatch(
      /if \[ -z "\$\{HS_EMAIL:-\}" \] \|\| \[ -z "\$\{HS_PASSWORD:-\}" \]; then/,
    );
    expect(script).toContain(
      "signed-in launch skipped: HS_EMAIL/HS_PASSWORD not set on the runner",
    );
  });

  it("passes the values through the environment as TEST_RUNNER_*, never as arguments", () => {
    expect(script).toMatch(
      /export TEST_RUNNER_HS_EMAIL="\$HS_EMAIL" TEST_RUNNER_HS_PASSWORD="\$HS_PASSWORD"/,
    );
    expect(script).toMatch(/unset TEST_RUNNER_HS_EMAIL TEST_RUNNER_HS_PASSWORD/);
    // Never echoed, never traced, never on an xcodebuild command line.
    expect(script).not.toMatch(/set -x|set -o xtrace/);
    expect(script).not.toMatch(/echo[^\n]*\$\{?HS_(EMAIL|PASSWORD)/);
    expect(script).not.toMatch(/xcodebuild[^\n]*HS_(EMAIL|PASSWORD)/);
    expect(script).not.toMatch(/^\s*(env|printenv)\s*$/m);
  });

  it("scrubs both values from everything it keeps, reading them inside python", () => {
    const redact = block("redact() {", "scrub_out() {");
    expect(redact).toMatch(/os\.environ\.get\("HS_PASSWORD", ""\)/);
    expect(redact).not.toMatch(/print\(/);
    expect(script).toMatch(/trap scrub_out EXIT/);
    // The log is scrubbed before attempt_class can tail it.
    const run = block("run_class() {", "attempt_class() {");
    expect(run.indexOf('redact "$OUT/$slug-$2.log"')).toBeGreaterThan(
      run.indexOf('wait "$test_pid"'),
    );
    // Signed-in result bundles are written outside the uploaded paths.
    expect(script).toMatch(/-resultBundlePath "\$\{result_dir:-\$OUT\}\/\$slug-\$2\.xcresult"/);
    expect(script).toMatch(/result_dir="\$PRIVATE"/);
    expect(script).toMatch(/PRIVATE="\$OUT\/DerivedData\/signed-in-private"/);
    expect(wfText).not.toMatch(/ios-launch-smoke\/DerivedData/);
  });

  it("keeps the HoundStack, WebContent and ReportCrash log, and crash reports", () => {
    expect(script).toMatch(
      /log show --last 20m [^\n]*\\\n\s*--predicate 'process == "HoundStack" OR process BEGINSWITH "com\.apple\.WebKit\.WebContent" OR process == "ReportCrash"'/,
    );
    expect(script).toMatch(/\\\( -name 'HoundStack\*' -o -name 'com\.apple\.WebKit\*' \\\)/);
  });
});
