import { COAT_TYPES } from "@/lib/groom";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { buildClientNamePatch } from "@/lib/client-name";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  // Through the shared gate, so a person whose access is turned off is
  // refused here as everywhere else (20261009180000).
  return (await resolveCaller(supabase, userId)).orgId;
}

/**
 * Every client of a business with the counts and balances the list shows.
 *
 * Read ORG-WIDE, never by id list (#617). This used to read the clients, then
 * fetch their properties, services and open invoices with
 * `.in("client_id", ids)`: every client id in one GET query string. At about
 * a thousand clients that URL was refused ("URI too long"), the read failed,
 * and every screen built on it went empty, including the New invoice and
 * One-off visit pickers. Filtering the same tables by organization_id selects
 * the same rows with a URL of fixed length. All four reads are paged, because
 * PostgREST stops at a thousand rows without saying so, and they run at once.
 */
async function loadClientRoster(supabase: any, orgId: string) {
  const { fetchAllPagesConcurrently } = await import("@/lib/supabase-paging.server");
  // All aggregates must succeed before the roster can report counts or balances.
  const [clients, props, subs, invs] = await Promise.all([
    fetchAllPagesConcurrently<any>((a, b) =>
      supabase
        .from("clients")
        .select(
          "id, display_name, account_type, primary_email, primary_phone, active, created_at, credit_balance_cents, churn_score, comms_paused, tags, import_external_id",
        )
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(a, b),
    ),
    // Inactive dogs and archived properties are excluded HERE because
    // the client detail page excludes them there — PropertiesTab
    // counts `d.active !== false`, and the dog-mismatch warning on a
    // service compares the billed count against that number. Marking a
    // dog inactive is the documented alternative to deleting one, so
    // without this filter the list keeps showing a count that no other
    // surface agrees with: the same records, two answers.
    fetchAllPagesConcurrently<any>((a, b) =>
      supabase
        .from("properties")
        .select("id, client_id, street, created_at, dogs(id, active, species)")
        .eq("organization_id", orgId)
        .is("archived_at", null)
        .order("created_at", { ascending: true })
        .order("id")
        .range(a, b),
    ),
    // ends_on is needed to tell an ended service from a running one —
    // see the isServiceEnded note below.
    fetchAllPagesConcurrently<any>((a, b) =>
      supabase
        .from("subscriptions")
        .select(
          "client_id, property_id, status, frequency, ends_on, account_type, dog_count, stay_id",
        )
        .eq("organization_id", orgId)
        .order("id")
        .range(a, b),
    ),
    fetchAllPagesConcurrently<any>((a, b) =>
      supabase
        .from("invoices")
        .select("client_id, total_cents, credit_applied_cents, amount_paid_cents, status")
        .eq("organization_id", orgId)
        .eq("status", "open")
        .order("id")
        .range(a, b),
    ),
  ]);
  const propsRes = { data: props };
  const subsRes = { data: subs };
  const invRes = { data: invs };
  const activeSubsByClient = new Map<string, number>();
  // Service-frequency label for the list view (punch list #15): distinct
  // active-subscription frequencies per client.
  const freqsByClient = new Map<string, string[]>();
  // "Active" has to mean the same thing here as it does on the client's own
  // Services tab, and it did not. This counted `status === 'active'` alone,
  // while the tab uses isServiceEnded — status canceled OR ends_on passed.
  // endSubscription only writes ends_on and leaves status 'active', so every
  // service a tenant has ever ENDED still counted here as one they are
  // running, and its frequency stayed in the client's chips.
  //
  // Latent until now: no row was in that state. Booking a one-off visit puts
  // one there every time, because a one_time service is created with
  // ends_on = the visit date — so from the day after each booking the client
  // would read as having an extra active service, permanently, and be
  // labelled "one_time" for a job finished months ago.
  const { isServiceEnded } = await import("@/lib/subscription-form");
  const todayISO = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
  for (const s of subsRes.data ?? []) {
    if (!isServiceEnded(s as any, todayISO)) {
      activeSubsByClient.set(s.client_id, (activeSubsByClient.get(s.client_id) ?? 0) + 1);
      const f = (s as any).frequency as string | null;
      if (f) {
        const list = freqsByClient.get(s.client_id) ?? [];
        if (!list.includes(f)) list.push(f);
        freqsByClient.set(s.client_id, list);
      }
    }
  }
  // Dogs live on properties (dogs.property_id), so aggregate through the
  // property → client relationship instead of a non-existent dogs.client_id.
  // Counted by propertyDogTally, the rule the client record, a quote and My
  // Day use too (#429): the dog records when a property has any, otherwise
  // what its plan bills for. Before that this counted records alone, so a
  // client imported with a two-dog plan and no dog names read "0 dogs" here
  // and "2 dogs" on the quote and the tech's stop.
  //
  // Inactive dogs and archived properties are excluded because the client
  // detail page excludes them: PropertiesTab counts activeDogCount, and the
  // dog-mismatch warning compares the billed count against that number.
  const { activeDogCount, clientDogTally, propertyDogTally } = await import("@/lib/pets");
  const billedByProperty = new Map<string, number[]>();
  for (const s of (subsRes.data ?? []) as any[]) {
    // A stay's plan counts the pets on the stay, not dogs (#411).
    if (s.account_type !== "residential" || s.stay_id || !s.property_id) continue;
    if (isServiceEnded(s, todayISO)) continue;
    const list = billedByProperty.get(s.property_id) ?? [];
    list.push(s.dog_count);
    billedByProperty.set(s.property_id, list);
  }
  const talliesByClient = new Map<string, ReturnType<typeof propertyDogTally>[]>();
  // The oldest property's street, so two clients with the same name can be
  // told apart in a picker.
  const streetByClient = new Map<string, string>();
  for (const p of (propsRes.data ?? []) as Array<{
    id: string;
    client_id: string;
    street: string | null;
    dogs: Array<{ active?: boolean | null; species?: string | null }> | null;
  }>) {
    if (!p.client_id) continue;
    const tally = propertyDogTally(
      activeDogCount(Array.isArray(p.dogs) ? p.dogs : []),
      billedByProperty.get(p.id) ?? [],
    );
    talliesByClient.set(p.client_id, [...(talliesByClient.get(p.client_id) ?? []), tally]);
    if (p.street && !streetByClient.has(p.client_id)) streetByClient.set(p.client_id, p.street);
  }

  // Same AR math as Dashboard "AR Open" and Reports "Outstanding" (finding #7).
  const { outstandingByClient } = await import("@/lib/ar");
  const balanceByClient = outstandingByClient((invRes.data ?? []) as any[]);

  return clients.map((c: any) => ({
      ...c,
      dog_count: clientDogTally(talliesByClient.get(c.id) ?? []).count,
      /** "plan" when the count is what a plan bills for, not dog records. */
      dog_count_source: clientDogTally(talliesByClient.get(c.id) ?? []).source,
      street: streetByClient.get(c.id) ?? null,
      active_subscription_count: activeSubsByClient.get(c.id) ?? 0,
      frequencies: freqsByClient.get(c.id) ?? [],
      outstanding_cents: balanceByClient.get(c.id) ?? 0,
    }));
}

export const listClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // Full roster with contact info and balances — not for field techs.
    const { orgId } = await requirePermission(supabase, userId, "view_client_directory");
    return { clients: await loadClientRoster(supabase, orgId) };
  });

const clientsPageSchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["all", "active", "inactive", "outstanding", "at_risk", "no_plan"]).optional(),
  type: z.enum(["all", "residential", "commercial"]).optional(),
  tag: z.string().max(60).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  /** Every matching row, for Export CSV. */
  all: z.boolean().optional(),
});

/**
 * One page of /clients, filtered and searched on the server (#617).
 *
 * The browser used to receive the whole roster and filter it itself. It now
 * sends its filters (a few short strings, so the GET stays small) and gets
 * back one page, how many rows matched, the tiles over the list, and the tags
 * in use for the tag filter. The tiles always describe the whole book.
 */
