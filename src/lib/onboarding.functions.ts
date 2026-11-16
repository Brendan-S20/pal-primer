import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuthedContext } from "@/lib/server-fn-context";
import {
  OFFERED_SERVICE_LINES,
  dayEndQuestion,
  runsPetWaste,
  serviceLinesOrDefault,
} from "@/lib/service-lines";
import { walksPricedForSetup } from "@/lib/setup-walk-prices";

export type OnboardingStepId = "business" | "zones" | "clients" | "staff" | "dump_site" | "payouts";

export type OnboardingStep = {
  id: OnboardingStepId;
  label: string;
  description: string;
  done: boolean;
  to: string;
  cta: string;
  /** The route whose role list decides who can do this step, checked with the
   *  same `canAccess` the sidebar uses. This runs on the server and cannot see
   *  the role, so the checklist and the setup guide filter on it. Payouts is
   *  the owner's alone (manage_org_billing); an office manager setting the
   *  business up should not be handed a step that refuses them. */
  gate: string;
  /** A second way to finish the same step, when the step has two honest
   *  answers and the description already says so. Rendered beside the primary
   *  control, never instead of it. `gate` is a route path checked against the
   *  viewer's role with the same `canAccess` the sidebar and CreateSheet use,
   *  because this runs on the server and cannot see the role itself. */
  alt?: { to: string; cta: string; gate: string };
  /** Only on the price step, and only for a business that runs more than one
   *  service line: one part per thing to price, in the order /setup draws
   *  them. The step is done when every part is. A one-line business never
   *  has parts; its step is about its own line (#639). */
  parts?: PricePart[];
};

export type PricePartId = "area" | "walks" | "stays" | "grooms" | "lessons";

export type PricePart = {
  id: PricePartId;
  label: string;
  description: string;
  done: boolean;
  /** Where the part is finished outside setup. The area and walks parts are
   *  also finished inline on /setup (#769); the rest are on Settings,
   *  Services. */
  to: "/zones" | "/settings/services";
  cta: string;
};

/** How the multi-line step's description names each part: by what a client
 *  buys, not by the tool that prices it. "Pet waste zones and walks" read to
 *  a walker as a scooping product with walks bolted on (#768). */
const PART_NOUN: Record<PricePartId, (petWaste: boolean) => string> = {
  area: (petWaste) => (petWaste ? "pet waste visits" : "your service area"),
  walks: () => "walks",
  stays: () => "stays",
  grooms: () => "grooms",
  lessons: () => "lessons",
};

/** The checklist and the setup guide are ONE list. The guide at /setup walks
 *  these ids in this order and reads `done` from this function; it has no
 *  step list or completion test of its own. */
export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = [
  "business",
  "zones",
  "clients",
  "staff",
  "dump_site",
  "payouts",
];

export const getOnboardingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadOnboardingStatus(context));

