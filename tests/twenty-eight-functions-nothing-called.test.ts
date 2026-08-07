// Twenty-eight exported server functions that no screen imported.
//
// They sat in `scripts/dead-machinery-baseline.json` under one shared reason
// that said, honestly, that nobody had looked at them: "each is either a
// feature whose screen was never built, or one whose screen was removed.
// Verify and either wire it up or delete it — do not edit this reason to make
// it look resolved."
//
// Verified. Twenty-four deleted, four wired. The interesting part is that
// "unwired" turned out to describe three quite different situations, and two of
// them were doing harm while dormant.
//
// ── THE TWO THAT WERE NOT MERELY DEAD ─────────────────────────────────────
//
// `chargeInvoiceWithSavedCard` charged the invoice's open balance to the saved
// card WITHOUT applying the client's account credit first. `chargeAutopayForInvoice`
// — the one the invoice drawer and the full invoice page both use — applies
// credit, guards against an in-flight bank debit, and only then calls the same
// `chargeSavedCardCore`. Wiring the unwired one up, which is what the baseline
// invited, would have taken money from customers who had already paid part of
// the bill. Deleted, not fixed: the correct version already exists.
//
// `generateAddonCharges` was the ONLY producer of `addon_charges` rows from
// `addon_subscriptions`. Nothing called it: not a screen, not a cron job.
// `run_billing_cycles` invoices addon_charges that are already 'pending', so
// every link in the recurring add-on chain existed except the first one, and
// `addon_charges` had zero rows with source = 'recurring', ever. That is not
// dead code, it is a feature that silently never ran. Fixed in migration
// 20260807040000 + the nightly hook.
//
// ── THE PATTERN IN THE OTHER TWENTY-TWO ───────────────────────────────────
//
// Almost all of them were a second implementation of something already wired:
//   updateStaffStart          -> setStaffAddresses (StaffRoutingDialog)
//   updateClientNotes         -> the client_notes table + NotesPanel
//   updatePropertyWindow      -> the arrival window moved to the SERVICE
//   resolveConcern            -> updateConcernStatus, which validates its input
//                                and checks a permission; this one did neither
//   getUnreadNotificationCount-> listMyNotifications already returns the count
//   listRecentClientVisits    -> SummaryTab derives it from visits it has
//   getInvoicePayLink         -> appUrl(), which the copy handlers now use
//   submitLead                -> POST /api/public/leads
//   listPlatformAudit         -> getPlatformAudit
//   setLocationRoyaltyPercent -> setChildRoyaltyRate, better gated
//   listPublicPlans           -> listPlatformPlans; public pricing is the
//                                marketing site, not this app
//
// A duplicate that nobody calls is not harmless: it is a second answer to a
// question that already had one, waiting for someone to wire up the wrong one.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const baseline = JSON.parse(read("scripts/dead-machinery-baseline.json"));