export const listClientsPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => clientsPageSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "view_client_directory");
    const { filterRoster, rosterStats, rosterTags, CLIENTS_PAGE_SIZE } = await import(
      "@/lib/client-roster"
    );
    const roster = await loadClientRoster(supabase, orgId);
    const matched = filterRoster(roster, data);
    const offset = data.offset ?? 0;
    const limit = data.limit ?? CLIENTS_PAGE_SIZE;
    return {
      rows: data.all ? matched : matched.slice(offset, offset + limit),
      matched: matched.length,
      offset: data.all ? 0 : offset,
      stats: rosterStats(roster),
      tags: rosterTags(roster),
    };
  });

const searchClientsSchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  /** Leave archived clients out (the pickers); Cmd-K finds them too. */
  activeOnly: z.boolean().optional(),
});

/**
 * Find clients by what a person types: the pickers and Cmd-K (#617).
 *
 * The pickers used to load the whole roster into a <select>, which is the
 * read that failed at a thousand clients and left them empty; Cmd-K matched
 * display names only, accent-sensitively. This narrows in SQL with a short
 * filter (one word, never an id list), then applies the same rule the
 * /clients search does (lib/client-search.ts): name, company, email, tags,
 * street and import id without regard to case or accents, a phone number by
 * its digits. An empty query returns the first clients by name, so a picker
 * opened with nothing typed is never blank.
 */
export const searchClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => searchClientsSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "view_client_directory");
    const { clientMatchesQuery, clientSearchOrFilter, streetSearchPattern } = await import(
      "@/lib/client-search"
    );
    const q = (data.q ?? "").trim();
    const limit = data.limit ?? 20;
    const cols =
      "id, display_name, company, first_name, last_name, primary_email, primary_phone, import_external_id, tags, active";
    const scoped = (select: string) => {
      let b = supabase.from("clients").select(select).eq("organization_id", orgId);
      if (data.activeOnly) b = b.eq("active", true);
      return b;
    };
    const firstStreet = (props: any): string | null => {
      const list = (Array.isArray(props) ? props : props ? [props] : []).filter(
        (p: any) => !p.archived_at && p.street,
      );
      list.sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
      return list[0]?.street ?? null;
    };
    const shape = (c: any) => ({
      id: c.id as string,
      display_name: (c.display_name as string | null) ?? "",
      primary_email: (c.primary_email as string | null) ?? null,
      primary_phone: (c.primary_phone as string | null) ?? null,
      active: c.active !== false,
      street: firstStreet(c.properties),
    });

    if (!q) {
      const { data: rows, error } = await scoped(
        `${cols}, properties(street, archived_at, created_at)`,
      )
        .order("display_name")
        .limit(limit);
      if (error) throw new Error(error.message);
      return { clients: (rows ?? []).map(shape) };
    }

    const or = clientSearchOrFilter(q);
    const street = streetSearchPattern(q);
    // Wider than `limit`: the SQL filter is a superset, and clientMatchesQuery
    // has the last word.
    const wide = Math.max(limit * 4, 60);
    const [byClient, byStreet] = await Promise.all([
      or
        ? scoped(`${cols}, properties(street, archived_at, created_at)`)
            .or(or)
            .order("display_name")
            .limit(wide)
        : Promise.resolve({ data: [], error: null }),
      street
        ? scoped(`${cols}, properties!inner(street, archived_at, created_at)`)
            .ilike("properties.street", street)
            .is("properties.archived_at", null)
            .order("display_name")
            .limit(wide)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (byClient.error) throw new Error(byClient.error.message);
    if (byStreet.error) throw new Error(byStreet.error.message);

    const byId = new Map<string, any>();
    for (const c of [...(byClient.data ?? []), ...(byStreet.data ?? [])] as any[]) {
      const seen = byId.get(c.id);
      const streets = (Array.isArray(c.properties) ? c.properties : [])
        .filter((p: any) => !p.archived_at)
        .map((p: any) => p.street);
      if (seen) {
        seen.streets.push(...streets);
        if (!seen.properties?.length) seen.properties = c.properties;
      } else byId.set(c.id, { ...c, streets });
    }
    const hits = [...byId.values()]
      .filter((c) => clientMatchesQuery(c, q))
      .sort((a, b) => String(a.display_name ?? "").localeCompare(String(b.display_name ?? "")))
      .slice(0, limit);
    return { clients: hits.map(shape) };
  });

const createClientSchema = z.object({
  displayName: z.string().min(1).max(200),
  accountType: z.enum(["residential", "commercial"]),
  primaryEmail: z.string().email().or(z.literal("")).optional(),
  primaryPhone: z.string().max(40).optional(),
});

export const createClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => createClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: row, error } = await supabase
      .from("clients")
      .insert({
        organization_id: orgId,
        display_name: data.displayName,
        account_type: data.accountType,
        primary_email: data.primaryEmail || null,
        primary_phone: data.primaryPhone || null,
      })
      .select("id, portal_token")
      .single();
    if (error) throw new Error(error.message);

    {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId: row.id as string,
        actorUserId: userId,
        kind: "client.created",
        summary: `Created client ${data.displayName}`,
      });
    }

    // Fire welcome email (best-effort; never block client creation)
    if (data.primaryEmail) {
      try {
        const { buildPortalLink } = await import("@/lib/portal-links.server");
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: orgId,
          clientId: row.id as string,
          templateName: "welcome",
          notifyKey: "notify_email_welcome",
          idempotencyKey: `welcome-${row.id}`,
          templateData: {
            portalUrl: await buildPortalLink(orgId, row.portal_token as string | null),
          },
        });
      } catch (e) {
        console.error("welcome email failed", e);
      }
    }
    return { id: row.id as string };
  });

const getClientSchema = z.object({ clientId: z.string().uuid() });

export const getClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Contact info, notes, and the portal token — not for field techs.
    await requirePermission(supabase, context.userId, "view_client_directory");
    const { data: client, error } = await supabase
      .from("clients")
      .select(
        "id, display_name, first_name, last_name, company, account_type, primary_email, primary_phone, active, created_at, notes, portal_token, sms_opt_out, email_opt_out, comms_paused, sms_consent_at, sms_consent_phone, sms_consent_text, sms_consent_source, referral_code, referred_by_client_id, referral_applied_at, review_asked_at, review_submitted_at, tags, preferred_contact, referral_source, churn_score, autopay_paused, billing_frequency, dna_compliance_enabled, tax_exempt, emergency_contact_name, emergency_contact_phone, emergency_contact_may_approve_vet, vet_treatment_limit_cents",
      )
      .eq("id", data.clientId)
      .single();
    if (error) throw new Error(error.message);
    return { client };
  });

