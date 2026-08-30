// Audit step 5: an org-level switch for the commercial-account machinery.
//
// The audit's framing needed two corrections before this could be built, and
// both changed the work:
//
//   1. "Commercial features are always visible" — mostly they are not. The
//      Units tab, the stations panel, the commercial pricing breakdown, the
//      per-property commercial fields and the tech's station checklist all
//      already branch on `account_type`, so a purely residential org sees
//      none of them today. What is genuinely unconditional is small: the
//      account-type pickers, the /dna nav entry, the zone drawer's commercial
//      pricing block, and the clients-list type filter.
//
//   2. "Copy the franchise pattern exactly" — franchise is a PLAN
//      ENTITLEMENT, available on the enterprise tier only. Copying it exactly
//      would have made commercial accounts a paid upsell: a pricing
//      commitment published on the marketing site and guarded by
//      tests/entitlement-parity.test.ts. This copies the owner-writable
//      boolean pattern (`seasonal_deepclean_enabled`) instead, which is what
//      this actually is.
//
// ── THE TRAP ──────────────────────────────────────────────────────────────
//
// Hiding an account-type <select> is not the same as removing the field. The
// edit form initialises `accountType` to `client?.account_type ??
// "residential"`. Hide the input but keep sending the value, and saving any
// unrelated edit to an existing COMMERCIAL client silently rewrites it to
// residential — while its subscription keeps `account_type='commercial'` and
// a `unit_count`, so the two disagree and the services tab starts rendering
// "Dogs: —". The payload has to omit the key, not default it.
//
// Live data checked before the default was chosen: 3 organizations, all demo
// orgs, all 3 holding commercial data (23 commercial clients, 14 commercial
// properties, 45 waste stations, 23 active commercial subscriptions). So the
// migration defaults false for NEW orgs and backfills true wherever data
// exists — nobody loses a screen they are already using.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = () =>
  read(
    "supabase/migrations/20260809010000_a-residential-operator-should-not-have-to-learn-about-hoas.sql",
  );

