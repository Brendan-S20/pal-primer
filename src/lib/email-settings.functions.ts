import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

export const getEmailSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("organizations")
      .select(
        "notify_email_invoice_sent, notify_email_payment_received, notify_email_visit_completed, notify_email_weather_reschedule, notify_email_welcome, notify_email_overdue, notify_email_visit_reminder, notify_email_on_my_way, notify_email_quote_sent, quote_followup_days",
      )
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    return data;
  });

const schema = z.object({
  notify_email_invoice_sent: z.boolean(),
  notify_email_payment_received: z.boolean(),
  notify_email_visit_completed: z.boolean(),
  notify_email_weather_reschedule: z.boolean(),
  notify_email_welcome: z.boolean(),
  notify_email_overdue: z.boolean(),
  notify_email_visit_reminder: z.boolean(),
  notify_email_on_my_way: z.boolean(),
  notify_email_quote_sent: z.boolean(),
  // Days after a quote is sent that the nightly job emails one reminder.
  quote_followup_days: z.number().int().min(0).max(30),
});

export const updateEmailSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => schema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("organizations")
      .update(data)
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
