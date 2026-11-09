// site-r2-05 (owner, 2026-11-08): Managed texting is for sale and must be
// operational. A business that adds the add-on and submits its details is
// "Under review, usually ready shortly" on every screen until a HoundStack
// admin activates it, and nothing calls it "coming soon".
//
// What this pins:
//   1. the state machine: not_added -> needs_details -> under_review -> active,
//      with needs_attention for a rejection or a dead submit
//   2. activation needs BOTH the carrier's approval and the admin's, either order
//   3. the words: one label, one sentence, shared by every screen, and
//      never "coming soon"
//   4. the billing card says Under review, not Active, until texting is live
//   5. the server: submit needs the add-on; the admin action is platform-admin
//      only; the texting screens read the state, not a hardcoded line
//   6. the migration: the gate column, the poll, the catalog copy

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  managedTextingState,
  opsQueueNote,
  shouldActivate,
  textingBadgeLabel,
  textingNotLiveSentence,
  textingSetupLink,
  UNDER_REVIEW_LABEL,
  UNDER_REVIEW_LINE,
  type ManagedTextingState,
} from "@/lib/managed-texting";
import { addonCardState, managedTextingCard } from "@/lib/addon-launch";
import { describeStatus, STALE_SUBMIT_MS } from "@/lib/texting-registration";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ALL: ManagedTextingState[] = [
  "not_added",
  "needs_details",
  "under_review",
  "needs_attention",
  "active",
];

describe("1. signup -> under review -> active", () => {
  const state = (
    subscribed: boolean,
    registrationStatus: Parameters<typeof managedTextingState>[0]["registrationStatus"],
    live = false,
    registrationUpdatedAt: string | null = new Date(NOW).toISOString(),
  ) => managedTextingState({ subscribed, live, registrationStatus, registrationUpdatedAt, now: NOW });

  it("walks the whole path a buyer takes", () => {
    // Has not bought it.
    expect(state(false, null)).toBe("not_added");
    // Bought it; nothing filed yet, then a saved draft.
    expect(state(true, null)).toBe("needs_details");
    expect(state(true, "draft")).toBe("needs_details");
    // Submitted: under review the whole way through Twilio and the admin.
    expect(state(true, "submitting")).toBe("under_review");
    expect(state(true, "submitted")).toBe("under_review");
    expect(state(true, "in_review")).toBe("under_review");
    expect(state(true, "approved")).toBe("under_review");
    // Switched on (the credential row exists).
    expect(state(true, "approved", true)).toBe("active");
  });

  it("a rejection or a stopped setup is the owner's to fix, not a review", () => {
    expect(state(true, "rejected")).toBe("needs_attention");
    expect(state(true, "failed")).toBe("needs_attention");
    const deadSubmit = new Date(NOW - STALE_SUBMIT_MS - 1).toISOString();
    expect(state(true, "submitting", false, deadSubmit)).toBe("needs_attention");
  });

  it("live always wins: a business that is sending is active whatever else is true", () => {
    for (const s of [null, "draft", "submitted", "approved", "rejected"] as const) {
      expect(state(false, s, true)).toBe("active");
    }
  });
});

describe("2. activation needs the carrier AND the admin, in either order", () => {
  it("is a truth table", () => {
    expect(shouldActivate({ status: "approved", ops_approved_at: "2026-11-09T12:00:00Z" })).toBe(true);
    expect(shouldActivate({ status: "approved", ops_approved_at: null })).toBe(false);
    expect(shouldActivate({ status: "approved" })).toBe(false);
    for (const status of ["draft", "submitting", "submitted", "in_review", "rejected", "failed"]) {
      expect(shouldActivate({ status, ops_approved_at: "2026-11-09T12:00:00Z" }), status).toBe(false);
    }
  });

  it("the admin queue says which half is missing", () => {
    expect(opsQueueNote("in_review", null)).toMatch(/You can activate now/);
    expect(opsQueueNote("in_review", "x")).toMatch(/moment the carrier approves/);
    expect(opsQueueNote("approved", null)).toMatch(/Ready to activate/);
    expect(opsQueueNote("approved", "x")).toMatch(/Retry/);
  });
});