/** Comment lines stripped, so a `not.toMatch` cannot be defeated by the prose
 *  documenting what was removed. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
    })
    .join("\n");

describe("the flag defaults off without stranding anyone", () => {
  it("is an owner-writable boolean on organizations, defaulting false", () => {
    expect(MIGRATION()).toMatch(
      /ADD COLUMN IF NOT EXISTS commercial_accounts boolean NOT NULL DEFAULT false/,
    );
  });

  it("backfills true wherever commercial data already exists", () => {
    const m = MIGRATION();
    const backfill = m.slice(m.indexOf("UPDATE public.organizations o"));
    expect(backfill.slice(0, 900)).toMatch(/SET commercial_accounts = true/);
    // All five kinds of evidence, because missing one strands that screen.
    for (const t of [
      "account_type = 'commercial'",
      "p.has_units",
      "property_units",
      "waste_stations",
      "dna_compliance_enabled",
    ]) {
      expect(backfill.slice(0, 900), t).toContain(t);
    }
  });

  it("asserts afterwards that no org is left off while holding data", () => {
    // The backfill's whole job, checked rather than assumed.
    expect(MIGRATION()).toMatch(
      /WHERE NOT o\.commercial_accounts AND public\.org_has_commercial_data\(o\.id\)/,
    );
    expect(MIGRATION()).toMatch(/organization\(s\) have commercial data but the flag is off/);
  });

  it("is NOT a plan entitlement", () => {
    // The audit's suggestion. Adding it to the entitlement matrix would make
    // commercial accounts a paid tier feature — a pricing decision.
    const ent = read("src/lib/entitlements.ts");
    expect(ent).not.toMatch(/commercial_accounts/);
  });

  it("is not platform-protected either — the owner owns this one", () => {
    expect(codeOnly(MIGRATION())).not.toMatch(/tg_orgs_protect_platform_columns/);
  });
});

describe("switching it off is refused while the data is live", () => {
  it("the setter checks the permission itself", () => {
    expect(MIGRATION()).toMatch(/has_permission\(auth\.uid\(\), _org, 'manage_settings'\)/);
  });

  it("and refuses to disable while commercial data exists", () => {
    expect(MIGRATION()).toMatch(/IF NOT _enabled AND public\.org_has_commercial_data\(_org\) THEN/);
  });

  it("one definition of 'has commercial data', not two", () => {
    // The refusal and the UI's explanation of why the switch is stuck have to
    // agree, or the toggle offers something the server then rejects.
    expect(MIGRATION()).toMatch(/CREATE OR REPLACE FUNCTION public\.org_has_commercial_data/);
    expect(read("src/lib/org-features.functions.ts")).toMatch(/org_has_commercial_data/);
  });

  it("the server function goes through the RPC, not a table update", () => {
    const fns = read("src/lib/org-features.functions.ts");
    expect(fns).toMatch(/rpc\("set_org_commercial_accounts"/);
    expect(codeOnly(fns)).not.toMatch(/from\("organizations"\)[\s\S]{0,80}\.update\(/);
  });
});

describe("the gate is presentational, and says so", () => {
  const gate = () => read("src/components/CommercialOnly.tsx");

  it("renders nothing until the answer is known", () => {
    expect(gate()).toMatch(/if \(q\.isLoading\) return \{ enabled: false, known: false \}/);
  });

  it("fails OPEN on error", () => {
    // A decluttering preference must never be the reason a customer's unit
    // charges become unreachable.
    expect(gate()).toMatch(
      /if \(q\.isError \|\| !q\.data\) return \{ enabled: true, known: true \}/,
    );
  });

  it("offers no upgrade prompt, because there is nothing to sell", () => {
    // The difference from PlanGate, which does show one.
    expect(codeOnly(gate())).not.toMatch(/Upgrade|upgrade/);
  });

  it("has no server-side counterpart that throws", () => {
    // Deliberate: enforcing it server-side would turn a sidebar preference
    // into hard failures in CSV import, nightly repricing and visit booking.
    expect(codeOnly(read("src/lib/org-features.functions.ts"))).not.toMatch(
      /requireCommercial|assertCommercial/,
    );
  });
});

describe("the account-type picker is omitted from the payload, not defaulted", () => {
  const drawer = () => read("src/components/client-detail/EditClientDrawer.tsx");

  it("the field is hidden for a residential-only org", () => {
    expect(drawer()).toMatch(/\{commercialEnabled && \(/);
  });

  it("and the key is dropped from the payload when it is", () => {
    // The trap in the header. `accountType: form.accountType` riding along
    // while the input is hidden rewrites commercial clients to residential.
    expect(drawer()).toMatch(
      /\.\.\.\(commercialEnabled \? \{ accountType: form\.accountType \} : \{\}\)/,
    );
    expect(codeOnly(drawer())).not.toMatch(/^\s*accountType: form\.accountType,\s*$/m);
  });

  it("which the server already supports — it only patches what it is sent", () => {
    const clients = read("src/lib/clients.functions.ts");
    expect(clients).toMatch(
      /accountType: z\.enum\(\["residential", "commercial"\]\)\.optional\(\)/,
    );
    expect(clients).toMatch(/if \(data\.accountType !== undefined\) \{/);
  });
});

describe("the two surfaces that were unconditional", () => {
  it("the DNA workspace leaves the sidebar", () => {
    const bar = read("src/components/AppSidebar.tsx");
    expect(bar).toMatch(/url: "\/dna", icon: Dna, commercialOnly: true/);
    expect(bar).toMatch(/!it\.commercialOnly \|\| \w+\.commercialEnabled/);
  });

  it("but permission and business-type stay separate filters", () => {
    // They answer different questions and conflating them would make one of
    // them a security boundary it is not. Asserted as two separate conjuncts
    // rather than one exact string: on 2026-08-30 the filter moved out of the
    // component body into `isNavItemVisible` so the phone could share it, and
    // pinning the old one-line spelling would have failed a refactor that
    // widened the rule rather than weakened it.
    const bar = read("src/components/AppSidebar.tsx");
    expect(bar).toMatch(
      /canAccess\(role, it\.url\)\s*&&\s*\(!it\.commercialOnly \|\| \w+\.commercialEnabled\)/,
    );
  });

  it("and the phone applies it too, which it did not used to", () => {
    // MobileTabBar consumes NAV_GROUPS and filtered on `canAccess` ALONE, so
    // every flag the sidebar honoured leaked into the More sheet. DNA
    // compliance was showing to residential-only orgs on phones for as long as
    // that flag existed — under a comment promising the phone nav "can never
    // drift from (or exceed) what the sidebar offers".
    //
    // The property is that More is filtered by the SHARED helper. A bare
    // `canAccess(role, it.url)` in the filter is the regression.
    const tabs = read("src/components/MobileTabBar.tsx");
    expect(tabs).toMatch(/isNavItemVisible\(it, role, \w+\)/);
    expect(codeOnly(tabs)).not.toMatch(/items:\s*g\.items\.filter\(\(it\) => canAccess\(/);
  });

  it("a new zone defaults to residential for a residential-only org", () => {
    // It defaulted to "all", which showed a commercial pricing block — base,
    // per unit, per acre, per station — to an operator with forty driveways.
    const zd = read("src/components/ZoneDrawer.tsx");
    expect(zd).toMatch(/commercialEnabled \? "all" : "residential"/);
  });

  it("and an EXISTING zone still shows whatever it actually is", () => {
    // Only the default for a new zone changes; a commercial zone created
    // before the switch was thrown must not silently re-render as residential.
    expect(read("src/components/ZoneDrawer.tsx")).toMatch(
      /\(zone\?\.account_type as ZoneType\) \?\?/,
    );
  });
});
