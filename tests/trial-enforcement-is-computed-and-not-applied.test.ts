import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

// TRIAL_ENFORCEMENT was flipped to true on 2026-08-16 under a commit message
// saying trials enforce. They do not. `restricted` is computed in all five
// branches of trialStateFor, serialized to the browser, and read by nothing —
// `git log -S'.restricted' -- src/` is empty for the life of the repo, so it was
// never wired and then unwired. It has always been inert.
//
// That is a defensible position: the gate was deferred pending Stripe, and what
// the published FAQ's "the account pauses" should actually mean is still an
// owner decision. What is NOT defensible is the gap between the code and what
// the repo said about itself, which is how a boolean nobody reads came to be
// described as enforcement in three places.
//
// So this file pins the gap rather than the fix. It fails in BOTH directions,
// and either failure is a prompt to update trial.ts's header rather than to
// silence the test:
//
//   - if somebody wires `restricted`, enforcement becomes real and the header
//     saying it does not restrict is now the lie;
//   - if somebody deletes it, the only record that day-15 enforcement was ever
//     intended goes with it.
describe("trial enforcement is computed and not applied", () => {
  const trialSrc = readFileSync(join(SRC, "lib", "trial.ts"), "utf8");

  it("still computes restricted, so the intent is not silently deleted", () => {
    expect(trialSrc, "TrialState.restricted was removed — see the header").toMatch(
      /restricted:\s*(boolean|TRIAL_ENFORCEMENT|enforcementApplies)/,
    );
  });

  it("nothing in src/ reads it, which is the whole point of the header", () => {
    const readers = walk(SRC)
      .filter((f) => f !== join(SRC, "lib", "trial.ts"))
      .flatMap((f) => {
        const src = readFileSync(f, "utf8");
        return /\.restricted\b/.test(src) ? [repoRelative(f, ROOT)] : [];
      });

    expect(
      readers,
      readers.length
        ? "`restricted` now has a reader, so trial enforcement may finally be real.\n" +
          "That is good — but the header of src/lib/trial.ts still says day 15 does NOT\n" +
          "restrict, and TRIAL_COPY tells expired orgs their account still works. Update\n" +
          "both, decide what the FAQ's \"the account pauses\" means, and revisit\n" +
          "TRIAL_ENFORCEMENT_FROM so nobody who signed up under \"a message, not a lock\"\n" +
          "is enforced anyway:\n" + readers.map((r) => `  ${r}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("the header does not claim day 15 restricts", () => {
    // The sentence that was there until 2026-08-20 read "What day 15 does NOW:
    // it restricts". It was false the day it was written.
    expect(trialSrc).not.toMatch(/day 15 does NOW: it restricts/);
    expect(trialSrc).toMatch(/It computes `restricted`\. It does not restrict\./);
  });

  it("AI is gated on phase, not on the flag, so the flag is not load-bearing", () => {
    // This is why flipping TRIAL_ENFORCEMENT changes nothing observable: the one
    // real consequence of an expired trial does not consult it.
    expect(trialSrc).toMatch(/aiAvailableFor[\s\S]{0,200}phase === "paid"/);
  });
});