export const getFieldClientInfo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const caller = await resolveCaller(supabase, userId);
    const canReadDirectory = caller.role !== "tech";
    // The lines of the tech's own visits to this client (#560): the page's
    // hazard words follow the work the tech does here, not the business.
    // Null for the office, which reads the business's lines.
    let ownVisitLines: (string | null)[] | null = null;

    if (!canReadDirectory) {
      const { data: staff, error: staffErr } = await supabase
        .from("staff")
        .select("id, organization_id, active")
        .eq("user_id", userId)
        .eq("organization_id", caller.orgId)
        .maybeSingle();
      if (staffErr) throw new Error(staffErr.message);
      if (!staff?.id || staff.active === false) throw new Error("Not authorized");

      const { data: assigned, error: visitErr } = await supabase
        .from("visits")
        .select("id, services(service_line)")
        .eq("client_id", data.clientId)
        .eq("organization_id", caller.orgId)
        .eq("assigned_staff_id", staff.id)
        .neq("status", "canceled")
        .limit(50);
      if (visitErr) throw new Error(visitErr.message);
      if (!assigned?.length) throw new Error("Not authorized");
      ownVisitLines = assigned.map((v: { services?: unknown }) => {
        const s = (Array.isArray(v.services) ? v.services[0] : v.services) as
          | { service_line?: string | null }
          | null
          | undefined;
        return s?.service_line ?? null;
      });
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: client, error: clientErr } = await supabaseAdmin
      .from("clients")
      .select("id, organization_id, display_name, account_type, primary_phone, notes")
      .eq("id", data.clientId)
      .eq("organization_id", caller.orgId)
      .maybeSingle();
    if (clientErr) throw new Error(clientErr.message);
    if (!client) throw new Error("Client not found");

    const { data: properties, error: propErr } = await supabaseAdmin
      .from("properties")
      .select(
        "id, label, street, city, region, postal_code, parking_notes, access_notes, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes, archived_at",
      )
      .eq("client_id", data.clientId)
      .eq("organization_id", caller.orgId)
      .is("archived_at", null)
      .order("street");
    if (propErr) throw new Error(propErr.message);
    const { accessFor, readPropertyAccess } = await import("@/lib/property-access");
    const access = await readPropertyAccess(
      supabase,
      (properties ?? []).map((p) => p.id),
    );

    const propertyIds = (properties ?? []).map((p) => p.id);
    const { data: dogs, error: dogErr } = propertyIds.length
      ? await supabaseAdmin
          .from("dogs")
          .select(
            "id, property_id, name, breed, weight_class, coat_type, weight_lb, temperament, notes, active, species, species_note",
          )
          .in("property_id", propertyIds)
          .order("name")
      : { data: [], error: null };
    if (dogErr) throw new Error(dogErr.message);

    const { loadVaccineSettings } = await import("@/lib/vaccines.server");
    const vaccineSettings = await loadVaccineSettings(supabase, caller.orgId);
    const vaccineStatuses: Record<string, import("@/lib/vaccines").VaccineState> = {};
    if (vaccineSettings.enabled && dogs?.length) {
      // Use the caller for pet and record reads so property access still applies.
      const { data: visibleDogs, error: visibleError } = await supabase
        .from("dogs")
        .select("id")
        .in(
          "id",
          dogs.map((d) => d.id),
        )
        .eq("organization_id", caller.orgId);
      if (visibleError) throw new Error(visibleError.message);
      const ids = (visibleDogs ?? []).map((d) => d.id);
      if (ids.length) {
        const { data: records, error } = await supabase
          .from("pet_vaccinations")
          .select("dog_id, vaccine, expires_on, source, verified_at, rejected_at")
          .in("dog_id", ids)
          .eq("organization_id", caller.orgId);
        if (error) throw new Error(error.message);
        const { vaccineStatus } = await import("@/lib/vaccines");
        for (const id of ids)
          vaccineStatuses[id] = vaccineStatus(
            (records ?? []).filter((r) => r.dog_id === id),
            vaccineSettings.required,
            vaccineSettings.today,
          ).overall;
      }
    }
    return {
      client,
      properties: (properties ?? []).map((p) => ({ ...p, ...accessFor(access, p.id) })),
      dogs: (dogs ?? [])
        .filter((d: any) => d.active !== false)
        .map((d) => (vaccineStatuses[d.id] ? { ...d, vaccine_status: vaccineStatuses[d.id] } : d)),
      ownVisitLines,
    };
  });

/** Edit-client drawer (client detail refactor): contact, status, tags,
 * preferences. Billing addresses live in Stripe, never here. */
export const updateClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        displayName: z.string().min(1).max(200).optional(),
        firstName: z.string().max(100).nullable().optional(),
        lastName: z.string().max(100).nullable().optional(),
        company: z.string().max(200).nullable().optional(),
        primaryEmail: z.string().email().max(200).or(z.literal("")).optional(),
        primaryPhone: z.string().max(40).optional(),
        accountType: z.enum(["residential", "commercial"]).optional(),
        active: z.boolean().optional(),
        tags: z.array(z.string().min(1).max(40)).max(30).optional(),
        preferredContact: z.enum(["sms", "email", "phone"]).nullable().optional(),
        referralSource: z.string().max(200).nullable().optional(),
        smsOptOut: z.boolean().optional(),
        emailOptOut: z.boolean().optional(),
        // Import comms hold (office toggle on the client header): lift — or
        // re-apply — the automated-communications pause for imported clients.
        commsPaused: z.boolean().optional(),
        billingFrequency: z
          .enum(["after_each_visit", "weekly", "monthly", "quarterly", "yearly"])
          .optional(),
        // No sales tax on this client's invoices. A billing decision, so it
        // takes the billing permission below.
        taxExempt: z.boolean().optional(),
        // Who the sitter calls, and what they may spend on the vet (#411).
        emergencyContactName: z.string().max(200).nullable().optional(),
        emergencyContactPhone: z.string().max(40).nullable().optional(),
        emergencyContactMayApproveVet: z.boolean().optional(),
        vetTreatmentLimitCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Archiving/reactivating a client (the `active` flag) shuts service and
    // billing down — that's a manager-class write, not a directory edit, so a
    // dispatcher token can't bulk-archive the book. Other contact-level edits
    // keep the directory gate.
    await requirePermission(
      supabase,
      userId,
      data.active !== undefined || data.taxExempt !== undefined
        ? "manage_client_billing"
        : "view_client_directory",
    );

    const { data: beforeRow, error: beforeErr } = await supabase
      .from("clients")
      .select(
        "display_name, first_name, last_name, company, primary_email, primary_phone, account_type, active, tags, preferred_contact, referral_source, sms_opt_out, email_opt_out, comms_paused, tax_exempt, emergency_contact_name, emergency_contact_phone, emergency_contact_may_approve_vet, vet_treatment_limit_cents",
      )
      .eq("id", data.clientId)
      .single();
    if (beforeErr) throw new Error(beforeErr.message);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const changed: string[] = [];
    const namePatch = buildClientNamePatch(data, beforeRow);
    Object.assign(patch, namePatch.patch);
    if (namePatch.changed) changed.push("name");
    if (data.primaryEmail !== undefined) {
      patch.primary_email = data.primaryEmail || null;
      changed.push("email");
    }
    if (data.primaryPhone !== undefined) {
      patch.primary_phone = data.primaryPhone || null;
      changed.push("phone");
    }
    if (data.accountType !== undefined) {
      patch.account_type = data.accountType;
      changed.push("client type");
    }
    if (data.active !== undefined) {
      patch.active = data.active;
      changed.push("status");
    }
    if (data.tags !== undefined) {
      patch.tags = data.tags;
      changed.push("tags");
    }
    if (data.preferredContact !== undefined) {
      patch.preferred_contact = data.preferredContact;
      changed.push("preferred contact");
    }
    if (data.referralSource !== undefined) {
      patch.referral_source = data.referralSource || null;
      changed.push("referral source");
    }
    if (data.smsOptOut !== undefined) {
      patch.sms_opt_out = data.smsOptOut;
      changed.push("SMS preference");
    }
    if (data.emailOptOut !== undefined) {
      patch.email_opt_out = data.emailOptOut;
      changed.push("email preference");
    }
    if (data.commsPaused !== undefined) {
      patch.comms_paused = data.commsPaused;
      changed.push("communications hold");
    }
    if (data.billingFrequency !== undefined) {
      patch.billing_frequency = data.billingFrequency;
      changed.push("billing cadence");
    }
    if (data.emergencyContactName !== undefined) {
      patch.emergency_contact_name = data.emergencyContactName?.trim() || null;
      changed.push("emergency contact");
    }
    if (data.emergencyContactPhone !== undefined) {
      patch.emergency_contact_phone = data.emergencyContactPhone?.trim() || null;
      if (!changed.includes("emergency contact")) changed.push("emergency contact");
    }
    if (data.emergencyContactMayApproveVet !== undefined) {
      patch.emergency_contact_may_approve_vet = data.emergencyContactMayApproveVet;
      if (!changed.includes("emergency contact")) changed.push("emergency contact");
    }
    if (data.vetTreatmentLimitCents !== undefined) {
      patch.vet_treatment_limit_cents = data.vetTreatmentLimitCents;
      changed.push("vet treatment limit");
    }
    if (data.taxExempt !== undefined) {
      patch.tax_exempt = data.taxExempt;
      changed.push("sales tax exemption");
    }
    if (changed.length === 0) return { ok: true };

    const { data: rows, error } = await supabase
      .from("clients")
      .update(patch as never)
      .eq("id", data.clientId)
      .select("id, organization_id");
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) throw new Error("Client not found");

    const beforeChanged: Record<string, unknown> = {};
    const afterChanged: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "updated_at") continue;
      beforeChanged[k] = (beforeRow as any)?.[k] ?? null;
      afterChanged[k] = v;
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: row.organization_id,
      clientId: row.id,
      actorUserId: userId,
      kind: "client.updated",
      summary: `Updated client ${changed.join(", ")}`,
      meta: { fields: changed, before: beforeChanged, after: afterChanged },
    });
    return { ok: true };
  });

