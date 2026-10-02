import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TRIAL_COPY, growthPausedFor, type TrialState } from "@/lib/trial";

const MIGRATIONS = join(__dirname, "..", "supabase", "migrations");

function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let found = "";
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error(`no migration defines ${fn}`);
  const rest = found.slice(found.search(re));
  const end = rest.indexOf("$function$;");
  return end === -1 ? rest : rest.slice(0, end);
}

const st = (phase: TrialState["phase"]): TrialState =>
  ({ phase, daysRemaining: null, endsOn: null, restricted: false }) as TrialState;

// Owner decision, 2026-08-20: "the account pauses" means GROWTH pauses.
//
// The decision ratified a gate that was already live rather than adding one.
// `org_can_add_client` — a BEFORE INSERT trigger on public.clients since
// 20260701164146 — has always refused a new customer once a trial expired. What
// was missing was anyone saying so: the banner claimed everything but AI kept
// working, and promised a warning the product had no way to send.
//
// These tests exist because that gap can reopen in two directions, and both are
// quiet. The copy can drift from the rule, or the rule can be widened into the
// broader freeze the owner declined. Neither would fail anything else.
describe("paused means growth, not the whole account", () => {
  it("matches the database rule, phase for phase", () => {
    // The SQL allows active/past_due, trialing-while-unexpired, free and grace;
    // everything else is refused. In phase terms that is exactly expired and
    // lapsed.
    expect(growthPausedFor(st("expired"))).toBe(true);
    expect(growthPausedFor(st("lapsed"))).toBe(true);
    expect(growthPausedFor(st("paid"))).toBe(false);
    expect(growthPausedFor(st("trialing"))).toBe(false);
    expect(growthPausedFor(st("none"))).toBe(false);
  });

  it("the SQL still says what this claims it says", () => {
    // If org_can_add_client stops keying on trial_ends_at, or starts allowing a
    // status the phase mapping calls paused, the two definitions have parted
    // and the banner is lying again.
    const sql = latestDefinitionOf("org_can_add_client");
    expect(sql, "org_can_add_client no longer reads trial_ends_at").toMatch(/trial_ends_at\s*>\s*now\(\)/);
    expect(sql, "org_can_add_client no longer defaults to refusing").toMatch(/ELSE\s+false/i);
  });

  it("does not gate on TRIAL_ENFORCEMENT, because the database does not", () => {
    // growthPausedFor must not consult enforcementApplies. The trigger is not
    // grandfathered by TRIAL_ENFORCEMENT_FROM, so a grandfathered org would be
    // told nothing is paused while its next customer is refused.
    const src = readFileSync(join(__dirname, "..", "src", "lib", "trial.ts"), "utf8");
    const body = src.slice(src.indexOf("export function growthPausedFor"));
    const fn = body.slice(0, body.indexOf("}") + 1);
    expect(fn).not.toMatch(/enforcementApplies|TRIAL_ENFORCEMENT/);
  });

  it("tells a paused tenant what still works, not only what stopped", () => {
    // A pause notice that lists only the loss reads as a lockout, which is the
    // thing this decision explicitly is not.
    for (const phase of ["expired", "lapsed"] as const) {
      const body = TRIAL_COPY[phase].body;
      expect(body, `${phase} does not say new customers are what stopped`).toMatch(/new customers/i);
      expect(body, `${phase} does not say what keeps running`).toMatch(/keeps running/i);
      expect(body, `${phase} dropped the "nothing deleted" promise`).toMatch(/nothing has been deleted/i);
    }
    // The banner used to add a second line (GROWTH_PAUSED_NOTE) repeating
    // this body nearly word for word. The body is now the only statement, so
    // it carries the part the note was there to guarantee: the portal.
    for (const phase of ["expired", "lapsed"] as const) {
      expect(TRIAL_COPY[phase].body, `${phase} does not say the portal keeps working`).toMatch(
        /portal/i,
      );
    }
  });

  it("trial state still has exactly two consumers, so a new gate cannot arrive quietly", () => {
    // The declined broader freeze, pinned in the only way that is not a word
    // search. A capability gate has to READ the trial state to gate on it, so
    // the honest invariant is the caller set, not vocabulary: the first version
    // of this test grepped trial.ts for "invoice" and failed on the banner copy
    // that says invoices keep working — flagging the sentence promising the
    // freedom as if it were the freeze.
    //
    // Today: ai-access.server.ts (AI, the separately-governed one) and
    // trial.functions.ts (the banner). A third caller means somebody is gating
    // something new, which is a decision to make on purpose.
    const SRC = join(__dirname, "..", "src");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
      }
      return out;
    };
    const callers = walk(SRC)
      .filter((f) => f !== join(SRC, "lib", "trial.ts"))
      .filter((f) => /\btrialStateFor\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))
      .sort();

    expect(
      callers,
      "the set of things that consult trial state changed. If this is a new " +
        "capability gate, the 2026-08-20 decision was that growth is the only " +
        "thing that pauses — revisit it deliberately rather than widening here.",
    ).toEqual(["lib/ai-access.server.ts", "lib/trial.functions.ts"]);
  });
});
