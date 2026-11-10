// Reviews in HoundStack's directory (#630): the server functions.
//
// Visitors: getDirectoryReviews reads APPROVED reviews through
// directory_public_reviews with the publishable key, so the database decides
// what is public and this file cannot widen it.
//
// The moderator: listDirectoryReviewQueue / moderateDirectoryReview. Platform
// admins only (Brendan is the only moderator for now). Asked here before any
// RPC, and asked again inside each function in the database, on the
// CALLER's own client: nothing here moderates with the service role.
//
// Submitting a review is not here yet: the invite a client reviews from is
// the next change, and its wording is Brendan's.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import { isDirectorySlug } from "@/lib/directory";
import {
  REVIEW_REJECTION_REASONS,
  REVIEW_STATUSES,
  toPublicReviews,
  type QueuedDirectoryReview,
} from "@/lib/directory-reviews";

export const ONLY_A_MODERATOR = "Only a HoundStack moderator can do that.";

type Rpc = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** Platform admins only. Exported for the test that pins it. */
export async function assertModerator(supabase: unknown, userId: string): Promise<void> {
  const { data, error } = await (supabase as Rpc).rpc("is_platform_admin", { _user_id: userId });
  if (error || data !== true) throw new Error(ONLY_A_MODERATOR);
}

export const getDirectoryReviews = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z.object({ slug: z.string().trim().toLowerCase().refine(isDirectorySlug) }).parse(d),
  )
  .handler(async ({ data }) => {
    const db = createClient(resolveSupabaseUrl(), process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    }) as unknown as Rpc;
    const { data: rows, error } = await db.rpc("directory_public_reviews", { _slug: data.slug });
    if (error) throw new Error("Reviews are unavailable right now.");
    return { reviews: toPublicReviews(rows) };
  });

export const listDirectoryReviewQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ status: z.enum(REVIEW_STATUSES).default("pending") }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertModerator(context.supabase, context.userId);
    const { data: rows, error } = await (context.supabase as unknown as Rpc).rpc(
      "directory_review_queue",
      { _status: data.status },
    );
    if (error) throw new Error(error.message);
    return { reviews: (rows ?? []) as QueuedDirectoryReview[] };
  });

export const moderateDirectoryReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        approve: z.boolean(),
        reason: z.enum(REVIEW_REJECTION_REASONS).nullable().optional(),
      })
      .refine((v) => v.approve || !!v.reason, {
        message: "Pick the rule this review breaks.",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertModerator(context.supabase, context.userId);
    const { error } = await (context.supabase as unknown as Rpc).rpc("moderate_directory_review", {
      _id: data.id,
      _approve: data.approve,
      _reason: data.approve ? null : data.reason,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
