import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { sendTwilioSms } from "@/lib/twilio.server";
import { twilioSignatureIsValid } from "@/lib/twilio-signature.server";

function ok(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.LOVABLE_API_KEY = "lov-key";
  process.env.TWILIO_API_KEY = "conn-key";
});
afterEach(() => vi.unstubAllGlobals());

describe("sendTwilioSms — direct (tenant BYOK)", () => {
  it("calls the Twilio REST API on the org's account with Basic auth", async () => {
    fetchMock.mockResolvedValueOnce(ok({ sid: "SM1", status: "queued" }));
    const res = await sendTwilioSms({
      to: "+15550001111",
      body: "hi",
      from: "+15558675310",
      credentials: { mode: "direct", accountSid: "ACxxx", authToken: "tok" },
    });
    expect(res).toEqual({ sid: "SM1", status: "queued", error_code: null, error_message: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json");
    expect((init as any).headers.Authorization).toBe(
      `Basic ${Buffer.from("ACxxx:tok").toString("base64")}`,
    );
    expect(String((init as any).body)).toContain("From=%2B15558675310");
  });

  it("prefers a Messaging Service SID when provided", async () => {
    fetchMock.mockResolvedValueOnce(ok({ sid: "SM2", status: "queued" }));
    await sendTwilioSms({
      to: "+15550001111",
      body: "hi",
      messagingServiceSid: "MGabc",
      credentials: { mode: "direct", accountSid: "ACxxx", authToken: "tok" },
    });
    const body = String((fetchMock.mock.calls[0][1] as any).body);
    expect(body).toContain("MessagingServiceSid=MGabc");
    expect(body).not.toContain("From=");
  });
});

describe("sendTwilioSms — gateway (platform, account holders only)", () => {
  it("routes through the Lovable connector gateway with platform keys", async () => {
    fetchMock.mockResolvedValueOnce(ok({ sid: "SM3", status: "sent" }));
    await sendTwilioSms({
      to: "+15550001111",
      body: "hi",
      from: "+15550002222",
      credentials: { mode: "gateway", purpose: "account_holder" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("connector-gateway.lovable.dev/twilio");
    expect((init as any).headers.Authorization).toBe("Bearer lov-key");
    expect((init as any).headers["X-Connection-Api-Key"]).toBe("conn-key");
  });

  it("throws when neither From nor Messaging Service is supplied", async () => {
    await expect(
      sendTwilioSms({ to: "+1", body: "x", credentials: { mode: "gateway", purpose: "account_holder" } }),
    ).rejects.toThrow(
      /From number or a Messaging Service/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("twilioSignatureIsValid", () => {
  const token = "auth-token-xyz";
  const url = "https://app.houndstack.com/api/public/hooks/twilio";
  const params = { To: "+15558675310", From: "+15550001111", Body: "Hello" };

  function sign(u: string, p: Record<string, string>) {
    let data = u;
    for (const k of Object.keys(p).sort()) data += k + p[k];
    return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  }

  it("accepts a correct signature", () => {
    expect(twilioSignatureIsValid(url, params, token, sign(url, params))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const good = sign(url, params);
    expect(twilioSignatureIsValid(url, { ...params, Body: "Tampered" }, token, good)).toBe(false);
  });

  it("rejects a wrong token", () => {
    const forged = crypto
      .createHmac("sha1", "other")
      .update(Buffer.from(url, "utf-8"))
      .digest("base64");
    expect(twilioSignatureIsValid(url, params, token, forged)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(twilioSignatureIsValid(url, params, token, null)).toBe(false);
  });
});
