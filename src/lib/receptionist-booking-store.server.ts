// The database behind receptionist-booking.ts. Service role: the inbound
// webhook has no signed-in user, so tenancy is never left to RLS here -- every
// read and write names the organization explicitly, and the rules module
// checks what comes back against it again.
//
// Each method is the existing query or RPC for its question, not a new one:
//   blackouts / work days   what portalOneOffBookingOptions reads
//   busyDays                portal_request_one_off's "already_scheduled"
//   daysWithATech           routable_staff, the planner's eligibility rule
//   arrivalWindow           the service's window, else the property's legacy
//                           pair (the rule in 20261002090000 and the screens)
//   services                the business's catalog, as portalOneOffBookingOptions
//                           reads it (every row of this org; the rules filter)
//   requestOneOff           portal_request_one_off itself
//   bookOneOff              bookOneOffVisit, as the portal's auto-accept
//   notifyOffice            notifyRoles, the one door notifications leave by
//
// It sends nothing to the client. The reply to the text is the webhook's
// TwiML answer, from the business's own number; no SMS is sent from here.

import type { ReceptionistStore } from "@/lib/receptionist-booking.types";
import { RECEPTIONIST_ACTOR } from "@/lib/receptionist-booking.types";

const OFFERS = "ai_receptionist_offers";

