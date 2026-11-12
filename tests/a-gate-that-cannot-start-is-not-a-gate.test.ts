// The IMP-2 schema gate stopped running, and reported failure while doing it.
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// `verify` moved to a self-hosted runner when GitHub's hosted allocation for
// this repository broke on 2026-08-10. The `migrations` job was deliberately
// left on `ubuntu-latest`, for two reasons that were both sound: its scripts
// shell out to `psql`, which is not on a Mac unless somebody installed it, and
// it is the job holding SUPABASE_DB_URL and STRIPE_SECRET_KEY.
//
// From 2026-08-12 it stopped receiving a machine at all — `runner_id: 0`, zero
// steps, two seconds, no logs. Five merges landed in that window and six
// migrations were applied to the live database, and nothing compared the two.
//
// The distinction that matters: a hard gate that CANNOT START is not a lenient
// gate, it is an absent one — and it is absent while showing red, which is the
// state that teaches everyone to scroll past it. The last run that actually
// executed was 2026-08-09, and it passed all three schema checks, so the
// secret and the scripts were never the problem.
//
// ── WHY THE psql STEP EXISTS ──────────────────────────────────────────────
//
// This is the trap that would have made "just move the job" fail anyway:
// `brew install libpq` is KEG-ONLY. It installs psql and deliberately does not
// put it on PATH, on either architecture. Someone who runs the documented
// command and re-runs the job gets "psql: command not found" and reasonably
// concludes the install failed.
//
// So the job finds psql itself in the places brew puts it, and if it genuinely
// is not there, says so with the command to run rather than dying on an ENOENT
// three steps later.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const raw = readFileSync(ROOT + ".github/workflows/ci.yml", "utf8");
const wf = load(raw) as {
  jobs: Record<string, { "runs-on": string; if?: string; steps: Array<Record<string, unknown>> }>;
};
const migrations = wf.jobs.migrations;
const verify = wf.jobs.verify;

describe("the schema gate can be scheduled", () => {
  it("checks UNIX_RUNNER first, because it needs psql and one runner is Windows", () => {
    // Pinned to `ubuntu-latest` is exactly the state that made it unrunnable,
    // and this used to assert the plain CI_RUNNER spelling for that reason.
    //
    // A Windows self-hosted runner joined on 2026-09-16. CI_RUNNER is
    // `self-hosted`, which matches BOTH machines, so this job -- which shells
    // out to psql -- could be dispatched somewhere psql does not exist and
    // fail in a way that reads like a broken migration. UNIX_RUNNER is checked
    // first and is `macOS`, a label only the Mac carries.
    expect(migrations["runs-on"]).toBe(
      "${{ vars.UNIX_RUNNER || vars.CI_RUNNER || 'ubuntu-latest' }}",
    );
  });

  it("no longer matches verify, because the condition it was waiting for happened", () => {
    // Identity, then a deliberate difference, then identity again, and now a
    // deliberate difference for the third time. The history is still the
    // useful part, so here is the entry that changed it.
    //
    // The previous version of this test said it "guards against re-splitting
    // them before the suite can actually survive the split". That was the
    // right guard and this is it being satisfied rather than removed.
    //
    // On 2026-09-18 the Windows runner ran the whole suite:
    //
    //     Suites 1163 passed, 0 failed | Tests 3653 passed, 0 failed
    //
    // the same test count as macOS. Getting there took six fixes and they
    // were all one rule -- a path that stopped being a path and became a
    // string that was compared, keyed, printed or matched:
    //
    //   * `new URL(..).pathname` returning `/C:/repo/`         (81 sites)
    //   * a built path spliced against a literal slash          (22 sites)
    //   * CRLF in a reused workspace `.gitattributes` missed    (4 tests)
    //   * baseline JSON keyed by forward-slash paths            (9 sites)
    //   * `/\/src\//` regexes that silently never matched        (4 sites)
    //   * an entry-point regex, which cost nine unrelated files
    //
    // `windows-probe` gates it now, so a seventh cannot arrive unnoticed.
    //
    // ── WHY THEY ARE DIFFERENT RATHER THAN BOTH FREE ──────────────────────
    //
    // `verify` runs on either self-hosted runner (plain `self-hosted`, via
    // PORTABLE_RUNNER_JSON) since helm/ci-minutes; `windows-probe` keeps the
    // Windows answer on every push to main. `migrations` must NOT follow it: it guards SUPABASE_DB_URL with bash `[ -z ... ]` and no
    // `shell:` override, and it decrypts a production credential, which is a
    // question about more than portability.
    //
    // The original worry -- two jobs, two spellings, half of CI somewhere
    // nobody meant -- is answered by asserting the difference explicitly here
    // rather than by forcing them to be equal.
    expect(verify["runs-on"]).toContain(
      "vars.VERIFY_RUNNER_JSON || vars.PORTABLE_RUNNER_JSON",
    );
    expect(verify["runs-on"]).toContain('["self-hosted"]');
    expect(migrations["runs-on"]).not.toBe(verify["runs-on"]);
    expect(migrations["runs-on"]).toContain("UNIX_RUNNER");
  });

  it("still falls back to hosted runners when the variable is unset", () => {
    // The escape hatch is the point: deleting the repository variable returns
    // both jobs to GitHub's runners with no PR.
    expect(migrations["runs-on"]).toContain("|| 'ubuntu-latest'");
  });

  it("is still a hard gate on main and skipped on pull requests", () => {
    // The move must not quietly turn the gate advisory. A PR legitimately
    // contains migrations that have not been applied yet; main must not.
    // A batch/* branch (batch.yml) is skipped for the same reason a PR is:
    // it carries those same PRs, migrations not yet applied included.
    expect(migrations.if).toBe(
      "github.event_name != 'pull_request' && !startsWith(github.ref, 'refs/heads/batch/')",
    );
  });
});

