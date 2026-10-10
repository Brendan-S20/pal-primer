import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRIAL_COPY,
  TRIAL_DAYS,
  TRIAL_ENFORCEMENT,
  TRIAL_ENFORCEMENT_FROM,
  aiAvailableFor,
  aiUnavailableReason,
  trialStateFor,
} from "@/lib/trial";

// BUILD-7. The cases worth pinning are the ones where being wrong is either
// invisible or expensive: a countdown that rounds the wrong way, a trial that
// silently locks an account nobody can pay to unlock, and an AI gate that a
// lapsed org slips through.

const at = (iso: string) => new Date(iso);
const NOW = at("2026-08-01T12:00:00Z");

describe("the trial length matches what the site promises", () => {
  it("is 14 days, the number published in the pricing FAQ", () => {
    // Three copies of this constant exist — here, the SQL in
    // bootstrap_organization, and TRIAL_DAYS in the marketing repo — because
    // neither SQL nor another repo can import it. A drift means the site sells
    // fourteen days while the app grants seven, and the customer finds out.
    expect(TRIAL_DAYS).toBe(14);
  });

  it("matches the SQL that actually starts the trial", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20260731150000_start-the-trial-on-signup.sql"),
      "utf8",
    );
    const m = sql.match(/_trial_days\s+constant\s+int\s*:=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(TRIAL_DAYS);
  });
});

describe("phases", () => {
  it("is paid when a subscription exists, whatever the status column says", () => {
    // Status columns are written by several paths and can lag. A live
    // subscription is a fact; trusting a stale 'trialing' over it would show a
    // paying customer a countdown and switch their AI off.
    const s = trialStateFor(
      { planStatus: "trialing", trialEndsAt: "2026-07-01T00:00:00Z", hasSubscription: true },
      NOW,
    );
    expect(s.phase).toBe("paid");
    expect(aiAvailableFor(s)).toBe(true);
  });

  it("is paid for active and past_due", () => {
    for (const planStatus of ["active", "past_due"]) {
      expect(trialStateFor({ planStatus, trialEndsAt: null }, NOW).phase).toBe("paid");
    }
  });

  it("is paid during an admin-granted grace period", () => {
    // This test used to pass `planStatus: "grace"` — a value org_plan_status
    // cannot hold. 'grace' and 'suspended' exist only in org_billing_status. So
    // it pinned a case that cannot occur while missing the one that does:
    // grantGracePeriod writes billing_status='grace' and leaves plan_status
    // 'free', which read as `none` and switched AI off for the tenant an admin
    // had just extended service to.
    const s = trialStateFor({ planStatus: "free", billingStatus: "grace", trialEndsAt: null }, NOW);
    expect(s.phase).toBe("paid");
    expect(aiAvailableFor(s)).toBe(true);
  });

  it("is `none` for an organization that predates trials", () => {
    // The six existing free orgs. Deliberately NOT backfilled: retro-fitting a
    // 14-day clock onto an account somebody has used for weeks would be a
    // surprise, not a migration.
    const s = trialStateFor({ planStatus: "free", trialEndsAt: null }, NOW);
    expect(s.phase).toBe("none");
    expect(s.restricted).toBe(false);
  });

  it("is trialing while time remains", () => {
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-08-08T12:00:00Z" }, NOW);
    expect(s.phase).toBe("trialing");
    expect(s.endsOn).toBe("2026-08-08");
  });

  it("is expired once the end has passed", () => {
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-07-30T12:00:00Z" }, NOW);
    expect(s.phase).toBe("expired");
  });

  it("treats an unparseable end date as no trial rather than an expired one", () => {
    // Failing the other way would lock an account out on bad data.
    expect(trialStateFor({ planStatus: "trialing", trialEndsAt: "not a date" }, NOW).phase).toBe(
      "none",
    );
  });
});

