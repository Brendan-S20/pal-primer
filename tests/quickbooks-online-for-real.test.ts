// QuickBooks Online, as Intuit's app assessment asks about it.
//
// Until 2026-10-09 the sync was switched off, and switched on it would have
// pushed no payments, created a duplicate customer on every invoice, stored
// tokens in plaintext, refreshed only when it happened to notice, retried
// nothing and recorded no intuit_tid (INV-7). Each behaviour below is one
// Intuit asks about, proved against a scripted Intuit (tests/support/
// fake-intuit.ts): no call here can reach QuickBooks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  DISCOVERY_URL,
  fakeIntuit,
  reply,
  REVOKE_URL,
  SANDBOX_DISCOVERY,
  TOKEN_URL,
} from "./support/fake-intuit";
import { qboEnvironment, qboCredentials, QBO_DISCOVERY_URL } from "@/lib/qbo-config.server";
import { backoffMs, QboApiError, qboHttp, QBO_MAX_ATTEMPTS } from "@/lib/qbo-http.server";
import {
  DISCOVERY_TTL_MS,
  QboReconnectRequired,
  qboAuthorizeUrl,
  qboDiscovery,
  refreshQboTokens,
  resetQboDiscoveryCache,
  revokeQboToken,
} from "@/lib/qbo-oauth.server";
import { QboClient, qboQuoted, REFRESH_SKEW_MS, type QboClientDeps } from "@/lib/qbo-client.server";
import {
  findOrCreateQboCustomer,
  qboInvoiceBody,
  qboPaymentBody,
  SyncValidationError,
  type InvoiceForSync,
} from "@/lib/accounting.server";
import { syncInvoiceToQbo, type InvoiceToSync, type QboSyncStore, type SyncLogEntry } from "@/lib/qbo-sync.server";

const NOW = Date.parse("2026-10-09T15:00:00Z");
const SECRET = "client-secret-never-logged";
const ACCESS = "access-token-never-logged";
const REFRESH = "refresh-token-never-logged";
const REALM = "4620816365";

const tokenReply = (n: number) =>
  reply(200, {
    access_token: `access-${n}`,
    refresh_token: `refresh-${n}`,
    expires_in: 3600,
    x_refresh_token_expires_in: 8_726_400,
    token_type: "bearer",
  }, { tid: `tid-token-${n}` });

function setup(conn: Partial<ConstructorParameters<typeof QboClient>[0]> = {}) {
  const intuit = fakeIntuit();
  const persisted: Array<{ id: string; refreshToken: string; accessToken: string }> = [];
  const reconnects: Array<{ id: string; reason: string }> = [];
  const sleeps: number[] = [];
  const deps: QboClientDeps = {
    fetch: intuit.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    now: () => NOW,
    environment: "sandbox",
    credentials: { clientId: "client-id", clientSecret: SECRET },
    persistTokens: async (id, t) => void persisted.push({ id, refreshToken: t.refreshToken, accessToken: t.accessToken }),
    markNeedsReconnect: async (id, reason) => void reconnects.push({ id, reason }),
  };
  const qbo = new QboClient(
    {
      id: "conn-1",
      realmId: REALM,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessExpiresAt: new Date(NOW + 50 * 60_000).toISOString(),
      refreshExpiresAt: new Date(NOW + 90 * 86_400_000).toISOString(),
      ...conn,
    },
    deps,
  );
  return { intuit, qbo, deps, persisted, reconnects, sleeps };
}

beforeEach(() => resetQboDiscoveryCache());
afterEach(() => vi.restoreAllMocks());

