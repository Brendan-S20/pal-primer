// The AI receptionist offers real days and books one, the way the portal does.
//
// Two tools, get_open_slots and book_visit (ai-receptionist.server.ts), and
// the rules behind them. Nothing here is a new way to decide a day or make a
// visit:
//
//   which days   bookableDays (one-off-booking.ts) -- the portal's own list:
//                the org's tomorrow through +30, its work_days, no blackout.
//                Less any day the address already has a visit (the refusal
//                portal_request_one_off makes), less any day no technician
//                can work: routable_staff, the planner's own answer to "who
//                is active, a field tech, routing and not on time off".
//   where        matchZone (zone-match.ts), the matcher property saves,
//                redetection and quoting use. Outside every zone, nothing is
//                offered and the office is handed the conversation.
//   booking      portal_request_one_off -> bookOneOffVisit, exactly as the
//                portal's portalRequestOneOff: the request is made first (the
//                database re-checks the day), then booked straight in when
//                the owner turned "Book requests automatically" on and set a
//                price -- otherwise it waits in Concerns, and the client is
//                told the office will confirm.
//   which service  the business's own list (list_services, phase 5), by id.
//                With none named, or the pet-waste service, it is the extra
//                cleanup at organizations.one_off_price_cents, exactly as
//                before the catalog. Any other service is validated against
//                the business (resolveService), recorded on the request
//                (portal_request_one_off's _service_id), and booked at the
//                service's price worked out by bookOneOffVisit for the
//                property's pets -- the same call the portal makes. Neither
//                tool here returns a price for it; get_pricing_quote does,
//                through public_quote with the same id.
//
// What it will not do:
//   * book a day get_open_slots did not offer to this phone, for this
//     address, in this business, in the last OFFER_TTL_HOURS;
//   * book anything for a number that is not exactly one of this business's
//     active clients (an unknown number becomes a lead, never a client);
//   * book twice for one conversation and day (the offer row is claimed);
//   * list or book a service on a line that is still Coming soon (outside
//     BOOKABLE_SERVICE_LINES), the same rule as the portal's (#506);
//   * say a price. Neither tool returns one; get_pricing_quote is the only
//     place a price comes from.
//
// The database is reached through ReceptionistStore so the rules can be
// driven without one (tests/the-receptionist-books-the-visit.test.ts). The
// real store is receptionist-booking-store.server.ts.

import { bookableDays, ONE_OFF_MAX_DAYS_AHEAD } from "@/lib/one-off-booking";
import { addDaysToDay } from "@/lib/reclean";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { oneOffRequestWord } from "@/lib/one-off-booking";
import { BOOKABLE_SERVICE_LINES, customerCanRequestService } from "@/lib/service-lines";
import { isZonePriced } from "@/lib/services";
import { servicePickerOptions } from "@/lib/visit-service";
import { matchZone, type ZoneMatchFields } from "@/lib/zone-match";

import {
  OFFER_TTL_HOURS,
  RECEPTIONIST_DEFAULT_DAYS,
  RECEPTIONIST_SLOTS_SHOWN,
  type ArrivalWindow,
  type Caller,
  type ClientFacts,
  type Offer,
  type OrgFacts,
  type PropertyFacts,
  type ReceptionistStore,
  type ServiceFacts,
} from "@/lib/receptionist-booking.types";

export * from "@/lib/receptionist-booking.types";

// ── small pure pieces ───────────────────────────────────────────────────────

export function conversationKey(fromNumber: string): string {
  return fromNumber.replace(/\D/g, "");
}

