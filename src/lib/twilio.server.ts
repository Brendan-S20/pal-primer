// Server-only Twilio helper. Two credential modes, and every call names one:
//   - "gateway": the PLATFORM's own Twilio via the Lovable connector gateway,
//     which owns HoundStack's toll-free number. ACCOUNT HOLDERS ONLY, and the
//     caller has to say so: `{ mode: "gateway", purpose: "account_holder" }`.
//   - "direct": a business's own provisioned subaccount, calling the Twilio
//     REST API with its Account SID + Auth Token. The only way to text a
//     business's client or lead; get it from `endCustomerSmsSender`.
//
// There is no default. Gateway used to be what you got by leaving
// `credentials` out, so an end-customer text reached the platform account by
// omission, which is the opposite of what the toll-free filing says. See
// lib/twilio-credentials.server.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
const TWILIO_API = "https://api.twilio.com/2010-04-01";

export type TwilioSendResult = {
  sid: string;
  status: string;
  error_code?: number | null;
  error_message?: string | null;
};

export type TwilioCredentials =
  /** HoundStack's own account and toll-free number. `purpose` is not
   *  decoration: it is the declaration that the person texted signs in to
   *  HoundStack, and the ratchet test allowlists every place that makes it. */
  | { mode: "gateway"; purpose: "account_holder" }
  | { mode: "direct"; accountSid: string; authToken: string };

export async function sendTwilioSms(params: {
  to: string;
  body: string;
  from?: string;
  messagingServiceSid?: string;
  credentials: TwilioCredentials;
}): Promise<TwilioSendResult> {
  const creds = params.credentials;
  if (!creds) throw new Error("Twilio send requires credentials: a subaccount, or the platform for an account holder");
  if (creds.mode === "gateway" && creds.purpose !== "account_holder") {
    // The type already refuses this; an `any` on the way in does not.
    throw new Error("The platform number texts account holders only");
  }
  if (!params.from && !params.messagingServiceSid) {
    throw new Error("Twilio send requires a From number or a Messaging Service SID");
  }

  const form = new URLSearchParams({ To: params.to, Body: params.body });
  if (params.messagingServiceSid) form.set("MessagingServiceSid", params.messagingServiceSid);
  else if (params.from) form.set("From", params.from);

  let res: Response;
  if (creds.mode === "direct") {
    // Tenant BYOK: Twilio REST with Basic auth (AccountSid:AuthToken).
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
    res = await fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
  } else {
    // Platform: via the Lovable connector gateway.
    const lovableKey = process.env.LOVABLE_API_KEY;
    const twilioKey = process.env.TWILIO_API_KEY;
    if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
    if (!twilioKey) throw new Error("TWILIO_API_KEY is not configured");
    res = await fetch(`${GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": twilioKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
  }

  const json = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      `Twilio send failed [${res.status}]: ${json?.message ?? JSON.stringify(json)}`,
    );
  }
  return {
    sid: json.sid,
    status: json.status,
    error_code: json.error_code ?? null,
    error_message: json.error_message ?? null,
  };
}

// Normalize a phone string down to digits for comparison.
export function phoneDigits(p: string | null | undefined): string {
  return (p ?? "").replace(/\D/g, "");
}
