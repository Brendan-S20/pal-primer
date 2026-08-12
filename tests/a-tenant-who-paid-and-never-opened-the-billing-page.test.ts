// The webhook wrote one column. Everything that asks "are they paying" read the other.
//
// `organizations` carries two status columns. `plan_status` gates the product —
// client creation, add-ons. `billing_status` is what says whether HoundStack is
// being paid: `contributesRevenue` → `isPayingStatus(billing_status)` for MRR,
// `active_tenants` on the platform overview, the status chip on
// /platform/tenants, `free_tenants`, `at_risk`, the lot.
//
// `src/routes/api/public/hooks/platform-stripe.ts` — the only thing on this
// system that hears from Stripe about a tenant's subscription — wrote
// `plan_status` on `invoice.paid`, on `invoice.payment_failed`, and on all
// three `customer.subscription.*` events. The string `billing_status` did not
// appear in the file.
//
// So a tenant who subscribed and never opened Settings → Billing stayed
// `billing_status = 'free'`: absent from MRR, counted as a freemium prospect in
// the console, shown to us as not paying while Stripe charged their card every
// month. The one writer that did set both is `refreshBillingStatus`, which runs
// when somebody opens the billing page — which is why the split was survivable
// and why it was invisible. The tenants we looked at were the ones who had
// looked at their own billing.
//
// The brief recorded this exact shape once already, in BUG-32: "BUILD-7 set
// plan_status='trialing' but left billing_status, and /platform/tenants reads
// the latter, so every trial showed as 'Free'." Same two columns, same
// direction, a different writer.
//
// ── AND THE KPI THAT COULD NOT HAVE WORKED ────────────────────────────────
//
// `getPlatformOverview` computed "Converted this month" from
// `platform_admin_audit` rows actioned `subscription_created` or
// `billing_status_change`. Checked against the live table: five distinct
// actions have ever been written, and neither of those is among them. The
// query was not wrong — the event it reads was never emitted — so the number
// was 0 the day it shipped and would have stayed 0 through a hundred
// conversions. Both halves are one change, because a status move that is not
// recorded is a conversion nobody can count.
//
// ── THE TWO REFUSALS THAT MAKE IT SAFE ────────────────────────────────────
//
// It will not overwrite `suspended`. That status is only set by a platform
// admin with a written reason, and a tenant suspended for fraud whose card
// still works would otherwise be quietly un-suspended by the next
// `invoice.paid`, with the suspension reason still in the row.
//
// It does not fire for the admin actions. `suspendTenant`, `reactivateTenant`,
// `grantGracePeriod` and `setTenantStatus` already write an audit row naming
// what the admin did, and an admin flipping a tenant to active is not evidence
// anybody paid. Counting it would inflate the only number on that page that
// claims to measure sales.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
// Lazy: a read resolved in a describe body turns a missing file into an
// import-time throw, and vitest reports that as "no tests" — which reads as a
// pass. The mutation test for this file stashes src/.
const read = (p: string) => () => readFileSync(ROOT + p, "utf8");
const writer = read("src/lib/platform-billing-status.server.ts");
const hook = read("src/routes/api/public/hooks/platform-stripe.ts");
const billing = read("src/lib/billing.functions.ts");
const overview = read("src/lib/platform-overview.functions.ts");
const tenantAdmin = read("src/lib/platform-tenant.functions.ts");

