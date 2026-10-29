// BUILD-3 (#538): each business texts its clients from its own Twilio
// subaccount, registered in that business's own name (toll-free verification
// by default).
//
// What this pins, against the ship checklist Product locked:
//   1. the owner's submit creates subaccount, business profile, number and
//      toll-free verification, with no console work, and resumes rather than
//      duplicates after a failure
//   2. status reads in plain words, rejection with reason and deadline, and a
//      rejection alerts HoundStack once
//   3. texting turns on ONLY on approval, through activate_org_texting, with a
//      v1. ciphertext token and the same E.164 number; pending cannot send
//   4. the EIN and the token are never stored, logged or returned
//   5. client consent names the business (tests/the-portal-consent-...)
//   6. every text to a client starts with the business's name
//   7. each bought number's incoming URL is the one inbound hook, POST

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ── A fake service-role client: one registration row, recorded writes ──────

type Row = Record<string, any>;
let reg: Row | null;
let org: Row;
const writes: Array<{ table: string; op: string; payload: unknown }> = [];
const rpcs: Array<{ fn: string; args: Row }> = [];
let rpcError: { message: string } | null = null;

function builder(table: string) {
  let op = "select";
  let payload: any;
  const b: any = {
    select: () => b,
    eq: () => b,
    in: () => b,
    upsert: (p: Row) => {
      op = "upsert";
      payload = p;
      writes.push({ table, op, payload: p });
      if (table === "org_texting_registrations") {
        reg = { ...(reg ?? {}), ...p, updated_at: new Date().toISOString() };
      }
      return Promise.resolve({ error: null });
    },
    update: (p: Row) => {
      op = "update";
      payload = p;
      writes.push({ table, op, payload: p });
      if (table === "org_texting_registrations" && reg) reg = { ...reg, ...p };
      return b;
    },
    insert: (p: Row) => {
      writes.push({ table, op: "insert", payload: p });
      return Promise.resolve({ error: null });
    },
    maybeSingle: async () => {
      if (table === "org_texting_registrations") return { data: reg, error: null };
      if (table === "organizations") return { data: org, error: null };
      return { data: null, error: null };
    },
    then: (res: (v: unknown) => unknown) => {
      if (op === "update") return Promise.resolve({ error: null }).then(res);
      if (table === "platform_admins")
        return Promise.resolve({ data: [{ user_id: "admin-1" }], error: null }).then(res);
      if (table === "org_texting_registrations")
        return Promise.resolve({ data: reg ? [reg] : [], error: null }).then(res);
      return Promise.resolve({ data: [], error: null }).then(res);
    },
  };
  void payload;
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Row) => {
      rpcs.push({ fn, args });
      return { data: null, error: fn === "activate_org_texting" ? rpcError : null };
    },
    auth: {
      admin: { getUserById: async () => ({ data: { user: { email: "brendan@example.com" } } }) },
    },
  },
}));
const notified: unknown[] = [];
vi.mock("@/lib/notify-center.server", () => ({
  notifyRoles: vi.fn(async (_r: unknown, n: unknown) => void notified.push(n)),
}));

// ── A fake Twilio ───────────────────────────────────────────────────────────

const SUB_SID = "AC" + "1".repeat(32);
const SUB_TOKEN = "f".repeat(32);
const NUMBER = "+18445550123";
let tfvStatus = "PENDING_REVIEW";
let failNumberPurchase = false;
const calls: Array<{ method: string; url: string; body: URLSearchParams; auth: string }> = [];

