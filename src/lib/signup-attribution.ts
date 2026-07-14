// Referral + UTM attribution for new-tenant signups (Feature 1/2).
//
// /sign-up?ref=CODE&utm_source=… stashes attribution here (localStorage) so it
// survives the whole walkthrough — including the OAuth path, which bounces
// through the provider and back — and is handed to bootstrap_organization at
// org creation, the only moment attribution can be captured reliably.

const KEY = "hs_signup_attribution";

export type SignupAttribution = {
  ref?: string;
  utm?: Record<string, string>;
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

export function stashSignupAttribution(search: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = search[k];
    if (typeof v === "string" && v) utm[k] = v.slice(0, 200);
  }
  const ref = typeof search.ref === "string" && search.ref ? search.ref.slice(0, 40) : undefined;
  if (!ref && !Object.keys(utm).length) return;
  const existing = readSignupAttribution();
  const next: SignupAttribution = {
    ref: ref ?? existing.ref,
    utm: { ...existing.utm, ...utm },
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private-mode storage failures shouldn't break signup.
  }
}

export function readSignupAttribution(): SignupAttribution {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function clearSignupAttribution() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
