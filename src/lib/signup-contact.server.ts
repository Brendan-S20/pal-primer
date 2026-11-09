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

/** The service-role client, typed only as far as this file uses it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js builder, as elsewhere in src/lib
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

export async function applySignupPhone(
  admin: AdminClient,
  args: { orgId: string; userId: string; phone: string },
): Promise<void> {
  const phone = args.phone.trim();
  if (!phone) return;

  // The business's contact phone: Settings and setup step 1 read
  // organizations.contact_phone through getOrgBranding.
  const { error: orgError } = await admin
    .from("organizations")
    .update({ contact_phone: phone })
    .eq("id", args.orgId)
    .is("contact_phone", null);
  if (orgError) throw new Error(`Your phone number was not saved: ${orgError.message}`);

  // The owner's own phone: Profile reads staff.phone through getMyProfile.
  const { error: staffError } = await admin
    .from("staff")
    .update({ phone })
    .eq("organization_id", args.orgId)
    .eq("user_id", args.userId)
    .is("phone", null);
  if (staffError) throw new Error(`Your phone number was not saved: ${staffError.message}`);
}
