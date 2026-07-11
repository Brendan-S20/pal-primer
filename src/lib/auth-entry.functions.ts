import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Identifier-first sign-in: given an email, tell the auth screen whether to
// show the password step (account exists) or hand off to the Get-started
// walkthrough (new). Runs server-side with the service role — the underlying
// RPC is not executable by anon/authenticated, so the browser can't probe it
// except through this fn.
export const checkEmailAccount = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ email: z.string().trim().email().max(255) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: exists, error } = await (supabaseAdmin as any).rpc("email_has_account", {
      _email: data.email,
    });
    if (error) throw new Error("Couldn't check that email — try again.");
    return { exists: !!exists };
  });