describe("a plan that ended stops being paid", () => {
  // The whole point of BUILD-7's AI gate is that nobody uses HoundStack's model
  // keys for free. Each of these reached `paid` before and kept the AI
  // receptionist answering, unmetered, with no banner to tell anyone.

  it("does not read a cancelled org as paid because the subscription id is still there", () => {
    // customer.subscription.deleted writes { stripe_subscription_id: sub.id,
    // plan_status: 'canceled' } — it re-writes the id rather than clearing it.
    const s = trialStateFor(
      { planStatus: "canceled", trialEndsAt: null, hasSubscription: true },
      NOW,
    );
    expect(s.phase).toBe("lapsed");
    expect(aiAvailableFor(s)).toBe(false);
  });

  it("does not read a SUSPENDED org as paid", () => {
    // suspendTenant writes billing_status='suspended' and never touches
    // plan_status, so a tenant suspended for fraud kept plan_status='active'.
    const s = trialStateFor(
      {
        planStatus: "active",
        billingStatus: "suspended",
        trialEndsAt: null,
        hasSubscription: true,
      },
      NOW,
    );
    expect(s.phase).toBe("lapsed");
    expect(aiAvailableFor(s)).toBe(false);
    // A suspension is already enforced elsewhere; it does not wait for the
    // trial-enforcement switch.
    expect(s.restricted).toBe(true);
  });

  it("does not tell someone who cancelled a paid plan that their trial ended", () => {
    expect(TRIAL_COPY.lapsed.headline({} as any)).toMatch(/plan has ended/i);
    // NP-12 (2026-10-09): locked until a plan is chosen, export for 30 days.
    expect(TRIAL_COPY.lapsed.body).toBe(
      "Your account is locked until you choose a plan. You can export your data for 30 days after cancelling.",
    );
  });

  it("explains AI in terms of the plan, not the trial", () => {
    const s = trialStateFor({ planStatus: "canceled", trialEndsAt: null }, NOW);
    expect(aiUnavailableReason(s)).toMatch(/active plan/i);
  });

  it("leaves a cancelled account working if it predates enforcement", () => {
    // UPDATED 2026-08-16. This read `.toBe(TRIAL_ENFORCEMENT)`, which was a
    // tautology dressed as an assertion: it passed for either value of the
    // switch and so pinned nothing at all. Now it pins the actual promise —
    // an account made under the old rules keeps working when it is cancelled.
    const grandfathered = trialStateFor(
      { planStatus: "canceled", trialEndsAt: null, createdAt: "2026-01-01T00:00:00Z" },
      NOW,
    );
    expect(grandfathered.restricted).toBe(false);
  });

  it("but restricts a cancelled account created after it", () => {
    const recent = trialStateFor(
      { planStatus: "canceled", trialEndsAt: null, createdAt: "2026-09-01T00:00:00Z" },
      NOW,
    );
    expect(recent.restricted).toBe(true);
  });

  it("suspends regardless of when the account was created", () => {
    // A suspension is a decision somebody already made — fraud, non-payment —
    // and grandfathering must not undo it. This is the one restriction that
    // does not consult the cutoff.
    const old = trialStateFor(
      { planStatus: "active", billingStatus: "suspended", trialEndsAt: null, createdAt: "2020-01-01T00:00:00Z" },
      NOW,
    );
    expect(old.restricted).toBe(true);
  });
});

describe("the countdown rounds up, never down", () => {
  it("says 1 day left with 18 hours to go", () => {
    // Flooring here tells someone their trial ended while the account still
    // works — the banner and the behaviour would disagree.
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-08-02T06:00:00Z" }, NOW);
    expect(s.daysRemaining).toBe(1);
  });

  it("says 1 day left with a minute to go", () => {
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-08-01T12:01:00Z" }, NOW);
    expect(s.phase).toBe("trialing");
    expect(s.daysRemaining).toBe(1);
  });

  it("says 14 on the day it starts", () => {
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-08-15T12:00:00Z" }, NOW);
    expect(s.daysRemaining).toBe(14);
  });

  it("reads as the last day rather than a plural in the copy", () => {
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-08-02T06:00:00Z" }, NOW);
    expect(TRIAL_COPY.trialing.headline(s)).toMatch(/last day/i);
  });
});

