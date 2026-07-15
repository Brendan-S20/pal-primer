// Pure mapping between a subscription record and the client-detail edit form's
// field values (QA finding #8: the form showed hardcoded defaults — weekly,
// $25, 1 dog, no property/zone — instead of the existing subscription's real
// values, a silent data-loss risk on save). Kept pure so it can be unit-tested
// without a browser.

export type SubscriptionRecord = {
  id: string;
  frequency: string;
  price_cents: number;
  dog_count: number | null;
  unit_count: number | null;
  zone_id: string | null;
  property_id: string | null;
  billing_cadence: string | null;
  preferred_weekdays: number[] | null;
  started_on?: string | null;
  ends_on?: string | null;
};

export type SubscriptionFormValues = {
  propertyId: string;
  frequency: string;
  priceDollars: string;
  dogCount: string;
  unitCount: string;
  zoneId: string;
  billingCadence: "postpaid" | "prepaid";
  preferredWeekdays: number[];
  /** ISO date (YYYY-MM-DD). For one_time this is the visit date. */
  startedOn: string;
  /** ISO date or "" for no end date. Visits stop generating after it. */
  endsOn: string;
};

function localTodayISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Hydrate the form from an existing subscription — every field mirrors the record. */
export function subscriptionToFormValues(s: SubscriptionRecord): SubscriptionFormValues {
  return {
    propertyId: s.property_id ?? "",
    frequency: s.frequency,
    priceDollars: (s.price_cents / 100).toFixed(2),
    dogCount: String(s.dog_count ?? 1),
    unitCount: String(s.unit_count ?? 1),
    zoneId: s.zone_id ?? "",
    billingCadence: s.billing_cadence === "prepaid" ? "prepaid" : "postpaid",
    preferredWeekdays: s.preferred_weekdays ?? [],
    startedOn: s.started_on ?? localTodayISO(),
    endsOn: s.ends_on ?? "",
  };
}

/**
 * Blank "add new subscription" defaults. Auto-selects the property when the
 * client has exactly one (and that property's zone), so a new subscription
 * isn't silently created with no property attached.
 */
export function blankSubscriptionFormValues(opts: {
  properties: Array<{ id: string; zone_id?: string | null }>;
}): SubscriptionFormValues {
  const onlyProperty = opts.properties.length === 1 ? opts.properties[0] : null;
  return {
    propertyId: onlyProperty?.id ?? "",
    frequency: "weekly",
    priceDollars: "",
    dogCount: "1",
    unitCount: "1",
    zoneId: onlyProperty?.zone_id ?? "",
    billingCadence: "postpaid",
    preferredWeekdays: [],
    startedOn: localTodayISO(),
    endsOn: "",
  };
}
