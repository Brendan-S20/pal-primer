/**
 * An in-memory ReceptionistStore (src/lib/receptionist-booking.ts) for the
 * receptionist's booking tests. It answers each question the way the real
 * store's query or RPC does, from rows a test puts in, so the rules module
 * can be driven through every branch without a database:
 *
 *   daysWithATech   routable_staff: active, field tech, routing, not off
 *   requestOneOff   portal_request_one_off: token -> active client, the
 *                   client's own live property, tomorrow..+30 on the org's
 *                   calendar, a work day, no blackout, idempotent per
 *                   property, day and service, "already_scheduled" per
 *                   service, and "service_not_offered" for a service that
 *                   is not this org's or is retired (pet waste folds to
 *                   none, as the SQL does)
 *   bookOneOff      bookOneOffVisit: a scheduled visit at the given price,
 *                   or at the service's price for the property's pets
 *                   (servicePriceCents) when asked to price "service"
 *
 * Every await takes a tick, so two calls awaited together interleave the
 * way two webhook requests do. Nothing here sends anything anywhere.
 */
import type {
  ArrivalWindow,
  ClientFacts,
  NewOffer,
  Offer,
  OrgFacts,
  PropertyFacts,
  ReceptionistStore,
  ServiceFacts,
} from "../../src/lib/receptionist-booking.types";
import { bookableDays } from "../../src/lib/one-off-booking";
import { orgToday } from "../../src/lib/org-day";
import { isZonePriced, servicePriceCents } from "../../src/lib/services";
import type { ZoneMatchFields } from "../../src/lib/zone-match";
import type { ServiceLineAvailability } from "../../src/lib/service-lines";
import { LAUNCH_DEFAULT } from "./service-line-availability";

const tick = () => new Promise((r) => setTimeout(r, 0));

export type FakeVisit = {
  id: string;
  orgId: string;
  clientId: string;
  propertyId: string;
  day: string;
  status: string;
  priceCents: number | null;
  bookedVia: string | null;
  serviceId?: string | null;
};

export class FakeReceptionistDb {
  now: Date;
  orgs = new Map<string, OrgFacts>();
  blackoutRows: { orgId: string; day: string }[] = [];
  clients: (ClientFacts & { primary_phone: string })[] = [];
  props: (PropertyFacts & { organization_id: string })[] = [];
  /** The catalog, per org. */
  serviceRows: (ServiceFacts & { organization_id: string })[] = [];
  /** The platform switch (#531). The migration's default unless a test says. */
  availability: ServiceLineAvailability = LAUNCH_DEFAULT;
  /** Active dogs at a property, as bookOneOffVisit counts them. Unset: one. */
  petsAt = new Map<string, number>();
  zoneRows: { orgId: string; zone: ZoneMatchFields }[] = [];
  visits: FakeVisit[] = [];
  staff: {
    id: string;
    orgId: string;
    active: boolean;
    is_field_tech: boolean;
    routing_available: boolean;
  }[] = [];
  timeOff: { staffId: string; starts: string; ends: string }[] = [];
  windows = new Map<string, ArrivalWindow>();
  offers: (Offer & { target: string; offered_at: string })[] = [];
  tickets: {
    id: string;
    orgId: string;
    clientId: string;
    propertyId: string;
    day: string;
    status: string;
    requestedVia: string | null;
    bookedVisitId: string | null;
    serviceId: string | null;
  }[] = [];
  leads: {
    id: string;
    orgId: string;
    name: string;
    phone: string;
    note: string;
    source: string;
    serviceId: string | null;
  }[] = [];
  activity: { orgId: string; clientId: string | null; kind: string; summary: string }[] = [];
  notices: { orgId: string; title: string; body: string; eventKey: string }[] = [];
  private n = 1;

  constructor(now: Date) {
    this.now = now;
  }

  id(prefix: string) {
    return `${prefix}-${this.n++}`;
  }

