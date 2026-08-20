import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRIAL_NOTICE_DAYS_BEFORE,
  TRIAL_NOTICE_TEMPLATE,
  renderTrialNoticeHtml,
  renderTrialNoticeText,
} from "@/lib/trial-expiry-emails.server";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments blanked, so prose describing a rule cannot satisfy a check FOR that
 *  rule. The header of trial-expiry-emails.server.ts quotes the very
 *  `.not("contact_email", ...)` query it exists to avoid, and the first version
 *  of this file failed on its own explanation. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const args = { orgName: "Scooper Troopers", daysLeft: 3, endsOn: "2026-08-30", billingUrl: "https://app.houndstack.com/settings/billing" };

// The expired banner promised "we'll tell you before anything changes" and
// there was no mechanism behind it. registry.ts holds nine templates and none
// was trial-related, and the only trial notification in the codebase --
// `trial_ending` in platform-stripe.ts -- comes from Stripe's
// customer.subscription.trial_will_end, which CANNOT fire for an app-side trial
// with no Stripe subscription. So the promise was unkeepable, not merely unkept.
describe("the trial notice", () => {
  it("is not Stripe's trial_will_end, and does not borrow its name", () => {
    // If these two ever share a template name, the send log stops being able to
    // answer "did WE tell them, or did Stripe?" — and for an app-side trial the
    // answer is always "not Stripe", because that event never fires.
    expect(TRIAL_NOTICE_TEMPLATE).toBe("trial_expiry_notice");
    expect(TRIAL_NOTICE_TEMPLATE).not.toBe("trial_ending");
    const stripe = read("src/routes/api/public/hooks/platform-stripe.ts");
    expect(stripe, "platform-stripe.ts no longer has the Stripe-side name").toContain("trial_ending");
    expect(
      codeOnly(read("src/lib/trial-expiry-emails.server.ts")),
      "the app-side sender must not emit the Stripe-side name",
    ).not.toMatch(/"trial_ending"|'trial_ending'/);
  });

  it("falls back to the owner's login when the org has no contact address", () => {
    // The whole reason this is not a copy of announcement-emails.server.ts,
    // which selects `.not("contact_email", "is", null)`. Checked against
    // production first: the ONE org in a trial has contact_email NULL, so that
    // query would have mailed nobody and reported a clean run.
    const src = codeOnly(read("src/lib/trial-expiry-emails.server.ts"));
    expect(src, "no owner fallback").toMatch(/role["']?,\s*["']owner["']/);
    expect(src, "does not read the owner's auth email").toMatch(/getUserById/);
    expect(src, "does not record which address it used").toMatch(/owner_auth_email/);
    expect(
      src,
      "requiring contact_email would skip every trial that has not set one",
    ).not.toMatch(/\.not\(\s*["']contact_email["']/);
  });

  it("states what pauses and what does not, matching the ratified definition", () => {
    const html = renderTrialNoticeHtml(args);
    const text = renderTrialNoticeText(args);
    for (const body of [html, text]) {
      // What stops.
      expect(body).toMatch(/new customer/i);
      // What does not — the half that makes it a pause rather than a lockout.
      expect(body).toMatch(/invoic/i);
      expect(body).toMatch(/portal/i);
      expect(body).toMatch(/nothing is deleted/i);
      // The CTA.
      expect(body).toContain("/settings/billing");
    }
    // It must NOT imply a broader freeze the product does not perform.
    expect(html).not.toMatch(/account (will be )?(locked|frozen|suspended|disabled)/i);
    expect(html).not.toMatch(/lose access/i);
  });

  it("reads correctly on the last day rather than saying 'in 1 days'", () => {
    expect(renderTrialNoticeHtml({ ...args, daysLeft: 1 })).toMatch(/ends tomorrow/i);
    expect(renderTrialNoticeHtml({ ...args, daysLeft: 0 })).toMatch(/ends today/i);
    expect(renderTrialNoticeHtml({ ...args, daysLeft: 3 })).toMatch(/ends in 3 days/i);
  });

  it("escapes the organization name", () => {
    const html = renderTrialNoticeHtml({ ...args, orgName: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is actually wired into the nightly run", () => {
    // The failure mode this whole area keeps repeating: built, correct, and set
    // in motion by nothing. announcement-emails.server.ts documents the same
    // thing happening to the announcement send, the weekly digest and the
    // franchise rollup.
    const nightly = read("src/routes/api/public/hooks/nightly.ts");
    expect(nightly, "the nightly run does not call the sender").toMatch(
      /sendTrialExpiryNotices\s*\(/,
    );
    expect(nightly, "the run summary does not report it").toMatch(/trial_notices/);
  });

  it("warns before expiry, not after", () => {
    expect(TRIAL_NOTICE_DAYS_BEFORE).toBeGreaterThan(0);
    const src = read("src/lib/trial-expiry-emails.server.ts");
    // The window must be trials that have NOT yet ended.
    expect(src).toMatch(/\.gt\(\s*["']trial_ends_at["']/);
  });

  it("tells an operator whether the notice actually went out", () => {
    // A health card that says a trial is expiring and nothing about whether we
    // told anyone reports the half nobody can act on.
    expect(read("src/lib/platform.functions.ts")).toMatch(/trials_not_notified/);
    // The wording is free to change; what the tile must not lose is that it
    // renders the un-emailed count at all, rather than only the expiry date.
    expect(read("src/routes/platform.health.tsx")).toMatch(/h\.trials_not_notified/);
  });
});

// ── THE HEALTH CARD MEASURES THE SENDER'S QUESTION, NOT AN ADJACENT ONE ────
//
// The first version of the card counted "not notified" across the whole
// 14-day expiring window while the sender only fires inside three days. On
// production that day it would have gone red immediately and stayed red for a
// week, reporting Scooper Troopers -- ten days out, correctly un-emailed -- as
// a missed send. A card that cries wolf for seven days is a card nobody reads
// on the eighth, which is the day it would have mattered.
describe("the platform health card", () => {
  const src = codeOnly(read("src/lib/platform.functions.ts"));

  it("scopes 'not notified' to trials the sender was due to mail", () => {
    // The counts must come from the due set, never from every expiring trial.
    expect(src, "a noticeDueBy cutoff is computed").toMatch(/noticeDueBy/);
    expect(src, "trials_not_notified counts the due set").toMatch(
      /trials_not_notified:\s*due\.filter/,
    );
    expect(src, "trials_notified counts the due set").toMatch(/trials_notified:\s*due\.filter/);
    // The exact shape of the bug: counting over `expiring` instead of `due`.
    expect(src, "the counts no longer span the whole 14-day window").not.toMatch(
      /trials_not(_notified)?:\s*expiring\.filter/,
    );
  });

  it("takes the window and the template name from the sender, not a copy", () => {
    // Restating either one lets the card drift into answering a question the
    // sender is not asking, and be confidently wrong while looking correct.
    expect(src, "the notice window is imported").toMatch(/TRIAL_NOTICE_DAYS_BEFORE/);
    expect(src, "the template name is imported").toMatch(/TRIAL_NOTICE_TEMPLATE/);
    expect(src, "the template name is not written out a second time").not.toMatch(
      /template_name["']?\s*,\s*["']trial_expiry_notice["']/,
    );
  });

  it("only claims a notice was sent when one was", () => {
    const tile = codeOnly(read("src/routes/platform.health.tsx"));
    // "notice sent" must be conditional on a send having happened. A trial
    // outside the window has had no notice and is not owed one; saying
    // "notice sent" there is the same false reassurance in the other direction.
    expect(tile, "'notice sent' is guarded by trials_notified").toMatch(
      /trials_notified\s*>\s*0\s*\?\s*["'`]notice sent/,
    );
  });
});