function reply(json: unknown, status = 200) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(
    method === "GET" ? (url.split("?")[1] ?? "") : String(init?.body ?? ""),
  );
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
  calls.push({ method, url, body, auth });
  const path = url.split("?")[0];
  if (path.endsWith("/2010-04-01/Accounts.json")) return reply({ sid: SUB_SID, auth_token: SUB_TOKEN });
  if (path.endsWith(`/Accounts/${SUB_SID}.json`)) return reply({ sid: SUB_SID, auth_token: SUB_TOKEN });
  if (path.includes("/Addresses")) return reply({ sid: "AD1" });
  if (path.endsWith("/EndUsers")) {
    const type = body.get("Type");
    return reply({ sid: type === "customer_profile_business_information" ? "IT_BIZ" : `IT_${type}` });
  }
  if (path.includes("/EndUsers/")) return reply({ sid: "IT_X" });
  if (path.endsWith("/SupportingDocuments")) return reply({ sid: "RD1" });
  if (path.endsWith("/CustomerProfiles")) return reply({ sid: "BU1", status: "draft" });
  if (path.endsWith("/EntityAssignments")) return reply({ sid: "BV1" });
  if (path.endsWith("/Evaluations")) return reply({ status: "compliant", results: [] });
  if (path.endsWith("/CustomerProfiles/BU1")) return reply({ sid: "BU1", status: "pending-review" });
  if (path.includes("/AvailablePhoneNumbers/US/TollFree.json"))
    return reply({ available_phone_numbers: [{ phone_number: NUMBER }] });
  if (path.endsWith("/IncomingPhoneNumbers.json")) {
    if (failNumberPurchase) return reply({ message: "number gone", code: 21422 }, 400);
    return reply({ sid: "PN1", phone_number: NUMBER });
  }
  if (path.endsWith("/Tollfree/Verifications") && method === "POST")
    return reply({ sid: "HH1", status: "PENDING_REVIEW" });
  if (path.endsWith("/Tollfree/Verifications/HH1") && method === "GET")
    return reply({
      sid: "HH1",
      status: tfvStatus,
      rejection_reason: tfvStatus === "TWILIO_REJECTED" ? "Opt-in image does not show consent" : null,
      error_code: tfvStatus === "TWILIO_REJECTED" ? 30513 : null,
      edit_expiration: tfvStatus === "TWILIO_REJECTED" ? "2026-11-05T00:00:00Z" : null,
    });
  return reply({ message: `unexpected ${method} ${path}` }, 404);
});

const EIN = "38-1234567";
const DETAILS = {
  legal_name: "Detroit Doo Disposal LLC",
  business_type: "llc" as const,
  dba: "Detroit Doo",
  street: "100 Woodward Ave",
  street2: "",
  city: "Detroit",
  region: "MI",
  postal_code: "48226",
  website_url: "https://detroitdoo.com",
  privacy_url: "https://detroitdoo.com/privacy",
  terms_url: "https://detroitdoo.com/terms",
  business_email: "devin@detroitdoo.com",
  business_phone: "(313) 555-0100",
  contacts: [
    { first_name: "Devin", last_name: "Doe", title: "Owner", email: "devin@detroitdoo.com", phone: "313-555-0101" },
    { first_name: "Sam", last_name: "Roe", title: "Manager", email: "sam@detroitdoo.com", phone: "313-555-0102" },
  ],
};

