// Error monitoring (src/lib/monitoring): when it sends, what it sends, and
// what it never sends.
//
// Three promises are pinned here, because each is the kind that breaks
// silently:
//
//   1. Dev and test send nothing, production sends to the default DSN. A test
//      run that reported its own deliberate failures would bury the owner's
//      real ones, and a test must never reach the network; a production build
//      that needed a variable somebody forgot would report nothing.
//   2. Nothing personal leaves: no email, no name, no cookie, no portal or
//      pay-link token, no form value. Checked on the events actually built,
//      in both runtimes, not on the helper in isolation.
//   3. A deliberate refusal ("Not authorized", "Invoice already paid") is not
//      an error report; a database fault is.
//
// Every test that gets as far as a send stubs `fetch` first, so nothing here
// can reach Sentry whatever the environment says.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SENTRY_DSN, resolveDsn } from "@/lib/monitoring/config";
import { isExpectedError, scrubEvent, scrubText, scrubUrl } from "@/lib/monitoring/policy";

const ROOT = join(import.meta.dirname, "..");
const EMAIL = "jane.customer@example.com";
const NAME = "Jane Customer";

/** A JWT-shaped bearer token whose payload carries an email beside `sub`. */
function bearerFor(sub: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `Bearer ${b64({ alg: "HS256" })}.${b64({ sub, email: EMAIL, name: NAME })}.c2lnbmF0dXJl`;
}

/** As a production build: what Lovable and Xcode Cloud ship. */
function asProduction() {
  vi.stubEnv("MODE", "production");
  vi.stubEnv("PROD", true);
  vi.stubEnv("DEV", false);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@sentry/react");
  vi.doUnmock("@capacitor/core");
});

// ── 1. When it sends ──────────────────────────────────────────────────────

describe("which builds report, and where to", () => {
  it("a production build reports to the HoundStack project with nothing configured", () => {
    expect(resolveDsn({ explicit: undefined, prod: true, mode: "production" })).toBe(
      DEFAULT_SENTRY_DSN,
    );
    expect(resolveDsn({ explicit: "", prod: true, mode: "production" })).toBe(DEFAULT_SENTRY_DSN);
  });

  it("the dev server sends nothing unless a DSN is set on purpose", () => {
    expect(resolveDsn({ explicit: undefined, prod: false, mode: "development" })).toBe("");
    expect(
      resolveDsn({ explicit: "https://k@example.ingest.sentry.io/1", prod: false, mode: "development" }),
    ).toBe("https://k@example.ingest.sentry.io/1");
  });

  it("vitest sends nothing, even with a DSN left in the shell", () => {
    expect(resolveDsn({ explicit: DEFAULT_SENTRY_DSN, prod: true, mode: "test" })).toBe("");
    expect(resolveDsn({ explicit: undefined, prod: true, mode: "test" })).toBe("");
  });

  it('"off" turns a production build off', () => {
    for (const off of ["off", "OFF", "0", "false", "none", "disabled", " off "]) {
      expect(resolveDsn({ explicit: off, prod: true, mode: "production" })).toBe("");
    }
  });

  it("the default DSN is the HoundStack project and parses to its envelope endpoint", async () => {
    const { parseDsn } = await import("@/lib/monitoring/report.server");
    const parsed = parseDsn(DEFAULT_SENTRY_DSN);
    expect(parsed?.endpoint).toMatch(
      /^https:\/\/o4512195773792256\.ingest\.us\.sentry\.io\/api\/4512195827007488\/envelope\/\?sentry_key=54378a292b0aba3048501701331842f7&/,
    );
    expect(parseDsn("not a dsn")).toBeNull();
    expect(parseDsn("https://example.com/1")).toBeNull();
  });
});

