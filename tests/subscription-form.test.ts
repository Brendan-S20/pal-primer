import { describe, expect, it } from "vitest";
import {
  subscriptionToFormValues,
  blankSubscriptionFormValues,
  isServiceEnded,
  serviceScheduleState,
} from "@/lib/subscription-form";

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
    expect(subscriptionToFormValues(RECORD)).toEqual({
      propertyId: "prop-7",
      frequency: "biweekly",
      priceDollars: "45.00",
      dogCount: "2",
      unitCount: "1",
      zoneId: "zone-9",
      billingCadence: "postpaid",
      preferredWeekdays: [1, 3],
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
      subscriptionToFormValues({ ...RECORD, frequency: "weekly", interval_weeks: 3 }).intervalWeeks,
    ).toBe("3");
    expect(
      subscriptionToFormValues({ ...RECORD, frequency: "every_n_days", interval_days: 5 })
        .intervalDays,
    ).toBe("5");
  });

  it("defaults start date to today and end date to open-ended when the record has none", () => {
    const v = subscriptionToFormValues({ ...RECORD, started_on: null, ends_on: null });
    expect(v.startedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.endsOn).toBe("");
  });

  it("does not invent $25 or 'weekly' from a real record", () => {
    const v = subscriptionToFormValues(RECORD);
    expect(v.priceDollars).not.toBe("25.00");
    expect(v.frequency).not.toBe("weekly");
  });

  it("carries a prepaid cadence through", () => {
    expect(subscriptionToFormValues({ ...RECORD, billing_cadence: "prepaid" }).billingCadence).toBe(
      "prepaid",
    );
  });
});

describe("blankSubscriptionFormValues (finding #8)", () => {
  it("auto-selects the property (and its zone) when there is exactly one", () => {
    const v = blankSubscriptionFormValues({ properties: [{ id: "only-prop", zone_id: "z1" }] });
    expect(v.propertyId).toBe("only-prop");
    expect(v.zoneId).toBe("z1");
  });

  it("leaves the property unselected when there are several", () => {
    const v = blankSubscriptionFormValues({ properties: [{ id: "a" }, { id: "b" }] });
    expect(v.propertyId).toBe("");
  });

  it("uses an empty price rather than a misleading hardcoded default", () => {
    const v = blankSubscriptionFormValues({ properties: [] });
    expect(v.priceDollars).toBe("");
  });

  it("starts today with no end date", () => {
    const v = blankSubscriptionFormValues({ properties: [] });
    expect(v.startedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
