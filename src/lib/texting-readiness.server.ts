// #1003: server-only. Reads whether each Twilio setting is present (a boolean,
// never the value) and the primary customer profile's status from ONE
// read-only Twilio call. A failure is an error CLASS, never Twilio's text.

import {
  READINESS_SETTINGS,
  summarize,
  type ProfileStatus,
  type TextingReadiness,
} from "@/lib/texting-readiness";

const TRUST_HUB = "https://trusthub.twilio.com/v1";

function mapStatus(raw: unknown): ProfileStatus {
  switch (raw) {
    case "twilio-approved":
      return { state: "approved" };
    case "pending-review":
    case "in-review":
      return { state: "in_review" };
    case "twilio-rejected":
      return { state: "rejected" };
    case "draft":
      return { state: "draft" };
    default:
      return { state: "unknown" };
  }
}

async function readPrimaryProfile(env: NodeJS.ProcessEnv): Promise<ProfileStatus> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const profile = env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID;
  if (!sid || !token || !profile) return { state: "not_checked" };
  try {
    const res = await fetch(`${TRUST_HUB}/CustomerProfiles/${encodeURIComponent(profile)}`, {
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    });
    if (res.status === 401 || res.status === 403) return { state: "error", errorClass: "auth" };
    if (res.status === 404) return { state: "error", errorClass: "not_found" };
    if (!res.ok) return { state: "error", errorClass: "twilio_unavailable" };
    const json = (await res.json().catch(() => ({}))) as { status?: unknown };
    return mapStatus(json?.status);
  } catch {
    return { state: "error", errorClass: "network" };
  }
}

export async function computeTextingReadiness(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TextingReadiness> {
  const settings = READINESS_SETTINGS.map((s) => ({ ...s, set: Boolean(env[s.name]) }));
  const profile = await readPrimaryProfile(env);
  const canFile =
    settings.filter((s) => s.required).every((s) => s.set) && profile.state === "approved";
  return { settings, profile, canFile, summary: summarize(settings, profile) };
}
