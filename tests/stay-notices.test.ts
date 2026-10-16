import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "react-email";
import { readFileSync } from "node:fs";
import { TEMPLATES } from "@/lib/email-templates/registry";

const state = vi.hoisted(() => ({
  org: { service_lines: ["pet_sitting"], notify_email_stay_ending: true },
  stays: [] as any[],
  queued: [] as any[],
  keys: new Set<string>(),
  fail: false,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];
      const rows = () =>
        (table === "stays" ? state.stays : [state.org]).filter((r) => filters.every((f) => f(r)));
      const q: any = {
        select: () => q,
        eq: (c: string, v: any) => {
          if (table === "stays") filters.push((r) => r[c] === v);
          return q;
        },
        single: async () => ({ data: rows()[0], error: null }),
        maybeSingle: async () => ({ data: rows()[0], error: null }),
        then: (res: any) => Promise.resolve({ data: rows(), error: null }).then(res),
      };
      return q;
    },
  },
}));
vi.mock("@/lib/portal-links.server", () => ({
  buildPortalLink: async () => "https://app.example/portal/sitter/token",
}));
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: async (params: any) => {
    if (state.fail) throw new Error("Queue unavailable");
    state.queued.push(params);
    if (state.keys.has(params.idempotencyKey)) return { ok: false, reason: "already_sent" };
    state.keys.add(params.idempotencyKey);
    return { ok: true };
  },
}));
const { notifyStayConfirmed, notifyStaysEnding } = await import("@/lib/stay-notify.server");

beforeEach(() => {
  state.org = { service_lines: ["pet_sitting"], notify_email_stay_ending: true };
  state.stays = [
    {
      id: "stay-a",
      organization_id: "org-a",
      client_id: "client-a",
      kind: "overnight",
      status: "confirmed",
      starts_on: "2030-12-27",
      ends_on: "2031-01-01",
      services: { name: "Overnight care" },
      clients: { portal_token: "token" },
      organizations: state.org,
      deposit_cents: 10000,
      deposit_invoice_id: "deposit-a",
    },
  ];
  state.queued = [];
  state.keys.clear();
  state.fail = false;
});

describe("stay notices", () => {
  it("confirms with the queue switch, a stable once-per-stay key and the deposit link", async () => {
    await notifyStayConfirmed("stay-a");
    expect(state.queued).toHaveLength(1);
    expect(state.queued[0]).toMatchObject({
      organizationId: "org-a",
      clientId: "client-a",
      templateName: "stay-confirmed",
      notifyKey: "notify_email_stay_confirmed",
      idempotencyKey: "stay-confirmed-stay-a",
      oncePerKey: true,
      templateData: {
        serviceName: "Overnight care",
        dates: "Check-in Dec 27, check-out Jan 1",
        depositUrl: "https://app.example/portal/sitter/token/pay/deposit-a",
      },
    });
  });
  it("sends no confirmation for a request, canceled stay or pet-waste business", async () => {
    for (const status of ["requested", "canceled", "completed"]) {
      state.stays[0].status = status;
      await notifyStayConfirmed("stay-a");
    }
    state.stays[0].status = "confirmed";
    state.org.service_lines = ["pet_waste"];
    await notifyStayConfirmed("stay-a");
    expect(state.queued).toEqual([]);
  });
  it("queues tomorrow's endings on the supplied local day and uses once-per-key delivery", async () => {
    state.stays.push(
      { ...state.stays[0], id: "later", ends_on: "2031-01-02" },
      { ...state.stays[0], id: "canceled", status: "canceled" },
    );
    expect(await notifyStaysEnding("org-a", "2030-12-31")).toBe(1);
    expect(await notifyStaysEnding("org-a", "2030-12-31")).toBe(0);
    expect(state.queued).toHaveLength(2);
    expect(state.queued[0]).toMatchObject({
      templateName: "stay-ending",
      notifyKey: "notify_email_stay_ending",
      oncePerKey: true,
      idempotencyKey: "stay-ending-stay-a",
    });
    expect(state.queued[0].templateData.depositUrl).toBeUndefined();
  });
  it("honors the ending switch and pet-sitting gate", async () => {
    state.org.notify_email_stay_ending = false;
    expect(await notifyStaysEnding("org-a", "2030-12-31")).toBe(0);
    state.org.notify_email_stay_ending = true;
    state.org.service_lines = ["pet_waste"];
    expect(await notifyStaysEnding("org-a", "2030-12-31")).toBe(0);
    expect(state.queued).toEqual([]);
  });
  it("a queue failure leaves a committed booking successful", async () => {
    state.fail = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(notifyStayConfirmed("stay-a")).resolves.toBeUndefined();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("wires the nightly job and shows switches only to sitting businesses", () => {
    const nightly = readFileSync("src/routes/api/public/hooks/nightly.ts", "utf8");
    expect(nightly).toMatch(
      /if \(org\.service_lines\?\.includes\("pet_sitting"\)\)[\s\S]*?notifyStaysEnding\(org\.id, todayStr\)/,
    );
    const settings = readFileSync("src/routes/_authenticated/settings.emails.tsx", "utf8");
    expect(settings).toContain("values.runs_pet_sitting ? SIT_ROWS : []");
    expect(settings).toMatch(
      /runs_pet_sitting\s*\?\s*\{[^}]*notify_email_stay_confirmed,\s*notify_email_stay_ending/,
    );
  });
});

describe("stay email templates", () => {
  it("confirmation shows the service, dates, deposit and business contact", async () => {
    const entry = TEMPLATES["stay-confirmed"];
    expect(entry.subject).toBe("Your stay is confirmed");
    const html = await render(
      createElement(entry.component, {
        orgName: "Happy Paws",
        clientName: "Sam",
        serviceName: "Overnight care",
        dates: "Check-in Dec 27, check-out Jan 1",
        depositUrl: "https://example.com/deposit",
        portalUrl: "https://example.com/stay",
        orgEmail: "hello@example.com",
      }),
    );
    for (const text of [
      "Happy Paws confirmed your stay",
      "Overnight care",
      "Check-in Dec 27",
      "Pay deposit",
      "https://example.com/deposit",
      "hello@example.com",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("cleaned up");
  });
  it("omits the deposit when none is due and renders the ending notice", async () => {
    const confirmed = await render(createElement(TEMPLATES["stay-confirmed"].component, {}));
    expect(confirmed).not.toContain("Pay deposit");
    const entry = TEMPLATES["stay-ending"];
    expect(entry.subject).toBe("Your stay ends tomorrow");
    const ending = await render(
      createElement(entry.component, {
        orgName: "Happy Paws",
        dates: "Check-in Dec 27, check-out Jan 1",
      }),
    );
    expect(ending).toContain("your stay with Happy Paws ends tomorrow");
    expect(ending).toContain("Check-in Dec 27");
    expect(ending).not.toContain("Pay deposit");
  });
});
