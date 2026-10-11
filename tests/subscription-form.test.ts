import { describe, expect, it } from "vitest";
import {
  subscriptionToFormValues,
  blankSubscriptionFormValues,
  isServiceEnded,
  serviceScheduleState,
  liveServiceOrFilter,
} from "@/lib/subscription-form";

// The org's today, supplied by the caller since the builders stopped
// manufacturing their own (that manufacture was the bug: it answered with
// the device's clock, and on the server the UTC one).
const ORG_TODAY = "2026-07-16";

// Finding #8: the edit form must mirror the actual subscription record, not
// hardcoded defaults (weekly / $25 / 1 dog / no property).
const RECORD = {
  id: "sub-1",
  frequency: "biweekly",
  price_cents: 4500,
  dog_count: 2,
  unit_count: null,
  zone_id: "zone-9",
  property_id: "prop-7",
  billing_cadence: "postpaid",
  preferred_weekdays: [1, 3],
  started_on: "2026-07-01",
  ends_on: "2026-09-30",
  interval_weeks: null,
  interval_days: null,
  earliest_time: "08:00:00",
  latest_time: "12:30:00",
};

describe("subscriptionToFormValues (finding #8)", () => {
  it("hydrates every field from the record — no default drift", () => {
    expect(subscriptionToFormValues(RECORD, ORG_TODAY)).toEqual({
      propertyId: "prop-7",
      frequency: "biweekly",
      priceDollars: "45.00",
      dogCount: "2",
      unitCount: "1",
      zoneId: "zone-9",
      billingCadence: "postpaid",
      preferredWeekdays: [1, 3],
      // Not a set-days plan (subscriptions.weekdays, migration 20261010010000).
      weekdays: [],
      startedOn: "2026-07-01",
      endsOn: "2026-09-30",
      intervalWeeks: "",
      intervalDays: "",
      // HH:MM:SS from Postgres becomes HH:MM for input[type=time].
      earliestTime: "08:00",
      latestTime: "12:30",
    });
  });

  it("hydrates every-N-weeks and every-X-days intervals", () => {
    expect(
      subscriptionToFormValues({ ...RECORD, frequency: "weekly", interval_weeks: 3 }, ORG_TODAY).intervalWeeks,
    ).toBe("3");
    expect(
      subscriptionToFormValues({ ...RECORD, frequency: "every_n_days", interval_days: 5 }, ORG_TODAY)
        .intervalDays,
    ).toBe("5");
  });

  it("defaults start date to today and end date to open-ended when the record has none", () => {
    const v = subscriptionToFormValues({ ...RECORD, started_on: null, ends_on: null }, ORG_TODAY);
    expect(v.startedOn).toBe(ORG_TODAY);
    expect(v.endsOn).toBe("");
  });

  it("does not invent $25 or 'weekly' from a real record", () => {
    const v = subscriptionToFormValues(RECORD, ORG_TODAY);
    expect(v.priceDollars).not.toBe("25.00");
    expect(v.frequency).not.toBe("weekly");
  });

  it("carries a prepaid cadence through", () => {
    expect(subscriptionToFormValues({ ...RECORD, billing_cadence: "prepaid" }, ORG_TODAY).billingCadence).toBe(
      "prepaid",
    );
  });
});

describe("blankSubscriptionFormValues (finding #8)", () => {
  it("auto-selects the property (and its zone) when there is exactly one", () => {
    const v = blankSubscriptionFormValues({ properties: [{ id: "only-prop", zone_id: "z1" }], today: ORG_TODAY });
    expect(v.propertyId).toBe("only-prop");
    expect(v.zoneId).toBe("z1");
  });

  it("leaves the property unselected when there are several", () => {
    const v = blankSubscriptionFormValues({ properties: [{ id: "a" }, { id: "b" }], today: ORG_TODAY });
    expect(v.propertyId).toBe("");
  });

  it("uses an empty price rather than a misleading hardcoded default", () => {
    const v = blankSubscriptionFormValues({ properties: [], today: ORG_TODAY });
    expect(v.priceDollars).toBe("");
  });

  it("starts today with no end date", () => {
    const v = blankSubscriptionFormValues({ properties: [], today: ORG_TODAY });
    expect(v.startedOn).toBe(ORG_TODAY);
    expect(v.endsOn).toBe("");
  });
});

// UX round 4: ended services must actually read as ended everywhere.
describe("isServiceEnded", () => {
  const today = "2026-07-16";

  it("canceled status is ended regardless of dates", () => {
    expect(isServiceEnded({ status: "canceled", ends_on: null }, today)).toBe(true);
    expect(isServiceEnded({ status: "canceled", ends_on: "2027-01-01" }, today)).toBe(true);
  });

  it("an end date today or earlier is ended even if status never flipped", () => {
    expect(isServiceEnded({ status: "active", ends_on: "2026-07-16" }, today)).toBe(true);
    expect(isServiceEnded({ status: "active", ends_on: "2026-07-01" }, today)).toBe(true);
  });

  it("a future end date is still live", () => {
    expect(isServiceEnded({ status: "active", ends_on: "2026-07-17" }, today)).toBe(false);
  });

  it("open-ended active and paused services are live", () => {
    expect(isServiceEnded({ status: "active", ends_on: null }, today)).toBe(false);
    expect(isServiceEnded({ status: "paused", ends_on: null }, today)).toBe(false);
  });
});