/** Full visit history for the Visits tab: scheduled window vs actual
 * start/completion so "estimated" and "actually happened" never blur. */
export const listClientVisitHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ clientId: z.string().uuid(), limit: z.number().int().min(1).max(200).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "view_client_directory");
    const select =
      "id, subscription_id, property_id, scheduled_on, status, created_at, assigned_staff_id, started_at, completed_at, eta_start, eta_end, skip_reason_code, skip_reason, rescheduled_from, is_deepclean, duration_min, groom_summary, client_package_id, properties(street, earliest_service_time, latest_service_time), subscriptions(earliest_time, latest_time), staff:assigned_staff_id(display_name)";
    const limit = data.limit ?? 100;
    const today = new Date().toISOString().slice(0, 10);
    // Two windows so a heavily scheduled client (many future visits) can't
    // push real history out of a single desc-ordered page: the EARLIEST
    // upcoming visits (next-visit math needs the minimum) plus the LATEST
    // past ones.
    const [upcoming, past] = await Promise.all([
      supabase
        .from("visits")
        .select(select)
        .eq("client_id", data.clientId)
        .gte("scheduled_on", today)
        .order("scheduled_on", { ascending: true })
        .limit(limit),
      supabase
        .from("visits")
        .select(select)
        .eq("client_id", data.clientId)
        .lt("scheduled_on", today)
        .order("scheduled_on", { ascending: false })
        .limit(limit),
    ]);
    if (upcoming.error) throw new Error(upcoming.error.message);
    if (past.error) throw new Error(past.error.message);
    const rows = [...(upcoming.data ?? []), ...(past.data ?? [])].sort((a: any, b: any) =>
      a.scheduled_on < b.scheduled_on ? 1 : a.scheduled_on > b.scheduled_on ? -1 : 0,
    );
    return { visits: rows };
  });

/** Every dog across the client's properties, for the detail page. */
export const listDogsForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "view_client_directory");
    const { data: props, error: pErr } = await supabase
      .from("properties")
      .select("id, street")
      .eq("client_id", data.clientId);
    if (pErr) throw new Error(pErr.message);
    const ids = (props ?? []).map((p) => p.id);
    if (!ids.length) return { dogs: [] };
    const { data: dogs, error } = await supabase
      .from("dogs")
      .select(
        "id, property_id, name, breed, weight_class, coat_type, weight_lb, temperament, notes, active, unit_id, dna_status, species, species_note, vet_clinic_name, vet_clinic_phone, muzzle_required, bite_history, senior_or_medical, handling_notes",
      )
      .in("property_id", ids)
      .order("name");
    if (error) throw new Error(error.message);
    const streetById = new Map((props ?? []).map((p) => [p.id, p.street]));
    return {
      dogs: (dogs ?? []).map((d) => ({
        ...d,
        property_street: streetById.get(d.property_id) ?? "",
      })),
    };
  });

/**
 * Rotate a client's portal token, invalidating the old link and every device
 * session minted from it (finding #4). Use when a client reports their link
 * may have leaked.
 */
export const regeneratePortalLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_settings");
    const { data: newToken, error } = await context.supabase.rpc("regenerate_portal_token" as any, {
      _client_id: data.clientId,
    });
    if (error) throw new Error(error.message);
    try {
      const { data: c } = await context.supabase
        .from("clients")
        .select("organization_id")
        .eq("id", data.clientId)
        .single();
      if (c) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: c.organization_id,
          clientId: data.clientId,
          actorUserId: context.userId,
          kind: "portal.link_regenerated",
          summary: "Regenerated the client portal link (old link invalidated)",
        });
      }
    } catch {}
    return { portalToken: newToken as string };
  });

/**
 * Read (mint) a one-time verification code for a client, so the office can
 * read it aloud when a client can't receive SMS/email. This is a sensitive
 * account-takeover-adjacent action (it hands out a valid sign-in code), so it
 * is (G2/I7):
 *   - permission-gated SERVER-SIDE to owner/office_manager (reveal_signin_code)
 *     — a dispatcher or tech token is rejected by the API, not just hidden;
 *   - the UI additionally requires an explicit click-through confirmation;
 *   - every reveal is written to the client's Activity with the actor.
 * Never exposed to the portal itself.
 */
export const readPortalVerificationCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "reveal_signin_code",
    );
    // Confirm the client is in the caller's org before touching it via admin.
    const { data: client } = await context.supabase
      .from("clients")
      .select("id, display_name")
      .eq("id", data.clientId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!client) throw new Error("Client not found");
    // Stored codes are hashed, so we can't reveal an existing one — mint a
    // fresh single-use code the office reads aloud and the client enters.
    const { issueOfficeReadCode } = await import("@/lib/portal-auth.server");
    const result = await issueOfficeReadCode(data.clientId);
    // G2/I7: EVERY reveal must be auditable. Unlike ordinary best-effort
    // activity, this is a security event — if the audit row can't be written we
    // do NOT return the code (the minted code goes unused and expires). Write
    // the row directly so an insert failure surfaces instead of being swallowed.
    const { data: staffRow } = await context.supabase
      .from("staff")
      .select("display_name")
      .eq("user_id", context.userId)
      .maybeSingle();
    const { error: auditErr } = await context.supabase.from("activity_log").insert({
      organization_id: orgId,
      client_id: data.clientId,
      actor_user_id: context.userId,
      actor_label: (staffRow as { display_name?: string } | null)?.display_name ?? null,
      kind: "portal.signin_code_revealed",
      summary: `Read a one-time portal sign-in code aloud for ${(client as any).display_name ?? "the client"}`,
      meta: {},
    });
    if (auditErr) {
      throw new Error("Couldn't record the sign-in code reveal to the activity log. Try again.");
    }
    return result;
  });

/**
 * Open a client's portal as a read-only preview, on the caller's own
 * browser. "Open portal" used to drop the owner on a sign-in screen that
 * sends a code to the CUSTOMER'S phone; the only way past was to reveal an
 * office-read code and sign in as the customer with every button live.
 *
 * Gated like the rest of the client's money (the portal shows invoices and
 * the card on file): owner and office manager. The session it mints is an
 * hour long and read-only in the server (requirePortalSession), and each
 * preview is written to the client's Activity with the name of whoever
 * opened it, before the session exists.
 */