describe("credentials and environment come from the server's env", () => {
  it("reads the client id and secret, and nothing when either is missing", () => {
    expect(qboCredentials({ QBO_CLIENT_ID: "a", QBO_CLIENT_SECRET: "b" } as any)).toEqual({ clientId: "a", clientSecret: "b" });
    expect(qboCredentials({ QBO_CLIENT_ID: "a" } as any)).toBeNull();
  });

  it("is the sandbox unless QBO_ENVIRONMENT says production", () => {
    expect(qboEnvironment({ QBO_ENVIRONMENT: "production" } as any)).toBe("production");
    expect(qboEnvironment({ QBO_ENVIRONMENT: "Production " } as any)).toBe("production");
    expect(qboEnvironment({ QBO_ENVIRONMENT: "prod" } as any)).toBe("sandbox");
    expect(qboEnvironment({} as any)).toBe("sandbox");
  });
});

describe("the discovery document", () => {
  const deps = (intuit: ReturnType<typeof fakeIntuit>, now = NOW) => ({
    fetch: intuit.fetch,
    sleep: async () => {},
    now: () => now,
  });

  it("is Intuit's, per environment", () => {
    expect(QBO_DISCOVERY_URL.sandbox).toBe("https://developer.api.intuit.com/.well-known/openid_sandbox_configuration");
    expect(QBO_DISCOVERY_URL.production).toBe("https://developer.api.intuit.com/.well-known/openid_configuration");
  });

  it("supplies the endpoints, fetched once and then cached", async () => {
    const intuit = fakeIntuit().on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY));
    const a = await qboDiscovery("sandbox", deps(intuit));
    const b = await qboDiscovery("sandbox", deps(intuit, NOW + 60_000));
    expect(a.token_endpoint).toBe(SANDBOX_DISCOVERY.token_endpoint);
    expect(b).toEqual(a);
    expect(intuit.calls).toHaveLength(1);
  });

  it("is fetched again after a day, and the old copy used if that fails", async () => {
    const intuit = fakeIntuit()
      .on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY))
      .on(DISCOVERY_URL, reply(503, {}))
      .on(DISCOVERY_URL, reply(503, {}))
      .on(DISCOVERY_URL, reply(503, {}))
      .on(DISCOVERY_URL, reply(503, {}));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await qboDiscovery("sandbox", deps(intuit));
    const later = await qboDiscovery("sandbox", deps(intuit, NOW + DISCOVERY_TTL_MS + 1));
    expect(intuit.calls).toHaveLength(1 + QBO_MAX_ATTEMPTS);
    expect(later.token_endpoint).toBe(SANDBOX_DISCOVERY.token_endpoint);
  });

  it("refuses an endpoint that is not Intuit's, so the secret cannot be sent elsewhere", async () => {
    const intuit = fakeIntuit().on(
      DISCOVERY_URL,
      reply(200, { ...SANDBOX_DISCOVERY, token_endpoint: "https://evil.example/token" }),
    );
    await expect(qboDiscovery("sandbox", deps(intuit))).rejects.toThrow(/token_endpoint/);
  });

  it("builds the authorize URL from it, with the accounting scope and the state", () => {
    const url = new URL(
      qboAuthorizeUrl(SANDBOX_DISCOVERY, {
        clientId: "client-id",
        redirectUri: "https://app.houndstack.com/api/public/hooks/qbo-callback",
        state: "s1",
      }),
    );
    expect(url.origin + url.pathname).toBe(SANDBOX_DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.houndstack.com/api/public/hooks/qbo-callback");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("tokens", () => {
  it("are not refreshed while the access token has time left", async () => {
    const { intuit, qbo, persisted } = setup();
    intuit.on(api("companyinfo"), reply(200, { CompanyInfo: {} }));
    await qbo.request("GET", `companyinfo/${REALM}`);
    expect(persisted).toEqual([]);
    expect(intuit.calls[0].headers.Authorization).toBe(`Bearer ${ACCESS}`);
  });

  it("are refreshed BEFORE expiry, and the rotated refresh token is stored every time", async () => {
    const { intuit, qbo, persisted } = setup({ accessExpiresAt: new Date(NOW + REFRESH_SKEW_MS - 1).toISOString() });
    intuit
      .on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY))
      .on(TOKEN_URL, tokenReply(2), "POST")
      .on(api("companyinfo"), reply(200, { CompanyInfo: {} }));
    await qbo.request("GET", `companyinfo/${REALM}`);
    const tokenCall = intuit.calls[1];
    expect(new URLSearchParams(tokenCall.body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(tokenCall.body).get("refresh_token")).toBe(REFRESH);
    expect(tokenCall.headers.Authorization).toBe(`Basic ${Buffer.from(`client-id:${SECRET}`).toString("base64")}`);
    expect(persisted).toEqual([{ id: "conn-1", refreshToken: "refresh-2", accessToken: "access-2" }]);
    expect(intuit.calls[2].headers.Authorization).toBe("Bearer access-2");
  });

  it("are refreshed on a 401, and the call is repeated once with the new token", async () => {
    const { intuit, qbo, persisted } = setup();
    intuit
      .on(api("companyinfo"), reply(401, { fault: { error: [{ message: "AuthenticationFailed", code: "3200" }] } }))
      .on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY))
      .on(TOKEN_URL, tokenReply(3))
      .on(api("companyinfo"), reply(200, { CompanyInfo: { CompanyName: "Sandbox Co" } }));
    const res = await qbo.request<{ CompanyInfo: { CompanyName: string } }>("GET", `companyinfo/${REALM}`);
    expect(res.CompanyInfo.CompanyName).toBe("Sandbox Co");
    expect(persisted.map((p) => p.refreshToken)).toEqual(["refresh-3"]);
  });

  it("a second 401 on a brand-new token asks for a reconnect", async () => {
    const { intuit, qbo, reconnects } = setup();
    intuit
      .on(api("companyinfo"), reply(401, {}))
      .on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY))
      .on(TOKEN_URL, tokenReply(4))
      .on(api("companyinfo"), reply(401, {}));
    await expect(qbo.request("GET", `companyinfo/${REALM}`)).rejects.toBeInstanceOf(QboReconnectRequired);
    expect(reconnects).toEqual([{ id: "conn-1", reason: "unauthorized" }]);
  });

  it("invalid_grant marks the connection needs-reconnect and stops", async () => {
    const { intuit, qbo, reconnects, persisted } = setup({ accessExpiresAt: new Date(NOW - 1).toISOString() });
    intuit
      .on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY))
      .on(TOKEN_URL, reply(400, { error: "invalid_grant", error_description: "Incorrect Token type or clientID" }));
    const err = await qbo.request("GET", `companyinfo/${REALM}`).catch((e) => e);
    expect(err).toBeInstanceOf(QboReconnectRequired);
    expect(err.reason).toBe("invalid_grant");
    expect(reconnects).toEqual([{ id: "conn-1", reason: "invalid_grant" }]);
    expect(persisted).toEqual([]);
    expect(intuit.pending()).toBe(0); // the API call was never attempted
  });

  it("a refresh token past its own expiry asks for a reconnect without calling Intuit", async () => {
    const { intuit, qbo, reconnects } = setup({
      accessExpiresAt: new Date(NOW - 1).toISOString(),
      refreshExpiresAt: new Date(NOW - 1).toISOString(),
    });
    await expect(qbo.request("GET", `companyinfo/${REALM}`)).rejects.toMatchObject({ reason: "refresh_expired" });
    expect(reconnects).toEqual([{ id: "conn-1", reason: "refresh_expired" }]);
    expect(intuit.calls).toEqual([]);
  });

  it("are revoked at the discovery document's revocation endpoint", async () => {
    const intuit = fakeIntuit()
      .on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY))
      .on(REVOKE_URL, reply(200, undefined, { tid: "tid-revoke" }), "POST");
    const r = await revokeQboToken(REFRESH, {
      fetch: intuit.fetch,
      sleep: async () => {},
      now: () => NOW,
      environment: "sandbox",
      credentials: { clientId: "client-id", clientSecret: SECRET },
    });
    expect(JSON.parse(intuit.calls[1].body!)).toEqual({ token: REFRESH });
    expect(r.intuitTid).toBe("tid-revoke");
  });
});

