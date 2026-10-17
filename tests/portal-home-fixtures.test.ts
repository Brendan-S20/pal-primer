import { describe, expect, it } from "vitest";
import type { BrowserContext, Route } from "@playwright/test";
import { installStubBackend } from "./viewports/fixtures/stub-backend";

async function backend(options: Parameters<typeof installStubBackend>[1]) {
  let answer!: (route: Route) => Promise<unknown>;
  const report = await installStubBackend(
    {
      route: async (pattern: string, handler: typeof answer) => {
        if (pattern === "**/_serverFn/**") answer = handler;
      },
    } as unknown as BrowserContext,
    options,
  );
  return {
    report,
    read: async (name: string, args: Record<string, unknown> = {}) => {
      const id = Buffer.from(
        JSON.stringify({ export: name, file: "fixture.functions.ts" }),
      ).toString("base64url");
      const payload = {
        p: { k: ["data"], v: [{ p: { k: Object.keys(args), v: Object.values(args) } }] },
      };
      const url = `http://localhost/_serverFn/${id}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
      let value: any;
      await answer({
        request: () => ({ url: () => url }),
        fulfill: async ({ body }: { body: string }) => {
          value = JSON.parse(body).result;
        },
      } as unknown as Route);
      return value;
    },
  };
}

describe("bundled viewport fixtures", () => {
  it("returns the existing portal fixtures only when withHome is requested", async () => {
    const stub = await backend({ portal: true });
    const context = await stub.read("portalContext");
    expect(context).not.toHaveProperty("home");
    const bundled = await stub.read("portalContext", { withHome: true });
    const { home, ...rest } = bundled;
    expect(rest).toEqual(context);
    const reads = {
      client: "portalGetClient",
      visits: "portalListUpcomingVisits",
      invoices: "portalListInvoices",
      subs: "portalListPrepaidSubs",
      catalog: "portalListAddonCatalog",
      clientAddons: "portalListClientAddons",
      history: "portalListRecentVisits",
      dogs: "portalListDogs",
      referral: "portalGetReferral",
      stations: "portalListStations",
      requests: "portalListMyRequests",
    };
    expect(Object.keys(home)).toHaveLength(11);
    for (const [part, name] of Object.entries(reads))
      expect(home[part], part).toEqual(await stub.read(name));
    expect(stub.report.unstubbed).toEqual([]);
  });

  it("builds shell context from the role and service line fixtures for this run", async () => {
    const stub = await backend({ role: "dispatcher", serviceLines: ["dog_walking"] });
    const shell = await stub.read("getShellContext");
    expect(shell.org).toEqual(await stub.read("getMyOrg"));
    expect(shell.org.organization.role).toBe("dispatcher");
    expect(shell.lock).toEqual(await stub.read("getAccountLock"));
    expect(shell.lock.locked).toBe(false);
    const reads = {
      profile: "getMyProfile",
      features: "getMyOrgFeatures",
      trial: "getTrialState",
      billingBanner: "getBillingBannerStatus",
      announcements: "listActiveAnnouncements",
      onboarding: "getOnboardingStatus",
      reviewCount: "getReviewQueueCount",
      platform: "getPlatformContext",
      notifications: "listMyNotifications",
      routingRuns: "listMyRoutingRuns",
      clock: "getMyClock",
    };
    for (const [part, name] of Object.entries(reads))
      expect(shell.parts[part], part).toEqual(await stub.read(name));
    expect(shell.parts.features.serviceLines).toEqual(["dog_walking"]);
    expect(stub.report.unstubbed).toEqual([]);
  });
});