export const previewClientPortal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_client_billing",
    );
    const { data: client } = await context.supabase
      .from("clients")
      .select("id, display_name")
      .eq("id", data.clientId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!client) throw new Error("Client not found");

    const { data: staffRow } = await context.supabase
      .from("staff")
      .select("display_name")
      .eq("user_id", context.userId)
      .maybeSingle();
    const { error: auditErr } = await context.supabase.from("activity_log").insert({
      organization_id: orgId,
      client_id: data.clientId,
      actor_user_id: context.userId,
      actor_label: (staffRow as { display_name?: string } | null)?.display_name ?? null,
      kind: "portal.previewed",
      summary: `Previewed ${(client as { display_name?: string }).display_name ?? "the client"}'s portal`,
      meta: {},
    });
    if (auditErr) throw new Error("Couldn't record the preview in the activity log. Try again.");

    const { startPortalPreview } = await import("@/lib/portal-auth.server");
    await startPortalPreview(data.clientId, context.userId);
    return { ok: true };
  });

/**
 * The portal sign-in channels we can actually deliver a code to for this
 * client, so staff copy ("code texted to …") matches what the portal really
 * offers (G2 channel mismatch: SMS is only offered when Twilio is configured).
 * Directory-gated (same visibility as the client record).
 */
export const getClientPortalChannels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const { data: client } = await context.supabase
      .from("clients")
      .select("portal_token")
      .eq("id", data.clientId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!client) throw new Error("Client not found");
    const token = (client as any).portal_token as string | null;
    if (!token) return { channels: [] as Array<"sms" | "email">, emailOff: false };
    const { portalContactChannels } = await import("@/lib/portal-auth.server");
    const { emailProviderConfigured } = await import("@/lib/email/provider.server");
    const contact = await portalContactChannels(token);
    // The portal emails a code only through the provider, and refuses to with
    // none. So "emailed to" is not said when there is no provider: the panel
    // says "not emailed" and points at the link instead (#612).
    const emailOff = !emailProviderConfigured();
    const channels = (contact?.channels ?? [])
      .map((c) => c.channel)
      .filter((c) => !(c === "email" && emailOff));
    return { channels, emailOff };
  });

// ---------- Internal quote (for authenticated onboarding wizard) ----------

const internalQuoteSchema = z.object({
  postalCode: z.string().trim().min(3).max(12),
  accountType: z.enum(["residential", "commercial"]).optional(),
  dogCount: z.coerce.number().int().min(1).max(20),
  frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly"]),
  boundaryAreaSqm: z.number().positive().max(1_000_000).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const getInternalQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => internalQuoteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: org, error: oErr } = await supabase
      .from("organizations")
      .select("currency, frequency_multipliers")
      .eq("id", orgId)
      .single();
    if (oErr) throw new Error(oErr.message);

    const { data: zones, error: zErr } = await supabase
      .from("zones")
      .select(
        "id, name, priority, account_type, postal_prefix, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, area_max_charge_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled",
      )
      .eq("organization_id", orgId);
    if (zErr) throw new Error(zErr.message);

    const { matchZone } = await import("@/lib/zone-match");
    const z = matchZone((zones ?? []) as any[], {
      postalCode: data.postalCode,
      point:
        data.latitude != null && data.longitude != null
          ? { lat: data.latitude, lng: data.longitude }
          : null,
      accountType: data.accountType ?? null,
    });

    if (!z) return { available: false as const };
    const { perVisitMultiplier } = await import("@/lib/frequency-multipliers");
    const mult = perVisitMultiplier(org.frequency_multipliers as any, data.frequency);
    const mode = (z.pricing_mode ?? "flat") as "flat" | "per_sqft" | "per_acre";

    const { computeZoneVisitPrice } = await import("@/lib/pricing");
    const price = computeZoneVisitPrice(
      {
        base_price_cents: z.base_price_cents,
        per_dog_addl_cents: z.per_dog_addl_cents,
        pricing_mode: mode,
        price_per_sqft_cents: Number(z.price_per_sqft_cents ?? 0),
        price_per_acre_cents: z.price_per_acre_cents,
        area_min_charge_cents: z.area_min_charge_cents,
        area_max_charge_cents: z.area_max_charge_cents,
      },
      { dogCount: data.dogCount, boundaryAreaSqm: data.boundaryAreaSqm, multiplier: mult },
    );
    return {
      available: true as const,
      quote: {
        zoneId: z.id as string,
        zoneName: z.name as string,
        pricingMode: mode,
        areaBasisCents: price.areaBasisCents,
        basePriceCents: price.perVisitCents,
        perDogAddlCents: z.per_dog_addl_cents ?? 0,
        recurringPriceCents: price.recurringCents,
        initialCleanupCents: z.initial_cleanup_cents ?? 0,
        currency: org.currency as string,
      },
    };
  });

// ---------- Composite onboarding: client + property + dogs + subscription ----------

const onboardSchema = z.object({
  // client
  displayName: z.string().min(1).max(200),
  accountType: z.enum(["residential", "commercial"]),
  primaryEmail: z.string().email().or(z.literal("")).optional(),
  primaryPhone: z.string().max(40).optional(),
  // property
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(20),
  // The pin the wizard already has: the address picker's match, or the Yard
  // step's lookup that the boundary was drawn on. See the handler.
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  gateCode: z.string().max(60).optional(),
  parkingNotes: z.string().max(1000).optional(),
  yardSize: z.enum(["small", "medium", "large", "xlarge"]).optional(),
  hazardNotes: z.string().max(1000).optional(),
  visitContactName: z.string().max(120).optional(),
  visitContactPhone: z.string().max(30).optional(),
  visitContactEmail: z.string().email().max(200).optional().or(z.literal("")),
  hazards: z
    .object({
      doNotEnterIfDogOut: z.boolean().optional(),
      aggressiveDog: z.boolean().optional(),
      escapeRisk: z.boolean().optional(),
      invisibleFence: z.boolean().optional(),
      dogInYardDuringService: z.boolean().optional(),
      beesWasps: z.boolean().optional(),
      sharpObjects: z.boolean().optional(),
      slipperySurfaces: z.boolean().optional(),
    })
    .optional(),
  boundary: z
    .object({
      type: z.literal("Polygon"),
      coordinates: z.array(z.array(z.array(z.number()))),
    })
    .optional(),
  boundaryAreaSqm: z.number().positive().max(1_000_000).optional(),
  // dogs
  dogs: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        breed: z.string().max(120).optional(),
        weightClass: z.string().max(40).optional(),
        coatType: z.enum(COAT_TYPES).nullable().optional(),
        weightLb: z.number().positive().max(300).multipleOf(0.1).nullable().optional(),
        // The dog_temperament enum's own values. The wizard offered "shy" and
        // "anxious", which the enum has never had, so any dog marked either
        // failed the whole onboarding on the dogs insert.
        temperament: z.enum(["friendly", "nervous", "aggressive", "unknown"]).optional(),
        notes: z.string().max(500).optional(),
      }),
    )
    .max(20)
    .optional(),
  // An internal office note (client_notes, audience "office"): hidden from
  // technicians by RLS. The wizard fills it with what a lead said.
  officeNote: z.string().max(4000).optional(),
  // Set when the wizard was opened from a lead. The lead is checked before
  // anything is created and marked converted, linked to this client, after.
  fromLeadId: z.string().uuid().optional(),
  // The first cleanup, when the office charged one: billed as its own open
  // invoice once the client exists. The price is the office's — prefilled
  // from the owner's first-cleanup pricing and editable in the wizard — and
  // taken only from someone who may bill clients (checked below).
  firstCleanup: z
    .object({
      priceCents: z.number().int().min(1).max(1_000_000),
      description: z.string().trim().min(1).max(300),
    })
    .optional(),
  // subscription (optional — user may skip)
  subscription: z
    .object({
      frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]),
      priceCents: z.number().int().min(0),
      dogCount: z.number().int().min(1).optional(),
      unitCount: z.number().int().min(1).optional(),
      zoneId: z.string().uuid().optional(),
      billingCadence: z.enum(["prepaid", "postpaid"]).optional(),
      preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      /** Which of the business's services the plan is for (the catalog).
       *  Omitted, the database gives the plan the business's default, as
       *  every client before the catalog (tg_subscriptions_service). */
      serviceId: z.string().uuid().optional(),
      /** A walk's days each week (subscriptions.weekdays, 0 = Sunday): one
       *  visit on each, every week. Only with frequency weekly; the set
       *  replaces the preferred day. */
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      /** The first day the service may run, on the org's calendar. Without
       *  it the column defaults to the database's CURRENT_DATE, which is UTC:
       *  a client created on a US evening got a visit that same night, after
       *  the route had finished, with nobody on it. */
      startedOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .optional(),
});