describe("retries", () => {
  const http = (intuit: ReturnType<typeof fakeIntuit>, sleeps: number[]) =>
    qboHttp({ url: "https://sandbox-quickbooks.api.intuit.com/v3/company/1/query", method: "GET", headers: {} }, {
      fetch: intuit.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
    });

  it("retries a 429, honouring Retry-After", async () => {
    const sleeps: number[] = [];
    const intuit = fakeIntuit()
      .on(/query/, reply(429, {}, { headers: { "retry-after": "2" } }))
      .on(/query/, reply(200, { ok: true }, { tid: "tid-ok" }));
    const r = await http(intuit, sleeps);
    expect(r.attempts).toBe(2);
    expect(r.intuitTid).toBe("tid-ok");
    expect(sleeps).toEqual([2000]);
  });

  it("retries 5xx and network failures with exponential backoff, and gives up at the cap", async () => {
    const sleeps: number[] = [];
    const intuit = fakeIntuit().drop(/query/).on(/query/, reply(502, {})).on(/query/, reply(503, {})).on(/query/, reply(500, {}, { tid: "tid-last" }));
    const err = await http(intuit, sleeps).catch((e) => e);
    expect(err).toBeInstanceOf(QboApiError);
    expect(err).toMatchObject({ kind: "server", status: 500, attempts: QBO_MAX_ATTEMPTS, intuitTid: "tid-last" });
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(backoffMs(10, null, () => 0)).toBe(8000);
  });

  it("does NOT retry a 400 validation error, and records Intuit's code and intuit_tid", async () => {
    const sleeps: number[] = [];
    const intuit = fakeIntuit().on(
      /query/,
      reply(400, { Fault: { Error: [{ Message: "Duplicate Name Exists Error", Detail: "The name supplied already exists.", code: "6240" }], type: "ValidationFault" } }, { tid: "tid-dup" }),
    );
    const err = await http(intuit, sleeps).catch((e) => e);
    expect(err).toMatchObject({ kind: "validation", status: 400, code: "6240", intuitTid: "tid-dup", attempts: 1 });
    expect(err.message).toMatch(/Duplicate Name Exists/);
    expect(sleeps).toEqual([]);
  });
});

