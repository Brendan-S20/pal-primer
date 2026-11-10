// The number typed at signup, put where the screens that show it read it.
//
// ── WHAT WAS WRONG (Detroit Doo Disposal onboarding, 2026-11-09) ───────────
//
// Get-started asks for a mobile number on its last step. That number went to
// exactly one place on every path: the auth user's `user_metadata.phone`,
// which no screen reads. It reached a column only when the texting box was
// also ticked, and then only `staff.phone` (via recordSmsConsent). So:
//
//   - Settings > Client portal branding > Contact phone was blank;
//   - setup step 1, "Business phone", was blank, though they had just typed it;
//   - without the box ticked, Profile > Phone was blank too.
//
// "Some things when onboarding didn't save or reflect in settings."
//
// Now bootstrapOrganization hands the number to this, for both columns, and
// only where nothing is stored yet: a re-run (a retried signup, an OAuth
// round-trip back to /auth) must never overwrite a number somebody has since
// corrected in Settings. A failed write throws, so the signup screen says so
// and can try again, rather than a success over a value that never landed.
//
// #766 added the other half: the address they signed up with is the business's
// contact email until they say otherwise. `bootstrap_organization` never set
// organizations.contact_email, so Settings showed it blank, and since BUILD-5
// that column is the reply-to on customer email -- replies went to noreply@.

import { handoffPhone } from "@/lib/phone-handoff";

/** The service-role client, typed only as far as this file uses it. */
export type AdminClient = { from: (table: string) => any };

/** The sign-up address as the business's contact email, where none is set. */
export async function applySignupEmail(
  admin: AdminClient,
  args: { orgId: string; email: string | null | undefined },
): Promise<void> {
  const email = args.email?.trim().toLowerCase();
  if (!email) return;
  const { error } = await admin
    .from("organizations")
    .update({ contact_email: email })
    .eq("id", args.orgId)
    .is("contact_email", null);
  if (error) throw new Error(`Your contact email was not saved: ${error.message}`);
}

/**
 * Fill one phone column, only where it is blank. Blank is NULL or "" (see
 * isBlankPhone): two updates, because a NULL-only fill left a field that had
 * been emptied empty forever. `scope` narrows the row(s).
 */
async function fillBlankPhone(
  admin: AdminClient,
  table: "organizations" | "staff",
  column: "contact_phone" | "phone",
  phone: string,
  scope: Record<string, string>,
): Promise<{ message: string } | null> {
  for (const blank of [null, ""] as const) {
    let q = admin.from(table).update({ [column]: phone });
    for (const [k, v] of Object.entries(scope)) q = q.eq(k, v);
    const { error } = await (blank === null ? q.is(column, null) : q.eq(column, blank));
    if (error) return error;
  }
  return null;
}

export async function applySignupPhone(
  admin: AdminClient,
  args: { orgId: string; userId: string; phone: string },
): Promise<void> {
  // A fragment (`555-`) is not handed on: stored, it would prefill setup with
  // the truncated value #787 reported, and say it came from the owner.
  const phone = handoffPhone(args.phone);
  if (!phone) return;

  // The business's contact phone: setup step 1 and Settings > Client portal
  // read organizations.contact_phone through getOrgBranding.
  const orgError = await fillBlankPhone(admin, "organizations", "contact_phone", phone, {
    id: args.orgId,
  });
  if (orgError) throw new Error(`Your phone number was not saved: ${orgError.message}`);

  // The owner's own phone: Profile reads staff.phone through getMyProfile.
  const staffError = await fillBlankPhone(admin, "staff", "phone", phone, {
    organization_id: args.orgId,
    user_id: args.userId,
  });
  if (staffError) throw new Error(`Your phone number was not saved: ${staffError.message}`);
}

/**
 * The office phone, saved by the OWNER (setup step 1, Settings > Client
 * portal), also becomes the owner's Profile phone when that is still blank
 * (#787: portal `555-010-0199`, Profile blank). Only the owner's own row and
 * only a blank one: an office manager typing the office line has not given
 * their own number, and a number already on Profile is the owner's choice.
 */
export async function fillOwnerProfilePhoneFromOffice(
  admin: AdminClient,
  args: { orgId: string; userId: string; phone: string | null | undefined },
): Promise<void> {
  const phone = handoffPhone(args.phone);
  if (!phone) return;
  const error = await fillBlankPhone(admin, "staff", "phone", phone, {
    organization_id: args.orgId,
    user_id: args.userId,
    role: "owner",
  });
  if (error) {
    throw new Error(
      `The office phone was saved, but it could not be copied to your Profile phone: ${error.message}`,
    );
  }
}
