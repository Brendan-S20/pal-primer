import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createSubSchema, createSubscriptionPlans } from "@/lib/subscriptions.functions";
import { walkWindowsProblem } from "@/lib/subscription-form";

export function parseWalkPlans(input: unknown) {
  const { windows, ...base } = z
    .object({
      serviceId: z.string().uuid(),
      windows: z.array(z.object({ earliestTime: z.string(), latestTime: z.string() })),
    })
    .passthrough()
    .parse(input);
  const problem = walkWindowsProblem(windows);
  if (problem) throw new Error(problem);
  return windows.map((window) => createSubSchema.parse({ ...base, ...window }));
}

export const createWalkPlans = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseWalkPlans)
  .handler(async ({ data, context }) =>
    createSubscriptionPlans(context.supabase, context.userId, data, true),
  );