describe("nothing secret is logged or recorded", () => {
  it("a failed refresh and a failed call leave no token or secret in any message", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    }
    const { intuit, qbo } = setup({ accessExpiresAt: new Date(NOW - 1).toISOString() });
    intuit
      .on(DISCOVERY_URL, reply(200, SANDBOX_DISCOVERY))
      .on(TOKEN_URL, reply(500, {}))
      .on(TOKEN_URL, reply(500, {}))
      .on(TOKEN_URL, reply(500, {}))
      .on(TOKEN_URL, reply(500, {}));
    const err = await qbo.request("GET", "query").catch((e) => e);
    const everything = [...lines, String(err?.message), JSON.stringify(err)].join("\n");
    for (const secret of [SECRET, ACCESS, REFRESH, Buffer.from(`client-id:${SECRET}`).toString("base64")]) {
      expect(everything).not.toContain(secret);
    }
  });
});

const invoice = (over: Partial<InvoiceToSync> = {}): InvoiceToSync => ({
  id: "inv-1",
  number: 1042,
  status: "paid",
  timezone: "America/Chicago",
  total_cents: 13_200,
  tax_cents: 0,
  currency: "usd",
  // 21:00 in Chicago on New Year's Eve is 03:00 UTC on Jan 1.
  issued_at: "2026-01-01T03:00:00Z",
  due_on: "2026-01-15",
  accounting_remote_id: null,
  client: {
    id: "client-uuid-1",
    display_name: "Pat: O'Neil",
    primary_email: "pat@example.com",
    accounting_remote_id: null,
  },
  lines: [
    { description: "Weekly service", amount_cents: 9_600, quantity: 4, unit_amount_cents: 2_400 },
    { description: "Deodorizer", amount_cents: 3_600 },
  ],
  payments: [
    { id: "pay-1", amount_cents: 13_200, paid_at: "2026-01-02T04:30:00Z", created_at: "2026-01-02T04:30:00Z", method: "card", reference: null, accounting_remote_id: null },
  ],
  ...over,
});

