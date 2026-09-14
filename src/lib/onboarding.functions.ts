import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type OnboardingStep = {
  id: "verify_email" | "zones" | "staff" | "dump_site" | "clients" | "route" | "billing";
  label: string;
  description: string;
  done: boolean;
  to: string;
  cta: string;
  /** A second way to finish the same step, when the step has two honest
   *  answers and the description already says so. Rendered beside the primary
   *  control, never instead of it. `gate` is a route path checked against the
   *  viewer's role with the same `canAccess` the sidebar and CreateSheet use,
   *  because this runs on the server and cannot see the role itself. */
  alt?: { to: string; cta: string; gate: string };
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

    const [zones, staff, dumps, clients, visits, org] = await Promise.all([
      supabase
        .from("zones")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId),
      supabase
        .from("staff")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId),
      // Geocoded, not merely present: an address nobody could place is a row
      // the router cannot use. staff_end_point skips facilities with no
      // coordinates, so counting them here would tick a box that changes
      // nothing about a route.
      supabase
        .from("waste_disposal_facilities")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("active", true)
        .not("latitude", "is", null),
      supabase
        .from("clients")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId),
      supabase
        .from("visits")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .not("assigned_staff_id", "is", null),
      supabase
        .from("organizations")
        .select("stripe_customer_id, onboarding_dismissed_at, email_verified_at")
        .eq("id", orgId)
        .single(),
    ]);

    const dismissed = Boolean(org.data?.onboarding_dismissed_at);

    const steps: OnboardingStep[] = [
      {
        // Frictionless signup: verification is a to-do, not a wall — but
        // Stripe Express stays locked until it's done.
        id: "verify_email",
        label: "Verify your email",
        description:
          "Confirm your address to unlock payments (Stripe). Everything else works meanwhile.",
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
        // ── WHY THIS IS A SETUP STEP AND NOT A SETTING ──────────────────
        //
        // Routes are planned from where a technician STARTS and, since
        // 20260831150000, to where their day ENDS. When a technician has no end
        // address the planner falls back to the organization's dump site, and
        // when there is no dump site either it plans an open path -- every stop
        // ordered as though the van evaporates on arrival at the last one.
        //
        // Measured on the demo day: an end-blind order leaves 116.3 minutes of
        // driving to the dump still to do, against 22.3 for one that knows
        // where the dump is. Same stops, same technicians, 45% less driving
        // over the whole day.
        //
        // It is a checklist step because of what production looked like on
        // 2026-08-31: six organizations, one disposal facility between them,
        // and that one not geocoded. Nobody is withholding this address; they
        // do not know the router wants it. A field sitting unused in Settings
        // is how that stays true, so it is asked for here, where the other
        // things a route needs are asked for.
        id: "dump_site",
        label: "Add your dump site",
        description:
          "Where the crew unloads at the end of the day. Routes end there, so adding it usually cuts a lot of driving.",
        done: (dumps.count ?? 0) > 0,
        to: "/waste-log",
        cta: "Add dump site",
      },
      {
        // ── WHY THIS STEP HAS TWO BUTTONS ───────────────────────────────
        //
        // The description has promised the CSV since this checklist was
        // written; the step offered one control and it went to the
        // one-at-a-time form. An operator arriving with a book of business --
        // the only kind of signup that already has customers to bring -- read
        // "or upload a CSV to seed many at once" and was handed a form to fill
        // in once per client.
        //
        // /imports is in the sidebar and the command palette, so this is not
        // a missing feature; it is a missing door on the one screen that
        // names it. The step it belongs to is also the step that matters:
        // every organization in production that never added a client never
        // came back either.
        //
        // Gated because /imports is owner+office_manager while /clients/new
        // also admits dispatchers -- an ungated second button would offer a
        // dispatcher a route that redirects them straight back.
        id: "clients",
        label: "Add or import clients",
        description: "Bring in at least one client (or upload a CSV to seed many at once).",
        done: (clients.count ?? 0) > 0,
        to: "/clients/new",
        cta: "Add client",
        alt: { to: "/imports", cta: "Import CSV", gate: "/imports" },
      },
      {
        id: "route",
        label: "Assign your first route",
        description:
          "Assign visits to a tech from the Today board so the field crew has work loaded.",
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
