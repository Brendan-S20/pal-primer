import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { describePlatformFee } from "@/lib/platform-fee";

/**
 * HoundStack's own cut, as a sentence, fetched rather than bundled.
 *
 * ── WHY THIS IS A SERVER FUNCTION AND NOT AN IMPORT ───────────────────────
 *
 * `describePlatformFee()` derives its sentence from PLATFORM_FEE_BPS. Importing
 * it from a component puts that constant in the CLIENT bundle, and a JavaScript
 * chunk is a static asset: it is served to anyone who asks, signed in or not.
 *
 * Today that is invisible, because the rate is 0, the function returns null on
 * its first line, and the bundler folds the whole thing away -- the built client
 * output contains no trace of it. That is the VALUE hiding it, not the
 * architecture. Setting the constant to 50 and rebuilding puts the rate and the
 * threshold straight into a chunk:
 *
 *     function oe(){return`a ${50/100}% HoundStack fee on payments over $${J/100}`}
 *
 * So the fee would become publicly readable on the day it went live, by the act
 * of turning it on, with nothing in the diff to suggest it.
 *
 * ── WHAT THIS DOES AND DOES NOT BUY ───────────────────────────────────────
 *
 * It keeps the number off the anonymous surface. It does NOT make it a secret:
 * the fee is a term tenants pay and every surface naming what a payment costs
 * still has to disclose it, which is the whole point of describePlatformFee()
 * returning null rather than "0%". Anyone who signs up sees it. This raises the
 * bar from "anybody who can fetch a chunk" to "anybody with an account", which
 * is the difference worth having and not more than that.
 *
 * ── NO PERMISSION GATE, DELIBERATELY ──────────────────────────────────────
 *
 * Authentication only. Its sibling in processing-fee.functions.ts requires
 * `manage_org_billing`, because reading THAT is reading one organization's own
 * configuration. This returns a published pricing term identical for every
 * tenant, and gating it would mean a technician looking at the payments page
 * sees a paragraph with a clause missing rather than the price the business
 * actually pays.
 */
export const getPlatformFeeSentence = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ sentence: describePlatformFee() }));