const mapping = { service_item_id: "1", sales_tax_item_id: "7", deposit_account_id: "35" };

describe("what is sent", () => {
  it("an invoice: the org's calendar day, every line through the chosen item, the total to the cent", () => {
    const body = qboInvoiceBody(mapping, invoice(), "58");
    expect(body.CustomerRef).toEqual({ value: "58" });
    expect(body.TxnDate).toBe("2025-12-31");
    expect(body.DueDate).toBe("2026-01-15");
    expect(body.Line).toEqual([
      { Amount: 96, DetailType: "SalesItemLineDetail", Description: "Weekly service", SalesItemLineDetail: { ItemRef: { value: "1" }, Qty: 4, UnitPrice: 24 } },
      { Amount: 36, DetailType: "SalesItemLineDetail", Description: "Deodorizer", SalesItemLineDetail: { ItemRef: { value: "1" }, Qty: 1, UnitPrice: 36 } },
    ]);
    expect(body.PrivateNote).toBe("HoundStack invoice #1042");
  });

  it("sales tax as its own line through the sales-tax item", () => {
    const body = qboInvoiceBody(mapping, invoice({ total_cents: 14_289, tax_cents: 1_089, tax_rate_bps: 825, tax_label: "Sales tax" }), "58");
    expect(body.Line.at(-1)).toMatchObject({ Amount: 10.89, Description: "Sales tax (8.25%)", SalesItemLineDetail: { ItemRef: { value: "7" } } });
  });

  it("refuses an invoice whose lines do not make its total, rather than post a different figure", () => {
    expect(() => qboInvoiceBody(mapping, invoice({ total_cents: 13_201 }), "58")).toThrow(SyncValidationError);
  });

  it("a payment: the invoice amount, linked to the QuickBooks invoice, on the org's day, to the chosen account", () => {
    const body = qboPaymentBody(mapping, invoice().payments[0], {
      invoiceRemoteId: "130",
      customerId: "58",
      timezone: "America/Chicago",
      currency: "usd",
    });
    expect(body).toMatchObject({
      CustomerRef: { value: "58" },
      TotalAmt: 132,
      TxnDate: "2026-01-01",
      Line: [{ Amount: 132, LinkedTxn: [{ TxnId: "130", TxnType: "Invoice" }] }],
      DepositToAccountRef: { value: "35" },
    });
  });
});