export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function clock(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${ampm}`;
}

/** "8:00 AM to 10:00 AM", "after 8:00 AM", "by 10:00 AM", or null. */
export function windowLabel(w: ArrivalWindow | null): string | null {
  if (!w || (!w.earliest && !w.latest)) return null;
  if (w.earliest && w.latest) return `${clock(w.earliest)} to ${clock(w.latest)}`;
  return w.earliest ? `after ${clock(w.earliest)}` : `by ${clock(w.latest!)}`;
}

/** Money named in a reply: "$45", "$1,200.50", "45 dollars". */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  const re =
    /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)|\b(\d{1,6}(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/gi;
  for (const m of text.matchAll(re)) {
    const n = Number((m[1] ?? m[2]).replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Every amount get_pricing_quote returned: the numbers under its *_usd keys. */
export function quotedAmounts(v: unknown, out: number[] = []): number[] {
  if (Array.isArray(v)) v.forEach((x) => quotedAmounts(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (/usd$/i.test(k) && typeof x === "number") out.push(x);
      else quotedAmounts(x, out);
    }
  }
  return out;
}

/** Booked straight in only on the portal's own switch, which needs a price:
 *  the org's one-off price for the extra cleanup (no service named, or the
 *  pet-waste one), the service's own base price for anything else. */
export function booksStraightIn(org: OrgFacts, service: ServiceFacts | null = null): boolean {
  if (!org.portal_auto_accept_bookings) return false;
  if (service && !isZonePriced(service)) return service.base_price_cents != null;
  return org.one_off_price_cents != null;
}

/** The extra cleanup when nothing was named or the pet-waste service was;
 *  the service itself otherwise. What the request, the visit and the office
 *  are told about. */
function askedFor(service: ServiceFacts | null): ServiceFacts | null {
  return service && !isZonePriced(service) ? service : null;
}

type Resolved = { ok: true; service: ServiceFacts | null } | { ok: false };

/** The service a tool was handed: none (the extra cleanup, as always), or one
 *  of THIS business's active services. Another business's id, a retired one
 *  and a made-up one are all the same refusal. */
async function resolveService(
  store: ReceptionistStore,
  orgId: string,
  serviceId: string | undefined,
): Promise<Resolved> {
  if (!serviceId) return { ok: true, service: null };
  const hit = (await store.services(orgId)).find((s) => s.id === serviceId);
  if (!hit || !hit.active || !customerCanRequestService(hit.service_line)) return { ok: false };
  // A line that is still Coming soon cannot be booked by a client, here any
  // more than from the portal (#506).
  if (!BOOKABLE_SERVICE_LINES.includes(hit.service_line)) return { ok: false };
  return { ok: true, service: hit };
}

function inServiceArea(zones: ZoneMatchFields[], p: PropertyFacts): boolean {
  // A manual zone override is the office's own statement that this address
  // is served, whatever the matcher would say (zones-redetect.server.ts).
  if (p.zone_override_reason && p.zone_id) return true;
  const point =
    p.latitude != null && p.longitude != null
      ? { lat: Number(p.latitude), lng: Number(p.longitude) }
      : null;
  const type =
    p.account_type === "commercial" || p.account_type === "residential" ? p.account_type : null;
  return !!matchZone(zones, { postalCode: p.postal_code, point, accountType: type });
}

function pickProperty(
  props: PropertyFacts[],
  address: string | undefined,
): PropertyFacts | PropertyFacts[] {
  if (props.length === 1) return props[0];
  const hint = (address ?? "").trim().toLowerCase();
  if (hint) {
    const hit = props.filter(
      (p) => p.street.toLowerCase().includes(hint) || hint.includes(p.street.toLowerCase()),
    );
    if (hit.length === 1) return hit[0];
  }
  return props;
}

type Who =
  | { kind: "client"; client: ClientFacts }
  | { kind: "unknown" }
  // The phone is on more than one of this business's clients, or the
  // webhook's match no longer holds. A person sorts that out.
  | { kind: "unsure" };

export async function identify(store: ReceptionistStore, c: Caller): Promise<Who> {
  const digits = conversationKey(c.fromNumber);
  if (!digits) return { kind: "unknown" };
  const matches = (await store.clientsWithPhone(c.orgId, digits)).filter(
    (m) => m.organization_id === c.orgId && m.active,
  );
  if (matches.length === 0) return { kind: "unknown" };
  if (matches.length > 1) return { kind: "unsure" };
  if (c.clientId && matches[0].id !== c.clientId) return { kind: "unsure" };
  return { kind: "client", client: matches[0] };
}

const handoff = (reason: string) => ({ available: false as const, handoff: true, reason });

// ── what the business sells ─────────────────────────────────────────────────

/** The list_services tool: this business's active services, by id and name,
 *  in the order its own Services page lists them. Only the ones that can be
 *  asked for: the pet-waste service (the extra cleanup) and any service with
 *  a price. NO PRICE on any of them; get_pricing_quote is the only place a
 *  price comes from, and it takes the id this hands back. */
export async function listServices(store: ReceptionistStore, c: Caller) {
  const org = await store.org(c.orgId);
  if (!org) return handoff("business_not_found");
  // servicePickerOptions: the active ones, by line (pet waste first) and name,
  // as the plan form and the portal list them. Not a line that is still
  // Coming soon, which the portal does not offer either (#506).
  const rows = servicePickerOptions(await store.services(c.orgId)).filter(
    (s) =>
      BOOKABLE_SERVICE_LINES.includes(s.service_line) &&
      customerCanRequestService(s.service_line) &&
      (isZonePriced(s) || s.base_price_cents != null),
  );
  return {
    services: rows.map((s) => ({
      service_id: s.id,
      name: s.name,
      kind: s.service_line,
      usual_minutes: s.default_duration_min,
    })),
    // What a caller who names nothing gets: the pet-waste extra cleanup.
    default_is_extra_cleanup: rows.some((s) => isZonePriced(s)),
  };
}

// ── which days are open ─────────────────────────────────────────────────────

type OpenDays = { days: string[]; window: ArrivalWindow | null };

/** The open days for one address (property) or one ZIP (unknown number),
 *  from the org's tomorrow through `horizon` days. The single rule both
 *  tools use: get_open_slots to offer, book_visit to re-check. */
async function openDays(
  store: ReceptionistStore,
  orgId: string,
  org: OrgFacts,
  today: string,
  horizon: number,
  property: PropertyFacts | null,
  clientId: string | null,
): Promise<OpenDays> {
  const through = addDaysToDay(today, Math.min(horizon, ONE_OFF_MAX_DAYS_AHEAD));
  const blackouts = await store.blackouts(orgId, today, through);
  let days = bookableDays(today, org.work_days, blackouts).filter((d) => d <= through);
  if (property) {
    const busy = new Set(await store.busyDays(orgId, property.id, today, through));
    days = days.filter((d) => !busy.has(d));
  }
  if (days.length) {
    const staffed = await store.daysWithATech(orgId, days);
    days = days.filter((d) => staffed.has(d));
  }
  const window =
    property && clientId && org.route_windows !== "ignore"
      ? await store.arrivalWindow(orgId, clientId, property.id)
      : null;
  return { days, window };
}

export type SlotsArgs = {
  days?: number;
  address?: string;
  postal_code?: string;
  /** The service asked about (list_services). Absent: the extra cleanup. */
  service_id?: string;
  now?: Date;
};

export async function getOpenSlots(store: ReceptionistStore, c: Caller, a: SlotsArgs) {
  const org = await store.org(c.orgId);
  if (!org) return handoff("business_not_found");
  const resolved = await resolveService(store, c.orgId, a.service_id);
  if (!resolved.ok) return { available: false as const, reason: "service_not_offered" };
  const now = a.now ?? new Date();
  const today = orgToday(org.timezone || DEFAULT_ORG_TIMEZONE, now);
  const horizon = Math.max(
    1,
    Math.min(a.days ?? RECEPTIONIST_DEFAULT_DAYS, ONE_OFF_MAX_DAYS_AHEAD),
  );
  const who = await identify(store, c);
  if (who.kind === "unsure") return handoff("phone_matches_more_than_one_client");
  const zones = await store.zones(c.orgId);

  let property: PropertyFacts | null = null;
  let postal: string | null = null;
  if (who.kind === "client") {
    const props = await store.properties(c.orgId, who.client.id);
    if (!props.length) return handoff("no_address_on_file");
    const pick = pickProperty(props, a.address);
    if (Array.isArray(pick)) {
      return {
        available: false as const,
        needs_address: true,
        addresses: pick.map((p) => p.street),
      };
    }
    if (!inServiceArea(zones, pick)) return handoff("outside_service_area");
    property = pick;
  } else {
    postal = (a.postal_code ?? "").trim().slice(0, 5);
    if (!/^\d{5}$/.test(postal)) return { available: false as const, needs_postal_code: true };
    if (!matchZone(zones, { postalCode: postal })) return handoff("outside_service_area");
  }

  const open = await openDays(
    store,
    c.orgId,
    org,
    today,
    horizon,
    property,
    who.kind === "client" ? who.client.id : null,
  );
  const shown = open.days.slice(0, RECEPTIONIST_SLOTS_SHOWN);
  if (!shown.length) return handoff("no_open_days");

  const offeredAt = now.toISOString();
  const expires = new Date(now.getTime() + OFFER_TTL_HOURS * 3_600_000).toISOString();
  await store.saveOffers(
    shown.map((day) => ({
      organization_id: c.orgId,
      conversation_key: conversationKey(c.fromNumber),
      client_id: who.kind === "client" ? who.client.id : null,
      property_id: property?.id ?? null,
      postal_code: property ? null : postal,
      day,
      window_start: open.window?.earliest ?? null,
      window_end: open.window?.latest ?? null,
      offered_at: offeredAt,
      expires_at: expires,
    })),
  );
  const window = windowLabel(open.window);
  return {
    available: true as const,
    address: property?.street ?? null,
    slots: shown.map((date) => ({ date, label: dayLabel(date), arrival_window: window })),
    // What book_visit will do with one of these. The model says this, not
    // "booked", until book_visit says booked.
    on_booking:
      who.kind === "client" && booksStraightIn(org, resolved.service)
        ? ("books_into_calendar" as const)
        : ("office_confirms" as const),
  };
}

// ── booking one ─────────────────────────────────────────────────────────────

export type BookArgs = {
  date: string;
  address?: string;
  postal_code?: string;
  name?: string;
  note?: string;
  /** The service to book (list_services). Absent: the extra cleanup. */
  service_id?: string;
  now?: Date;
};

/** portal_request_one_off's refusal codes (one-off-booking.ts reads the same). */
const ONE_OFF_REFUSALS = [
  "date_in_past",
  "date_too_soon",
  "date_too_far",
  "not_a_working_day",
  "blackout_day",
  "already_scheduled",
  "property_not_found",
  "service_not_offered",
  "invalid_token",
];

const refused = (reason: string) => ({ booked: false as const, reason });

function settledAnswer(o: Offer) {
  return {
    booked: o.outcome === "booked",
    already: true,
    date: o.day,
    label: dayLabel(o.day),
    status: o.outcome === "booked" ? ("booked" as const) : ("office_will_confirm" as const),
  };
}

export async function bookVisit(store: ReceptionistStore, c: Caller, a: BookArgs) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) return refused("date_not_understood");
  const org = await store.org(c.orgId);
  if (!org) return refused("business_not_found");
  const resolved = await resolveService(store, c.orgId, a.service_id);
  if (!resolved.ok) return refused("service_not_offered");
  // The service the request and the visit carry: null is the extra cleanup.
  const service = askedFor(resolved.service);
  const word = oneOffRequestWord(service);
  const now = a.now ?? new Date();
  const key = conversationKey(c.fromNumber);
  const who = await identify(store, c);

  // The offer for this business, this phone and this day -- and, for a
  // client, this address.
  const offers = (await store.findOffers(c.orgId, key, a.date)).filter(
    (o) => o.organization_id === c.orgId && o.conversation_key === key && o.day === a.date,
  );
  let candidates: Offer[];
  if (who.kind === "client") {
    candidates = offers.filter((o) => o.client_id === who.client.id && o.property_id);
    if (candidates.length > 1 && a.address) {
      const props = await store.properties(c.orgId, who.client.id);
      const pick = pickProperty(
        props.filter((p) => candidates.some((o) => o.property_id === p.id)),
        a.address,
      );
      if (!Array.isArray(pick)) candidates = candidates.filter((o) => o.property_id === pick.id);
    }
  } else {
    const zip = (a.postal_code ?? "").trim().slice(0, 5);
    candidates = offers.filter((o) => !o.client_id && (!zip || o.postal_code === zip));
  }
  if (candidates.length > 1) return { booked: false as const, needs_address: true };
  const offer = candidates[0];
  if (!offer || Date.parse(offer.expires_at) <= now.getTime()) return refused("not_offered");

  // The same "yes" a second time: say what happened the first time.
  if (offer.outcome) return settledAnswer(offer);

  if (who.kind !== "client") {
    // Never a booking. An unknown number is a lead; an ambiguous one is a
    // person's job. Either way the office confirms.
    if (!(await store.claimOffer(c.orgId, offer.id))) return refused("already_in_progress");
    let leadId: string | null = null;
    if (who.kind === "unknown") {
      leadId = await store.createLead({
        orgId: c.orgId,
        fromNumber: c.fromNumber,
        name: (a.name ?? "").trim().slice(0, 120) || `Text from ${c.fromNumber}`,
        note: `Asked by text for a first visit${service ? ` (${service.name})` : ""} on ${dayLabel(offer.day)} (ZIP ${offer.postal_code ?? "?"}). Not booked: the office confirms.${
          a.note ? ` ${a.note.slice(0, 300)}` : ""
        }`,
        serviceId: service?.id ?? null,
      });
    }
    await store.settleOffer(c.orgId, offer.id, { outcome: leadId ? "lead" : "handed_off", leadId });
    await store.notifyOffice({
      orgId: c.orgId,
      title: "AI receptionist: a visit to confirm",
      body: `${c.fromNumber} asked for ${dayLabel(offer.day)}. Not booked.`,
      link: leadId ? "/leads" : "/messages",
      eventKey: `receptionist-offer:${offer.id}`,
    });
    return {
      booked: false as const,
      status: "office_will_confirm" as const,
      date: offer.day,
      label: dayLabel(offer.day),
    };
  }

  // A client. Re-check the day with the same rule that offered it: a visit,
  // a blackout or a technician's time off may have landed since.
  const props = await store.properties(c.orgId, who.client.id);
  const property = props.find((p) => p.id === offer.property_id);
  if (!property) return refused("address_not_found");
  const zones = await store.zones(c.orgId);
  if (!inServiceArea(zones, property)) return { ...refused("outside_service_area"), handoff: true };
  const today = orgToday(org.timezone || DEFAULT_ORG_TIMEZONE, now);
  const horizon = Math.round(
    (Date.parse(`${offer.day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (horizon < 1) return refused("no_longer_available");
  const open = await openDays(store, c.orgId, org, today, horizon, property, who.client.id);
  if (!open.days.includes(offer.day)) return refused("no_longer_available");

  if (!(await store.claimOffer(c.orgId, offer.id))) return refused("already_in_progress");

  const label = dayLabel(offer.day);
  let ticket: { ticketId: string; created: boolean };
  try {
    ticket = await store.requestOneOff({
      portalToken: who.client.portal_token,
      propertyId: property.id,
      day: offer.day,
      message: `Asked by text (AI receptionist)${a.note ? `: ${a.note.slice(0, 300)}` : ""}`,
      // Only when a service other than the extra cleanup was named, so the
      // call for the extra cleanup is the four-argument call it always was.
      ...(service ? { serviceId: service.id } : {}),
    });
  } catch (e) {
    await store.releaseOffer(c.orgId, offer.id);
    const raw = (e as Error).message ?? "";
    const code = ONE_OFF_REFUSALS.find((r) => raw.includes(r)) ?? "refused";
    return refused(code === "already_scheduled" ? "no_longer_available" : code);
  }
  if (!ticket.created) {
    // The portal (or an earlier text) already asked for this day.
    await store.settleOffer(c.orgId, offer.id, { outcome: "requested", ticketId: ticket.ticketId });
    return {
      booked: false as const,
      status: "office_will_confirm" as const,
      date: offer.day,
      label,
    };
  }
  await store.markRequestedByText(c.orgId, ticket.ticketId);

  let visitId: string | null = null;
  if (booksStraightIn(org, service)) {
    try {
      const booked = await store.bookOneOff({
        orgId: c.orgId,
        clientId: who.client.id,
        propertyId: property.id,
        day: offer.day,
        // The extra cleanup at the owner's one-off price, as always; any
        // other service at ITS price, worked out by bookOneOffVisit for the
        // property's pets through the one rule (never a number from here).
        ...(service
          ? { priceCents: "service" as const, serviceId: service.id }
          : { priceCents: Number(org.one_off_price_cents) }),
        note: `${word} the client asked for by text (AI receptionist)`,
        window: open.window,
      });
      await store.linkTicketToVisit(c.orgId, ticket.ticketId, booked.visitId, booked.scheduledOn);
      visitId = booked.visitId;
    } catch {
      // As on the portal: the request stands and the office books it.
    }
  }
  await store.settleOffer(c.orgId, offer.id, {
    outcome: visitId ? "booked" : "requested",
    visitId,
    ticketId: ticket.ticketId,
  });
  if (!visitId) {
    await store.logActivity({
      orgId: c.orgId,
      clientId: who.client.id,
      propertyId: property.id,
      kind: "receptionist.visit_requested",
      summary: `Asked by text for ${service ? `a ${service.name}` : "an extra cleanup"} on ${label}; waiting for the office`,
    });
  }
  await store.notifyOffice({
    orgId: c.orgId,
    title: `${visitId ? "Booked by text" : "Asked by text"}: ${who.client.display_name ?? "a client"}`,
    body: `${word} ${visitId ? "booked" : "requested"} for ${label} by the AI receptionist.`,
    link: "/concerns",
    eventKey: `receptionist-offer:${offer.id}`,
  });
  return visitId
    ? {
        booked: true as const,
        status: "booked" as const,
        date: offer.day,
        label,
        arrival_window: windowLabel(open.window),
      }
    : { booked: false as const, status: "office_will_confirm" as const, date: offer.day, label };
}
