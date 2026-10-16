import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  // Through the shared gate, so a person whose access is turned off is
  // refused here as everywhere else (20261009180000).
  return (await resolveCaller(supabase, userId)).orgId;
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
    // The walk emails (#410), read on their own so a database without
    // 20261015220000 still loads this page; they are shown only to a
    // business that runs dog walking.
    // The missed medication email (#411, 20261016130000) rides the same read,
    // and is shown only to a pet sitting business.
    const { data: walk } = await (context.supabase as any)
      .from("organizations")
      .select(
        "service_lines, notify_email_walk_not_done, notify_email_walk_schedule_change, notify_email_walk_canceled, notify_email_missed_meds, notify_email_stay_confirmed, notify_email_stay_ending",
      )
      .eq("id", orgId)
      .maybeSingle();
    const { serviceLinesOrDefault } = await import("@/lib/service-lines");
    const lines = serviceLinesOrDefault(walk?.service_lines);
    return {
      ...data,
      runs_dog_walking: lines.includes("dog_walking"),
      runs_pet_sitting: lines.includes("pet_sitting"),
      notify_email_stay_confirmed: walk?.notify_email_stay_confirmed !== false,
      notify_email_stay_ending: walk?.notify_email_stay_ending !== false,
      notify_email_walk_not_done: walk?.notify_email_walk_not_done !== false,
      notify_email_walk_schedule_change: walk?.notify_email_walk_schedule_change !== false,
      notify_email_walk_canceled: walk?.notify_email_walk_canceled !== false,
      notify_email_missed_meds: walk?.notify_email_missed_meds !== false,
    };
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
  // The walk emails (#410). Optional, so a page that did not draw them
  // leaves them as they are.
  notify_email_stay_confirmed: z.boolean().optional(),
  notify_email_stay_ending: z.boolean().optional(),
  notify_email_walk_not_done: z.boolean().optional(),
  notify_email_walk_schedule_change: z.boolean().optional(),
  notify_email_walk_canceled: z.boolean().optional(),
  // The missed medication email (#411). Optional, the same way.
  notify_email_missed_meds: z.boolean().optional(),
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