export function supabaseReceptionistStore(
  supabaseAdmin: any,
  opts: {
    createLead: ReceptionistStore["createLead"];
  },
): ReceptionistStore {
  return {
    async org(orgId) {
      const { data } = await supabaseAdmin
        .from("organizations")
        .select(
          "timezone, work_days, one_off_price_cents, portal_auto_accept_bookings, route_windows",
        )
        .eq("id", orgId)
        .maybeSingle();
      return data ?? null;
    },

    async blackouts(orgId, after, through) {
      const { data } = await supabaseAdmin
        .from("blackout_dates")
        .select("blackout_on")
        .eq("organization_id", orgId)
        .gt("blackout_on", after)
        .lte("blackout_on", through);
      return ((data ?? []) as Array<{ blackout_on: string }>).map((b) => b.blackout_on);
    },

    async clientsWithPhone(orgId, digits) {
      // The same match the webhook makes (digits of primary_phone), asked
      // again so a booking never rests on a match made somewhere else.
      const { data } = await supabaseAdmin
        .from("clients")
        .select("id, organization_id, active, portal_token, display_name, primary_phone")
        .eq("organization_id", orgId)
        .eq("active", true)
        .not("primary_phone", "is", null);
      return ((data ?? []) as Array<any>)
        .filter((c) => String(c.primary_phone ?? "").replace(/\D/g, "") === digits)
        .map(({ primary_phone: _p, ...c }) => c);
    },

    async properties(orgId, clientId) {
      const { data } = await supabaseAdmin
        .from("properties")
        .select(
          "id, client_id, label, street, city, postal_code, latitude, longitude, account_type, zone_id, zone_override_reason",
        )
        .eq("organization_id", orgId)
        .eq("client_id", clientId)
        .is("archived_at", null)
        .order("created_at");
      return data ?? [];
    },

    async services(orgId) {
      const { data } = await supabaseAdmin
        .from("services")
        .select(
          "id, name, service_line, active, price_unit, base_price_cents, extra_pet_cents, default_duration_min",
        )
        .eq("organization_id", orgId)
        .order("created_at");
      return data ?? [];
    },

    async zones(orgId) {
      const { data } = await supabaseAdmin
        .from("zones")
        .select(
          "id, name, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
        )
        .eq("organization_id", orgId);
      return data ?? [];
    },

    async busyDays(orgId, propertyId, after, through) {
      const { data } = await supabaseAdmin
        .from("visits")
        .select("scheduled_on")
        .eq("organization_id", orgId)
        .eq("property_id", propertyId)
        .gt("scheduled_on", after)
        .lte("scheduled_on", through)
        .not("status", "in", "(skipped,canceled)");
      return ((data ?? []) as Array<{ scheduled_on: string }>).map((v) => v.scheduled_on);
    },

    async daysWithATech(orgId, days) {
      const { data: staff } = await supabaseAdmin
        .from("staff")
        .select("id")
        .eq("organization_id", orgId)
        .eq("active", true)
        .eq("is_field_tech", true);
      const ids = ((staff ?? []) as Array<{ id: string }>).map((s) => s.id);
      const open = new Set<string>();
      if (!ids.length) return open;
      await Promise.all(
        days.map(async (day) => {
          const { data, error } = await supabaseAdmin.rpc("routable_staff", {
            _org_id: orgId,
            _staff_ids: ids,
            _day: day,
          });
          if (!error && Array.isArray(data) && data.length > 0) open.add(day);
        }),
      );
      return open;
    },

    async arrivalWindow(orgId, clientId, propertyId) {
      const { data: sub } = await supabaseAdmin
        .from("subscriptions")
        .select("earliest_time, latest_time")
        .eq("organization_id", orgId)
        .eq("client_id", clientId)
        .eq("property_id", propertyId)
        .eq("status", "active")
        .order("started_on", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (sub?.earliest_time || sub?.latest_time) {
        return { earliest: sub.earliest_time ?? null, latest: sub.latest_time ?? null };
      }
      const { data: prop } = await supabaseAdmin
        .from("properties")
        .select("earliest_service_time, latest_service_time")
        .eq("organization_id", orgId)
        .eq("id", propertyId)
        .maybeSingle();
      if (prop?.earliest_service_time || prop?.latest_service_time) {
        return {
          earliest: prop.earliest_service_time ?? null,
          latest: prop.latest_service_time ?? null,
        };
      }
      return null;
    },

    async saveOffers(rows) {
      if (!rows.length) return;
      const { error } = await supabaseAdmin
        .from(OFFERS)
        .upsert(rows, { onConflict: "organization_id,conversation_key,day,target" });
      if (error) throw new Error(error.message);
    },

    async findOffers(orgId, key, day) {
      const { data } = await supabaseAdmin
        .from(OFFERS)
        .select(
          "id, organization_id, conversation_key, client_id, property_id, postal_code, day, window_start, window_end, expires_at, claimed_at, outcome, visit_id, ticket_id",
        )
        .eq("organization_id", orgId)
        .eq("conversation_key", key)
        .eq("day", day);
      return data ?? [];
    },

    async claimOffer(orgId, offerId) {
      // Conditional: only the first of two concurrent "yes"es gets a row back.
      const { data } = await supabaseAdmin
        .from(OFFERS)
        .update({ claimed_at: new Date().toISOString() })
        .eq("organization_id", orgId)
        .eq("id", offerId)
        .is("claimed_at", null)
        .is("outcome", null)
        .select("id");
      return Array.isArray(data) && data.length === 1;
    },

    async releaseOffer(orgId, offerId) {
      await supabaseAdmin
        .from(OFFERS)
        .update({ claimed_at: null })
        .eq("organization_id", orgId)
        .eq("id", offerId)
        .is("outcome", null);
    },

    async settleOffer(orgId, offerId, s) {
      await supabaseAdmin
        .from(OFFERS)
        .update({
          outcome: s.outcome,
          settled_at: new Date().toISOString(),
          visit_id: s.visitId ?? null,
          ticket_id: s.ticketId ?? null,
          lead_id: s.leadId ?? null,
        })
        .eq("organization_id", orgId)
        .eq("id", offerId);
    },

    async requestOneOff(a) {
      const { data, error } = await supabaseAdmin.rpc("portal_request_one_off", {
        _token: a.portalToken,
        _property_id: a.propertyId,
        _on: a.day,
        _message: a.message,
        // The service asked for (20261011100200), only when one was named.
        ...(a.serviceId ? { _service_id: a.serviceId } : {}),
      });
      if (error) throw new Error(error.message);
      const row = ((data ?? []) as Array<{ ticket_id: string; created: boolean }>)[0];
      if (!row?.ticket_id) throw new Error("request_not_saved");
      return { ticketId: row.ticket_id, created: !!row.created };
    },

    async markRequestedByText(orgId, ticketId) {
      await supabaseAdmin
        .from("qc_tickets")
        .update({ requested_via: "ai_receptionist" })
        .eq("organization_id", orgId)
        .eq("id", ticketId);
    },

    async bookOneOff(a) {
      const { bookOneOffVisit } = await import("@/lib/one-off-visit.server");
      const booked = await bookOneOffVisit(supabaseAdmin, {
        orgId: a.orgId,
        actorUserId: null,
        clientId: a.clientId,
        propertyId: a.propertyId,
        scheduledOn: a.day,
        priceCents: a.priceCents,
        serviceId: a.serviceId ?? null,
        note: a.note,
        asService: true,
        actorLabel: RECEPTIONIST_ACTOR,
        bookedVia: "ai_receptionist",
        earliestTime: a.window?.earliest ?? null,
        latestTime: a.window?.latest ?? null,
      });
      return { visitId: booked.visitId, scheduledOn: booked.scheduledOn };
    },

    async linkTicketToVisit(orgId, ticketId, visitId, day) {
      // What portalRequestOneOff writes after an auto-accept booking.
      await supabaseAdmin
        .from("qc_tickets")
        .update({
          booked_visit_id: visitId,
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolution_note: `Booked for ${day} by the AI receptionist.`,
        })
        .eq("organization_id", orgId)
        .eq("id", ticketId);
    },

    createLead: opts.createLead,

    async logActivity(a) {
      try {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(supabaseAdmin, {
          ...a,
          actorUserId: null,
          actorLabel: RECEPTIONIST_ACTOR,
        });
      } catch {
        // The timeline is best-effort, as everywhere else.
      }
    },

    async notifyOffice(a) {
      try {
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager", "dispatcher"], {
          orgId: a.orgId,
          type: "receptionist_booking",
          title: a.title,
          body: a.body,
          link: a.link,
          eventKey: a.eventKey,
        });
      } catch (e) {
        console.error("[receptionist] office notification failed", (e as Error).message);
      }
    },
  };
}