/** getOnboardingStatus's answer, also asked by getShellContext. */
export const loadOnboardingStatus = createServerOnlyFn(async (context: AuthedContext) => {
  const { supabase, userId } = context;

  const { data: role } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!role) return { steps: [] as OnboardingStep[], completed: 0, total: 0, dismissed: true };

  const orgId = role.organization_id;

  const [zones, fieldStaff, invites, dumps, staffEnds, clients, org, lines] = await Promise.all([
    supabase
      .from("zones")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    // Somebody who RUNS ROUTES, not merely a staff row. The old test was
    // `staff > 0`, which bootstrapOrganization satisfies at signup by
    // writing the owner's own row -- so "Add your first tech" ticked itself
    // for every business before the owner had read it, and an owner who
    // drives the truck was never asked to say so. That matters: visits are
    // handed to ACTIVE FIELD TECHNICIANS (20260930010000), and an owner's
    // row is not one until somebody ticks "Runs routes". An owner-operator
    // who skipped that got a schedule in which no visit was anybody's.
    supabase
      .from("staff")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("active", true)
      .eq("is_field_tech", true),
    // An invitation sent is the owner's half done; the tech accepting it is
    // theirs, and the step should not stay open waiting on somebody else.
    (supabase as any)
      .from("org_invites")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("status", "pending"),
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
    // A field tech with their own pinned end point answers "where does the
    // day end" as well as a dump site does: the planner prefers it.
    supabase
      .from("staff")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("active", true)
      .not("end_latitude", "is", null),
    supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    (supabase as any)
      .from("organizations")
      .select(
        "contact_address, stripe_connect_charges_enabled, onboarding_dismissed_at, email_verified_at",
      )
      .eq("id", orgId)
      .single(),
    // Its own read, so a database the service-lines migration has not
    // reached fails this alone and falls open to pet waste.
    supabase.from("organizations").select("service_lines").eq("id", orgId).maybeSingle(),
  ]);
  const orgLines = serviceLinesOrDefault(lines.data?.service_lines);
  const petWaste = runsPetWaste(orgLines);
  const sitting = orgLines.includes("pet_sitting");

  // A training business prices lessons as a package and scores a skill
  // list, and signup seeds the package inactive at $0 (training-package-
  // seed.server.ts). Nothing would ever be sold until somebody prices and
  // turns it on, so the price step asks for that too. Read only for a
  // business that runs training.
  const runsTraining = orgLines.includes("training");
  const [pricedPackages, skills] = runsTraining
    ? await Promise.all([
        supabase
          .from("service_packages")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("active", true)
          .gt("price_cents", 0),
        supabase
          .from("training_skills")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("active", true),
      ])
    : [{ count: 0 }, { count: 0 }];
  // #861: the pet-waste price is answered by a zone OR by the standard price,
  // which every quote falls back to when no zone has a price. An owner who
  // saved $20 read "Next: Your service area and price" for the rest of setup,
  // because only a zone row counted. Since #860 the standard price is the
  // default pet-waste service's own price (Settings → Services), the one
  // setting every reader uses (standard-price.ts), so that is what counts.
  const { loadPetWasteStandard } = await import("@/lib/standard-price");
  const standard = petWaste ? await loadPetWasteStandard(supabase, orgId) : null;
  const standardPriced = (standard?.base_price_cents ?? 0) > 0;
  const areaDone = (zones.count ?? 0) > 0 || standardPriced;
  const training = runsTraining
    ? { done: (pricedPackages.count ?? 0) > 0 && (skills.count ?? 0) > 0 }
    : undefined;

  const grooming = orgLines.includes("mobile_grooming");
  const groomingSetup = grooming
    ? await supabase
        .from("organizations")
        .select("groom_setup_reviewed_at")
        .eq("id", orgId)
        .maybeSingle()
    : null;
  const o = (org.data ?? {}) as {
    contact_address?: string | null;
    stripe_connect_charges_enabled?: boolean | null;
    onboarding_dismissed_at?: string | null;
    email_verified_at?: string | null;
  };
  const dismissed = Boolean(o.onboarding_dismissed_at);

  // ── WHERE THE DAY ENDS, FOR A BUSINESS WITH NO DUMP ─────────────────
  //
  // The dump site matters because the planner ends a day THERE
  // (staff_end_point), and a day planned with no end is ordered as though
  // the van evaporates at the last stop. A dog walker or a groomer has no
  // dump, but their day still ends somewhere -- home, the shop, the kennel
  // -- and the planner reads that from each person's own end point, which
  // already answers this step for a pet-waste business too. So the step
  // keeps its id, its place and its reason (/setup walks the ids), and
  // asks the question that business can answer. A business that does not
  // run pet waste is never asked about a dump site.
  //
  // #768: a business that scoops AND walks (or sits, or grooms) used to get
  // the dump-site wording whole, because `petWaste` was true. Its walkers do
  // not unload anywhere. It now reads the neutral question, and the dump site
  // is offered on the form as the pet-waste half (dayEndQuestion "both").
  const dayEnd = dayEndQuestion(orgLines);
  const endOfDay =
    dayEnd === "dump_site"
      ? {
          label: "Where the day ends",
          description:
            "Where the crew unloads at the end of the day. Routes end there, so adding it usually cuts a lot of driving.",
          cta: "Add dump site",
        }
      : dayEnd === "both"
        ? {
            label: "Where does your day end?",
            description:
              "Set where each person finishes the day: home, the shop, wherever they park. Routes end there instead of at the last stop, which usually cuts a lot of driving. Pet waste routes can end at a dump site instead.",
            cta: "Set day's end",
          }
        : {
            label: "Where does your day end?",
            description:
              "Set where each person finishes the day: home, the shop, wherever they park. Routes end there instead of at the last stop, which usually cuts a lot of driving.",
            cta: "Set day's end",
          };

  // ── WHAT A FIRST SESSION HAS TO LEAVE BEHIND ────────────────────────
  //
  // Six things, and at the end of them the business WORKS: a client is
  // quoted from a price, the visit has somebody to run it, the route knows
  // where it starts and ends, and the money has somewhere to land. Each is
  // a thing the product cannot do for them, and nothing on this list is
  // arrangement for its own sake.
  //
  // The order is the order the product needs them in, which is also the
  // order the guide at /setup walks:
  //
  //   business  the address is where every route STARTS when a tech has no
  //             start of their own (staff_start_point falls back to it), and
  //             the time zone is what "today" means. Thirty seconds.
  //   zones     the PRICE. A client's plan is quoted from the zone their
  //             address falls in (getInternalQuote); with no zone the
  //             new-client wizard has no price to offer and asks for one by
  //             hand, client after client. So the service area and its rate
  //             come before the first client, not after.
  //   clients   the step that makes every other screen do something. Third,
  //             and the earliest it can usefully be: see the note on zones.
  //             It used to come FIFTH behind zones, staff and the dump site,
  //             and the one real signup who met the dump site fourth never
  //             signed in again. It is now ahead of everything that is not
  //             needed to price it.
  //   staff     who runs the route. Visits go to active field technicians,
  //             and an owner-operator is not one until they say so.
  //   dump_site where the day ENDS. Asked once there is a route to improve:
  //             an end-blind route leaves 116 minutes of driving to the dump
  //             still to do against 22 for one that knows where it is.
  //   payouts   where the money lands. Last, skippable, and honest that it
  //             needs a verified email first.
  //
  // Verifying the email and assigning a first route were steps of their
  // own. The first is folded into payouts, the only thing it gates; the
  // second is not a setup step at all once a field tech exists, because
  // auto-assign hands the visits out.
  const steps: OnboardingStep[] = [
    {
      id: "business",
      label: "Your business details",
      description:
        "Your business address and time zone. Routes start from the address, and the time zone decides what counts as today.",
      done: Boolean(o.contact_address && o.contact_address.trim()),
      to: "/setup",
      cta: "Add details",
      gate: "/settings/business",
    },
    {
      id: "zones",
      label: "Your service area and price",
      // The pet-waste step: a zone's per-visit price is what a scooping plan
      // is quoted from. Every other line is restated below (R2-47).
      description:
        "Where you work and what you charge per visit. New clients in the area are quoted this price.",
      done: areaDone && (!grooming || !!groomingSetup?.data?.groom_setup_reviewed_at),
      to: "/setup",
      cta: "Set your price",
      gate: "/zones",
      ...(grooming
        ? {
            alt: {
              to: "/settings/services",
              cta: "Review grooming setup",
              gate: "/settings/services",
            },
          }
        : {}),
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
      // Gated because /imports is owner+office_manager while /clients/new
      // also admits dispatchers -- an ungated second button would offer a
      // dispatcher a route that redirects them straight back.
      id: "clients",
      label: "Add or import clients",
      description: "Bring in at least one client (or upload a CSV to seed many at once).",
      done: (clients.count ?? 0) > 0,
      to: "/clients/new",
      cta: "Add client",
      gate: "/clients",
      alt: { to: "/imports", cta: "Import CSV", gate: "/imports" },
    },
    {
      id: "staff",
      label: "Who runs the route",
      description:
        "Say if you run the route yourself, or invite a tech. Visits are only handed to people who run routes.",
      done: (fieldStaff.count ?? 0) > 0 || (invites.count ?? 0) > 0,
      // /settings redirects to /settings/preferences, so this button — the
      // most-clicked control on an empty dashboard — once delivered the
      // owner to a timezone and branding form instead of the invite panel.
      to: "/setup",
      cta: "Choose",
      gate: "/settings/users",
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
      // It is a checklist step because of what production looked like on
      // 2026-08-31: six organizations, one disposal facility between them,
      // and that one not geocoded. Nobody is withholding this address; they
      // do not know the router wants it.
      //
      // The wording is endOfDay's, above: a business without pet waste is
      // asked where its day ends, not for a dump site. Done either way when
      // the planner has an end to plan to.
      //
      // Gated on Users & roles, where each person's end point lives, rather
      // than on the waste log, a page a business without pet waste is never
      // shown. The same people pass both (owner, office manager), so a
      // pet-waste business is offered the step exactly as before.
      id: "dump_site",
      label: endOfDay.label,
      description: endOfDay.description,
      done: (dumps.count ?? 0) > 0 || (staffEnds.count ?? 0) > 0,
      to: "/setup",
      cta: endOfDay.cta,
      gate: "/settings/users",
    },
    {
      // Was "Connect Stripe (optional)", done when `stripe_customer_id` was
      // set -- which is HoundStack's OWN billing customer for the org, set
      // when the owner pays for their plan, and nothing to do with whether
      // the business can take a card from a client. So the box ticked for
      // anyone who subscribed and stayed empty for anyone who connected
      // payouts. Done now means what the step says: Stripe will pay out.
      id: "payouts",
      label: "Get paid",
      description:
        "Connect Stripe so clients can pay by card and the money lands in your bank. Verify your email first. You can do this later.",
      done: Boolean(o.stripe_connect_charges_enabled),
      to: "/payments",
      cta: "Set up payouts",
      gate: "/payments",
    },
  ];

  // ── ONE PRICE STEP FOR EVERY LINE THE BUSINESS RUNS ─────────────────
  //
  // Each line is priced in a different place: a pet-waste plan from a
  // zone's per-visit price, a walk or a stay from its own service, a groom
  // from the size grid, a lesson package from service_packages. Until #639
  // the step below was overwritten once per line, in order, so the last
  // line to run won: a business with all five read "Price your sitting
  // services" and was never asked about walks, grooms, lessons or its
  // pet-waste area. The guide stays at six steps
  // (tests/every-setup-step-has-somewhere-to-go.test.ts), so a business
  // with more than one line gets ONE step that names each line, with a
  // part per line, done when every part is. A business with one line gets
  // the step for that line alone, exactly as before.
  const walks = orgLines.includes("dog_walking")
    ? (
        await supabase
          .from("services")
          .select("base_price_cents, default_duration_min")
          .eq("organization_id", orgId)
          .eq("service_line", "dog_walking")
          .eq("active", true)
      ).data
    : null;
  const stays = sitting
    ? (
        await supabase
          .from("services")
          .select("created_at, updated_at")
          .eq("organization_id", orgId)
          .eq("service_line", "pet_sitting")
          .eq("active", true)
      ).data
    : null;
  // Signup seeds the walks with blank prices. Done means the 30-minute AND
  // the 60-minute walk have one (#769): "some walk has a price" ticked the
  // step for one price on one walk and left the rest "No price yet".
  const walksDone = walksPricedForSetup(walks ?? []);
  // Signup seeds the stays with starter prices; done means one was saved.
  const staysDone = (stays ?? []).some((s) => s.updated_at !== s.created_at);
  const groomDone = !!groomingSetup?.data?.groom_setup_reviewed_at;

  const parts: PricePart[] = [];
  // The service area and its per-visit price are asked of a pet-waste
  // business only: its plans are quoted from it. A lesson is priced by its
  // package (R2-47): "How far you drive / Price per visit / Each extra dog"
  // asked a trainer for a number no lesson reads, and the step stayed open
  // after it was saved. A trainer's area is still on Zones.
  if (petWaste) {
    parts.push({
      id: "area",
      label: "Pet waste service area",
      description:
        "Where you work and what you charge per visit. New pet waste clients in the area are quoted this price.",
      done: areaDone,
      to: "/zones",
      cta: "Set area price",
    });
  }
  if (orgLines.includes("dog_walking")) {
    parts.push({
      id: "walks",
      label: "Walks",
      description: "What a 30-minute walk and a 60-minute walk cost.",
      done: walksDone,
      to: "/settings/services",
      cta: "Price walks",
    });
  }
  if (sitting) {
    parts.push({
      id: "stays",
      label: "Sitting",
      description:
        "Drop-in, Overnight stay and House sit prices, holiday dates and the deposit refund window.",
      done: staysDone,
      to: "/settings/services",
      cta: "Review sitting prices",
    });
  }
  if (grooming) {
    parts.push({
      id: "grooms",
      label: "Grooming",
      description: "The size grid, required vaccines, and setup, cleanup and travel minutes.",
      done: groomDone,
      to: "/settings/services",
      cta: "Review grooming setup",
    });
  }
  if (training) {
    parts.push({
      id: "lessons",
      label: "Training",
      description: "Price your lesson package, turn it on, and add the skills a trainer scores.",
      done: training.done,
      to: "/settings/services",
      cta: "Price lessons",
    });
  }
  const linesRun = OFFERED_SERVICE_LINES.filter((l) => orgLines.includes(l));
  const zonesStep = steps.find((step) => step.id === "zones")!;

  if (linesRun.length > 1) {
    const names = parts.map((p) => PART_NOUN[p.id](petWaste));
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
        : names[0];
    // `alt` belongs to the one-line step; the parts carry it.
    delete zonesStep.alt;
    Object.assign(zonesStep, {
      label: "Price your services",
      description: `You run ${linesRun.length} services. Set a price for each: ${list}. New clients are quoted these prices.`,
      done: parts.every((p) => p.done),
      to: "/setup",
      cta: "Set your prices",
      gate: parts.some((p) => p.id === "area") ? "/zones" : "/settings/services",
      parts,
    });
  } else if (grooming) {
    Object.assign(zonesStep, {
      label: "Review your grooming prices, vaccines and buffer",
      description:
        "Review the starter size grid, required vaccines and setup, cleanup and travel minutes in Settings, Services.",
      done: groomDone,
      cta: "Review grooming setup",
      gate: "/settings/services",
    });
  } else if (orgLines.includes("dog_walking")) {
    // A walking business prices each walk; a zone's per-visit price is what a
    // pet-waste plan is quoted from, so asking a walker for one sends them to
    // a number no walk ever reads. Asked HERE, on /setup (#769): the step was
    // a link to Settings, Services, and an owner who did not follow it
    // finished setup with every walk unpriced.
    Object.assign(zonesStep, {
      label: "Price your walks",
      description:
        "Set what a 30-minute walk and a 60-minute walk cost, and a drop-in if you offer one. New clients are quoted these prices. Your service area is on Zones.",
      done: walksDone,
      to: "/setup",
      cta: "Price walks",
      gate: "/settings/services",
    });
  } else if (sitting) {
    Object.assign(zonesStep, {
      label: "Price your sitting services",
      description:
        "Review Drop-in, Overnight stay and House sit prices, holiday dates and the deposit refund window before booking your first stay.",
      done: staysDone,
      to: "/settings/services",
      cta: "Review sitting services",
      gate: "/settings/services",
    });
  } else if (training) {
    // R2-47: the step a trainer reads is the lesson price, done when the
    // package is priced and a skill exists, the same test the multi-line
    // part uses. It used to be the pet-waste area form, done only when the
    // area AND the lessons were, so a saved area left it open with no word
    // about why.
    Object.assign(zonesStep, {
      label: "Price your lessons",
      description:
        "Price your lesson package, turn it on, and add the skills a trainer scores. New clients are quoted these prices. Your service area is on Zones.",
      done: training.done,
      to: "/settings/services",
      cta: "Price lessons",
      gate: "/settings/services",
    });
  }

  const completed = steps.filter((s) => s.done).length;
  return {
    steps,
    completed,
    total: steps.length,
    dismissed,
    emailVerified: Boolean(o.email_verified_at),
  };
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
