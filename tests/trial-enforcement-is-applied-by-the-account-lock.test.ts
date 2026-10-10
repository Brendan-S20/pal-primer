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

// Until 2026-10-09 this file was "trial enforcement is computed and not
// applied". `restricted` was computed in every branch of trialStateFor and read
// by nothing, by the owner's 2026-08-20 decision that "the account pauses"
// meant only that growth paused. The file pinned that gap in both directions,
// and said: if somebody wires `restricted`, update trial.ts's header and the
// banner copy, and revisit the grandfather date.
//
// On 2026-10-09 the owner decided the other way (spec NP-12): day 14 with no
// plan LOCKS the account. So `restricted` now has exactly one reader, the
// account lock, and this file pins THAT: the reader set, the header that says
// so, and the copy that no longer promises everything keeps running. The
// grandfather date (TRIAL_ENFORCEMENT_FROM) was revisited and kept: nobody who
// signed up before the trial existed is locked by it.
describe("trial enforcement is applied by the account lock", () => {
  const trialSrc = readFileSync(join(SRC, "lib", "trial.ts"), "utf8");

  it("still computes restricted", () => {
    expect(trialSrc).toMatch(/restricted:\s*(boolean|TRIAL_ENFORCEMENT|enforcementApplies)/);
  });

  it("is read by the account lock and nothing else", () => {
    const readers = walk(SRC)
      .filter((f) => f !== join(SRC, "lib", "trial.ts"))
      .flatMap((f) => (/\.restricted\b/.test(readFileSync(f, "utf8")) ? [repoRelative(f, ROOT)] : []));
    expect(
      readers,
      "a second reader of `restricted` is a second definition of the lock; read it through src/lib/account-lock.ts",
    ).toEqual(["src/lib/account-lock.ts"]);
  });

  it("the header says day 15 locks, and no longer says it does not", () => {
    expect(trialSrc).toMatch(/WHAT DAY 15 DOES NOW[\s\S]{0,200}It LOCKS\./);
    expect(trialSrc).not.toMatch(/It computes `restricted`\. It does not restrict\./);
  });

  it("the banner no longer tells a locked account that everything keeps running", () => {
    const copy = trialSrc.slice(trialSrc.indexOf("export const TRIAL_COPY"));
    expect(copy.slice(0, copy.indexOf("};"))).not.toMatch(/keeps running|Nothing has been deleted/);
  });

  it("AI is still gated on phase, independently of the lock", () => {
    expect(trialSrc).toMatch(/aiAvailableFor[\s\S]{0,200}phase === "paid"/);
  });
});
