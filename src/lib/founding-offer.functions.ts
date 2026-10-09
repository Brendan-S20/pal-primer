import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { FoundingOffer } from "@/lib/founding-offer";

// The founding-offer banner's one question: how many of the 20 places are
// left? Answered from the LAUNCH20 promotion code in Stripe (NP-2), cached
// briefly on the server. The browser never computes it.
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