describe("psql is found rather than assumed", () => {
  const step = migrations.steps.find((s) => s.name === "Find psql") as
    { name: string; run: string } | undefined;

  it("has a step that looks for it", () => {
    expect(step, "no `Find psql` step in the migrations job").toBeTruthy();
  });

  it("runs before anything that needs it", () => {
    const names = migrations.steps.map((s) => (s.name as string) ?? (s.uses as string));
    const find = names.indexOf("Find psql");
    const firstCheck = names.findIndex((n) => n?.startsWith("Check repo migrations"));
    expect(find).toBeGreaterThanOrEqual(0);
    expect(find, "the psql lookup must precede the first schema check").toBeLessThan(firstCheck);
  });

  it("looks in libpq's keg-only bin on both architectures", () => {
    // The actual defect this guards. Checking only /opt/homebrew silently
    // fails on an Intel Mac and vice versa, and neither is a configuration
    // anyone would think to write down.
    //
    // Asserted against the SEARCH LIST rather than the step body, and that
    // distinction is not pedantic — it is the difference this test failed to
    // make on its first draft. The failure message at the bottom of the step
    // also names every directory it looked in, so deleting a prefix from the
    // `for` loop left the string present in the step and the assertion green.
    // The test agreed that a path was checked because the error message
    // claimed it had been.
    const loop = /for d in ([\s\S]*?); do/.exec(step!.run);
    expect(loop, "no search loop found in the psql lookup").toBeTruthy();
    const searched = loop![1];
    expect(searched, "Apple Silicon prefix missing from the search").toContain(
      "/opt/homebrew/opt/libpq/bin",
    );
    expect(searched, "Intel prefix missing from the search").toContain("/usr/local/opt/libpq/bin");
  });

  it("puts what it finds on PATH for the later steps", () => {
    // Discovering psql and not exporting it would be a slower way to fail.
    expect(step!.run).toContain("GITHUB_PATH");
  });

  it("names the install command when it finds nothing", () => {
    // "psql: command not found" is not an actionable message; this is.
    expect(step!.run).toMatch(/brew install libpq/);
    expect(step!.run).toMatch(/::error::/);
  });

  it("fails rather than continuing without it", () => {
    // Skipping the schema checks because a tool is missing would recreate the
    // exact fault above: a gate that reports something other than the answer.
    expect(step!.run).toMatch(/exit 1/);
    expect(step!.continueOnError ?? (step as Record<string, unknown>)["continue-on-error"]).toBe(
      undefined,
    );
  });
});

describe("one run reports every fact it knows", () => {
  // The first time this gate ran after being unblocked it reported "2
  // migrations exist in the repo but not in the database" and STOPPED — which
  // left the one question that matters unanswered. Do the objects those
  // migrations create actually exist? If yes, they ran and were not recorded,
  // and the fix is a baseline entry. If no, they never ran, and the fix is to
  // apply them. Opposite problems, opposite fixes, and the run halted one step
  // short of telling them apart.
  const checks = migrations.steps.filter(
    (s) => typeof s.name === "string" && s.name !== "Find psql" && "run" in s,
  ) as Array<{ name: string; if?: string }>;

  it("lets every check after the first one still run", () => {
    // The first check is allowed to have no condition — nothing precedes it.
    const rest = checks.slice(1);
    expect(rest.length).toBeGreaterThanOrEqual(4);
    for (const s of rest) {
      expect(s.if, `${s.name} is skipped when an earlier check fails`).toMatch(/always\(\)/);
    }
  });

  it("still skips them all when psql is missing", () => {
    // A bare `always()` would run each check with no psql and bury the one
    // message naming the install command under four ENOENTs — undoing the
    // step that exists to prevent exactly that.
    for (const s of checks.slice(1)) {
      expect(s.if, `${s.name} would run without psql`).toContain(
        "steps.psql.conclusion == 'success'",
      );
    }
  });

  it("keeps the id the condition refers to", () => {
    // `steps.psql` resolves to nothing without it, and a condition on a
    // missing step id is silently false — every check would skip and the job
    // would go green having run nothing.
    const find = migrations.steps.find((s) => s.name === "Find psql") as { id?: string };
    expect(find.id).toBe("psql");
  });
});

describe("the checks themselves are unchanged", () => {
  it("still runs all three schema scripts and both live checks", () => {
    const names = migrations.steps.map((s) => s.name as string).filter(Boolean);
    for (const expected of [
      "Check repo migrations against the database",
      "Check the database against the repo migrations",
      "Check every object the migrations create still exists",
      "The published app origin answers the native preflight",
      "Stripe charges what the catalog says",
    ]) {
      expect(names, `${expected} went missing while moving the job`).toContain(expected);
    }
  });

  it("still refuses to pass when SUPABASE_DB_URL is absent", () => {
    // A check that silently passes without checking anything is the failure
    // mode IMP-2 exists to remove, and moving runners is a plausible moment to
    // lose the guard.
    expect(raw.match(/SUPABASE_DB_URL secret is not set/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