export const onboardClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => onboardSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    // Billing a first cleanup is billing. Refused before anything is written,
    // so a person who may add clients but not bill them is told now rather
    // than after a client exists with half of what they asked for.
    if (data.firstCleanup) {
      await requirePermission(supabase, userId, "manage_client_billing");
    }

    // 0) the lead this client is converted from, if any. Checked BEFORE the
    // client exists: a lead that is already a client is refused here, not
    // discovered after a duplicate household has been written.
    const leadConversion = data.fromLeadId ? await import("@/lib/lead-conversion.server") : null;
    let fromLead: { id: string } | null = null;
    if (data.fromLeadId && leadConversion) {
      const caller = await requirePermission(supabase, userId, "manage_leads");
      if (caller.orgId !== orgId) throw new Error("That lead was not found.");
      const lead = await leadConversion.loadLeadForConversion(supabase, orgId, data.fromLeadId);
      leadConversion.assertConvertible(lead);
      fromLead = { id: lead.id };
    }

    // 1) client
    const { data: cRow, error: cErr } = await supabase
      .from("clients")
      .insert({
        organization_id: orgId,
        display_name: data.displayName,
        account_type: data.accountType,
        primary_email: data.primaryEmail || null,
        primary_phone: data.primaryPhone || null,
      })
      .select("id, portal_token")
      .single();
    if (cErr) throw new Error(cErr.message);
    const clientId = cRow.id as string;

    // All-or-nothing for the RECORD. The four writes below are separate
    // statements, and a failure after this point used to leave a client with
    // a property and no dogs or service in the list -- and every retry made
    // another one (found by a first-time-owner persona test, 2026-09-27).
    // Deleting the client cascades to its property, dogs and subscription.
    // Side effects after the subscription (visit generation, activity, the
    // welcome email) are not undone: by then the record is complete.
    const undoClient = async () => {
      await supabase.from("clients").delete().eq("id", clientId);
    };

    // 2) property (best-effort geocode)
    //
    // The wizard's own pin wins. It is the address picker's match -- Google
    // Places, house-level, when the key is configured -- or the point the
    // Yard step showed and the boundary was drawn on. This used to throw it
    // away and ask Nominatim again, which on 2026-08-26 matched a house for
    // two of six ordinary US addresses and missed two entirely: so the most
    // common way to add a customer could store a street centroid, or NO
    // location, for an address the screen had just pinned exactly. The
    // routing trials showed what a stop with no location costs a route.
    // createProperty / updateProperty already prefer provider coordinates;
    // this is the same rule on the path most customers arrive by.
    const pinned = data.latitude != null && data.longitude != null;
    let latitude: number | null = pinned ? data.latitude! : null;
    let longitude: number | null = pinned ? data.longitude! : null;
    if (!pinned) {
      try {
        const { geocodeAddress } = await import("./geocode.server");
        const geo = await geocodeAddress({
          street: data.street,
          city: data.city,
          region: data.region,
          postal_code: data.postalCode,
        });
        latitude = geo?.latitude ?? null;
        longitude = geo?.longitude ?? null;
      } catch {}
    }

    // Zone detection must run on EVERY property creation path, not just the
    // client-detail drawer (QA follow-up 1.1: wizard-created properties had
    // no zone even when a ZIP-covered zone existed).
    const { detectZoneId } = await import("@/lib/properties.functions");
    const autoZoneId = await detectZoneId(supabase, orgId, {
      postalCode: data.postalCode,
      point: latitude != null && longitude != null ? { lat: latitude, lng: longitude } : null,
      accountType: data.accountType,
    });

    const hz = data.hazards ?? {};
    const { data: pRow, error: pErr } = await supabase
      .from("properties")
      .insert({
        client_id: clientId,
        organization_id: orgId,
        street: data.street,
        city: data.city,
        region: data.region || null,
        postal_code: data.postalCode,
        gate_code: data.gateCode || null,
        parking_notes: data.parkingNotes || null,
        address_source: "manual",
        auto_zone_id: autoZoneId,
        zone_id: autoZoneId,
        yard_size: data.yardSize ?? null,
        visit_contact_name: data.visitContactName || null,
        visit_contact_phone: data.visitContactPhone || null,
        visit_contact_email: data.visitContactEmail || null,
        do_not_enter_if_dog_out: !!hz.doNotEnterIfDogOut,
        aggressive_dog: !!hz.aggressiveDog,
        escape_risk: !!hz.escapeRisk,
        invisible_fence: !!hz.invisibleFence,
        dog_in_yard_during_service: !!hz.dogInYardDuringService,
        bees_wasps: !!hz.beesWasps,
        sharp_objects: !!hz.sharpObjects,
        slippery_surfaces: !!hz.slipperySurfaces,
        hazard_notes: data.hazardNotes || null,
        latitude,
        longitude,
        boundary: (data.boundary as any) ?? null,
        boundary_area_sqm: data.boundaryAreaSqm ?? null,
      })
      .select("id")
      .single();
    if (pErr) {
      await undoClient();
      throw new Error(pErr.message);
    }
    const propertyId = pRow.id as string;

    // 3) dogs
    if (data.dogs?.length) {
      const rows = data.dogs.map((d) => ({
        organization_id: orgId,
        property_id: propertyId,
        name: d.name,
        breed: d.breed || null,
        weight_class: d.weightClass || null,
        coat_type: d.coatType ?? null,
        weight_lb: d.weightLb ?? null,
        temperament: (d.temperament ?? "unknown") as any,
        notes: d.notes || null,
      }));
      const { error: dErr } = await supabase.from("dogs").insert(rows);
      if (dErr) {
        await undoClient();
        throw new Error(dErr.message);
      }
    }

    // 4) subscription
    let firstVisitOn: string | null = null;
    if (data.subscription) {
      const s = data.subscription;
      const isRes = data.accountType === "residential";
      if (s.startedOn) {
        const { data: orgRow } = await supabase
          .from("organizations")
          .select("timezone")
          .eq("id", orgId)
          .maybeSingle();
        const { orgToday, DEFAULT_ORG_TIMEZONE } = await import("@/lib/org-day");
        if (s.startedOn < orgToday(orgRow?.timezone || DEFAULT_ORG_TIMEZONE)) {
          await undoClient();
          throw new Error("The first visit can't be in the past.");
        }
      }
      // A weekday set rides on 'weekly' (subscriptions_weekdays_are_weekly)
      // and is the whole schedule, so the preferred day is left empty beside it.
      const { normalizeWeekdays } = await import("@/lib/weekday-set");
      const weekdays =
        s.frequency === "weekly" && s.weekdays?.length ? normalizeWeekdays(s.weekdays) : null;
      const { data: subRow, error: sErr } = await supabase
        .from("subscriptions")
        .insert({
          organization_id: orgId,
          client_id: clientId,
          property_id: propertyId,
          account_type: data.accountType,
          frequency: s.frequency,
          price_cents: s.priceCents,
          dog_count: isRes ? (s.dogCount ?? data.dogs?.length ?? 1) : null,
          unit_count: !isRes ? (s.unitCount ?? 1) : null,
          zone_id: s.zoneId ?? null,
          billing_cadence: s.billingCadence ?? "postpaid",
          preferred_weekdays: !weekdays && s.preferredWeekdays?.length ? s.preferredWeekdays : null,
          ...(s.startedOn ? { started_on: s.startedOn } : {}),
          ...(s.serviceId ? { service_id: s.serviceId } : {}),
          ...(weekdays ? { weekdays } : {}),
        })
        .select("id")
        .single();
      if (sErr) {
        await undoClient();
        throw new Error(sErr.message);
      }

      // An active service must have visits (QA follow-up 1.6): generate the
      // schedule immediately instead of waiting for the nightly job.
      const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
      await generateVisitHorizon(supabase, orgId);

      // The owner is told when the first visit actually is, which is not
      // always the day they picked: generation moves it to the next work day
      // or preferred weekday.
      const { data: first } = await supabase
        .from("visits")
        .select("scheduled_on")
        .eq("subscription_id", subRow!.id)
        .order("scheduled_on")
        .limit(1)
        .maybeSingle();
      firstVisitOn = first?.scheduled_on ?? null;
    }

    // 5) office note. The client and everything under it already exist, so a
    // failure here is reported rather than thrown: throwing would tell the
    // owner the save failed and invite a second, duplicate client.
    let officeNoteSaved = true;
    if (data.officeNote?.trim()) {
      const { error: nErr } = await supabase.from("client_notes").insert({
        organization_id: orgId,
        client_id: clientId,
        audience: "office",
        body: data.officeNote.trim(),
        pinned: false,
        created_by: userId,
      });
      if (nErr) {
        console.error("office note on new client failed", nErr);
        officeNoteSaved = false;
      }
    }

    // 6) the lead, linked to the client it became. Same reasoning as the note.
    const leadLinked =
      fromLead && leadConversion
        ? await leadConversion.markLeadConverted(supabase, fromLead.id, clientId)
        : null;

    // 7) the first cleanup, as a one-time line on its own invoice. Same shape
    // as a quote's one-time charges (invoiceQuoteOneTimeCharges), through the
    // same helper, and reported rather than thrown for the same reason as the
    // note: the client exists, and a thrown error invites a duplicate.
    let firstCleanupInvoiced: boolean | null = null;
    if (data.firstCleanup) {
      try {
        const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
        await insertManualInvoice(supabase, {
          orgId,
          userId,
          clientId,
          items: [
            {
              description: data.firstCleanup.description,
              amountCents: data.firstCleanup.priceCents,
              quantity: 1,
              unitAmountCents: data.firstCleanup.priceCents,
            },
          ],
          notes: "First cleanup",
          activityLabel: "first-cleanup invoice",
        });
        firstCleanupInvoiced = true;
      } catch (e) {
        console.error("first-cleanup invoice on new client failed", e);
        firstCleanupInvoiced = false;
      }
    }

    {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId,
        propertyId,
        actorUserId: userId,
        kind: "client.created",
        summary: `Created client ${data.displayName}${fromLead ? " from a lead" : ""} with property ${data.street}, ${data.city}`,
        meta: fromLead ? { leadId: fromLead.id } : undefined,
      });
    }

    // welcome email (best-effort). Reported back, so the owner is told it went
    // rather than finding out from the customer. "Went" means the provider
    // took it (#612): queued is not sent, so the page polls welcomeStatusHandle,
    // and with no provider nothing is queued and the page says "not sent" and
    // hands over the portal link instead.
    let welcomeEmailed = false;
    let welcomeStatusHandle: string | null = null;
    let welcomeTurnedOff = false;
    let welcomeLink: string | null = null;
    if (data.primaryEmail) {
      try {
        const { buildPortalLink } = await import("@/lib/portal-links.server");
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        welcomeLink = (await buildPortalLink(orgId, cRow.portal_token as string | null)) ?? null;
        const sent = await enqueueAppEmail({
          organizationId: orgId,
          clientId,
          templateName: "welcome",
          notifyKey: "notify_email_welcome",
          idempotencyKey: `welcome-${clientId}`,
          requireProvider: true,
          templateData: {
            portalUrl: welcomeLink ?? undefined,
          },
        });
        welcomeEmailed = sent.ok;
        // The owner turned welcome emails off: nothing to report as missing.
        welcomeTurnedOff = sent.reason === "org_toggle_off";
        if (sent.ok && sent.messageId) {
          const { signEmailStatusHandle } = await import("@/lib/email/status-handle.server");
          welcomeStatusHandle = signEmailStatusHandle(
            orgId,
            { kind: "client", id: clientId },
            sent.messageId,
          );
        }
      } catch (e) {
        console.error("welcome email failed", e);
      }
    }

    return {
      id: clientId,
      firstVisitOn,
      welcomeEmailed,
      welcomeStatusHandle,
      welcomeTurnedOff,
      welcomeLink,
      officeNoteSaved,
      leadLinked,
      firstCleanupInvoiced,
    };
  });