  store(): ReceptionistStore {
    const db = this;
    return {
      async org(orgId) {
        await tick();
        return db.orgs.get(orgId) ?? null;
      },
      async blackouts(orgId, after, through) {
        await tick();
        return db.blackoutRows
          .filter((b) => b.orgId === orgId && b.day > after && b.day <= through)
          .map((b) => b.day);
      },
      async clientsWithPhone(orgId, digits) {
        await tick();
        return db.clients
          .filter(
            (c) =>
              c.organization_id === orgId &&
              c.active &&
              c.primary_phone.replace(/\D/g, "") === digits,
          )
          .map(({ primary_phone: _p, ...c }) => c);
      },
      async properties(orgId, clientId) {
        await tick();
        return db.props
          .filter((p) => p.organization_id === orgId && p.client_id === clientId)
          .map(({ organization_id: _o, ...p }) => p);
      },
      async services(orgId) {
        await tick();
        return db.serviceRows
          .filter((s) => s.organization_id === orgId)
          .map(({ organization_id: _o, ...s }) => s);
      },
      async serviceLineAvailability() {
        await tick();
        return db.availability;
      },
      async zones(orgId) {
        await tick();
        return db.zoneRows.filter((z) => z.orgId === orgId).map((z) => z.zone);
      },
      async busyDays(orgId, propertyId, after, through) {
        await tick();
        return db.visits
          .filter(
            (v) =>
              v.orgId === orgId &&
              v.propertyId === propertyId &&
              v.day > after &&
              v.day <= through &&
              !["skipped", "canceled"].includes(v.status),
          )
          .map((v) => v.day);
      },
      async daysWithATech(orgId, days) {
        await tick();
        const out = new Set<string>();
        for (const day of days) {
          const someone = db.staff.some(
            (s) =>
              s.orgId === orgId &&
              s.active &&
              s.is_field_tech &&
              s.routing_available &&
              !db.timeOff.some((t) => t.staffId === s.id && day >= t.starts && day <= t.ends),
          );
          if (someone) out.add(day);
        }
        return out;
      },
      async arrivalWindow(_orgId, clientId, propertyId) {
        await tick();
        return db.windows.get(`${clientId}:${propertyId}`) ?? null;
      },
      async saveOffers(rows: NewOffer[]) {
        await tick();
        for (const r of rows) {
          const target = r.property_id ?? `zip:${r.postal_code ?? ""}`;
          const hit = db.offers.find(
            (o) =>
              o.organization_id === r.organization_id &&
              o.conversation_key === r.conversation_key &&
              o.day === r.day &&
              o.target === target,
          );
          if (hit) Object.assign(hit, r);
          else
            db.offers.push({
              ...r,
              id: db.id("offer"),
              target,
              claimed_at: null,
              outcome: null,
              visit_id: null,
              ticket_id: null,
            });
        }
      },
      async findOffers(orgId, key, day) {
        await tick();
        return db.offers
          .filter((o) => o.organization_id === orgId && o.conversation_key === key && o.day === day)
          .map((o) => ({ ...o }));
      },
      async claimOffer(orgId, offerId) {
        await tick();
        const o = db.offers.find((x) => x.id === offerId && x.organization_id === orgId);
        if (!o || o.claimed_at || o.outcome) return false;
        o.claimed_at = db.now.toISOString();
        return true;
      },
      async releaseOffer(orgId, offerId) {
        await tick();
        const o = db.offers.find((x) => x.id === offerId && x.organization_id === orgId);
        if (o && !o.outcome) o.claimed_at = null;
      },
      async settleOffer(orgId, offerId, s) {
        await tick();
        const o = db.offers.find((x) => x.id === offerId && x.organization_id === orgId);
        if (!o) return;
        o.outcome = s.outcome;
        o.visit_id = s.visitId ?? null;
        o.ticket_id = s.ticketId ?? null;
      },
      async requestOneOff(a) {
        await tick();
        const client = db.clients.find((c) => c.portal_token === a.portalToken && c.active);
        if (!client) throw new Error("invalid_token");
        const prop = db.props.find(
          (p) =>
            p.id === a.propertyId &&
            p.client_id === client.id &&
            p.organization_id === client.organization_id,
        );
        if (!prop) throw new Error("property_not_found");
        // The service asked for: this org's and active, or refused; pet
        // waste is the extra cleanup, recorded as none (20261011100200).
        let serviceId: string | null = null;
        if (a.serviceId) {
          const svc = db.serviceRows.find(
            (s) => s.id === a.serviceId && s.organization_id === client.organization_id && s.active,
          );
          if (!svc) throw new Error("service_not_offered");
          serviceId = isZonePriced(svc) ? null : svc.id;
        }
        const org = db.orgs.get(client.organization_id)!;
        const today = orgToday(org.timezone ?? "America/Chicago", db.now);
        if (a.day < today) throw new Error("date_in_past");
        if (a.day === today) throw new Error("date_too_soon");
        const allowed = bookableDays(
          today,
          org.work_days,
          db.blackoutRows.filter((b) => b.orgId === client.organization_id).map((b) => b.day),
        );
        if (!allowed.includes(a.day)) throw new Error("not_a_working_day");
        const asked = db.tickets.find(
          (t) =>
            t.clientId === client.id &&
            t.propertyId === prop.id &&
            t.day === a.day &&
            (t.serviceId ?? null) === serviceId,
        );
        if (asked) return { ticketId: asked.id, created: false };
        // A visit OF THIS SERVICE that day (a visit with no service is the
        // org's default, the extra cleanup).
        if (
          db.visits.some(
            (v) =>
              v.propertyId === prop.id &&
              v.day === a.day &&
              (v.serviceId ?? null) === serviceId &&
              !["skipped", "canceled"].includes(v.status),
          )
        )
          throw new Error("already_scheduled");
        const id = db.id("ticket");
        db.tickets.push({
          id,
          orgId: client.organization_id,
          clientId: client.id,
          propertyId: prop.id,
          day: a.day,
          status: "received",
          requestedVia: null,
          bookedVisitId: null,
          serviceId,
        });
        return { ticketId: id, created: true };
      },
      async markRequestedByText(orgId, ticketId) {
        await tick();
        const t = db.tickets.find((x) => x.id === ticketId && x.orgId === orgId);
        if (t) t.requestedVia = "ai_receptionist";
      },
      async bookOneOff(a) {
        await tick();
        const client = db.clients.find((c) => c.id === a.clientId);
        if (!client || client.organization_id !== a.orgId)
          throw new Error("That client is not in your organization");
        // bookOneOffVisit's pricing, restated: "service" prices the named
        // service for the property's active dogs through the one rule, and
        // refuses a service that is not this org's, retired, or unpriced.
        let priceCents: number;
        if (a.priceCents === "service") {
          if (!a.serviceId) throw new Error("A service is needed to price this visit");
          const svc = db.serviceRows.find((s) => s.id === a.serviceId);
          if (!svc || svc.organization_id !== a.orgId || !svc.active)
            throw new Error("That service is not offered");
          const cents = servicePriceCents(svc, { pets: db.petsAt.get(a.propertyId) ?? 1 });
          if (cents == null) throw new Error("That service has no price yet");
          priceCents = cents;
        } else {
          priceCents = a.priceCents;
        }
        const id = db.id("visit");
        db.visits.push({
          id,
          orgId: a.orgId,
          clientId: a.clientId,
          propertyId: a.propertyId,
          day: a.day,
          status: "scheduled",
          priceCents,
          bookedVia: "ai_receptionist",
          serviceId: a.serviceId ?? null,
        });
        db.activity.push({
          orgId: a.orgId,
          clientId: a.clientId,
          kind: "visit.created",
          summary: a.note,
        });
        return { visitId: id, scheduledOn: a.day };
      },
      async linkTicketToVisit(orgId, ticketId, visitId) {
        await tick();
        const t = db.tickets.find((x) => x.id === ticketId && x.orgId === orgId);
        if (t) {
          t.bookedVisitId = visitId;
          t.status = "resolved";
        }
      },
      async createLead(a) {
        await tick();
        const id = db.id("lead");
        db.leads.push({
          id,
          orgId: a.orgId,
          name: a.name,
          phone: a.fromNumber,
          note: a.note,
          source: "sms_receptionist",
          serviceId: a.serviceId ?? null,
        });
        return id;
      },
      async logActivity(a) {
        await tick();
        db.activity.push({
          orgId: a.orgId,
          clientId: a.clientId,
          kind: a.kind,
          summary: a.summary,
        });
      },
      async notifyOffice(a) {
        await tick();
        if (db.notices.some((x) => x.eventKey === a.eventKey)) return;
        db.notices.push({ orgId: a.orgId, title: a.title, body: a.body, eventKey: a.eventKey });
      },
    };
  }
}