describe("3. one set of words, and never coming soon", () => {
  it("says exactly what the owner decided", () => {
    expect(UNDER_REVIEW_LABEL).toBe("Under review");
    expect(UNDER_REVIEW_LINE).toBe("Under review, usually ready shortly");
    expect(textingBadgeLabel("under_review")).toBe("Under review");
    expect(textingNotLiveSentence("under_review")).toBe(
      "Texting your clients is under review, usually ready shortly.",
    );
  });

  it("no state, and no loading state, is described as coming soon", () => {
    for (const s of [...ALL, undefined]) {
      expect(textingBadgeLabel(s) ?? "", String(s)).not.toMatch(/coming soon/i);
      expect(textingNotLiveSentence(s), String(s)).not.toMatch(/coming soon/i);
    }
    expect(textingBadgeLabel("active")).toBeNull();
    expect(textingNotLiveSentence("active")).toBe("");
  });

  it("points each state at the page that moves it on", () => {
    expect(textingSetupLink("not_added")).toBe("/settings/billing");
    expect(textingSetupLink("needs_details")).toBe("/settings/sms");
    expect(textingSetupLink("needs_attention")).toBe("/settings/sms");
    expect(textingSetupLink("under_review")).toBeNull();
    expect(textingNotLiveSentence("not_added")).toMatch(/Plan & billing/);
    expect(textingNotLiveSentence("needs_details")).toMatch(/Settings → Texting/);
  });

  it("Settings → Texting says Under review from submit until it is live", () => {
    for (const status of ["submitted", "in_review", "approved"] as const) {
      const d = describeStatus({ status }, undefined, false);
      expect(d.title).toBe(UNDER_REVIEW_LABEL);
      expect(d.detail.startsWith(`${UNDER_REVIEW_LINE}.`)).toBe(true);
    }
    expect(describeStatus({ status: "approved" }, undefined, true).title).toBe("Approved and live");
  });
});

describe("4. the billing card", () => {
  const card = (subscribed: boolean, textingState: ManagedTextingState | null) => ({
    slug: "managed-sms",
    subscribed,
    status: "active",
    billing_interval: "month",
    textingState,
  });

  it("is for sale, not coming soon, when not on the plan", () => {
    expect(addonCardState(card(false, "not_added"))).toBe("for_sale");
    expect(managedTextingCard(card(false, "not_added"))).toBeNull();
  });

  it("reads Under review, not Active, once bought and submitted", () => {
    expect(managedTextingCard(card(true, "under_review"))).toEqual({
      label: "Under review",
      line: "Texting your clients is under review, usually ready shortly.",
    });
    expect(managedTextingCard(card(true, "needs_details"))?.label).toBe("Setup needed");
    expect(managedTextingCard(card(true, "needs_attention"))?.label).toBe("Needs attention");
  });

  it("reads Active only once texting is live", () => {
    expect(managedTextingCard(card(true, "active"))).toBeNull();
    expect(addonCardState(card(true, "active"))).toBe("active");
  });

  it("leaves every other add-on alone", () => {
    expect(
      managedTextingCard({ slug: "priority-support", subscribed: true, textingState: "under_review" }),
    ).toBeNull();
  });

  it("the billing page draws it", () => {
    const page = read("src/routes/_authenticated/settings.billing.tsx");
    expect(page).toContain("const texting = managedTextingCard(a);");
    expect(page).toContain("<ComingSoonBadge>{texting.label}</ComingSoonBadge>");
    expect(page).toContain("{texting.line}");
    const fn = read("src/lib/platform-addons.functions.ts");
    expect(fn).toMatch(/textingState: a\.slug === MANAGED_TEXTING_SLUG \? textingState : null/);
  });
});

