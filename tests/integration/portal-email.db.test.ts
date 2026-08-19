/**
 * Proves the portal OTP EMAIL path actually attempts a real provider send and
 * records it — stronger evidence than "a row was queued". We intercept the
 * outgoing HTTP request to Resend and assert:
 *   1. issuePortalOtp POSTs to the provider with the auth header + OTP payload.
 *   2. On provider success → email_send_log row status='sent' with the
 *      provider_message_id (the value you cross-reference in the dashboard).
 *   3. On provider failure → it throws (never silent) AND logs status='failed'.
 *
 * Local stack only; skipped without TEST_SUPABASE_* env.
 *
 * ── THIS FILE WAS AIMED AT A PROVIDER THE CODE NO LONGER USES ─────────────
 *
 * It ran for the first time on 2026-08-15, when the Sandboxes replay finally
 * built a database for it, and two of its three tests failed with
 *
 *     Error: Email isn't configured for this company. Ask us to read you the code.
 *
 * which portal-auth.server.ts raises when RESEND_API_KEY is unset. The file
 * was setting LOVABLE_API_KEY and intercepting api.lovable.dev — the OTP email
 * path has since moved to Resend, and nothing noticed, because a test that has
 * never run cannot observe that the thing it tests was rewritten underneath it.
 *
 * That is the same fault as every other one this replay found, one layer up:
 * evidence nobody had checked in a while, trusted because it was written down.
 *
 * Retargeted at what the code does now — POST https://api.resend.com/emails,
 * Bearer RESEND_API_KEY, `to` as an array, provider id read from `id` in the
 * response body. The THIRD test needed no change: the current code still
 * throws "We couldn't email your code right now" and still writes a 'failed'
 * row, which is what it always asserted.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);

// portal-auth.server + client.server read these at import/use time.
if (enabled) {
  process.env.SUPABASE_URL = URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  process.env.RESEND_API_KEY = "test-resend-key";
}

const runId = Math.random().toString(36).slice(2, 8);
let admin: SupabaseClient;
let clientId: string;
let token: string;
let token2: string;
const email = `email-otp-${runId}@test.local`;
const email2 = `email-otp-fail-${runId}@test.local`;

const realFetch = globalThis.fetch;
let captured: { url: string; init: any } | null = null;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as any).id as string;
}

describe.skipIf(!enabled)("portal OTP email is attempted + logged (finding #4)", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    const orgId = await ins("organizations", { name: `Email Test ${runId}` });
    clientId = await ins("clients", {
      organization_id: orgId,
      display_name: "Email Client",
      account_type: "residential",
      primary_email: email,
      active: true,
    });
    const { data } = await admin.from("clients").select("portal_token").eq("id", clientId).single();
    token = (data as any).portal_token;

    // Separate client for the failure case (per-client rate limit is 30s).
    const clientId2 = await ins("clients", {
      organization_id: orgId,
      display_name: "Email Client 2",
      account_type: "residential",
      primary_email: email2,
      active: true,
    });
    const { data: d2 } = await admin.from("clients").select("portal_token").eq("id", clientId2).single();
    token2 = (d2 as any).portal_token;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    captured = null;
  });

  function mockProvider(response: { ok: boolean; body: any }) {
    globalThis.fetch = (async (input: any, init: any) => {
      const u = typeof input === "string" ? input : input?.url ?? "";
      if (String(u).includes("api.resend.com")) {
        captured = { url: String(u), init };
        return new Response(JSON.stringify(response.body), {
          status: response.ok ? 200 : 502,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init); // supabase + everything else hits the real stack
    }) as any;
  }

  it("POSTs the code to the provider and logs a 'sent' row with the provider id", async () => {
    mockProvider({ ok: true, body: { id: "prov_msg_123" } });
    const { issuePortalOtp } = await import("@/lib/portal-auth.server");

    const res = await issuePortalOtp(token, "email");
    expect(res.sent).toBe(true);
    expect(res.channel).toBe("email");

    // The real outgoing provider request happened, with auth + our payload.
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain("/emails");
    const headers = new Headers(captured!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-resend-key");
    const sentBody = JSON.parse(captured!.init.body);
    // Resend takes an ARRAY of recipients; the Lovable API took a string.
    expect(sentBody.to).toEqual([email]);
    expect(sentBody.subject).toMatch(/verification code/i);
    expect(sentBody.html).toMatch(/\d/); // contains the code

    // Evidence trail: a 'sent' log row carrying the provider's message id.
    const { data: log } = await admin
      .from("email_send_log")
      .select("status, metadata, recipient_email")
      .eq("recipient_email", email)
      .eq("status", "sent")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(log).not.toBeNull();
    expect((log as any).metadata?.provider_message_id).toBe("prov_msg_123");
  });

  it("throws AND logs 'failed' when the provider rejects (never silent)", async () => {
    mockProvider({ ok: false, body: { message: "domain_unverified" } });
    const { issuePortalOtp } = await import("@/lib/portal-auth.server");

    await expect(issuePortalOtp(token2, "email")).rejects.toThrow(/couldn't email/i);

    const { data: log } = await admin
      .from("email_send_log")
      .select("status")
      .eq("recipient_email", email2)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(log).not.toBeNull();
  });
});
