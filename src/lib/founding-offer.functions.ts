import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { FoundingOffer } from "@/lib/founding-offer";

// The founding-offer banner's one question: how many of the 20 places are
// left? Answered on the server from the accounts that PAID with LAUNCH20
// (founding_accounts), while the code is live in Stripe (NP-2), cached
// briefly. The browser never computes it.
export const getFoundingOffer = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<FoundingOffer> => {
    const { readFoundingOffer } = await import("@/lib/founding-offer.server");
    return readFoundingOffer(async () => {
      const secret = process.env.STRIPE_SECRET_KEY;
      if (!secret) return null;
      const { makeStripe } = await import("@/lib/stripe-client.server");
      return makeStripe(secret);
    });
  });
