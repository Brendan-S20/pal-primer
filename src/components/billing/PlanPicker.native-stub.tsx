// What `@/components/billing/PlanPicker` resolves to inside the store binary.
//
// ── WHY A MODULE SWAP RATHER THAN A RUNTIME BRANCH ────────────────────────
//
// The runtime gate is real and now sits at the component level, so nothing
// buyable renders on iOS or Android. What it does NOT do is keep the code out
// of the artifact: the plan cards, the "Choose plan" labels and the inline
// Stripe subscription checkout were all still in the shipped bundle, gated by
// a branch taken at render time.
//
// This is the difference between "a user cannot reach it" and "it is not
// there". Aliasing the module in the NATIVE_BUILD branch of vite.config.ts
// makes the second true for the SaaS purchase UI specifically.
//
// ── WHAT IT DELIBERATELY DOES NOT REMOVE ──────────────────────────────────
//
// Stripe itself stays, and must. Six other files use @stripe/react-stripe-js
// to take money from the TENANT'S OWN CUSTOMERS — StaffInvoicePayForm, the
// portal pay routes, the client Billing tab — and that is the half of
// src/lib/app-store-billing.ts that is deliberately never gated. Stripping
// Stripe from the binary would break the thing the app is for.
//
// So the claim this file supports is narrow and should be stated narrowly:
// the HoundStack SUBSCRIPTION purchase UI is absent from the native bundle.
// Payment machinery is present because customers pay through it.
import { BILLING_MANAGED_OUTSIDE_APP } from "@/lib/app-store-billing";

export type BillingInterval = "month" | "year";

function StoreBuildNote() {
  return (
    <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
      {BILLING_MANAGED_OUTSIDE_APP}
    </div>
  );
}

/** Same shape as the real export, so every call site type-checks unchanged. */
export function PlanPicker(_props: {
  currentSlug?: string | null;
  currentInterval?: BillingInterval | null;
  paid?: boolean;
  onSelect?: (planId: string, interval: BillingInterval) => void;
  selecting?: boolean;
  switchingPlanId?: string | null;
  chooseLabel?: string;
}) {
  return <StoreBuildNote />;
}

export function EmbeddedPlanCheckout(_props: {
  planId?: string;
  interval?: BillingInterval;
  returnUrl?: string;
  onCancel?: () => void;
  onSwitched?: () => void;
}) {
  return <StoreBuildNote />;
}

/**
 * Only reachable from OrgCardSetup, which is itself behind
 * `canBuySaas && data.isPaidTier` — so in a store build nothing calls this.
 * It throws rather than returning null so that a future call site which DOES
 * reach it fails loudly here instead of rendering a broken Stripe Elements
 * tree with no explanation.
 */
export function getPlatformStripe(_pk: string): never {
  throw new Error(
    "getPlatformStripe is not available in a store build. The HoundStack " +
      "subscription purchase UI is excluded from the native bundle. See " +
      "src/components/billing/PlanPicker.native-stub.tsx",
  );
}