/** Header overflow action (QA follow-up 4.2): delete a client only when
 * nothing references them; anything else archives instead. */
export const deleteClientIfNoHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "manage_settings");
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, display_name")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    // Every guard query MUST surface its error: a failed count reads as 0
    // and would bypass the history check, cascade-deleting real visit and
    // service history (QA: visits/subscriptions are ON DELETE CASCADE).
    const guards = await Promise.all([
      supabase
        .from("visits")
        .select("id", { count: "exact", head: true })
        .eq("client_id", data.clientId),
      supabase
        .from("invoices")
        .select("id", { count: "exact", head: true })
        .eq("client_id", data.clientId),
      supabase
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("client_id", data.clientId),
      supabase
        .from("properties")
        .select("id", { count: "exact", head: true })
        .eq("client_id", data.clientId),
    ]);
    for (const g of guards) if (g.error) throw new Error(g.error.message);
    const [
      { count: visitCount },
      { count: invoiceCount },
      { count: subCount },
      { count: propCount },
    ] = guards;
    if ((visitCount ?? 0) > 0 || (invoiceCount ?? 0) > 0 || (subCount ?? 0) > 0)
      throw new Error("This client has history. Mark them inactive instead of deleting.");

    if ((propCount ?? 0) > 0) {
      const { data: props, error: listErr } = await supabase
        .from("properties")
        .select("id")
        .eq("client_id", data.clientId);
      if (listErr) throw new Error(listErr.message);
      for (const pr of props ?? []) {
        const dDel = await supabase.from("dogs").delete().eq("property_id", pr.id);
        if (dDel.error) throw new Error(dDel.error.message);
        const wDel = await supabase.from("waste_stations").delete().eq("property_id", pr.id);
        if (wDel.error) throw new Error(wDel.error.message);
      }
      const { error: pDelErr } = await supabase
        .from("properties")
        .delete()
        .eq("client_id", data.clientId);
      if (pDelErr) throw new Error(pDelErr.message);
    }
    const nDel = await supabase.from("client_notes").delete().eq("client_id", data.clientId);
    if (nDel.error) throw new Error(nDel.error.message);
    const { error } = await supabase.from("clients").delete().eq("id", data.clientId);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: client.organization_id,
      actorUserId: userId,
      kind: "client.deleted",
      summary: `Deleted client ${client.display_name} (no history)`,
    });
    return { ok: true };
  });

// ── Vacation holds (QA round 8) ─────────────────────────────────────────────
// A hold is a date range during which the client gets no visits: creating one
// removes already-scheduled visits in the range (DB trigger) and
// generate_visits_core skips dates inside a hold. RLS: org members read,
// office roles (can_write_org) write.

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const listClientHolds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "view_client_directory");
    const { data: rows, error } = await (supabase as any)
      .from("client_holds")
      .select("id, client_id, starts_on, ends_on, reason, created_at")
      .eq("client_id", data.clientId)
      .order("starts_on", { ascending: false });
    if (error) throw new Error(error.message);
    return { holds: rows ?? [] };
  });

