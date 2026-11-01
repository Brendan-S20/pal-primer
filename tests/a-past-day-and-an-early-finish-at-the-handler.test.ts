// #654, F-23, at the server functions themselves rather than their source:
// a past day is refused before anything is written, and completing a visit on
// a later day is refused without a confirm and goes through with one.
//
// The handlers run against a stub client. Nothing reaches a real Supabase.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orgToday } from "@/lib/org-day";
import { FUTURE_COMPLETE_REFUSAL, PAST_DAY_REFUSAL, shiftDay } from "@/lib/booking-dates";

const TZ = "America/Detroit";
const TODAY = orgToday(TZ);
const VISIT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const PROPERTY = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
  visit: { scheduled_on: "", status: "scheduled" },
  rpc: vi.fn(async () => ({ data: null, error: null })),
  bookOneOff: vi.fn(async () => ({ visitId: "v" })),
}));

/** Enough of PostgREST for these handlers: every read answers by table. */
function stubClient() {
  const rowFor = (table: string) =>
    table === "organizations"
      ? { timezone: "America/Detroit" }
      : table === "visits"
        ? {
            id: VISIT,
            organization_id: "org-1",
            client_id: CLIENT,
            property_id: PROPERTY,
            ...state.visit,
          }
        : null;
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "order", "limit"]) q[m] = () => q;
      q.single = async () => ({ data: rowFor(table), error: null });
      q.maybeSingle = async () => ({ data: rowFor(table), error: null });
      return q;
    },
    rpc: state.rpc,
  };
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: stubClient(), userId: "user-1" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/booking-price.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-price.server")>()),
  oneOffGridPriceCents: async () => ({ cents: 4500, reason: null }),
}));
vi.mock("@/lib/one-off-visit.server", () => ({ bookOneOffVisit: state.bookOneOff }));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/walk-notify.server", () => ({
  watchWalkSchedule: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/groom-clash.server", () => ({
  refuseGroomMoveClash: async () => {},
  groomWriteError: async (_db: unknown, e: { message: string }) => new Error(e.message),
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));

const { completeVisitFromOffice, createOneOffVisit, rescheduleVisitFromOffice } =
  await import("@/lib/visits.functions");
const call = (fn: unknown, data: unknown) =>
  (fn as (a: { data: unknown }) => Promise<unknown>)({ data });

beforeEach(() => {
  state.rpc.mockClear();
  state.bookOneOff.mockClear();
  state.visit = { scheduled_on: TODAY, status: "scheduled" };
});

describe("a past day", () => {
  it("is refused for a one-off before anything is booked", async () => {
    await expect(
      call(createOneOffVisit, {
        clientId: CLIENT,
        propertyId: PROPERTY,
        scheduledOn: shiftDay(TODAY, -1),
      }),
    ).rejects.toThrow(PAST_DAY_REFUSAL);
    expect(state.bookOneOff).not.toHaveBeenCalled();
  });

  it("is refused for an office reschedule before the RPC runs", async () => {
    await expect(
      call(rescheduleVisitFromOffice, { visitId: VISIT, newDate: shiftDay(TODAY, -1) }),
    ).rejects.toThrow(PAST_DAY_REFUSAL);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("lets today through", async () => {
    await expect(
      call(rescheduleVisitFromOffice, { visitId: VISIT, newDate: TODAY }),
    ).resolves.toBeDefined();
    expect(state.rpc).toHaveBeenCalledWith("reschedule_visit", {
      _visit_id: VISIT,
      _new_date: TODAY,
    });
  });
});

describe("completing a visit on a later day", () => {
  it("is refused without a confirm", async () => {
    state.visit = { scheduled_on: shiftDay(TODAY, 2), status: "scheduled" };
    await expect(call(completeVisitFromOffice, { visitId: VISIT })).rejects.toThrow(
      FUTURE_COMPLETE_REFUSAL,
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("goes through with one", async () => {
    state.visit = { scheduled_on: shiftDay(TODAY, 2), status: "scheduled" };
    await expect(
      call(completeVisitFromOffice, { visitId: VISIT, confirmedEarly: true }),
    ).resolves.toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("office_complete_visit", { _visit_id: VISIT });
  });

  it("needs no confirm for today", async () => {
    await expect(call(completeVisitFromOffice, { visitId: VISIT })).resolves.toEqual({ ok: true });
  });
});
