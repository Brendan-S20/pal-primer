// Book a single visit that is not part of a recurring plan: the work behind
// createOneOffVisit (visits.functions.ts), moved here so it can have a second
// caller without becoming a second copy.
//
// The two callers:
//   * createOneOffVisit -- the office, signed in, holding manage_pricing, on
//     its own RLS-scoped client. "Book a one-off visit", "Schedule re-clean",
//     and booking a customer's extra-cleanup request from /concerns.
//   * portalRequestOneOff -- a customer's extra-cleanup request, when the
//     owner turned auto-accept on and set a price. Runs as the service role,
//     so nothing here may rely on RLS for tenancy: the client and property
//     are checked against input.orgId explicitly below, and were already.
//
// Every comment below was written about createOneOffVisit and still applies;
// see there for why a one-off is a `one_time` subscription at all.

export type BookOneOffInput = {
  orgId: string;
  /** The person booking, or null when the portal books it automatically. */
  actorUserId: string | null;
  clientId: string;
  propertyId: string;
  scheduledOn: string;
  priceCents: number;
  staffId?: string | null;
  note?: string;
  /** True only for the portal's auto-accept path (service-role client). */
  asService?: boolean;
};

export type BookOneOffResult = {
  visitId: string;
  subscriptionId: string;
  scheduledOn: string;
  assigned: boolean;
  assignWarning: string | null;
};

