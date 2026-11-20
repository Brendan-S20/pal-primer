// #1003: can texting file for a business today? Pure types and wording.
// Nothing here reads the environment or returns a value.

export type ReadinessSetting = {
  name: string;
  set: boolean;
  /** Filing for a business fails without it. */
  required: boolean;
};

export type ProfileStatus =
  | { state: "approved" | "in_review" | "rejected" | "draft" | "unknown" }
  | { state: "not_checked" }
  | { state: "error"; errorClass: "auth" | "not_found" | "twilio_unavailable" | "network" };

export type TextingReadiness = {
  settings: ReadinessSetting[];
  profile: ProfileStatus;
  canFile: boolean;
  summary: string;
};

const SETTINGS: Array<{ name: string; required: boolean }> = [
  { name: "TWILIO_ACCOUNT_SID", required: true },
  { name: "TWILIO_AUTH_TOKEN", required: true },
  { name: "TWILIO_PRIMARY_CUSTOMER_PROFILE_SID", required: true },
  { name: "TWILIO_API_KEY", required: false },
  { name: "TWILIO_COMPLIANCE_EMAIL", required: false },
  { name: "TWILIO_INBOUND_SECRET", required: false },
];

export const READINESS_SETTINGS: Array<{ name: string; required: boolean }> = [
  { name: "TWILIO_ACCOUNT_SID", required: true },
  { name: "TWILIO_AUTH_TOKEN", required: true },
  { name: "TWILIO_PRIMARY_CUSTOMER_PROFILE_SID", required: true },
  { name: "TWILIO_API_KEY", required: false },
  { name: "TWILIO_COMPLIANCE_EMAIL", required: false },
  { name: "TWILIO_INBOUND_SECRET", required: false },
];

export function summarize(settings: ReadinessSetting[], profile: ProfileStatus): string {
  const missing = settings.filter((s) => s.required && !s.set).map((s) => s.name);
  if (missing.length > 0) {
    return `Add ${missing.join(", ")} in the hosting secrets. Until then the first business to file will fail.`;
  }
  if (profile.state === "error") {
    return profile.errorClass === "auth"
      ? "Twilio refused the account SID and auth token. Check them in the hosting secrets."
      : profile.errorClass === "not_found"
        ? "Twilio has no customer profile with that SID. Check TWILIO_PRIMARY_CUSTOMER_PROFILE_SID in the hosting secrets."
        : "Could not reach Twilio to read the primary profile. Try again shortly.";
  }
  if (profile.state === "approved") return "Texting can file for a business today.";
  if (profile.state === "in_review")
    return "The primary customer profile is still in review at Twilio. Filing waits for approval.";
  if (profile.state === "rejected")
    return "Twilio rejected the primary customer profile. Fix it in the Twilio console.";
  return "The primary customer profile is not approved yet. Check it in the Twilio console.";
}