describe("customers are looked up before they are created", () => {
  it("uses the stored QuickBooks Id and asks nothing", async () => {
    const { intuit, qbo } = setup();
    const r = await findOrCreateQboCustomer(qbo, { ...invoice().client!, accounting_remote_id: "58" }, "req");
    expect(r).toEqual({ id: "58", store: false });
    expect(intuit.calls).toEqual([]);
  });

  it("finds an existing customer by DisplayName instead of creating a duplicate", async () => {
    const { intuit, qbo } = setup();
    intuit.on(api("query"), reply(200, { QueryResponse: { Customer: [{ Id: "58", DisplayName: "Pat O'Neil", PrimaryEmailAddr: { Address: "PAT@example.com" } }] } }));
    const r = await findOrCreateQboCustomer(qbo, invoice().client!, "req");
    expect(r).toEqual({ id: "58", store: true });
    const q = new URL(intuit.calls[0].url).searchParams.get("query");
    expect(q).toBe(`select Id, DisplayName, PrimaryEmailAddr from Customer where DisplayName = 'Pat O\\'Neil'`);
  });

  it("then by email, and only then creates one, with a request id", async () => {
    const { intuit, qbo } = setup();
    intuit
      .on(api("query"), reply(200, { QueryResponse: {} }))
      .on(api("query"), reply(200, { QueryResponse: {} }))
      .on(api("customer"), reply(200, { Customer: { Id: "59" } }), "POST");
    const r = await findOrCreateQboCustomer(qbo, invoice().client!, "req-123");
    expect(r).toEqual({ id: "59", store: true });
    expect(new URL(intuit.calls[2].url).searchParams.get("requestid")).toBe("req-123");
    expect(JSON.parse(intuit.calls[2].body!)).toMatchObject({ DisplayName: "Pat O'Neil", PrimaryEmailAddr: { Address: "pat@example.com" } });
  });

  it("on a Duplicate Name it cannot see (an inactive customer), creates once more under a distinguishing name", async () => {
    const { intuit, qbo } = setup();
    intuit
      .on(api("query"), reply(200, { QueryResponse: {} }))
      .on(api("query"), reply(400, { Fault: { Error: [{ Message: "QueryParserError", code: "4000" }] } }))
      .on(api("customer"), reply(400, { Fault: { Error: [{ Message: "Duplicate Name Exists Error", code: "6240" }] } }), "POST")
      .on(api("customer"), reply(200, { Customer: { Id: "60" } }), "POST");
    const r = await findOrCreateQboCustomer(qbo, invoice().client!, "req");
    expect(r).toEqual({ id: "60", store: true });
    expect(JSON.parse(intuit.calls[3].body!).DisplayName).toBe("Pat O'Neil (client)");
  });

  it("quotes a name for the query language", () => {
    expect(qboQuoted(`a'b\\c`)).toBe(`'a\\'b\\\\c'`);
  });
});

function memoryStore(inv: InvoiceToSync) {
  const log: SyncLogEntry[] = [];
  const saved: Array<[string, string, string]> = [];
  const store: QboSyncStore = {
    loadInvoice: async () => structuredClone(inv),
    saveRemoteId: async (table, id, remoteId) => {
      saved.push([table, id, remoteId]);
      if (table === "invoices") inv.accounting_remote_id = remoteId;
      if (table === "clients" && inv.client) inv.client.accounting_remote_id = remoteId;
      if (table === "payments") inv.payments.find((p) => p.id === id)!.accounting_remote_id = remoteId;
    },
    log: async (e) => void log.push(e),
    touchLastSync: async () => {},
  };
  return { store, log, saved, inv };
}

