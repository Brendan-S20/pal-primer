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
  permissions: [] as string[],
  clientOrg: "org-1",
  clientEmail: "client@example.test" as string | null,
  enqueue: vi.fn(),
  inserts: [] as Array<{ table: string; row: unknown }>,
}));

/** A Supabase client that answers every chain with a row and records inserts. */
function fakeSupabase() {
  const chain = (table: string): any => {
    const result = {
      data: {
        id: "client-1",
        portal_token: "tok",
        organization_id: state.clientOrg,
        primary_email: state.clientEmail,
      },
      error: null,
    };
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
  requirePermission: async (_db: unknown, _user: string, permission: string) => {
    state.permissions.push(permission);
    return { orgId: "org-1", role: "owner" };
  },
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

const { onboardClient, createClient, shouldSendWelcome, sendClientWelcomeEmail } =
  await import("@/lib/clients.functions");
const { WELCOME_EMAIL_DEFAULT_CHECKED, welcomeEmailPreview, confirmThenSendWelcome } =
  await import("@/lib/welcome-email");
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
  // A residential client must arrive with a named dog (#779,
  // lib/new-client-dogs); without one onboardClient refuses before the
  // welcome-email decision is ever reached.
  dogs: [{ name: "Bailey" }],
};

const onboard = (extra: Record<string, unknown> = {}) =>
  (onboardClient as any)({ data: { ...FIRST_CLIENT, ...extra } });

beforeEach(() => {
  state.permissions = [];
  state.clientOrg = "org-1";
  state.clientEmail = "client@example.test";
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
    expect(wizard).toMatch(
      /sendWelcome: sendWelcome && !welcomeTurnedOffInSettings && !!primaryEmail\.trim\(\),/,
    );
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

describe("the box when welcome emails are off in Settings", () => {
  const html = renderToStaticMarkup(
    <WelcomeEmailOptIn
      email="client@example.test"
      orgName="Acme"
      checked
      onCheckedChange={() => {}}
      turnedOffInSettings
    />,
  );

  it("is disabled and unticked, even if it was ticked", () => {
    expect(html).toMatch(/role="checkbox"[^>]*aria-checked="false"/);
    expect(html).toMatch(/role="checkbox"[^>]*disabled=""/);
  });

  it("says why, and does not promise a send", () => {
    expect(html).toContain("Welcome emails are off in Settings, Emails");
    expect(html).not.toContain("Sent when you press Create client");
  });

  it("the wizard reads the toggle and never sends past it", () => {
    const wizard = read("src/routes/_authenticated/clients.new.tsx");
    expect(wizard).toMatch(
      /const welcomeTurnedOffInSettings = emailSettings\?\.notify_email_welcome === false;/,
    );
    expect(wizard).toMatch(/turnedOffInSettings=\{welcomeTurnedOffInSettings\}/);
  });

  it("unticked, it says the welcome can be sent later", () => {
    const off = renderToStaticMarkup(
      <WelcomeEmailOptIn
        email="a@b.test"
        orgName="Acme"
        checked={false}
        onCheckedChange={() => {}}
      />,
    );
    expect(off).toMatch(/You can send it later from the client(&#x27;|')s page\./);
  });
});

describe("sending the welcome later, from the client page", () => {
  const send = () =>
    (sendClientWelcomeEmail as any)({ data: { clientId: "11111111-1111-4111-8111-111111111111" } });

  it("sends the welcome template once, as a manual send, and needs message_clients", async () => {
    const out = await send();
    expect(state.permissions).toContain("message_clients");
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.enqueue.mock.calls[0][0]).toMatchObject({
      organizationId: "org-1",
      templateName: "welcome",
      notifyKey: "notify_email_welcome",
      manual: true,
      requireProvider: true,
      templateData: { portalUrl: "https://example.test/portal/tok" },
    });
    expect(out).toMatchObject({
      ok: true,
      statusHandle: "handle",
      recipient: "client@example.test",
    });
  });

  it("reports the Settings toggle rather than claiming a send", async () => {
    state.enqueue.mockResolvedValueOnce({ ok: false, reason: "org_toggle_off" });
    const out = await send();
    expect(out).toMatchObject({ ok: false, reason: "org_toggle_off", statusHandle: null });
  });

  it("refuses a client with no address, and another business's client, without sending", async () => {
    state.clientEmail = null;
    await expect(send()).rejects.toThrow(/no email address/);
    state.clientEmail = "client@example.test";
    state.clientOrg = "org-2";
    await expect(send()).rejects.toThrow(/not found/);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it("the client page's action goes through the confirm helper, and nowhere else sends", () => {
    const header = read("src/components/client-detail/ClientHeader.tsx");
    expect(header).toMatch(/void confirmThenSendWelcome\(\{/);
    expect(header).toMatch(/send: \(\) => welcomeMut\.mutate\(\),/);
    expect(header.match(/welcomeMut\.mutate\(/g)?.length).toBe(1);
    expect(header.match(/welcomeFn\(/g)?.length).toBe(1);
    // Offered only when it can go.
    expect(header).toMatch(
      /!client\.email_opt_out &&\s*emailSettings\?\.notify_email_welcome !== false;/,
    );
  });
});

describe("confirmThenSendWelcome: nothing is sent without a yes", () => {
  const run = (answer: boolean) => {
    const order: string[] = [];
    const confirm = vi.fn(async (opts: unknown) => {
      order.push("confirm");
      void opts;
      return answer;
    });
    const send = vi.fn(() => order.push("send"));
    return {
      order,
      confirm,
      send,
      done: confirmThenSendWelcome({
        email: "client@example.test",
        orgName: "SIC QA Scoop Test",
        confirm,
        send,
        describe: (what) => what,
      }),
    };
  };

  it("cancelled, the send helper is never called", async () => {
    const r = run(false);
    expect(await r.done).toBe(false);
    expect(r.confirm).toHaveBeenCalledTimes(1);
    expect(r.send).not.toHaveBeenCalled();
  });

  it("confirmed, it sends once, after the dialog", async () => {
    const r = run(true);
    expect(await r.done).toBe(true);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.order).toEqual(["confirm", "send"]);
  });

  it("the dialog names the recipient and the subject before anything is sent", async () => {
    const r = run(false);
    await r.done;
    expect(r.confirm.mock.calls[0][0]).toEqual({
      title: "Send the welcome email?",
      confirmLabel: "Send welcome email",
      description: {
        email: "client@example.test",
        subject: "Welcome to SIC QA Scoop Test",
        summary: welcomeEmailPreview("x").summary,
      },
    });
  });
});