const logged: string[] = [];
beforeEach(() => {
  reg = null;
  org = { name: "Detroit Doo", slug: "detroit-doo" };
  writes.length = 0;
  rpcs.length = 0;
  calls.length = 0;
  notified.length = 0;
  logged.length = 0;
  rpcError = null;
  tfvStatus = "PENDING_REVIEW";
  failNumberPurchase = false;
  vi.stubGlobal("fetch", fetchMock);
  process.env.TWILIO_ACCOUNT_SID = "AC" + "0".repeat(32);
  process.env.TWILIO_AUTH_TOKEN = "parent-token";
  process.env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID = "BUprimary";
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  delete process.env.APP_ORIGIN;
  delete process.env.PUBLIC_APP_ORIGIN;
  delete process.env.APP_URL;
  for (const k of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const prov = await import("@/lib/twilio-provisioning.server");
const tr = await import("@/lib/texting-registration");
const { brandedBody } = await import("@/lib/sms-brand");
const { sendTwilioSms } = await import("@/lib/twilio.server");

async function submit() {
  return prov.submitTextingRegistration({
    orgId: "org-1",
    userId: "owner-1",
    details: tr.registrationDetailsSchema.parse(DETAILS),
    ein: EIN,
  });
}

describe("1. one submit, no console work", () => {
  it("creates the subaccount, the business profile, a toll-free number and its verification", async () => {
    const r = await submit();
    expect(r).toEqual({ status: "submitted" });
    const paths = calls.map((c) => `${c.method} ${c.url.split("?")[0].replace(/^https:\/\/[^/]+/, "")}`);
    expect(paths[0]).toBe("POST /2010-04-01/Accounts.json");
    expect(paths).toContain("POST /v1/CustomerProfiles");
    expect(paths).toContain("POST /v1/CustomerProfiles/BU1/Evaluations");
    expect(paths).toContain(`POST /2010-04-01/Accounts/${SUB_SID}/IncomingPhoneNumbers.json`);
    expect(paths.at(-1)).toBe("POST /v1/Tollfree/Verifications");
    expect(reg).toMatchObject({
      status: "submitted",
      subaccount_sid: SUB_SID,
      customer_profile_sid: "BU1",
      phone_number: NUMBER,
      verification_sid: "HH1",
    });
  });

  it("files the profile as a secondary profile that cites HoundStack's primary one", async () => {
    await submit();
    const profile = calls.find((c) => c.url.endsWith("/v1/CustomerProfiles"))!;
    expect(profile.body.get("PolicySid")).toBe(prov.SECONDARY_PROFILE_POLICY_SID);
    const assigned = calls
      .filter((c) => c.url.endsWith("/EntityAssignments"))
      .map((c) => c.body.get("ObjectSid"));
    expect(assigned).toContain("BUprimary");
    expect(assigned).toContain("IT_BIZ");
    expect(assigned).toContain("IT_authorized_representative_1");
    expect(assigned).toContain("IT_authorized_representative_2");
  });

  it("buys the number in the business's own subaccount, never the parent", async () => {
    await submit();
    const buy = calls.find((c) => c.url.endsWith("/IncomingPhoneNumbers.json"))!;
    expect(buy.url).toContain(`/Accounts/${SUB_SID}/`);
  });

  it("7. sets the bought number's incoming URL to the one inbound hook, POST", async () => {
    await submit();
    const buy = calls.find((c) => c.url.endsWith("/IncomingPhoneNumbers.json"))!;
    expect(buy.body.get("SmsUrl")).toBe("https://app.houndstack.com/api/public/hooks/twilio");
    expect(buy.body.get("SmsMethod")).toBe("POST");
    expect(prov.inboundSmsUrl()).toBe("https://app.houndstack.com/api/public/hooks/twilio");
  });

  it("files the verification as the subaccount, in the business's own name", async () => {
    await submit();
    const tfv = calls.find((c) => c.url.endsWith("/Tollfree/Verifications"))!;
    expect(tfv.auth).toBe(`Basic ${Buffer.from(`${SUB_SID}:${SUB_TOKEN}`).toString("base64")}`);
    expect(tfv.body.get("BusinessName")).toBe("Detroit Doo Disposal LLC");
    expect(tfv.body.get("DoingBusinessAs")).toBe("Detroit Doo");
    expect(tfv.body.getAll("UseCaseCategories")).toEqual(["ACCOUNT_NOTIFICATIONS", "CUSTOMER_CARE"]);
    expect(tfv.body.get("TollfreePhoneNumberSid")).toBe("PN1");
    expect(tfv.body.get("CustomerProfileSid")).toBe("BU1");
    expect(tfv.body.get("PrivacyPolicyUrl")).toBe("https://detroitdoo.com/privacy");
    expect(tfv.body.get("TermsAndConditionsUrl")).toBe("https://detroitdoo.com/terms");
    // Not HoundStack's name anywhere a reviewer reads as the brand.
    for (const k of ["BusinessName", "DoingBusinessAs", "BusinessWebsite", "ProductionMessageSample"]) {
      expect(tfv.body.get(k) ?? "").not.toMatch(/houndstack/i);
    }
    expect(tfv.body.get("ProductionMessageSample")).toMatch(/^Detroit Doo: /);
    expect(tfv.body.get("OptInConfirmationMessage")).toMatch(/^Detroit Doo: /);
  });

  it("resumes after a failure without a second subaccount or profile", async () => {
    failNumberPurchase = true;
    const first = await submit();
    expect(first.status).toBe("failed");
    expect(reg?.status).toBe("failed");
    expect(reg?.last_error).toMatch(/number gone/);

    failNumberPurchase = false;
    calls.length = 0;
    const second = await submit();
    expect(second.status).toBe("submitted");
    expect(calls.some((c) => c.url.endsWith("/2010-04-01/Accounts.json"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/v1/CustomerProfiles"))).toBe(false);
  });

  it("refuses a second submit while one is with Twilio", async () => {
    await submit();
    calls.length = 0;
    const again = await submit();
    expect(again.status).toBe("submitted");
    expect(again.error).toMatch(/already with Twilio/);
    expect(calls).toEqual([]);
  });
});

describe("4. the EIN and the token go nowhere but Twilio", () => {
  it("never writes the EIN or the subaccount token to the database", async () => {
    tfvStatus = "TWILIO_APPROVED";
    await submit();
    await prov.refreshTextingStatus("org-1");
    const everything = JSON.stringify(writes) + JSON.stringify(rpcs);
    expect(everything).not.toContain("381234567");
    expect(everything).not.toContain(EIN);
    expect(everything).not.toContain(SUB_TOKEN);
    expect(reg?.ein_last4).toBe("4567");
  });

  it("never logs the EIN, even when Twilio echoes it back in an error", async () => {
    fetchMock.mockImplementationOnce(async () =>
      reply({ message: `Account limit reached for EIN ${EIN} (381234567)` }, 400),
    );
    const r = await submit();
    expect(r.status).toBe("failed");
    const text = logged.join("\n") + (r.error ?? "") + JSON.stringify(writes);
    expect(text).not.toContain("381234567");
    expect(text).not.toContain(EIN);
  });

  it("scrubs nine-digit runs and token-shaped strings", () => {
    expect(prov.scrub(`ein ${EIN} and 381234567 and token ${SUB_TOKEN}`, EIN)).toBe(
      "ein [EIN] and [EIN] and token [secret]",
    );
  });

  it("the settings read never selects a SID, a token or an EIN", () => {
    const src = read("src/lib/texting-registration.functions.ts");
    const cols = /const DETAIL_COLUMNS =([\s\S]*?);/.exec(src)![1];
    expect(cols).not.toMatch(/_sid|token|\bein\b/);
    expect(cols).toMatch(/ein_last4/);
  });
});

describe("2 and 3. status, and texting only on approval", () => {
  it("a pending verification does not turn texting on", async () => {
    await submit();
    tfvStatus = "IN_REVIEW";
    expect(await prov.refreshTextingStatus("org-1")).toBe("in_review");
    expect(rpcs.find((r) => r.fn === "activate_org_texting")).toBeUndefined();
  });

  it("approval writes the credential through activate_org_texting: v1. ciphertext, same E.164", async () => {
    await submit();
    tfvStatus = "TWILIO_APPROVED";
    expect(await prov.refreshTextingStatus("org-1")).toBe("approved");
    const act = rpcs.find((r) => r.fn === "activate_org_texting")!;
    expect(act.args._org_id).toBe("org-1");
    expect(act.args._account_sid).toBe(SUB_SID);
    expect(String(act.args._auth_token).startsWith("v1.")).toBe(true);
    expect(act.args._token_last4).toBe(SUB_TOKEN.slice(-4));
    expect(act.args._from).toBe(NUMBER);
    expect(notified).toContainEqual(expect.objectContaining({ type: "texting_approved" }));
  });

  it("a rejection records reason and deadline, and alerts HoundStack and the owner once", async () => {
    await submit();
    tfvStatus = "TWILIO_REJECTED";
    expect(await prov.refreshTextingStatus("org-1")).toBe("rejected");
    expect(reg).toMatchObject({
      status: "rejected",
      rejection_reason: "Opt-in image does not show consent",
      rejection_code: "30513",
      resubmit_deadline: "2026-11-05T00:00:00Z",
    });
    const emails = rpcs.filter((r) => r.fn === "enqueue_email");
    expect(emails).toHaveLength(1);
    expect(emails[0].args.payload.to).toBe("brendan@example.com");
    expect(emails[0].args.payload.subject).toMatch(/rejected: Detroit Doo/);
    expect(notified).toContainEqual(expect.objectContaining({ type: "texting_rejected" }));

    await prov.refreshTextingStatus("org-1");
    expect(rpcs.filter((r) => r.fn === "enqueue_email")).toHaveLength(1);
  });

  it("maps Twilio's statuses and says each in plain words", () => {
    expect(tr.statusFromVerification("PENDING_REVIEW")).toBe("submitted");
    expect(tr.statusFromVerification("IN_REVIEW")).toBe("in_review");
    expect(tr.statusFromVerification("TWILIO_APPROVED")).toBe("approved");
    expect(tr.statusFromVerification("TWILIO_REJECTED")).toBe("rejected");
    expect(tr.describeStatus(null).title).toBe("Not started");
    expect(tr.describeStatus({ status: "draft" }).title).toBe("Waiting on your details");
    expect(tr.describeStatus({ status: "submitted" }).detail).toMatch(/three business days/);
    expect(tr.describeStatus({ status: "in_review" }).title).toBe("In review");
    expect(tr.describeStatus({ status: "approved", phone_number: NUMBER }).detail).toContain(NUMBER);
    const rejected = tr.describeStatus({
      status: "rejected",
      rejection_reason: "Opt-in image does not show consent",
      resubmit_deadline: "2026-11-05T00:00:00Z",
    });
    expect(rejected.title).toBe("Rejected");
    expect(rejected.detail).toMatch(/Opt-in image does not show consent/);
    expect(rejected.detail).toMatch(/resubmit by 2026-11-05/);
  });

  it("the poll runs every ten minutes, only while something is with Twilio", () => {
    const sql = read("supabase/migrations/20261029150000_each-business-texts-in-its-own-name.sql");
    expect(sql).toMatch(/cron\.schedule\('texting-status', '\*\/10 \* \* \* \*'/);
    expect(sql).toMatch(/AND public\.texting_status_due\(\);/);
    expect(sql).toMatch(/url := 'https:\/\/app\.houndstack\.com\/api\/public\/hooks\/texting-status'/);
  });
});

describe("the database refuses what the app must never do", () => {
  const sql = read("supabase/migrations/20261029150000_each-business-texts-in-its-own-name.sql");
  const activate = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.activate_org_texting"),
    sql.indexOf("$fn$;", sql.indexOf("CREATE OR REPLACE FUNCTION public.activate_org_texting")),
  );

  it("activates only an approved registration, its own subaccount and number", () => {
    expect(activate).toMatch(/_reg\.status <> 'approved'/);
    expect(activate).toMatch(/_reg\.subaccount_sid IS DISTINCT FROM _account_sid/);
    expect(activate).toMatch(/_reg\.phone_number IS DISTINCT FROM _from/);
  });

  it("refuses a plaintext token", () => {
    expect(activate).toMatch(/_auth_token NOT LIKE 'v1\.%'/);
  });

  it("writes the credential and the org's sender in one function, so one transaction", () => {
    expect(activate).toMatch(/INSERT INTO public\.org_twilio_credentials/);
    expect(activate).toMatch(/UPDATE public\.organizations SET sms_from_number = _from/);
  });

  it("is the service role's alone", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.activate_org_texting\(uuid, text, text, text, text\) FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("stores four digits of an EIN at most", () => {
    expect(sql).toMatch(/ein_last4 IS NULL OR ein_last4 ~ '\^\[0-9\]\{4\}\$'/);
    expect(sql).not.toMatch(/\bein text\b|\bein_full\b/i);
  });

  it("lets the booking link record consent the way the portal does, and nobody else anonymously", () => {
    expect(sql).toMatch(/_source IN \('portal', 'booking'\) AND auth\.uid\(\) IS NULL/);
    expect(sql).toMatch(/'portal', 'staff', 'import', 'reply', 'booking'/);
  });
});

describe("the owner's form is checked before anything goes to Twilio", () => {
  const parse = (over: Partial<typeof DETAILS>) =>
    tr.registrationDetailsSchema.safeParse({ ...DETAILS, ...over });

  it("accepts a complete registration", () => {
    expect(parse({}).success).toBe(true);
  });

  it("wants Privacy and Terms on the business's own site, as separate pages", () => {
    expect(parse({ privacy_url: "https://termly.io/acme/privacy" }).success).toBe(false);
    expect(parse({ terms_url: "https://detroitdoo.com/privacy" }).success).toBe(false);
    expect(parse({ privacy_url: "https://www.detroitdoo.com/privacy" }).success).toBe(true);
  });

  it("wants the business email on the same domain", () => {
    expect(parse({ business_email: "detroitdoo@gmail.com" }).success).toBe(false);
  });

  it("wants two authorized contacts", () => {
    expect(parse({ contacts: [DETAILS.contacts[0]] as any }).success).toBe(false);
  });

  it("takes an EIN with or without the dash, and nothing else", () => {
    expect(tr.einSchema.safeParse("38-1234567").success).toBe(true);
    expect(tr.einSchema.safeParse("381234567").success).toBe(true);
    expect(tr.einSchema.safeParse("38-123456").success).toBe(false);
  });
});

describe("6. every text to a client starts with the business's name", () => {
  it("brands a body once, whatever case the template used", () => {
    expect(brandedBody("Detroit Doo", "Hi Sam, your visit is complete.")).toBe(
      "Detroit Doo: Hi Sam, your visit is complete.",
    );
    expect(brandedBody("Detroit Doo", "detroit doo: hi")).toBe("detroit doo: hi");
  });

  it("sendTwilioSms puts the name on anything sent from a subaccount", async () => {
    calls.length = 0;
    fetchMock.mockImplementationOnce(async (input: unknown, init?: RequestInit) => {
      calls.push({ method: "POST", url: String(input), body: new URLSearchParams(String(init?.body)), auth: "" });
      return reply({ sid: "SM1", status: "queued" });
    });
    await sendTwilioSms({
      to: "+13135550199",
      body: "Hi Sam, this is a reminder your visit is scheduled for Wed, Aug 12.",
      from: NUMBER,
      credentials: { mode: "direct", accountSid: SUB_SID, authToken: "tok", brand: "Detroit Doo" },
    });
    expect(calls[0].body.get("Body")).toBe(
      "Detroit Doo: Hi Sam, this is a reminder your visit is scheduled for Wed, Aug 12.",
    );
  });

  it("every sender of a client text brands the body it logs", () => {
    for (const f of [
      "src/lib/messages.functions.ts",
      "src/lib/on-my-way.server.ts",
      "src/lib/my-day.functions.ts",
      "src/lib/reviews.functions.ts",
      "src/routes/api/public/hooks/nightly.ts",
      "src/routes/api/public/hooks/stripe.ts",
      "src/lib/client-sms-consent.server.ts",
    ]) {
      expect(read(f), f).toMatch(/brandedBody\(\s*sender\.brand/);
    }
    // The portal code already starts with the business's name.
    expect(read("src/lib/portal-auth.server.ts")).toMatch(/`\$\{contact\.org_name\}: your verification code/);
  });
});

describe("the locked wording", () => {
  it("no file says client texts go out under HoundStack's 10DLC brand", () => {
    for (const f of [
      "src/lib/twilio-credentials.server.ts",
      "src/lib/twilio-settings.functions.ts",
      "src/routes/_authenticated/settings.sms.tsx",
      "docs/twilio-toll-free-resubmission.md",
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/under (our|HoundStack's) 10DLC brand/);
    }
    expect(read("src/lib/twilio-credentials.server.ts")).toMatch(
      /one subaccount per business,\s*\n?\/\/ registered in that business's own name \(toll-free verification by default\)/,
    );
  });
});