describe("a sync is idempotent", () => {
  it("creates the customer, invoice and payment once; a second sync updates them in place", async () => {
    const { intuit, qbo } = setup();
    const mem = memoryStore(invoice());
    let n = 0;
    const ids = () => `req-${++n}`;

    intuit
      .on(api("query"), reply(200, { QueryResponse: {} }))
      .on(api("query"), reply(200, { QueryResponse: {} }))
      .on(api("customer"), reply(200, { Customer: { Id: "58" } }, { tid: "tid-cust" }), "POST")
      .on(api("invoice"), reply(200, { Invoice: { Id: "130", SyncToken: "0" } }, { tid: "tid-inv" }), "POST")
      .on(api("payment"), reply(200, { Payment: { Id: "131", SyncToken: "0" } }, { tid: "tid-pay" }), "POST");
    const first = await syncInvoiceToQbo(qbo, mapping, mem.store, "inv-1", ids);
    expect(first).toMatchObject({ invoiceRemoteId: "130", invoiceCreated: true, payments: [{ id: "pay-1", remoteId: "131" }] });
    expect(mem.saved).toEqual([
      ["clients", "client-uuid-1", "58"],
      ["invoices", "inv-1", "130"],
      ["payments", "pay-1", "131"],
    ]);
    expect(mem.log.map((l) => [l.entity_type, l.status, l.intuit_tid])).toEqual([
      ["client", "success", "tid-cust"],
      ["invoice", "success", "tid-inv"],
      ["payment", "success", "tid-pay"],
    ]);

    // Second press: no query for the customer, no create anywhere.
    intuit
      .on(/invoice\/130\?/, reply(200, { Invoice: { Id: "130", SyncToken: "3" } }), "GET")
      .on(api("invoice\\?"), reply(200, { Invoice: { Id: "130", SyncToken: "4" } }), "POST")
      .on(/payment\/131\?/, reply(200, { Payment: { Id: "131", SyncToken: "0" } }), "GET")
      .on(api("payment\\?"), reply(200, { Payment: { Id: "131", SyncToken: "1" } }), "POST");
    const before = intuit.calls.length;
    const second = await syncInvoiceToQbo(qbo, mapping, mem.store, "inv-1", ids);
    expect(second.invoiceCreated).toBe(false);
    const again = intuit.calls.slice(before);
    expect(again.map((c) => c.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(JSON.parse(again[1].body!)).toMatchObject({ Id: "130", SyncToken: "3", sparse: true });
    expect(JSON.parse(again[3].body!)).toMatchObject({ Id: "131", SyncToken: "0", sparse: true });
    expect(again.some((c) => /requestid=/.test(c.url))).toBe(false);
    expect(intuit.pending()).toBe(0);
  });

  it("re-creates an invoice that was deleted in QuickBooks", async () => {
    const { intuit, qbo } = setup();
    const mem = memoryStore(invoice({ accounting_remote_id: "130", payments: [], client: { ...invoice().client!, accounting_remote_id: "58" } }));
    intuit
      .on(/invoice\/130\?/, reply(400, { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } }))
      .on(api("invoice\\?"), reply(200, { Invoice: { Id: "200" } }), "POST");
    const r = await syncInvoiceToQbo(qbo, mapping, mem.store, "inv-1", () => "req");
    expect(r).toMatchObject({ invoiceRemoteId: "200", invoiceCreated: true });
  });

  it("records a validation error with its code and intuit_tid, and does not retry it", async () => {
    const { intuit, qbo, sleeps } = setup();
    const mem = memoryStore(invoice({ client: { ...invoice().client!, accounting_remote_id: "58" } }));
    intuit.on(
      api("invoice\\?"),
      reply(400, { Fault: { Error: [{ Message: "Invalid Reference Id", Detail: "Item 1 is inactive", code: "2500" }] } }, { tid: "tid-bad" }),
      "POST",
    );
    await expect(syncInvoiceToQbo(qbo, mapping, mem.store, "inv-1", () => "req")).rejects.toBeInstanceOf(QboApiError);
    expect(mem.log).toEqual([
      expect.objectContaining({ entity_type: "invoice", status: "error", intuit_tid: "tid-bad", http_status: 400, error_code: "2500", attempts: 1 }),
    ]);
    expect(sleeps).toEqual([]);
  });

  it("refuses a taxed invoice with no sales-tax item before creating anything, customer included", async () => {
    const { intuit, qbo } = setup();
    const mem = memoryStore(invoice({ total_cents: 14_289, tax_cents: 1_089 }));
    await expect(
      syncInvoiceToQbo(qbo, { ...mapping, sales_tax_item_id: null }, mem.store, "inv-1"),
    ).rejects.toThrow(/sales tax item/);
    expect(intuit.calls).toEqual([]);
    expect(mem.log).toEqual([expect.objectContaining({ status: "error", error_code: "validation" })]);
  });

  it("only sends a paid invoice", async () => {
    const { qbo } = setup();
    const mem = memoryStore(invoice({ status: "open" }));
    await expect(syncInvoiceToQbo(qbo, mapping, mem.store, "inv-1")).rejects.toThrow(/Only paid invoices/);
  });
});

// Keep the InvoiceForSync import honest: the test data above is that shape.
const _shape: InvoiceForSync = invoice();
void _shape;