/** Whole-line `//` comments dropped. Every file here explains the bug it
 *  fixes, and the prose names the column and the action string it bans, so a
 *  raw match finds the explanation as readily as a relapse. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("the platform webhook moves the column the console reads", () => {
  it("sets billing_status on an invoice outcome, not just plan_status", () => {
    const code = codeOnly(hook());
    expect(code).toMatch(/applyPlatformBillingStatus/);
    const invoiceBranch = code.slice(
      code.indexOf('case "invoice.paid"'),
      code.indexOf('case "customer.subscription.trial_will_end"'),
    );
    expect(
      invoiceBranch,
      "invoice.paid moved plan_status and left billing_status, which is the " +
        "column MRR and active_tenants read",
    ).toMatch(/applyPlatformBillingStatus\(/);
    expect(invoiceBranch).toMatch(/plan_status/);
  });

  it("sets it on every subscription event too, with the same mapping", () => {
    const code = codeOnly(hook());
    const subBranch = code.slice(
      code.indexOf('case "customer.subscription.created"'),
      code.indexOf('case "customer.created"'),
    );
    expect(subBranch).toMatch(/applyPlatformBillingStatus\(supabaseAdmin, orgId, mapped,/);
    // `mapped` is the one status map in that branch. A second literal here
    // would be a second opinion about what "past_due" means.
    expect(subBranch).not.toMatch(/billing_status:\s*"/);
  });

  it("passes no actor, because a webhook is not a person", () => {
    const code = codeOnly(hook());
    const calls = [...code.matchAll(/applyPlatformBillingStatus\(([\s\S]*?)\}\);/g)];
    // Assert the calls exist before asserting a property of them — otherwise
    // deleting the whole feature satisfies this test.
    expect(calls.length, "no applyPlatformBillingStatus call in the webhook").toBe(2);
    for (const c of calls) expect(c[1]).not.toMatch(/actorUserId/);
    // …while the billing page, which a signed-in person triggered, does name one.
    expect(codeOnly(billing())).toMatch(/actorUserId: context\.userId/);
  });
});

describe("the writer refuses the two things it must", () => {
  it("will not lift an admin suspension", () => {
    const code = codeOnly(writer());
    expect(
      code,
      "a tenant suspended for fraud whose card still works would be " +
        "un-suspended by the next invoice.paid",
    ).toMatch(/if \(previous === "suspended"\)/);
    expect(code).toMatch(/refused: "suspended"/);
  });

  it("writes nothing and files nothing when the status did not move", () => {
    // Stripe redelivers, and customer.subscription.updated fires for changes
    // that have nothing to do with status. Either would file a second
    // conversion for the same tenant.
    const code = codeOnly(writer());
    expect(code).toMatch(/if \(previous === next\) return \{ changed: false/);
    const update = code.indexOf(".update({ billing_status: next })");
    const guard = code.indexOf("if (previous === next)");
    expect(guard).toBeGreaterThan(-1);
    expect(update, "the no-op guard must precede the write").toBeGreaterThan(guard);
  });

  it("records the transition, not just the destination", () => {
    const code = codeOnly(writer());
    expect(code).toMatch(/action: "billing_status_change"/);
    expect(code).toMatch(/before_json: \{ billing_status: previous \}/);
    expect(code).toMatch(/became_paying:/);
  });

  it("does not let a lost audit row roll back a subscription activation", () => {
    const code = codeOnly(writer());
    const auditAt = code.indexOf('action: "billing_status_change"');
    const before = code.slice(0, auditAt);
    expect(before.lastIndexOf("try {")).toBeGreaterThan(
      before.lastIndexOf('await supabaseAdmin\n    .from("organizations")\n    .update'),
    );
    expect(code).toMatch(/billing_status_change audit failed/);
  });
});

describe("the billing page and the webhook now agree", () => {
  it("refreshBillingStatus no longer writes the column directly", () => {
    const code = codeOnly(billing());
    const fn = code.slice(code.indexOf("export const refreshBillingStatus"));
    expect(fn, "two writers for one column is how the suspension guard gets skipped").not.toMatch(
      /billing_status:\s*(status|"canceled")/,
    );
    expect(fn).toMatch(/applyPlatformBillingStatus\(supabaseAdmin, orgId, status,/);
    expect(fn).toMatch(/applyPlatformBillingStatus\(supabaseAdmin, orgId, "canceled",/);
  });

  it("still writes plan_status, which gates the product and is a different question", () => {
    const code = codeOnly(billing());
    const fn = code.slice(code.indexOf("export const refreshBillingStatus"));
    expect(fn).toMatch(/plan_status: status/);
    expect(fn).toMatch(/plan_status: "canceled"/);
  });

  it("leaves the admin lifecycle actions alone", () => {
    // They write their own audited row naming the act. Routing them through
    // the conversion writer would count an admin override as a sale.
    const code = codeOnly(tenantAdmin());
    expect(code).not.toMatch(/applyPlatformBillingStatus/);
    expect(code).toMatch(/"suspend_tenant"/);
    expect(code).toMatch(/"reactivate_tenant"/);
  });
});

describe("Converted this month counts conversions", () => {
  it("reads the action that is now actually written", () => {
    const code = codeOnly(overview());
    expect(code).toMatch(/\.eq\("action", "billing_status_change"\)/);
    // The name nothing has ever written is gone rather than left as a second
    // thing to look for.
    expect(code).not.toMatch(/subscription_created/);
  });

  it("counts becoming a payer, not being one", () => {
    // past_due → active and grace → active are a lapsed customer's card
    // clearing: the same tenant again, and no new revenue.
    const code = codeOnly(overview());
    expect(code).toMatch(/became_paying/);
    expect(code).toMatch(/!PAYING\.includes\(before \?\? ""\)/);
    expect(code).toMatch(/before_json/);
  });

  it("still counts a tenant once however many events they generate", () => {
    const code = codeOnly(overview());
    expect(code).toMatch(/const convertedIds = new Set<string>\(\)/);
    expect(code).toMatch(/converted_this_month: convertedIds\.size/);
  });
});

describe("the audit table stopped assuming a person had done it", () => {
  const FILE = "20260812170000_the-audit-table-assumed-a-person-had-done-it.sql";
  const migration = () => readFileSync(ROOT + "supabase/migrations/" + FILE, "utf8");

  it("drops NOT NULL rather than inventing an actor", () => {
    // Crediting the org owner, a service account, or the first platform admin
    // would put a name on an act that person did not perform, in the one table
    // whose entire job is saying who did what.
    const sql = migration();
    expect(sql).toMatch(/alter column actor_user_id drop not null/i);
    expect(sql).toMatch(/do \$pre\$/i);
    expect(sql).toMatch(/expected no actorless rows before this runs/);
  });

  it("proves it wrote no rows, only widened what is permitted", () => {
    const post = migration().slice(migration().indexOf("do $post$"));
    expect(post).toMatch(/actor_user_id is still NOT NULL/);
    expect(post).toMatch(/should have written none/);
  });

  it("leaves a comment on the column saying what null means", () => {
    expect(migration()).toMatch(/comment on column public\.platform_admin_audit\.actor_user_id/i);
    expect(migration()).toMatch(/by the billing system/);
  });

  it("stops both routes reading a uuid that may not be there", () => {
    // `.slice(0, 8)` on a null throws, and it was written twice.
    for (const p of ["src/routes/platform.audit.tsx", "src/routes/platform.tenants.$id.tsx"]) {
      const src = codeOnly(readFileSync(ROOT + p, "utf8"));
      expect(src, `${p} still slices actor_user_id directly`).not.toMatch(/actor_user_id\.slice/);
      expect(src).toMatch(/auditActorLabel\(/);
    }
  });

  it("stops the email lookups keying on a null id", () => {
    for (const p of ["src/lib/platform.functions.ts", "src/lib/platform-tenant.functions.ts"]) {
      const src = codeOnly(readFileSync(ROOT + p, "utf8"));
      expect(src, `${p} looks an email up by a possibly-null id`).toMatch(
        /r\.actor_user_id \? \(?\w+\.get\(r\.actor_user_id\) \?\? null\)? : null/,
      );
    }
  });
});