export async function bookOneOffVisit(db: any, input: BookOneOffInput): Promise<BookOneOffResult> {
  const { data: client, error: cErr } = await db
    .from("clients")
    .select("id, organization_id, account_type, display_name")
    .eq("id", input.clientId)
    .single();
  if (cErr) throw new Error(cErr.message);
  if (client.organization_id !== input.orgId)
    throw new Error("That client is not in your organization");

  const { data: prop, error: pErr } = await db
    .from("properties")
    .select("id, client_id, zone_id, auto_zone_id, total_units")
    .eq("id", input.propertyId)
    .single();
  if (pErr) throw new Error(pErr.message);
  if (prop.client_id !== input.clientId)
    throw new Error("That property belongs to a different client");

  // subscriptions_account_shape_chk: residential needs dog_count, commercial
  // needs unit_count, and exactly one of them. Getting this wrong fails at
  // the constraint with a message no office manager could act on.
  const accountType =
    (client.account_type as string) === "commercial" ? "commercial" : "residential";
  const dogCount =
    accountType === "residential"
      ? await db
          .from("dogs")
          .select("id", { count: "exact", head: true })
          .eq("property_id", input.propertyId)
          // NOT (active IS false) — `neq("active", false)` would drop rows
          // where active is NULL, which is how most dogs are stored.
          .not("active", "is", false)
          .then((r: any) => Math.max(1, r.count ?? 1))
      : null;

  // ── billing_cadence must be INHERITED, never defaulted ──────────────────
  //
  // Omitting it takes the table default 'postpaid', and that is not a
  // cosmetic difference. client_default_billing_cadence answers "what is this
  // client's cadence" with the cadence of their newest-started ACTIVE
  // subscription — and a one-off booked for today or later is exactly that
  // row. So booking a $40 call-out for a PREPAID client silently converted
  // the whole client to postpaid: their add-on charges stopped drawing down
  // the credit they had already paid, and started landing on postpaid
  // invoices instead. Money they had funded once, billed again.
  //
  // Confirmed live before this was written: cadence_before=prepaid,
  // cadence_after_one_off=postpaid.
  //
  // ── why this mirrors client_default_billing_cadence instead of calling it ──
  //
  // The first version of this fix DID call the RPC, and it would not have
  // worked: client_default_billing_cadence is not granted to `authenticated`,
  // so the call fails, the result is not one of the two literals, and the
  // fallback below quietly restores the very 'postpaid' this exists to
  // prevent. A fix that reports success and changes nothing.
  //
  // Granting it is the wrong repair. It is SECURITY DEFINER, so it would
  // answer about ANY client id from any tenant — the same shape as BUG-42,
  // where six authorization primitives answered about anyone who was asked
  // about. Not worth widening for a convenience.
  //
  // So the ordering is restated here against the caller's own RLS-scoped
  // client, which can only see its own organization's rows. That is a second
  // copy of a rule, which I would normally refuse; the SQL definition is
  // `status='active' ORDER BY started_on DESC NULLS LAST LIMIT 1` and this
  // matches it exactly. It is read BEFORE the insert on purpose — a moment
  // later, the one-off itself would be the newest active subscription and
  // would answer about itself.
  let cadence: "postpaid" | "prepaid" = "postpaid";
  {
    const { data: newest } = await db
      .from("subscriptions")
      .select("billing_cadence")
      .eq("client_id", input.clientId)
      .eq("status", "active")
      .order("started_on", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const c = (newest as { billing_cadence?: string } | null)?.billing_cadence;
    if (c === "prepaid" || c === "postpaid") cadence = c;
  }

  const { data: sub, error: sErr } = await db
    .from("subscriptions")
    .insert({
      organization_id: input.orgId,
      client_id: input.clientId,
      property_id: input.propertyId,
      account_type: accountType,
      frequency: "one_time",
      price_cents: input.priceCents,
      billing_cadence: cadence,
      dog_count: dogCount,
      unit_count: accountType === "commercial" ? Math.max(1, prop.total_units ?? 1) : null,
      zone_id: prop.zone_id ?? prop.auto_zone_id ?? null,
      started_on: input.scheduledOn,
      // A one-off must not keep generating. Bounding it on the same day is
      // what makes the `one_time` branch terminate rather than relying on
      // the frequency alone.
      ends_on: input.scheduledOn,
    })
    .select("id")
    .single();
  if (sErr) throw new Error(sErr.message);

  // ── Generate NOW rather than waiting for the nightly run ────────────────
  //
  // This is the whole reason this function exists. Saving a service has never
  // created its visits — the nightly cron does, or someone presses "Generate
  // schedule". And that button was explicitly disabled for one_time
  // (`canGenerate = … && s.frequency !== "one_time"`), so booking a one-off
  // for TODAY produced a service with no visit, no button, and a banner
  // reading "Its one-time visit is in the past" — which was false. The
  // emergency case was the one case that could not work.
  //
  // Scoped to THIS subscription. It used to call the org-wide
  // generate_visits_through, and I wrote here that the side effect was
  // harmless because the nightly run does the same work. That was true only
  // inside the org's 60-day horizon. Past it, one booking materialised
  // visits for every active subscription across a window whose blackouts
  // nobody had entered yet — and addBlackout only inserts a blackout row, it
  // does not remove visits already generated, so those stay routed on top of
  // the holiday. generate_visits_for_subscription runs the identical code
  // path (same blackout, work-day, hold and ends_on rules) over one row.
  //
  // The portal's auto-accept path runs as the service role, which has no
  // auth.uid() for generate_visits_for_subscription's can_write_org check
  // to recognise. It calls the core that wrapper delegates to -- the same
  // function, the same rules, scoped to the same one subscription -- after
  // this file has already checked that the client and property are this
  // organization's, which is the check the wrapper adds.
  const { error: gErr } = input.asService
    ? // rpc-role: service (only on the service-role path; see above)
      await (db as any).rpc("generate_visits_core", {
        _org_id: input.orgId,
        _through: input.scheduledOn,
        _subscription_id: sub.id,
      })
    : await (db as any).rpc("generate_visits_for_subscription", {
        _org_id: input.orgId,
        _subscription_id: sub.id,
        _through: input.scheduledOn,
      });
  if (gErr) throw new Error(gErr.message);

  const { data: visit } = await db
    .from("visits")
    .select("id, scheduled_on")
    .eq("subscription_id", sub.id)
    .maybeSingle();

  // The generator declines a date that is blacked out, outside the org's work
  // days, or inside a client hold — all of which are correct refusals, and
  // all of which would otherwise look like the booking silently vanishing.
  if (!visit) {
    // Take the subscription back out. There is no transaction across these
    // statements, so throwing on its own left a priced, status='active'
    // service behind with no visit — and every failed attempt left another.
    // Those orphans are not inert: an active subscription is what
    // client_default_billing_cadence reads, what the client portal shows as
    // "your plan", and what the seasonal deep-clean generator bills.
    //
    // Delete rather than mark ended: nothing happened, so there is nothing
    // to keep a record of, and a canceled service in the client's history
    // would be a service they never had.
    await db.from("subscriptions").delete().eq("id", sub.id);
    throw new Error(
      `Nothing could be scheduled on ${input.scheduledOn}. It is a blackout day, outside your work days, or inside a hold on this client. The booking was not saved, so pick another date and try again.`,
    );
  }

  // Assignment failing must NOT fail the booking. The visit already exists
  // and is already billable at this point, so throwing here reported failure
  // for work that had succeeded — and the dialog stays open with every field
  // still filled in, so the natural response (press the button again) created
  // a SECOND subscription and a SECOND visit for the same client, property
  // and date, which invoices as two visits at full price. Nothing dedupes
  // that: the unique index is (subscription_id, scheduled_on), and these are
  // two different subscriptions.
  //
  // So an unassignable tech leaves the visit unassigned — the state it would
  // have been in anyway had the caller not picked one — and says so.
  let assigned = false;
  let assignWarning: string | null = null;
  if (input.staffId && input.asService) {
    // reassign_visit checks the signed-in user; the service role is nobody.
    assignWarning = "Booked automatically, so nobody was assigned.";
  } else if (input.staffId) {
    const { error: rErr } = await (db as any).rpc("reassign_visit", {
      _visit_id: visit.id,
      _staff_id: input.staffId,
    });
    if (rErr) assignWarning = rErr.message;
    else assigned = true;
  }

  try {
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(db, {
      orgId: input.orgId,
      clientId: input.clientId,
      propertyId: input.propertyId,
      actorUserId: input.actorUserId,
      ...(input.asService ? { actorLabel: "Customer portal" } : {}),
      kind: "visit.created",
      summary: `Booked a one-off visit on ${visit.scheduled_on}${
        input.note ? ` — ${input.note}` : ""
      }`,
    });
  } catch {
    // The timeline is best-effort; the visit is booked either way.
  }

  return {
    visitId: visit.id as string,
    subscriptionId: sub.id as string,
    scheduledOn: visit.scheduled_on as string,
    assigned,
    assignWarning,
  };
}
