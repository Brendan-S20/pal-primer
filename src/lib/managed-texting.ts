import {
  canSubmit,
  UNDER_REVIEW_LABEL,
  UNDER_REVIEW_LINE,
  type RegistrationStatus,
} from "@/lib/texting-registration";

export { UNDER_REVIEW_LABEL, UNDER_REVIEW_LINE };

// site-r2-05: Managed texting is on sale, and it has to be operational.
//
// Owner's decision (2026-11-08): when a business adds the add-on and submits
// its details, it is UNDER REVIEW, and every screen says so in the same
// words, until a HoundStack admin activates it. No screen anywhere says
// "coming soon" about a thing a business can buy.
//
// One business's texting is in exactly one of these states. Every screen that
// talks about texting (Plan & billing, Settings → Texting, the texting
// controls on Messages, the client page, Automation, Reviews) reads it from
// `managedTextingState`, so they cannot disagree.
//
//   not_added        the add-on is not on the plan, and texting is not live
//   needs_details    the add-on is on the plan; the registration has not
//                    been submitted yet (no row, or a draft)
//   under_review     submitted. With Twilio, approved by Twilio and waiting
//                    on a HoundStack admin, or both. Not sending.
//   needs_attention  Twilio rejected it, or setup stopped; the owner has to
//                    fix and resubmit in Settings → Texting
//   active           the business's own credential row exists: sending
//
// What turns under_review into active is BOTH halves, in either order:
// Twilio's toll-free verification approved, and an admin's Activate on
// /platform/addons (`ops_approved_at`). An unverified toll-free number is
// blocked by carriers, so an admin cannot switch one on early; an approval
// without the admin waits for the admin. See `shouldActivate`.

export const MANAGED_TEXTING_SLUG = "managed-sms";

export type ManagedTextingState =
  | "not_added"
  | "needs_details"
  | "under_review"
  | "needs_attention"
  | "active";

export function managedTextingState(i: {
  /** The org holds the managed-sms add-on (org_platform_addons, active). */
  subscribed: boolean;
  /** The org's own credential row exists (orgCanTextClients). */
  live: boolean;
  registrationStatus: RegistrationStatus | null | undefined;
  registrationUpdatedAt?: string | null;
  now?: number;
}): ManagedTextingState {
  if (i.live) return "active";
  const s = i.registrationStatus ?? null;
  switch (s) {
    case "rejected":
    case "failed":
      return "needs_attention";
    case "submitting":
      // A submit that died partway is the owner's to restart, not a review.
      return canSubmit("submitting", i.registrationUpdatedAt ?? null, i.now)
        ? "needs_attention"
        : "under_review";
    case "submitted":
    case "in_review":
    case "approved":
      return "under_review";
    case "draft":
    case null:
      return i.subscribed ? "needs_details" : "not_added";
  }
}

/** Short label for a texting control's badge, or null once texting is live. */
export function textingBadgeLabel(state: ManagedTextingState | undefined): string | null {
  switch (state) {
    case "active":
      return null;
    case "under_review":
      return UNDER_REVIEW_LABEL;
    case "needs_details":
      return "Setup needed";
    case "needs_attention":
      return "Needs attention";
    case "not_added":
      return "Add-on";
    default:
      // Loading or unreadable: say nothing that might be untrue.
      return "Not set up";
  }
}

/**
 * One sentence, for a texting control that cannot send yet. Each screen adds
 * its own tail ("Until then, these messages go by email.").
 */
export function textingNotLiveSentence(state: ManagedTextingState | undefined): string {
  switch (state) {
    case "under_review":
      return `Texting your clients is ${UNDER_REVIEW_LINE.charAt(0).toLowerCase()}${UNDER_REVIEW_LINE.slice(1)}.`;
    case "needs_details":
      return "Texting your clients needs your business details. Finish setup in Settings → Texting.";
    case "needs_attention":
      return "Your texting setup needs attention in Settings → Texting.";
    case "not_added":
      return "Texting your clients is the Managed texting add-on on Plan & billing.";
    case "active":
      return "";
    default:
      return "Texting your clients is not switched on for your business yet.";
  }
}

/** Where a texting control's notice sends the person who can act on it. */
export function textingSetupLink(state: ManagedTextingState | undefined): string | null {
  if (state === "not_added") return "/settings/billing";
  if (state === "needs_details" || state === "needs_attention") return "/settings/sms";
  return null;
}

/**
 * Whether a registration may be switched on now: Twilio approved it AND an
 * admin has activated it. Both are needed, in either order.
 */
export function shouldActivate(reg: {
  status: RegistrationStatus | string | null | undefined;
  ops_approved_at?: string | null;
}): boolean {
  return reg.status === "approved" && Boolean(reg.ops_approved_at);
}

/** What the admin queue says about a registration that is under review. */
export function opsQueueNote(
  status: RegistrationStatus | string,
  opsApprovedAt: string | null | undefined,
): string {
  if (status === "approved")
    return opsApprovedAt
      ? "Carrier approved and activated, but switching on did not finish. Retry."
      : "Carrier approved. Ready to activate.";
  return opsApprovedAt
    ? "Activated. Switches on the moment the carrier approves."
    : "With the carrier. You can activate now; it switches on once the carrier approves.";
}
