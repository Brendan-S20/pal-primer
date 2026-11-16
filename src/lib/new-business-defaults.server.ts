// Writes a new business's completion-photo default by segment (#915). The
// rule itself, and the spec it comes from, is in ./new-business-defaults.ts.
//
// ── WHY THIS IS APP CODE AND NOT A MIGRATION ───────────────────────────────
//
// The spec forbids changing an existing business's setting, and changing the
// column default would make a scooper who signs up tomorrow start with it
// off. So the default stays `true` in the database and the app moves a
// business that is still being set up, and only that one, at the two places
// a new business says what it runs: bootstrapOrganization (the line from
// /sign-up?service=) and step 1 of /setup (the services ticked).
//
// ── WHAT COUNTS AS "STILL BEING SET UP" ───────────────────────────────────
//
// Server-side, not the browser's word for it:
//   - setup step 1 is not done: the business has no address yet (the step's
//     own "done", onboarding.functions.ts), which step 1 writes AFTER the
//     lines, so it is still empty when this runs;
//   - it has no visits at all: a business that has ever scheduled work is
//     live, whatever its address says;
//   - the setting is still what the previous lines' default was: an owner who
//     already turned it on or off in Settings made a choice, and a later tick
//     in setup does not undo it.
// Any of those not holding, or not readable, and nothing is written.

import { newBusinessRequiresCompletionPhoto } from "@/lib/new-business-defaults";
import type { AuthedContext } from "@/lib/server-fn-context";

type Db = AuthedContext["supabase"];

export type PhotoDefaultOutcome =
  | { written: true; required: boolean }
  | { written: false; why: "same-default" | "set-up" | "has-visits" | "owner-chose" | "unread" };

/** Moves a business that is still being set up to the completion-photo
 *  default for the lines it now runs. `before` is what it ran until now (for
 *  a business bootstrap just built, the column default {pet_waste}). Throws
 *  only when the write itself fails, through updateOwnOrg. */
export async function followNewBusinessPhotoDefault(
  supabase: Db,
  orgId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<PhotoDefaultOutcome> {
  const was = newBusinessRequiresCompletionPhoto(before);
  const next = newBusinessRequiresCompletionPhoto(after);
  if (was === next) return { written: false, why: "same-default" };

  const { data: org, error } = await supabase
    .from("organizations")
    .select("require_completion_photo, contact_address")
    .eq("id", orgId)
    .maybeSingle();
  if (error || !org) return { written: false, why: "unread" };
  if (typeof org.contact_address === "string" && org.contact_address.trim())
    return { written: false, why: "set-up" };
  if (org.require_completion_photo !== was) return { written: false, why: "owner-chose" };

  const { data: visits, error: vErr } = await supabase
    .from("visits")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1);
  if (vErr || !Array.isArray(visits)) return { written: false, why: "unread" };
  if (visits.length > 0) return { written: false, why: "has-visits" };

  const { updateOwnOrg } = await import("@/lib/org-write.server");
  await updateOwnOrg(supabase, orgId, { require_completion_photo: next });
  return { written: true, required: next };
}
