// Server-only Twilio helper (via Lovable connector gateway).
const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";

export type TwilioSendResult = {
  sid: string;
  status: string;
  error_code?: number | null;
  error_message?: string | null;
};

export async function sendTwilioSms(params: {
  from: string;
  to: string;
  body: string;
}): Promise<TwilioSendResult> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const twilioKey = process.env.TWILIO_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!twilioKey) throw new Error("TWILIO_API_KEY is not configured");

  const body = new URLSearchParams({
    From: params.from,
    To: params.to,
    Body: params.body,
  });

  const res = await fetch(`${GATEWAY_URL}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": twilioKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
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