export const createClientHold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().max(500).optional(),
      })
      .refine((v) => v.endsOn >= v.startsOn, { message: "The hold must end on or after it starts" })
      // A vacation hold longer than a year is a data-entry error (the sheet saw
      // a 2026 -> 2028 range accepted). Mirrors tg_client_holds_validate (I11).
      .refine((v) => (Date.parse(v.endsOn) - Date.parse(v.startsOn)) / 86400000 <= 366, {
        message: "A hold cannot be longer than a year",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    // The hold's client must belong to the caller's org (a DB trigger also
    // enforces this): otherwise a foreign client id would delete ANOTHER
    // tenant's scheduled visits via the SECURITY DEFINER clearing trigger.
    const { data: holdClient, error: hcErr } = await supabase
      .from("clients")
      .select("organization_id")
      .eq("id", data.clientId)
      .single();
    if (hcErr) throw new Error(hcErr.message);
    if (holdClient.organization_id !== orgId) throw new Error("Client not found");

    // Count what the hold is about to remove (the DB trigger deletes them on
    // insert) so the activity entry can say so.
    const { count } = await supabase
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("client_id", data.clientId)
      .eq("status", "scheduled")
      .gte("scheduled_on", data.startsOn)
      .lte("scheduled_on", data.endsOn);

    const { data: row, error } = await (supabase as any)
      .from("client_holds")
      .insert({
        organization_id: orgId,
        client_id: data.clientId,
        starts_on: data.startsOn,
        ends_on: data.endsOn,
        reason: data.reason?.trim() || null,
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const removed = count ?? 0;
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: data.clientId,
      actorUserId: userId,
      kind: "client.hold_created",
      summary:
        `Placed a vacation hold ${data.startsOn} to ${data.endsOn}` +
        (removed ? ` (${removed} scheduled visit${removed === 1 ? "" : "s"} removed)` : "") +
        (data.reason?.trim() ? `: ${data.reason.trim()}` : ""),
      meta: { starts_on: data.startsOn, ends_on: data.endsOn, removed_visits: removed },
    });
    return { id: row!.id as string, removedVisits: removed };
  });

/** End a hold early (or remove one that hasn't started). Visits already
 * removed by the hold are not recreated; use Generate schedule if needed. */
export const endClientHold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ holdId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: hold, error: hErr } = await (supabase as any)
      .from("client_holds")
      .select("id, client_id, starts_on, ends_on")
      .eq("id", data.holdId)
      .single();
    if (hErr) throw new Error(hErr.message);

    const today = localToday();
    if (hold.ends_on < today) throw new Error("This hold has already ended");

    let summary: string;
    if (hold.starts_on >= today) {
      // Not started yet (or starts today): remove it entirely.
      const { error } = await (supabase as any).from("client_holds").delete().eq("id", data.holdId);
      if (error) throw new Error(error.message);
      summary = `Removed the vacation hold ${hold.starts_on} to ${hold.ends_on}`;
    } else {
      // In progress: close it as of yesterday so today is serviceable again.
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
      const { error } = await (supabase as any)
        .from("client_holds")
        .update({ ends_on: yesterday })
        .eq("id", data.holdId);
      if (error) throw new Error(error.message);
      summary = `Ended the vacation hold early (was ${hold.starts_on} to ${hold.ends_on})`;
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: hold.client_id,
      actorUserId: userId,
      kind: "client.hold_ended",
      summary,
      meta: { starts_on: hold.starts_on, ends_on: hold.ends_on },
    });
    return { ok: true };
  });

// ── Texting consent ───────────────────────────────────────────────────────
//
// Twilio 30513 rejected toll-free verification because there was no opt-in to
// describe: `sms_opt_out` only ever went true AFTER a STOP reply, so a client
// nobody had asked read as sendable. Consent is now a recorded fact with the
// wording attached — see migration 20260805020000.

/** The exact words a client agrees to, for the caller's business: they name
 *  the business and carry its own Terms and Privacy links (#538). Built in
 *  one place (lib/client-sms-consent) so what the office reads out, what the
 *  portal and the booking link show, and what is stored as evidence cannot
 *  drift apart. A carrier asks for it verbatim. */
export const getClientSmsConsentWording = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { orgClientSmsConsentWording } = await import("@/lib/client-sms-consent.server");
    return orgClientSmsConsentWording(orgId);
  });

export const recordClientSmsConsent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    // Same-org check before the RPC so a uuid from another tenant reads as
    // "not your client" rather than a policy error.
    const { data: who } = await (context.supabase.from("clients") as any)
      .select("id")
      .eq("id", data.clientId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!who) throw new Error("That client is not in your organization.");

    const { orgClientSmsConsentWording, sendOptInConfirmation } = await import(
      "@/lib/client-sms-consent.server"
    );
    const { text } = await orgClientSmsConsentWording(orgId);
    // 'staff' — recorded on the client's behalf by someone in the office (a
    // verbal yes, read from the script on the client page), which an audit
    // must be able to tell apart from the client ticking a box.
    const { error } = await (context.supabase as any).rpc("record_client_sms_consent", {
      _client_id: data.clientId,
      _text: text,
      _source: "staff",
    });
    if (error) throw new Error(error.message);
    await sendOptInConfirmation(orgId, data.clientId);
    return { ok: true, text };
  });

/** How much of the book can actually be texted. Drives the banner, so the gap
 *  is a number on screen rather than a mystery about why reminders stopped. */
export const getSmsConsentCoverage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase as any).rpc("sms_consent_coverage", {
      _org_id: orgId,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0] ?? { with_phone: 0, consented: 0, opted_out: 0 };
    return {
      withPhone: Number(row.with_phone),
      consented: Number(row.consented),
      optedOut: Number(row.opted_out),
    };
  });

/** Add or remove one tag across many clients: the Clients list's bulk bar.
 *  Tags could only be edited one client at a time, which Jobber's own users
 *  name as a chore, and now that imports bring tags in there are hundreds. */
export const bulkTagClients = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        tag: z.string().trim().min(1).max(40),
        action: z.enum(["add", "remove"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // The same gate as editing tags on one client.
    const { orgId } = await requirePermission(supabase, userId, "view_client_directory");
    // Up to 500 ids, read 40 at a time: all of them in one GET was a query
    // string of about 19 KB (#617).
    const { idChunks } = await import("@/lib/supabase-paging.server");
    const reads = await Promise.all(
      idChunks(data.ids).map((ids) =>
        supabase.from("clients").select("id, tags").eq("organization_id", orgId).in("id", ids),
      ),
    );
    const rows: Array<{ id: string; tags: string[] | null }> = [];
    for (const r of reads) {
      if (r.error) throw new Error(r.error.message);
      rows.push(...((r.data ?? []) as Array<{ id: string; tags: string[] | null }>));
    }
    const want = data.tag;
    const lc = want.toLowerCase();
    let changed = 0;
    const work = rows.flatMap((r) => {
      const tags = r.tags ?? [];
      const has = tags.some((t) => t.toLowerCase() === lc);
      if (data.action === "add" && has) return [];
      if (data.action === "remove" && !has) return [];
      const next =
        data.action === "add"
          ? [...tags, want].slice(0, 30)
          : tags.filter((t) => t.toLowerCase() !== lc);
      return [{ id: r.id, tags: next }];
    });
    for (let i = 0; i < work.length; i += 25) {
      const results = await Promise.all(
        work
          .slice(i, i + 25)
          .map((w) =>
            supabase
              .from("clients")
              .update({ tags: w.tags, updated_at: new Date().toISOString() })
              .eq("id", w.id)
              .eq("organization_id", orgId),
          ),
      );
      for (const r of results) {
        if (r.error) throw new Error(r.error.message);
        changed += 1;
      }
    }
    return { changed, unchanged: (rows ?? []).length - changed };
  });