/** Two businesses, A and B, on weekdays in Chicago. A has one client with
 *  one property in its one zone and one technician. B has a client of its
 *  own. Monday 12 Oct 2026, 10am in Chicago. */
export function twoBusinesses() {
  const db = new FakeReceptionistDb(new Date("2026-10-12T15:00:00Z"));
  const weekdays = [1, 2, 3, 4, 5];
  db.orgs.set("org-a", {
    timezone: "America/Chicago",
    work_days: weekdays,
    one_off_price_cents: 4500,
    portal_auto_accept_bookings: true,
    route_windows: "honour",
  });
  db.orgs.set("org-b", {
    timezone: "America/Chicago",
    work_days: weekdays,
    one_off_price_cents: 9900,
    portal_auto_accept_bookings: true,
    route_windows: "honour",
  });
  db.zoneRows.push(
    { orgId: "org-a", zone: { id: "zone-a", zip_codes: ["60601"], priority: 0 } },
    { orgId: "org-b", zone: { id: "zone-b", zip_codes: ["60601", "60602"], priority: 0 } },
  );
  db.staff.push(
    { id: "tech-a", orgId: "org-a", active: true, is_field_tech: true, routing_available: true },
    { id: "tech-b", orgId: "org-b", active: true, is_field_tech: true, routing_available: true },
  );
  db.clients.push(
    {
      id: "client-a",
      organization_id: "org-a",
      active: true,
      portal_token: "token-a",
      display_name: "Ada Client",
      primary_phone: "+1 (312) 555-0101",
    },
    {
      id: "client-b",
      organization_id: "org-b",
      active: true,
      portal_token: "token-b",
      display_name: "Bea Client",
      primary_phone: "+1 (312) 555-0202",
    },
  );
  const prop = (id: string, org: string, client: string, street: string, zip: string) => ({
    id,
    organization_id: org,
    client_id: client,
    label: null,
    street,
    city: "Chicago",
    postal_code: zip,
    latitude: null,
    longitude: null,
    account_type: "residential",
    zone_id: null,
    zone_override_reason: null,
  });
  db.props.push(
    prop("prop-a", "org-a", "client-a", "1 Ada St", "60601"),
    prop("prop-b", "org-b", "client-b", "2 Bea St", "60602"),
  );
  // What each sells. A scoops and walks (and lists a drop-in it has not
  // priced, and a walk it retired); B scoops only, as every business did
  // before the catalog.
  const svc = (
    id: string,
    org: string,
    name: string,
    line: ServiceFacts["service_line"],
    base: number | null,
    extra = 0,
    minutes: number | null = 30,
    active = true,
  ): ServiceFacts & { organization_id: string } => ({
    id,
    organization_id: org,
    name,
    service_line: line,
    active,
    price_unit: "visit",
    base_price_cents: base,
    extra_pet_cents: extra,
    default_duration_min: minutes,
  });
  db.serviceRows.push(
    svc("pw-a", "org-a", "Pet waste removal", "pet_waste", null, 0, null),
    svc("walk-a", "org-a", "30-minute walk", "dog_walking", 2500, 500),
    svc("dropin-a", "org-a", "Drop-in", "pet_sitting", null, 0, 20),
    svc("old-walk-a", "org-a", "Old walk", "dog_walking", 2000, 0, 30, false),
    svc("pw-b", "org-b", "Pet waste removal", "pet_waste", null, 0, null),
  );
  return {
    db,
    store: db.store(),
    clientA: { orgId: "org-a", fromNumber: "+13125550101", clientId: "client-a" },
    clientB: { orgId: "org-b", fromNumber: "+13125550202", clientId: "client-b" },
    stranger: { orgId: "org-a", fromNumber: "+17735550999", clientId: null },
  };
}