// ── the one-off booking dead end ───────────────────────────────────────────
//
// Booking a one-off visit for TODAY produced a service with no visit, a banner
// reading "Its one-time visit is in the past" (false), and no Generate button,
// because canGenerate excluded one_time outright. Three things had to be true
// at once for the emergency case to be the one case that could not work.

describe("serviceScheduleState — why there is no upcoming visit", () => {
  const base = { status: "active", started_on: "2026-07-31" };
  const opts = { today: "2026-07-31", nextVisit: null, ended: false, paused: false };

  it("says a one-time visit booked for TODAY is unscheduled, not in the past", () => {
    const r = serviceScheduleState({ ...base, frequency: "one_time" }, opts);
    expect(r.reason).toBe("Its visit on 2026-07-31 hasn't been scheduled yet");
    expect(r.reason).not.toMatch(/in the past/);
  });

  it("offers a way to generate it", () => {
    // The half that made the wrong sentence unrecoverable.
    expect(serviceScheduleState({ ...base, frequency: "one_time" }, opts).canGenerate).toBe(true);
  });

  it("still says 'in the past' when the date really has gone by", () => {
    const r = serviceScheduleState(
      { ...base, frequency: "one_time", started_on: "2026-07-20" },
      opts,
    );
    expect(r.reason).toBe("Its one-time visit is in the past");
    // Generating a past-dated one-time service does nothing, so the button
    // would only look broken.
    expect(r.canGenerate).toBe(false);
  });

  it("leaves recurring services exactly as they were", () => {
    const r = serviceScheduleState({ ...base, frequency: "weekly" }, opts);
    expect(r.reason).toBe("Schedule hasn't been generated yet");
    expect(r.canGenerate).toBe(true);
  });

  it("explains a future start without offering to generate it", () => {
    const r = serviceScheduleState(
      { ...base, frequency: "weekly", started_on: "2026-08-10" },
      opts,
    );
    expect(r.reason).toBe("Starts 2026-08-10; visits appear once it begins");
    expect(r.canGenerate).toBe(false);
  });

  it("shows no banner at all when a visit is already scheduled", () => {
    for (const state of [
      { ...opts, nextVisit: "2026-08-01" },
      { ...opts, ended: true },
      { ...opts, paused: true },
    ]) {
      const r = serviceScheduleState({ ...base, frequency: "one_time" }, state);
      expect(r.reason).toBeNull();
      expect(r.canGenerate).toBe(false);
    }
  });
});

// ── "active" has to mean one thing ─────────────────────────────────────────
//
// listClients counted `status === 'active'` while the client's own Services tab
// used isServiceEnded. endSubscription only writes ends_on and leaves status
// 'active', so every ENDED service still counted as one the tenant was running.
// Latent — no row was in that state — until booking a one-off visit started
// creating one every time, because a one_time service carries
// ends_on = the visit date.
//
// These pin the contract listClients now shares with the tab.

describe("isServiceEnded is the single definition of a finished service", () => {
  const TODAY = "2026-07-31";

  it("treats a one-off whose day has passed as ended", () => {
    expect(isServiceEnded({ status: "active", ends_on: "2026-07-30" }, TODAY)).toBe(true);
  });

  it("treats a one-off booked for TODAY as ended once the day arrives", () => {
    // ends_on is inclusive of the visit date, so the service closes the same
    // day the work happens rather than lingering as an active service.
    expect(isServiceEnded({ status: "active", ends_on: TODAY }, TODAY)).toBe(true);
  });

  it("still counts a one-off booked for a future date as live", () => {
    expect(isServiceEnded({ status: "active", ends_on: "2026-08-05" }, TODAY)).toBe(false);
  });

  it("counts an ordinary open-ended service as live", () => {
    expect(isServiceEnded({ status: "active", ends_on: null }, TODAY)).toBe(false);
  });

  it("is not fooled by status alone, in either direction", () => {
    // The exact gap: status 'active' + a past ends_on is an ENDED service, and
    // counting on status alone is what made every ended service look running.
    expect(isServiceEnded({ status: "active", ends_on: "2020-01-01" }, TODAY)).toBe(true);
    expect(isServiceEnded({ status: "canceled", ends_on: null }, TODAY)).toBe(true);
  });
});

// ── the same rule, got wrong in four places ────────────────────────────────
//
// listClients, admin_generate_seasonal_deepcleans (in SQL, where it billed),
// the property service-time estimate, and the portal's "your plan" all asked
// `status = 'active'` and stopped. Ending a service writes ends_on and LEAVES
// status active, so that question has a different answer from "is this service
// still running". liveServiceOrFilter is the query-side twin of isServiceEnded.

describe("liveServiceOrFilter", () => {
  it("keeps open-ended services and those ending today or later", () => {
    // PostgREST `.or()` syntax: null OR ends_on >= today. `gte`, not `gt` —
    // a service ending TODAY is still running today.
    expect(liveServiceOrFilter("2026-07-31")).toBe("ends_on.is.null,ends_on.gte.2026-07-31");
  });

  it("agrees with isServiceEnded at the boundary", () => {
    // The two must not disagree about the same day, or a service is live to one
    // surface and finished to another — which is exactly the bug.
    const today = "2026-07-31";
    expect(liveServiceOrFilter(today)).toContain(`gte.${today}`);
    // isServiceEnded says a service ending BEFORE today is over...
    expect(isServiceEnded({ status: "active", ends_on: "2026-07-30" }, today)).toBe(true);
    // ...and the filter's gte excludes exactly those.
  });
});
