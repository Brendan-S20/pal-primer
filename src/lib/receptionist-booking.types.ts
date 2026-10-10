// The shapes and the store the AI receptionist's booking rules
// (receptionist-booking.ts) work through, and its few constants. Split out
// so the rules file stays readable; the real store is
// receptionist-booking-store.server.ts, the test one
// tests/support/fake-receptionist-store.ts.

import type { ZoneMatchFields } from "@/lib/zone-match";

export const RECEPTIONIST_DEFAULT_DAYS = 14;
/** A text is short. Five days is a choice; thirty is a calendar. */
export const RECEPTIONIST_SLOTS_SHOWN = 5;
/** How long an offered day can be accepted. A client who answers tomorrow
 *  morning is still answering; one who answers next week gets fresh days. */
export const OFFER_TTL_HOURS = 48;
export const RECEPTIONIST_ACTOR = "AI receptionist";

export type Caller = {
  orgId: string;
  fromNumber: string;
  /** The client the webhook matched by phone, or null. Re-checked here. */
  clientId: string | null;
};

export type OrgFacts = {
  timezone: string | null;
  work_days: number[] | null;
  one_off_price_cents: number | null;
  portal_auto_accept_bookings: boolean | null;
  route_windows: string | null;
};
export type ClientFacts = {
  id: string;
  organization_id: string;
  active: boolean;
  portal_token: string;
  display_name: string | null;
};
export type PropertyFacts = {
  id: string;
  client_id: string;
  label: string | null;
  street: string;
  city: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  account_type: string | null;
  zone_id: string | null;
  zone_override_reason: string | null;
};
export type ArrivalWindow = { earliest: string | null; latest: string | null };
export type Outcome = "booked" | "requested" | "lead" | "handed_off";
export type Offer = {
  id: string;
  organization_id: string;
  conversation_key: string;
  client_id: string | null;
  property_id: string | null;
  postal_code: string | null;
  day: string;
  window_start: string | null;
  window_end: string | null;
  expires_at: string;
  claimed_at: string | null;
  outcome: Outcome | null;
  visit_id: string | null;
  ticket_id: string | null;
};
export type NewOffer = Omit<Offer, "id" | "claimed_at" | "outcome" | "visit_id" | "ticket_id"> & {
  offered_at: string;
};

export interface ReceptionistStore {
  org(orgId: string): Promise<OrgFacts | null>;
  blackouts(orgId: string, after: string, through: string): Promise<string[]>;
  /** Active clients OF THIS ORG whose primary phone has these digits. */
  clientsWithPhone(orgId: string, digits: string): Promise<ClientFacts[]>;
  properties(orgId: string, clientId: string): Promise<PropertyFacts[]>;
  zones(orgId: string): Promise<ZoneMatchFields[]>;
  /** Days in (after, through] the property has a visit not skipped/canceled. */
  busyDays(orgId: string, propertyId: string, after: string, through: string): Promise<string[]>;
  /** The days, of those given, on which at least one tech is routable. */
  daysWithATech(orgId: string, days: string[]): Promise<Set<string>>;
  arrivalWindow(orgId: string, clientId: string, propertyId: string): Promise<ArrivalWindow | null>;
  saveOffers(rows: NewOffer[]): Promise<void>;
  findOffers(orgId: string, key: string, day: string): Promise<Offer[]>;
  /** Take the offer for one booking attempt. False if another has it. */
  claimOffer(orgId: string, offerId: string): Promise<boolean>;
  releaseOffer(orgId: string, offerId: string): Promise<void>;
  settleOffer(
    orgId: string,
    offerId: string,
    s: {
      outcome: Outcome;
      visitId?: string | null;
      ticketId?: string | null;
      leadId?: string | null;
    },
  ): Promise<void>;
  /** portal_request_one_off. Throws its refusal code as the message. */
  requestOneOff(a: {
    portalToken: string;
    propertyId: string;
    day: string;
    message: string;
  }): Promise<{
    ticketId: string;
    created: boolean;
  }>;
  markRequestedByText(orgId: string, ticketId: string): Promise<void>;
  bookOneOff(a: {
    orgId: string;
    clientId: string;
    propertyId: string;
    day: string;
    priceCents: number;
    note: string;
    window: ArrivalWindow | null;
  }): Promise<{ visitId: string; scheduledOn: string }>;
  linkTicketToVisit(orgId: string, ticketId: string, visitId: string, day: string): Promise<void>;
  createLead(a: {
    orgId: string;
    fromNumber: string;
    name: string;
    note: string;
  }): Promise<string | null>;
  logActivity(a: {
    orgId: string;
    clientId: string | null;
    propertyId: string | null;
    kind: string;
    summary: string;
  }): Promise<void>;
  notifyOffice(a: {
    orgId: string;
    title: string;
    body: string;
    link: string;
    eventKey: string;
  }): Promise<void>;
}
