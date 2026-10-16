// A client asks for a groom from the portal; the office books it.
//
// Pure data and functions shared by the portal page, its server functions,
// the Concerns inbox and the tests. The price and length come from groomQuote
// and groomHoldMinutes, the same two the office's booking dialog uses, so the
// client sees the number the office would book.

import {
  groomHoldMinutes,
  groomQuote,
  type CoatType,
  type GroomRule,
  type GroomService,
  type PetSize,
} from "@/lib/groom";

/** The windows a client can prefer. The office still picks the start time. */
export const GROOM_WINDOWS = {
  any: { label: "Any time", from: null, until: null },
  morning: { label: "Morning (8 to 12)", from: "08:00", until: "12:00" },
  afternoon: { label: "Afternoon (12 to 4)", from: "12:00", until: "16:00" },
  evening: { label: "Late afternoon (4 to 7)", from: "16:00", until: "19:00" },
} as const;
export type GroomWindow = keyof typeof GROOM_WINDOWS;
export const GROOM_WINDOW_KEYS = Object.keys(GROOM_WINDOWS) as GroomWindow[];

/** How far ahead a client can ask, the same bound portal_request_groom holds. */
export const GROOM_REQUEST_MAX_DAYS_AHEAD = 90;

/** The sentence a client reads for each code portal_request_groom raises.
 *  The database decides; this only words it. */
export const GROOM_REQUEST_REFUSALS: Record<string, string> = {
  invalid_token: "This portal link is no longer valid. Open the link in your most recent message.",
  grooming_not_offered: "Grooming isn't offered by this business.",
  pet_not_found: "Choose one of your pets.",
  service_not_offered: "That groom isn't offered right now. Please pick another.",
  addon_not_offered: "One of those add-ons isn't offered right now. Please check them again.",
  date_too_soon: "The earliest day you can ask for is tomorrow.",
  date_too_far: `You can ask for a day up to ${GROOM_REQUEST_MAX_DAYS_AHEAD} days ahead.`,
  not_a_working_day: "We don't groom that day. Please pick another.",
  blackout_day: "We're closed that day. Please pick another.",
  bad_window: "Choose a time of day.",
  bad_quote: "We couldn't price that groom. Please contact us.",
  too_many_open_requests:
    "You have ten groom requests waiting for us already. We'll be in touch about those first.",
};

export function groomRequestRefusal(message: string): string {
  const code = Object.keys(GROOM_REQUEST_REFUSALS).find((c) => message.includes(c));
  return code
    ? GROOM_REQUEST_REFUSALS[code]
    : "That request could not be sent. Please try again, or contact us.";
}

export type GroomRequestAddon = { addonServiceId: string; quantity: number };

/** What the portal shows and the request stores: groomQuote for one pet and
 *  its add-ons, held for the business's setup and cleanup minutes. Null cents
 *  when the business has no price for this pet yet; the request still goes to
 *  the office, which prices it when booking. */
export function groomRequestQuote(input: {
  service: GroomService & { id: string };
  rules: readonly (GroomRule & { service_id: string })[];
  pet: { id: string; name: string; size: PetSize | null; coat_type: CoatType | null };
  addons: readonly {
    id: string;
    name: string;
    unit_price_cents: number;
    duration_min: number | null;
  }[];
  picked: readonly GroomRequestAddon[];
  bufferMin: number | null | undefined;
}): { cents: number | null; minutes: number } {
  const quote = groomQuote({
    service: input.service,
    rules: input.rules.filter((r) => r.service_id === input.service.id),
    pets: [input.pet],
    addons: input.picked.flatMap((p) => {
      const a = input.addons.find((x) => x.id === p.addonServiceId);
      return a
        ? [
            {
              id: a.id,
              name: a.name,
              unit_price_cents: a.unit_price_cents,
              duration_min: a.duration_min ?? 0,
              quantity: p.quantity,
            },
          ]
        : [];
    }),
  });
  return {
    cents: quote.cents,
    minutes: quote.minutes > 0 ? groomHoldMinutes(quote.minutes, input.bufferMin) : 0,
  };
}

/** "HH:MM" from a Postgres time ("08:00:00"), or null. */
export function clockOf(value: string | null | undefined): string | null {
  const m = /^(\d{2}):(\d{2})/.exec(value ?? "");
  return m ? `${m[1]}:${m[2]}` : null;
}

/** The window a stored request asked for, as the key the form uses. */
export function groomWindowOf(
  from: string | null | undefined,
  until: string | null | undefined,
): GroomWindow {
  const f = clockOf(from);
  const u = clockOf(until);
  const hit = GROOM_WINDOW_KEYS.find(
    (k) => GROOM_WINDOWS[k].from === f && GROOM_WINDOWS[k].until === u,
  );
  return hit ?? "any";
}

/** What the office's booking dialog opens with, from a groom request. */
export type GroomBookingPrefill = {
  propertyId: string;
  serviceId: string;
  petIds: string[];
  addons: GroomRequestAddon[];
  scheduledOn: string;
  /** The start of the preferred window, when the client gave one. */
  startTime: string | null;
};

export function groomPrefillFromRequest(ticket: {
  property_id: string | null;
  service_id: string | null;
  dog_id: string | null;
  requested_on: string | null;
  requested_time: string | null;
  groom_addons: unknown;
}): GroomBookingPrefill | null {
  if (!ticket.property_id || !ticket.service_id || !ticket.dog_id || !ticket.requested_on)
    return null;
  const addons = Array.isArray(ticket.groom_addons)
    ? ticket.groom_addons.flatMap((a: unknown) => {
        const row = a as { addon_service_id?: unknown; quantity?: unknown };
        return typeof row?.addon_service_id === "string" &&
          typeof row.quantity === "number" &&
          row.quantity > 0
          ? [{ addonServiceId: row.addon_service_id, quantity: row.quantity }]
          : [];
      })
    : [];
  return {
    propertyId: ticket.property_id,
    serviceId: ticket.service_id,
    petIds: [ticket.dog_id],
    addons,
    scheduledOn: ticket.requested_on,
    startTime: clockOf(ticket.requested_time),
  };
}