describe("expiry locks out new accounts, and only new accounts", () => {
  // ── THE POLICY CHANGED ON 2026-08-16, BY OWNER DECISION ─────────────────
  //
  // This block used to assert `TRIAL_ENFORCEMENT).toBe(false)` and that an
  // expired trial restricted nothing. That was correct while there was no way
  // to pay: a paywall whose only exit is a payment nobody can make is an
  // outage. Stripe is live now, so the condition the switch was waiting for
  // has been met.
  //
  // It was flipped while the blast radius was zero — three organizations, all
  // demo, none subscribed, none expired, none trialing — and grandfathered, so
  // anyone who signed up under the old promise keeps it. Both halves are
  // pinned below, because "enforcement is on" and "enforcement reaches the
  // right accounts" are different claims and only one of them is a one-liner.
  it("restricts an expired trial for an account created after the cutoff", () => {
    expect(TRIAL_ENFORCEMENT).toBe(true);
    const s = trialStateFor(
      {
        planStatus: "trialing",
        trialEndsAt: "2026-07-01T00:00:00Z",
        createdAt: `${TRIAL_ENFORCEMENT_FROM}T00:00:00Z`,
      },
      NOW,
    );
    expect(s.phase).toBe("expired");
    expect(s.restricted).toBe(true);
  });

  it("leaves an account created the day before alone, forever", () => {
    // One day either side of the cutoff, so the boundary itself is pinned
    // rather than a comfortable distance from it.
    const s = trialStateFor(
      { planStatus: "trialing", trialEndsAt: "2026-07-01T00:00:00Z", createdAt: "2026-08-15T23:59:59Z" },
      NOW,
    );
    expect(s.phase).toBe("expired");
    expect(s.restricted).toBe(false);
  });

  it("fails OPEN when the caller did not say when the account was made", () => {
    // Deliberate direction: a forgotten field lets somebody in rather than
    // locking them out of an account they may be paying for. The risk this
    // takes on — a call site quietly disabling enforcement — is why the next
    // test exists.
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-07-01T00:00:00Z" }, NOW);
    expect(s.restricted).toBe(false);
  });

  it("every caller passes createdAt, since the type will not ask", () => {
    // createdAt is optional, so omitting it compiles and silently switches
    // enforcement off for that path. There are only two callers; both are
    // checked here by reading them, because there is no type-level way to
    // require a field that older tests are allowed to omit.
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const f of ["src/lib/ai-access.server.ts", "src/lib/trial.functions.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      const call = src.slice(src.indexOf("trialStateFor({"));
      expect(call.slice(0, 400), `${f} calls trialStateFor without createdAt`).toMatch(
        /createdAt:/,
      );
      // Inside the .select(...) string, not anywhere in the file. The first
      // version of this line matched the whole source, and `data.created_at`
      // on the very next line satisfied it — so the test passed for months
      // while ai-access.server.ts selected four columns and read a fifth that
      // was therefore always undefined, silently switching enforcement off for
      // that path. A guard answered by the thing it was guarding against.
      const select = /\.select\(\s*"([^"]*)"/.exec(src);
      expect(select, `${f} has no .select("…") to check`).not.toBeNull();
      expect(select![1], `${f} does not select created_at`).toMatch(/\bcreated_at\b/);
    }
  });

  it("tells an expired org it is locked and how long its data is kept", () => {
    // NP-12 (2026-10-09), exactly.
    expect(TRIAL_COPY.expired.body).toBe(
      "Your account is locked. Choose a plan to unlock it. Your data is kept for 30 days.",
    );
    expect(TRIAL_COPY.trialing.body).toBe(
      "Everything is unlocked. If you don't choose a plan by the end of the trial, the account is locked until you do, and your data is kept for 30 days. Nothing is charged automatically and no card is on file.",
    );
  });

  it("the account lock passes createdAt too, and its select carries it", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const lock = readFileSync(join(root, "src/lib/account-lock.ts"), "utf8");
    expect(lock.slice(lock.indexOf("trialStateFor("), lock.indexOf("trialStateFor(") + 400)).toMatch(
      /createdAt: org\.created_at/,
    );
    const server = readFileSync(join(root, "src/lib/account-lock.server.ts"), "utf8");
    expect(/ORG_LOCK_COLUMNS =\s*"([^"]*)"/.exec(server)?.[1]).toMatch(/\bcreated_at\b/);
  });
});

describe("AI is paid-only", () => {
  it("is unavailable during a trial", () => {
    // Owner decision. AI runs on HoundStack's keys with no metering (BUILD-2 is
    // Stripe-blocked), so a trial with AI is unbounded spend.
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-08-08T12:00:00Z" }, NOW);
    expect(aiAvailableFor(s)).toBe(false);
  });

  it("is unavailable after expiry", () => {
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-07-01T00:00:00Z" }, NOW);
    expect(aiAvailableFor(s)).toBe(false);
  });

  it("is unavailable for a legacy free org — no grandfather loophole", () => {
    const s = trialStateFor({ planStatus: "free", trialEndsAt: null }, NOW);
    expect(aiAvailableFor(s)).toBe(false);
  });

  it("is available once paid", () => {
    expect(aiAvailableFor(trialStateFor({ planStatus: "active", trialEndsAt: null }, NOW))).toBe(
      true,
    );
  });

  it("explains itself instead of saying 'unavailable'", () => {
    const s = trialStateFor({ planStatus: "trialing", trialEndsAt: "2026-08-08T12:00:00Z" }, NOW);
    const reason = aiUnavailableReason(s);
    expect(reason).toMatch(/paid plan/i);
    expect(reason).toMatch(/costs us real money|doesn't include/i);
  });

  it("gives no reason when AI is available", () => {
    expect(
      aiUnavailableReason(trialStateFor({ planStatus: "active", trialEndsAt: null }, NOW)),
    ).toBeNull();
  });
});
