// @vitest-environment happy-dom
//
// #1003: Platform > Add-ons "Texting readiness". Platform admins only; shows
// Set / Missing for each Twilio server setting and the primary profile status,
// and never a value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let context: { supabase: unknown; userId: string };
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    type Builder = {
      middleware: () => Builder;
      handler: (h: (a: { context: unknown }) => unknown) => () => Promise<unknown>;
    };
    const builder: Builder = {
      middleware: () => builder,
      handler: (handler) => async () => handler({ context }),
    };
    return builder;
  },
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { getTextingReadiness } from "@/lib/texting-readiness.functions";
import { computeTextingReadiness } from "@/lib/texting-readiness.server";
import { TextingReadinessView } from "@/components/TextingReadinessCard";

const SECRETS = {
  TWILIO_ACCOUNT_SID: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  TWILIO_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
  TWILIO_PRIMARY_CUSTOMER_PROFILE_SID: "BUbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  TWILIO_API_KEY: "sk-api-key-value-xyz",
  TWILIO_COMPLIANCE_EMAIL: "compliance-secret@example.com",
  TWILIO_INBOUND_SECRET: "inbound-shared-secret-123",
};
const ENV_KEYS = Object.keys(SECRETS);
const saved: Record<string, string | undefined> = {};

const adminDb = (isAdmin: boolean) => ({
  rpc: vi.fn(async () => ({ data: isAdmin, error: null })),
});

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  context = { supabase: adminDb(true), userId: "u1" };
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("who may ask", () => {
  it("refuses a non-admin before reading anything or calling Twilio", async () => {
    Object.assign(process.env, SECRETS);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    context = { supabase: adminDb(false), userId: "u2" };
    await expect(
      (getTextingReadiness as unknown as () => Promise<{ canFile: boolean; profile: unknown }>)(),
    ).rejects.toThrow("Forbidden");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers a platform admin", async () => {
    Object.assign(process.env, SECRETS);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ status: "twilio-approved" }), { status: 200 }),
      ),
    );
    const r = await (
      getTextingReadiness as unknown as () => Promise<{ canFile: boolean; profile: unknown }>
    )();
    expect(r.canFile).toBe(true);
    expect(r.profile).toEqual({ state: "approved" });
  });
});

describe("no secret value leaves the server", () => {
  it("success path contains none of the values", async () => {
    Object.assign(process.env, SECRETS);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "twilio-approved", friendly_name: SECRETS.TWILIO_AUTH_TOKEN }),
            { status: 200 },
          ),
      ),
    );
    const json = JSON.stringify(await computeTextingReadiness());
    for (const v of Object.values(SECRETS)) expect(json).not.toContain(v);
    expect(json).not.toContain("example.com");
  });

  it("failure path returns an error class, not Twilio's message", async () => {
    Object.assign(process.env, SECRETS);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: `bad ${SECRETS.TWILIO_AUTH_TOKEN}` }), {
            status: 401,
          }),
      ),
    );
    const r = await computeTextingReadiness();
    expect(r.profile).toEqual({ state: "error", errorClass: "auth" });
    const json = JSON.stringify(r);
    for (const v of Object.values(SECRETS)) expect(json).not.toContain(v);
  });

  it("a thrown network error is a class too", async () => {
    Object.assign(process.env, SECRETS);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`down ${SECRETS.TWILIO_AUTH_TOKEN}`);
      }),
    );
    const r = await computeTextingReadiness();
    expect(r.profile).toEqual({ state: "error", errorClass: "network" });
    expect(JSON.stringify(r)).not.toContain(SECRETS.TWILIO_AUTH_TOKEN);
  });
});

describe("missing settings", () => {
  it("marks them Missing, makes no Twilio call, and says what to add", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await computeTextingReadiness();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.canFile).toBe(false);
    expect(r.profile).toEqual({ state: "not_checked" });
    expect(r.settings.every((s) => s.set === false)).toBe(true);
    expect(r.summary).toContain("TWILIO_PRIMARY_CUSTOMER_PROFILE_SID");
  });
});

describe("the card", () => {
  it("renders the Missing state without any value", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const data = await computeTextingReadiness();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(createElement(TextingReadinessView, { data }));
    });
    expect(el.textContent).toContain("TWILIO_ACCOUNT_SID");
    expect(el.textContent).toContain("Missing");
    expect(el.textContent).not.toContain("Set");
    expect(el.textContent).toContain("Not checked");
    expect(el.querySelector("[data-testid=readiness-summary]")?.textContent).toContain(
      "Add TWILIO_ACCOUNT_SID",
    );
    act(() => root.unmount());
  });
});