describe("5. the server and the screens", () => {
  it("a submit without the add-on is refused before anything goes to Twilio", () => {
    const src = read("src/lib/texting-registration.functions.ts");
    const fn = src.slice(src.indexOf("export const submitTextingRegistration"));
    const gate = fn.indexOf("orgHoldsManagedTexting(orgId)");
    const twilio = fn.indexOf("@/lib/twilio-provisioning.server");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(twilio);
    expect(fn).toContain("throw new Error(MANAGED_TEXTING_REQUIRED)");
  });

  it("the admin action is platform-admin only and goes through opsActivateTexting", () => {
    const src = read("src/lib/texting-ops.functions.ts");
    for (const name of ["listTextingReviews", "activateTextingForOrg"]) {
      const fn = src.slice(src.indexOf(`export const ${name}`));
      const body = fn.slice(0, fn.indexOf("});") + 3);
      expect(body, name).toContain("await assertPlatformAdmin(context.supabase, context.userId);");
    }
    expect(src).toContain("opsActivateTexting(data.organizationId, context.userId)");
    expect(src).not.toMatch(/_sid,|auth_token|\bein\b/);
    expect(read("src/routes/platform.addons.tsx")).toContain("<TextingReviewQueue />");
  });

  it("the availability answer carries the state every texting control reads", () => {
    const src = read("src/lib/client-texting.functions.ts");
    expect(src).toContain('return { available: state === "active", state };');
  });

  // clients.index.tsx is left to #709, which has it open; its one
  // "(coming soon)" is listed in the PR body as a follow-up.
  const SCREENS = [
    "src/components/client-detail/EditClientDrawer.tsx",
    "src/components/client-detail/CommunicationTab.tsx",
    "src/components/client-detail/SummaryTab.tsx",
    "src/components/client-detail/comms-panels.tsx",
    "src/components/client-detail/TextingConsentPanel.tsx",
    "src/routes/_authenticated/messages.tsx",
    "src/routes/_authenticated/messages.index.tsx",
    "src/routes/_authenticated/messages.$clientId.tsx",
    "src/routes/_authenticated/settings.reviews.tsx",
    "src/routes/_authenticated/settings.automation.tsx",
    "src/routes/_authenticated/settings.sms.tsx",
  ];
  it("no texting screen tells a business that texting is coming soon", () => {
    for (const f of SCREENS) {
      const shown = read(f)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      expect(shown, f).not.toMatch(/coming soon/i);
      expect(shown, f).not.toContain("<ComingSoonBadge");
    }
  });

  it("the help article says Under review, not coming soon", async () => {
    const { HELP_ARTICLES } = await import("@/lib/help-content");
    const a = HELP_ARTICLES.find((x) => x.slug === "texting-setup")!;
    expect(a.title).not.toMatch(/coming soon/i);
    const text = a.body.join("\n");
    expect(text).not.toMatch(/coming soon/i);
    expect(text).toContain("Under review, usually ready shortly");
    expect(text).toContain("Managed texting");
  });
});

describe("6. the migration (included, not applied)", () => {
  const sql = read(
    "supabase/migrations/20261109150000_managed-texting-is-under-review-until-ops-activates.sql",
  );

  it("adds the admin's activation and backfills every business that is already live", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ops_approved_at timestamptz/);
    expect(sql).toMatch(/SET ops_approved_at = activated_at\s+WHERE activated_at IS NOT NULL/);
  });

  it("stops the poll from counting an approval no admin has activated", () => {
    expect(sql).toMatch(
      /r\.status = 'approved'\s+AND r\.ops_approved_at IS NOT NULL\s+AND NOT EXISTS/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.texting_status_due\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("keeps it on sale and carries the decided words, with no coming soon", () => {
    const update = sql.slice(sql.indexOf("UPDATE public.platform_addons"));
    const copy = [...update.slice(0, update.indexOf("WHERE slug")).matchAll(/'((?:[^']|'')*)'/g)]
      .map((m) => m[1])
      .filter((t) => t.length > 20)
      .join("");
    expect(update).toMatch(/SET status = 'active',\s+is_active = true/);
    expect(copy).toContain("Under review, usually ready shortly");
    expect(copy).not.toMatch(/coming soon/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'managed texting is on sale but its copy says coming soon'/);
  });

  it("never asserts operations state: a missing catalog row warns", () => {
    expect(sql).toMatch(/RAISE WARNING 'no managed-sms add-on on this database/);
  });
});