/** Every .ts/.tsx under src, recursively. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const ALL = sources(join(root, "src"));

/** Comment lines stripped, so a `not.toMatch` cannot be satisfied or defeated
 *  by the prose that documents the removal. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("--") ||
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("{/*")
      );
    })
    .join("\n");

const DELETED = [
  "autoRebalanceForecast",
  "getStaffWorkload",
  "getZoneVisitsOnDay",
  "updateZoneCoords",
  "balanceOverloadedRoutes",
  "updateStaffStart",
  "updatePropertyWindow",
  "chargeInvoiceWithSavedCard",
  "getInvoicePayLink",
  "listUnbilledForClient",
  "updateClientNotes",
  "listRecentClientVisits",
  "deleteDog",
  "resolveConcern",
  "getUnreadNotificationCount",
  "listPublicPlans",
  "submitLead",
  "listPlatformAudit",
  "updateOrgPlan",
  "setLocationRoyaltyPercent",
  "unlinkFranchiseLocation",
  "getEmailVerificationStatus",
  "subscribeClientNativePush",
  "generateAddonCharges",
  "reassignBillingTierForOrg",
];

describe("the baseline is empty, and empty for the right reason", () => {
  it("carries no unwired server functions at all", () => {
    expect(Object.keys(baseline.unwired_server_fns)).toEqual([]);
  });

  it("says so in the readme, so the next person does not refill it", () => {
    const readme = baseline._readme.join("\n");
    expect(readme).toMatch(/unwired_server_fns is EMPTY/);
    expect(readme).toMatch(/A new entry here needs its own reason, not a shared one/);
  });

  it("records the two that were doing harm while dormant", () => {
    const readme = baseline._readme.join("\n");
    expect(readme).toMatch(/without applying account credit first/);
    expect(readme).toMatch(/recurring add-ons produced/);
  });
});

describe("the deleted ones are gone, not just unexported", () => {
  it.each(DELETED)("%s no longer exists as a server function", (name) => {
    const declared = ALL.filter((f) =>
      new RegExp(`export const ${name}\\s*=\\s*createServerFn`).test(readFileSync(f, "utf8")),
    );
    expect(declared).toEqual([]);
  });

  it.each(DELETED)("%s is not imported anywhere either", (name) => {
    const importers = ALL.filter((f) =>
      new RegExp(`\\b${name}\\b`).test(codeOnly(readFileSync(f, "utf8"))),
    ).map((f) => f.slice(root.length + 1));
    expect(importers).toEqual([]);
  });

  it("takes the whole plans.functions.ts file with listPublicPlans", () => {
    // It was a single-export module for a public pricing grid this app does not
    // have — pricing lives on the marketing site. An empty file left behind is
    // an invitation to put something else in it.
    expect(existsSync(join(root, "src/lib/plans.functions.ts"))).toBe(false);
  });
});

describe("the pay link names the host the product lives at", () => {
  // Both copy handlers built the URL from window.location.origin. That is the
  // host the STAFFER is on, which on a Lovable preview build is a preview
  // domain — a link that works today, 404s next week, and was sent to a
  // customer. getInvoicePayLink existed to solve this server-side and was never
  // called; appUrl() solves it without a round trip, and src/lib/app-origin.ts
  // is explicitly safe to call from the client.
  const drawer = read("src/components/InvoiceDrawer.tsx");
  const row = read("src/components/InvoiceRow.tsx");

  it("uses appUrl in the drawer", () => {
    expect(drawer).toMatch(/appUrl\(`\/pay\/i\/\$\{inv\.public_token\}`\)/);
    expect(codeOnly(drawer)).not.toMatch(/window\.location\.origin\}\/pay/);
  });

  it("uses appUrl in the row menu", () => {
    expect(row).toMatch(/appUrl\(`\/pay\/i\/\$\{invoice\.public_token\}`\)/);
    expect(codeOnly(row)).not.toMatch(/window\.location\.origin\}\/pay/);
  });
});

describe("recurring add-ons produce charges now", () => {
  const migration = read(
    "supabase/migrations/20260807040000_a-recurring-add-on-that-never-charged.sql",
  );
  const nightly = read("src/routes/api/public/hooks/nightly.ts");

  it("adds an admin_ variant the cron can actually call", () => {
    // The staff-facing one opens with has_permission(auth.uid(), ...) and the
    // nightly hook runs as service_role, where auth.uid() is NULL — calling it
    // from cron would have raised 'Not authorized' on every org, swapping a
    // silent no-op for a nightly error.
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.admin_generate_addon_charges_through/,
    );
    const adminBody = migration.slice(
      migration.indexOf("admin_generate_addon_charges_through(_org_id uuid, _through date)"),
      migration.indexOf("CREATE OR REPLACE FUNCTION public.generate_addon_charges_through"),
    );
    expect(adminBody).not.toMatch(/has_permission/);
  });

  it("keeps the logic in one place", () => {
    // Same relationship as generate_invoice_for_client ->
    // admin_generate_invoice_for_client. Two copies of a loop that writes money
    // rows is how one of them drifts.
    expect(migration).toMatch(
      /RETURN public\.admin_generate_addon_charges_through\(_org_id, _through\)/,
    );
    expect(migration).toMatch(/IF NOT public\.has_permission\(auth\.uid\(\), _org_id/);
  });

  it("refuses to silently retire a subscription on an unmapped frequency", () => {
    // A frequency the CASE misses leaves _step NULL, `_next + NULL` is NULL,
    // the WHILE exits immediately and next_charge_on is set to NULL — the
    // subscription stops billing forever with no error anywhere.
    expect(migration).toMatch(/IF _step IS NULL THEN/);
    expect(migration).toMatch(/unmapped frequency/);
    expect(migration).toMatch(/CONTINUE;/);
  });

  it("runs in the nightly job before the invoice run", () => {
    // Otherwise a charge that comes due today waits a full cycle for an invoice.
    const gen = nightly.indexOf("admin_generate_addon_charges_through");
    const bill = nightly.indexOf('rpc("run_billing_cycles"');
    expect(gen).toBeGreaterThan(-1);
    expect(bill).toBeGreaterThan(-1);
    expect(gen).toBeLessThan(bill);
  });

  it("reports what it did, per org", () => {
    expect(nightly).toMatch(/perOrg\.addon_charges_generated/);
  });
});

describe("the four that were wired instead of deleted", () => {
  it("the review queue count reaches the nav badge it was written for", () => {
    const sidebar = read("src/components/AppSidebar.tsx");
    expect(sidebar).toMatch(/getReviewQueueCount/);
    expect(sidebar).toMatch(/openReviews/);
    // Collapsed to the icon rail there is no room for a number.
    expect(sidebar).toMatch(/collapsed \? \(/);
    expect(sidebar).toMatch(/rounded-full bg-destructive/);
  });

  it("the badge is not fetched for roles that cannot see the page", () => {
    const sidebar = read("src/components/AppSidebar.tsx");
    expect(sidebar).toMatch(/enabled: canAccess\(role, "\/review"\)/);
  });

  it("gift card redemptions are disclosed on the card that spent them", () => {
    const promos = read("src/routes/_authenticated/settings.promotions.tsx");
    expect(promos).toMatch(/listGiftCardRedemptions/);
    expect(promos).toMatch(/function GiftCardHistory/);
    // Names clients, so it is closed by default and fetched on open.
    expect(promos).toMatch(/enabled: open/);
  });

  it("still offers the history on a voided card", () => {
    // A void zeroes remaining_balance_cents, so "spent" stops being meaningful
    // — and that is exactly the card somebody asks about.
    const promos = read("src/routes/_authenticated/settings.promotions.tsx");
    expect(promos).toMatch(/if \(spent <= 0 && card\.status === "active"\) return null/);
  });

  it("plan bands can be recomputed after they are edited", () => {
    // Editing a band here moved nobody: each org's tier was decided the last
    // time assign_billing_tier_for_org ran for them.
    const plans = read("src/routes/platform.plans.tsx");
    expect(plans).toMatch(/reassignAllBillingTiers/);
    expect(plans).toMatch(/Recompute tiers/);
    expect(plans).toMatch(/confirm\(\{/);
  });

  it("says plainly when a recompute changed nothing", () => {
    const plans = read("src/routes/platform.plans.tsx");
    expect(plans).toMatch(/Every tenant was already on the right tier/);
  });
});

describe("the orphan the cleanup created is recorded, not hidden", () => {
  it("unlink_franchise_child is in the baseline with its own reason", () => {
    // Deleting unlinkFranchiseLocation left its RPC with no caller, and the
    // detector caught it on the next run — which is the detector working.
    const reason = baseline.uncalled_rpcs.unlink_franchise_child;
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/screen was never built/);
    expect(reason).toMatch(/only way to perform the operation/);
  });

  it("is not filed as a known gap, because it is a decision", () => {
    // 'KNOWN GAP' is the check's marker for unfinished work and gets counted
    // separately on every run. This is a deliberate exception, not a to-do.
    expect(baseline.uncalled_rpcs.unlink_franchise_child).not.toMatch(/^KNOWN GAP/);
  });
});