describe("dev and test builds send nothing", () => {
  it("the browser half downloads nothing, fetches nothing and logs nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("window", {});
    const init = vi.fn();
    vi.doMock("@sentry/react", () => ({ init }));
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "info"),
    ];

    const client = await import("@/lib/monitoring/client");
    expect(client.browserDsn()).toBe("");
    client.initClientMonitoring();
    client.reportBoundaryError(new TypeError("x is undefined"), "router_default_error");
    client.setMonitoringIdentity({ userId: "u1", orgId: "o1" });
    expect(await client.sendClientTestError()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));

    expect(init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const l of logs) expect(l).not.toHaveBeenCalled();
  });

  it("the server half fetches nothing and logs nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const server = await import("@/lib/monitoring/report.server");
    expect(server.serverDsn()).toBe("");
    await server.reportServerError(new TypeError("boom"));
    await server.reportServerMessage("/api/public/hooks/nightly answered 500");
    expect(await server.sendServerTestError(null)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ── 2. What it sends ──────────────────────────────────────────────────────

describe("a production browser build", () => {
  async function loadWithMockedSdk() {
    asProduction();
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", vi.fn());
    const scope = { setTag: vi.fn() };
    const sdk = {
      init: vi.fn(),
      setUser: vi.fn(),
      setTag: vi.fn(),
      captureException: vi.fn(),
      withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
      breadcrumbsIntegration: vi.fn((opts: unknown) => ({ name: "Breadcrumbs", opts })),
    };
    vi.doMock("@sentry/react", () => sdk);
    vi.doMock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios" } }));
    const client = await import("@/lib/monitoring/client");
    return { client, sdk, scope };
  }

  it("starts Sentry with the default DSN, no tracing, no replay, no DOM or console breadcrumbs", async () => {
    const { client, sdk } = await loadWithMockedSdk();
    expect(client.browserDsn()).toBe(DEFAULT_SENTRY_DSN);
    client.initClientMonitoring();
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledTimes(1));

    const opts = sdk.init.mock.calls[0][0];
    expect(opts.dsn).toBe(DEFAULT_SENTRY_DSN);
    expect(opts.environment).toBe("production");
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.replaysSessionSampleRate).toBeUndefined();
    expect(opts.replaysOnErrorSampleRate).toBeUndefined();
    const kept = opts.integrations([
      { name: "Breadcrumbs" },
      { name: "BrowserSession" },
      { name: "GlobalHandlers" },
      { name: "Dedupe" },
    ]);
    expect(kept.map((i: { name: string }) => i.name)).toEqual([
      "GlobalHandlers",
      "Dedupe",
      "Breadcrumbs",
    ]);
    expect(sdk.breadcrumbsIntegration).toHaveBeenCalledWith({ console: false, dom: false });
    expect(sdk.setTag).toHaveBeenCalledWith("platform", "ios");
  });

  it("names the user by id and the org by id, and by nothing else", async () => {
    const { client, sdk } = await loadWithMockedSdk();
    client.setMonitoringIdentity({
      userId: "user-1",
      orgId: "org-1",
      // A careless future caller handing over the whole profile.
      ...({ email: EMAIL, name: NAME, phone: "+15551234567" } as object),
    });
    await vi.waitFor(() => expect(sdk.setUser).toHaveBeenCalled());
    expect(sdk.setUser).toHaveBeenLastCalledWith({ id: "user-1" });
    expect(sdk.setTag).toHaveBeenCalledWith("org_id", "org-1");
    const everything = JSON.stringify([
      sdk.init.mock.calls.map((c) => ({ ...c[0], integrations: undefined, beforeSend: undefined })),
      sdk.setUser.mock.calls,
      sdk.setTag.mock.calls,
    ]);
    expect(everything).not.toContain(EMAIL);
    expect(everything).not.toContain(NAME);
  });

  it("beforeSend drops a deliberate refusal and scrubs what it keeps", async () => {
    const { client, sdk } = await loadWithMockedSdk();
    client.initClientMonitoring();
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());
    const { beforeSend, beforeBreadcrumb } = sdk.init.mock.calls[0][0];

    expect(beforeSend({}, { originalException: new Error("Not authorized") })).toBeNull();
    expect(beforeSend({}, { originalException: new Error("Failed to fetch") })).toBeNull();

    const event = beforeSend(
      {
        user: { id: "user-1", email: EMAIL, username: NAME, ip_address: "203.0.113.9" },
        request: {
          url: "https://app.houndstack.com/portal/acme/tok_SECRET123/billing?session=abc#x",
          headers: { Cookie: "hs_portal_x=1", "User-Agent": "Mozilla/5.0", Referer: "x" },
          cookies: { hs_portal_x: "1" },
          data: { email: EMAIL, card_note: "gate 1234" },
          query_string: "token=abc",
        },
        exception: {
          values: [{ type: "TypeError", value: `Cannot read x of ${EMAIL}`, stacktrace: { frames: [{ vars: { password: "p" }, filename: "https://app.houndstack.com/pay/i/PAYTOKEN/x.js?v=1" }] } }],
        },
        breadcrumbs: [
          { category: "ui.click", message: `button[aria-label="Call ${NAME}"]` },
          { category: "fetch", data: { url: "https://app.houndstack.com/q/QUOTETOKEN?x=1", method: "GET" } },
          { category: "navigation", data: { from: "/track/TRACKTOKEN", to: "/invite/INVITETOKEN" } },
        ],
        extra: { email: EMAIL, name: NAME, note: `call ${EMAIL}` },
      },
      { originalException: new TypeError("Cannot read x") },
    );

    const s = JSON.stringify(event);
    for (const secret of [EMAIL, NAME, "tok_SECRET123", "PAYTOKEN", "QUOTETOKEN", "TRACKTOKEN", "INVITETOKEN", "hs_portal_x", "session=abc", "gate 1234", "203.0.113.9", '"p"']) {
      expect(s).not.toContain(secret);
    }
    expect(event.user).toEqual({ id: "user-1" });
    expect(event.request).toEqual({
      url: "https://app.houndstack.com/portal/acme/[token]/billing",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    expect(event.breadcrumbs).toHaveLength(2);
    expect(beforeBreadcrumb({ category: "ui.click" })).toBeNull();
    expect(beforeBreadcrumb({ category: "fetch" })).toEqual({ category: "fetch" });
  });

  it("an error boundary's error is captured with the boundary named", async () => {
    const { client, sdk, scope } = await loadWithMockedSdk();
    const err = new TypeError("x is undefined");
    client.reportBoundaryError(err, "router_default_error");
    await vi.waitFor(() => expect(sdk.captureException).toHaveBeenCalledWith(err));
    expect(scope.setTag).toHaveBeenCalledWith("boundary", "router_default_error");
  });

  it("the test button's event is not mistaken for a deliberate refusal", async () => {
    const { client, sdk } = await loadWithMockedSdk();
    expect(await client.sendClientTestError()).toBe(true);
    const sent = sdk.captureException.mock.calls.at(-1)?.[0];
    expect(sent).toBeInstanceOf(Error);
    expect(isExpectedError(sent)).toBe(false);
  });
});

describe("a production server", () => {
  function captureFetch() {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: init.body });
        return new Response("{}");
      }),
    );
    return calls;
  }
  const eventOf = (body: string) => JSON.parse(body.split("\n")[2]);

  it("sends a database fault, with the user's id and nothing else about them", async () => {
    asProduction();
    const calls = captureFetch();
    const { reportServerError, serverDsn } = await import("@/lib/monitoring/report.server");
    expect(serverDsn()).toBe(DEFAULT_SENTRY_DSN);

    const request = new Request(
      "https://app.houndstack.com/portal/acme/PORTALTOKEN/billing?token=abc",
      {
        method: "POST",
        headers: { authorization: bearerFor("user-42"), cookie: "hs_portal_acme=s3cret" },
      },
    );
    await reportServerError(
      new Error(`duplicate key value violates unique constraint "clients_email_key" for ${EMAIL}`),
      { request, tags: { surface: "server_fn" } },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/4512195827007488/envelope/");
    const event = eventOf(calls[0].body);
    expect(event.user).toEqual({ id: "user-42" });
    expect(event.request).toEqual({
      url: "https://app.houndstack.com/portal/acme/[token]/billing",
      method: "POST",
    });
    expect(event.tags).toMatchObject({ platform: "server", surface: "server_fn" });
    expect(event.environment).toBe("production");
    expect(event.exception.values.at(-1).value).toContain("[email]");
    for (const secret of [EMAIL, NAME, "PORTALTOKEN", "s3cret", "token=abc"]) {
      expect(calls[0].body).not.toContain(secret);
    }
  });

  it("does not send a deliberate refusal, and sends one fault once", async () => {
    asProduction();
    const calls = captureFetch();
    const { reportServerError } = await import("@/lib/monitoring/report.server");
    await reportServerError(new Error("Not authorized"));
    await reportServerError(new Error("Invoice already paid"));
    await reportServerError(new Error(JSON.stringify([{ message: "Required", path: ["id"] }])));
    expect(calls).toHaveLength(0);

    const fault = new TypeError("Cannot read properties of undefined (reading 'id')");
    await reportServerError(fault);
    await reportServerError(fault);
    expect(calls).toHaveLength(1);
    expect(eventOf(calls[0].body).exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  });

  it("uses the Worker's waitUntil when the request carries one", async () => {
    asProduction();
    const calls = captureFetch();
    const { reportServerError } = await import("@/lib/monitoring/report.server");
    const pending: Promise<unknown>[] = [];
    const request = Object.assign(new Request("https://app.houndstack.com/x"), {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    await reportServerError(new TypeError("boom"), { request });
    expect(pending).toHaveLength(1);
    await pending[0];
    expect(calls).toHaveLength(1);
  });

  it("a hook that answers 5xx is reported once, unless its exception already was", async () => {
    asProduction();
    const calls = captureFetch();
    const server = await import("@/lib/monitoring/report.server");

    const nightly = new Request("https://app.houndstack.com/api/public/hooks/nightly?s=CRONSECRET");
    await server.reportFailedHookResponse(
      nightly,
      new Response(JSON.stringify({ error: "permission denied for table organizations" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(calls).toHaveLength(1);
    const event = eventOf(calls[0].body);
    expect(event.message).toBe("/api/public/hooks/nightly answered 500");
    expect(event.tags.hook).toBe("nightly");
    expect(event.extra.body).toContain("permission denied");
    expect(calls[0].body).not.toContain("CRONSECRET");

    // Stripe's handler reports its exception itself; the 500 is then not
    // reported a second time.
    const stripe = new Request("https://app.houndstack.com/api/public/hooks/stripe");
    await server.reportServerError(new Error("Invoice not found"), { request: stripe, force: true });
    await server.reportFailedHookResponse(stripe, new Response("Handler error", { status: 500 }));
    expect(calls).toHaveLength(2);

    // A 4xx is the caller's problem (bad signature), not ours.
    await server.reportFailedHookResponse(
      new Request("https://app.houndstack.com/api/public/hooks/twilio"),
      new Response("Invalid signature", { status: 401 }),
    );
    expect(calls).toHaveLength(2);
  });

  it('SENTRY_DSN="off" silences a production server', async () => {
    asProduction();
    vi.stubEnv("SENTRY_DSN", "off");
    const calls = captureFetch();
    const { reportServerError } = await import("@/lib/monitoring/report.server");
    await reportServerError(new TypeError("boom"));
    expect(calls).toHaveLength(0);
  });
});

// ── The scrubber on its own ───────────────────────────────────────────────

describe("scrubUrl", () => {
  it.each([
    ["https://app.houndstack.com/pay/i/abc123?x=1", "https://app.houndstack.com/pay/i/[token]"],
    ["/portal/acme/T0KEN/visits", "/portal/acme/[token]/visits"],
    ["/portal/acme", "/portal/acme"],
    ["/q/abc", "/q/[token]"],
    ["/track/abc", "/track/[token]"],
    ["/invite/abc", "/invite/[token]"],
    ["/api/public/calendar/feed.ics", "/api/public/calendar/[token]"],
    ["/auth#access_token=eyJabc&refresh_token=x", "/auth"],
    ["/clients/123e4567-e89b-12d3-a456-426614174000", "/clients/123e4567-e89b-12d3-a456-426614174000"],
    ["/api/public/invoice-pdf?token=abc", "/api/public/invoice-pdf"],
  ])("%s", (input, expected) => {
    expect(scrubUrl(input)).toBe(expected);
  });

  it("masks the token of every $token route in src/routes", () => {
    const routes = join(ROOT, "src", "routes");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = join(dir, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\$token/.test(n)) files.push(f);
      }
    };
    walk(routes);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const rel = relative(routes, f).split(/[\\/]/).join("/").replace(/\.(tsx?|ts)$/, "");
      const path =
        "/" +
        rel
          .split(/[/.]/)
          .filter((s) => s !== "index" && s !== "route" && !s.startsWith("_"))
          .map((s) => (s === "$token" ? "SECRETTOKEN" : s.startsWith("$") ? "value" : s))
          .join("/");
      expect(scrubUrl(path), `${rel} -> ${path}`).not.toContain("SECRETTOKEN");
    }
  });
});

describe("scrubText", () => {
  it("masks what a message can quote", () => {
    const out = scrubText(
      `user ${EMAIL} phone (555) 123-4567 alt +15551234567 bare 5551234567 ` +
        `token Bearer abc.def.ghi jwt eyJhbGciOi.eyJzdWIiOi.sig key sk_live_abcdefgh123 ` +
        `link https://app.houndstack.com/pay/i/PAYTOKEN?x=1`,
    );
    for (const s of [EMAIL, "123-4567", "15551234567", "5551234567", "abc.def.ghi", "eyJhbGciOi", "sk_live_abcdefgh123", "PAYTOKEN"]) {
      expect(out).not.toContain(s);
    }
  });

  it("leaves alone what a developer reads the error for", () => {
    const keep =
      "invalid input syntax for type uuid: 123e4567-e89b-12d3-a456-426614174000 at 2026-10-03 12:00:00, status 503, 42 rows";
    expect(scrubText(keep)).toBe(keep);
  });
});

describe("scrubEvent", () => {
  it("keeps the user's id and drops every other user field", () => {
    const e = scrubEvent({ user: { id: "u", email: EMAIL, username: NAME, name: NAME, ip_address: "1.2.3.4" } });
    expect(e.user).toEqual({ id: "u" });
  });

  it("drops a user with no id rather than sending an anonymous one with an email", () => {
    expect(scrubEvent({ user: { email: EMAIL } }).user).toBeNull();
  });

  it("keeps the browser and OS names in contexts", () => {
    const e = scrubEvent({ contexts: { browser: { name: "Chrome" }, os: { name: "iOS" } } });
    expect(e.contexts).toEqual({ browser: { name: "Chrome" }, os: { name: "iOS" } });
  });
});

// ── 3. Expected or not ────────────────────────────────────────────────────

describe("isExpectedError", () => {
  const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

  it.each([
    ["Not authorized", new Error("Not authorized")],
    ["auth middleware", new Error("Unauthorized: Invalid token")],
    ["SQL raise, lowercase", new Error("forbidden")],
    ["lookup", new Error("Client not found")],
    ["lookup, lowercase", new Error("visit not found")],
    ["copy", new Error("Invoice already paid")],
    ["copy with a contraction", new Error("Card wasn't saved. Please try again.")],
    ["validation", new Error(JSON.stringify([{ message: "Invalid uuid", path: ["id"] }]))],
    ["zod", Object.assign(new Error("[]"), { name: "ZodError", issues: [] })],
    ["AI", named("AiGenerationError", "Summary: model refused")],
    ["plan gate", named("PlanUpgradeRequiredError")],
    ["impersonation", named("ImpersonationExpiredError")],
    ["refund", named("RefundRefused")],
    ["portal", Object.assign(new Error("PORTAL_VERIFICATION_REQUIRED"), { code: "PORTAL_VERIFICATION_REQUIRED" })],
    ["card declined", Object.assign(new Error("Your card was declined."), { type: "StripeCardError" })],
    ["redirect", new Response(null, { status: 307 })],
    ["notFound()", { isNotFound: true }],
    ["HTTP 404", Object.assign(new Error("x"), { statusCode: 404 })],
    ["offline", new TypeError("Failed to fetch")],
  ])("expected: %s", (_label, err) => {
    expect(isExpectedError(err)).toBe(true);
  });

  it.each([
    ["TypeError", new TypeError("Cannot read properties of undefined (reading 'id')")],
    ["unique violation", new Error('duplicate key value violates unique constraint "x"')],
    ["missing grant", new Error("permission denied for table invoices")],
    ["RLS", new Error('new row violates row-level security policy for table "visits"')],
    ["PostgREST", new Error("JSON object requested, multiple (or no) rows returned")],
    ["PostgREST schema", new Error("Could not find the function public.x(y) in the schema cache")],
    ["wrapped", new Error("Upload failed: new row violates row-level security policy")],
    ["upstream", new Error("QBO invoice failed: 400 Bad Request")],
    ["config", new Error("LOVABLE_API_KEY is not configured")],
    ["5xx", new Error("DNS-over-HTTPS answered 503")],
    ["timeout", new Error("canceling statement due to statement timeout")],
    ["missing key", named("MissingEncryptionKeyError", "CREDENTIAL_ENCRYPTION_KEY is not set")],
    ["HTTP 500", Object.assign(new Error("x"), { statusCode: 500 })],
    ["a thrown string", "boom"],
    ["a PostgREST error object", { message: "relation \"x\" does not exist", code: "42P01" }],
  ])("reported: %s", (_label, err) => {
    expect(isExpectedError(err)).toBe(false);
  });
});

// ── Nothing else in src/ talks to Sentry ──────────────────────────────────

describe("the only door out", () => {
  it("only lib/monitoring imports Sentry, and only sentry-browser sets the user", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = join(dir, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(n)) {
          const rel = relative(ROOT, f).split(/[\\/]/).join("/");
          const src = readFileSync(f, "utf8");
          if (/from\s+["']@sentry\//.test(src) && rel !== "src/lib/monitoring/sentry-browser.ts") {
            offenders.push(`${rel} imports @sentry`);
          }
          if (/\bsetUser\(/.test(src) && rel !== "src/lib/monitoring/sentry-browser.ts") {
            offenders.push(`${rel} calls setUser`);
          }
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
    const browser = readFileSync(join(ROOT, "src/lib/monitoring/sentry-browser.ts"), "utf8");
    // The one setUser call takes the output of identityUser, which is { id }.
    expect(browser.match(/setUser\(([^)]*)\)/g)).toEqual(["setUser(user)"]);
    expect(browser).toMatch(/const user = identityUser\(identity\)/);
  });

  it("no session replay or tracing integration is configured anywhere", () => {
    const browser = readFileSync(join(ROOT, "src/lib/monitoring/sentry-browser.ts"), "utf8");
    const code = browser.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/replayIntegration|browserTracingIntegration|replaysSessionSampleRate/);
    expect(code).toMatch(/tracesSampleRate:\s*0\b/);
  });
});

beforeEach(() => {
  // Belt and braces: whatever a test forgets, nothing in this file reaches
  // the network. A test that needs fetch stubs its own.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});
