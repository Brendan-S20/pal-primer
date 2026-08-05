import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type OnboardingStep = {
  id: "verify_email" | "zones" | "staff" | "clients" | "route" | "billing";
  label: string;
  description: string;
  done: boolean;
  to: string;
  cta: string;
};

export const getOnboardingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!role) return { steps: [] as OnboardingStep[], completed: 0, total: 0, dismissed: true };

    const orgId = role.organization_id;

    const [zones, staff, clients, visits, org] = await Promise.all([
      supabase.from("zones").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
      supabase.from("staff").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
      supabase.from("clients").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
      supabase.from("visits").select("id", { count: "exact", head: true }).eq("organization_id", orgId).not("assigned_staff_id", "is", null),
      supabase.from("organizations").select("stripe_customer_id, onboarding_dismissed_at, email_verified_at").eq("id", orgId).single(),
    ]);

    const dismissed = Boolean(org.data?.onboarding_dismissed_at);

    const steps: OnboardingStep[] = [
      {
        // Frictionless signup: verification is a to-do, not a wall — but
        // Stripe Express stays locked until it's done.
        id: "verify_email",
        label: "Verify your email",
        description: "Confirm your address to unlock payments (Stripe). Everything else works meanwhile.",
        done: Boolean((org.data as any)?.email_verified_at),
        to: "/payments",
        cta: "Verify",
      },
      {
        id: "zones",
        label: "Create service zones",
        description: "Group properties by neighborhood or postal prefix so routes stay tight.",
        done: (zones.count ?? 0) > 0,
        to: "/zones",
        cta: "Add a zone",
      },
      {
        id: "staff",
        label: "Add your first tech",
        description: "Invite at least one tech so visits can be assigned and dispatched.",
        done: (staff.count ?? 0) > 0,
        // /settings redirects to /settings/preferences, so this button — the
        // most-clicked control on an empty dashboard — delivered the owner to a
        // timezone and branding form instead of the invite panel.
        to: "/settings/users",
        cta: "Invite tech",
      },
      {
        id: "clients",
        label: "Add or import clients",
        description: "Bring in at least one client (or upload a CSV to seed many at once).",
        done: (clients.count ?? 0) > 0,
        to: "/clients/new",
        cta: "Add client",
      },
      {
        id: "route",
        label: "Assign your first route",
        description: "Assign visits to a tech from the Today board so the field crew has work loaded.",
        done: (visits.count ?? 0) > 0,
        to: "/routes",
        cta: "Open Today",
      },
      {
        id: "billing",
        label: "Connect Stripe (optional)",
        description: "Bring your own Stripe key to collect payments and enable autopay.",
        done: Boolean(org.data?.stripe_customer_id),
        to: "/settings/billing",
        cta: "Set up billing",
      },
    ];

    const completed = steps.filter((s) => s.done).length;
    return { steps, completed, total: steps.length, dismissed };
  });

export const dismissOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!role) return { ok: false };
    const { error } = await supabase
      .from("organizations")
      .update({ onboarding_dismissed_at: new Date().toISOString() })
      .eq("id", role.organization_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
