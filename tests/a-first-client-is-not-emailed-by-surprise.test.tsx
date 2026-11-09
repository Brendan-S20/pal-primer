// Onboarding audit 2026-11-09, D4 (high). A pilot walking through setup
// step 3 created their first client and the client was emailed "Welcome to
// <business>" from notify.houndstack.com the moment Create client was
// pressed: no box, no preview, only a toast after the fact. The welcome
// email is now opt-in: onboardClient sends it only when sendWelcome is true,
// and the wizard's box starts unticked and shows the subject and recipient
// before anything is sent.
//
// The handler runs here against fakes. Nothing reaches Supabase and no email
// leaves this file: enqueueAppEmail is a spy.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const state = vi.hoisted(() => ({
  enqueue: vi.fn(),
  inserts: [] as Array<{ table: string; row: unknown }>,
}));

/** A Supabase client that answers every chain with a row and records inserts. */
function fakeSupabase() {
  const chain = (table: string): any => {
    const result = { data: { id: "client-1", portal_token: "tok" }, error: null };
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => unknown) => res(result);
          if (prop === "single" || prop === "maybeSingle") return async () => result;
          if (prop === "insert")
            return (row: unknown) => {
              state.inserts.push({ table, row });
              return q;
            };
          return () => q;
        },
      },
    );
    return q;
  };
  return { from: (table: string) => chain(table) };
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
          fn({
            data: validate(args?.data),
            context: { supabase: fakeSupabase(), userId: "user-1" },
          }),
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
vi.mock("@/lib/properties.functions", () => ({ detectZoneId: async () => null }));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/portal-links.server", () => ({
  buildPortalLink: async () => "https://example.test/portal/tok",
}));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: state.enqueue }));
vi.mock("@/lib/email/status-handle.server", () => ({
  signEmailStatusHandle: () => "handle",
}));

const { onboardClient, createClient, shouldSendWelcome } = await import("@/lib/clients.functions");
const { WELCOME_EMAIL_DEFAULT_CHECKED, welcomeEmailPreview } = await import("@/lib/welcome-email");
const { WelcomeEmailOptIn } = await import("@/components/client-detail/WelcomeEmailOptIn");

const FIRST_CLIENT = {
  displayName: "SIC QA Client",
  accountType: "residential" as const,
  primaryEmail: "client@example.test",
  street: "1 Main St",
  city: "Detroit",
  postalCode: "48201",
  latitude: 42.33,
  longitude: -83.05,
};

const onboard = (extra: Record<string, unknown> = {}) =>
  (onboardClient as any)({ data: { ...FIRST_CLIENT, ...extra } });

beforeEach(() => {
  state.inserts = [];
  state.enqueue.mockReset().mockResolvedValue({ ok: true, messageId: "m-1" });
});

describe("onboardClient sends the welcome email only when asked", () => {
  it("does not call the email sender when sendWelcome is unset (the setup walkthrough)", async () => {
    const out = await onboard();
    expect(out.id).toBe("client-1");
    expect(state.inserts.some((i) => i.table === "clients")).toBe(true);
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(out.welcomeEmailed).toBe(false);
    expect(out.welcomeRequested).toBe(false);
  });

  it("does not call the email sender when sendWelcome is false", async () => {
    const out = await onboard({ sendWelcome: false });
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(out.welcomeRequested).toBe(false);
  });

  it("calls the email sender, once, with the welcome template when sendWelcome is true", async () => {
    const out = await onboard({ sendWelcome: true });
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.enqueue.mock.calls[0][0]).toMatchObject({
      organizationId: "org-1",
      clientId: "client-1",
      templateName: "welcome",
      notifyKey: "notify_email_welcome",
    });
    expect(out.welcomeEmailed).toBe(true);
    expect(out.welcomeRequested).toBe(true);
  });

  it("does not send with sendWelcome true and no address", async () => {
    await onboard({ sendWelcome: true, primaryEmail: "" });
    expect(state.enqueue).not.toHaveBeenCalled();
  });
});

describe("the older createClient follows the same rule", () => {
  const create = (extra: Record<string, unknown> = {}) =>
    (createClient as any)({
      data: {
        displayName: "A",
        accountType: "residential",
        primaryEmail: "a@example.test",
        ...extra,
      },
    });

  it("sends nothing unless sendWelcome is true", async () => {
    await create();
    await create({ sendWelcome: false });
    expect(state.enqueue).not.toHaveBeenCalled();
    await create({ sendWelcome: true });
    expect(state.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("shouldSendWelcome", () => {
  it("is true only for an explicit true and an address", () => {
    expect(shouldSendWelcome({ primaryEmail: "a@b.test" })).toBe(false);
    expect(shouldSendWelcome({ primaryEmail: "a@b.test", sendWelcome: false })).toBe(false);
    expect(shouldSendWelcome({ primaryEmail: "a@b.test", sendWelcome: null })).toBe(false);
    expect(shouldSendWelcome({ primaryEmail: "  ", sendWelcome: true })).toBe(false);
    expect(shouldSendWelcome({ primaryEmail: "a@b.test", sendWelcome: true })).toBe(true);
  });
});

describe("the new-client wizard", () => {
  const wizard = read("src/routes/_authenticated/clients.new.tsx");

  it("starts the box unticked, in setup and out of it", () => {
    expect(WELCOME_EMAIL_DEFAULT_CHECKED).toBe(false);
    expect(wizard).toMatch(
      /const \[sendWelcome, setSendWelcome\] = useState\(WELCOME_EMAIL_DEFAULT_CHECKED\);/,
    );
    // Not restored from a draft, so a kept draft cannot tick it either.
    expect(wizard).not.toMatch(/setSendWelcome\(d\./);
  });

  it("passes the box to the server, and nothing else turns it on", () => {
    expect(wizard).toMatch(/sendWelcome: sendWelcome && !!primaryEmail\.trim\(\),/);
    expect(wizard.match(/setSendWelcome\(/g)?.length ?? 0).toBe(0);
    expect(wizard).toMatch(/onCheckedChange=\{setSendWelcome\}/);
  });

  it("only reports a welcome send that was asked for", () => {
    expect(wizard).toMatch(/if \(welcomeRequested && primaryEmail && !welcomeTurnedOff\)/);
  });
});

describe("the opt-in box shows what would be sent before anything is", () => {
  it("names the recipient, the template's own subject, and starts unchecked", () => {
    const html = renderToStaticMarkup(
      <WelcomeEmailOptIn
        email="client@example.test"
        orgName="SIC QA Scoop Test"
        checked={WELCOME_EMAIL_DEFAULT_CHECKED}
        onCheckedChange={() => {}}
      />,
    );
    expect(html).toMatch(/role="checkbox"[^>]*aria-checked="false"/);
    expect(html).toContain("Email them a welcome");
    expect(html).toContain("client@example.test");
    expect(html).toContain("Welcome to SIC QA Scoop Test");
    expect(html).toContain("Nothing is sent unless you tick this");
  });

  it("says it will send once ticked", () => {
    const html = renderToStaticMarkup(
      <WelcomeEmailOptIn email="a@b.test" orgName="Acme" checked onCheckedChange={() => {}} />,
    );
    expect(html).toMatch(/aria-checked="true"/);
    expect(html).toContain("Sent when you press Create client");
  });

  it("uses the welcome template's subject", async () => {
    const { template } = await import("@/lib/email-templates/welcome");
    expect(template.subject({ orgName: "Acme" })).toBe(welcomeEmailPreview("Acme").subject);
    expect(template.subject({})).toBe(welcomeEmailPreview(null).subject);
  });
});
