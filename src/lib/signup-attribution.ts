// Referral + UTM attribution for new-tenant signups (Feature 1/2).
//
// /sign-up?ref=CODE&utm_source=… stashes attribution here (localStorage) so it
// survives the whole walkthrough — including the OAuth path, which bounces
// through the provider and back — and is handed to bootstrap_organization at
// org creation, the only moment attribution can be captured reliably.

import { requestedServiceLine } from "@/lib/signup-service";
import type { ServiceLine } from "@/lib/service-lines";

const KEY = "hs_signup_attribution";

export type SignupAttribution = {
  ref?: string;
  utm?: Record<string, string>;
  /** "Promo or referral code" typed on Get-started (coupon OR referral code —
   *  classified server-side). Stashed so it survives the OAuth bounce. */
  promo?: string;
  /** The service line the visitor came for (`?service=`, site-r2-03). Only a
   *  line the settings screen offers survives requestedServiceLine. */
  service?: ServiceLine;
  /** Epoch ms when the attribution was captured. */
  at?: number;
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

// A stash that never expired could attribute a stranger's signup months later
// on a shared computer (QA finding). 30 days matches typical referral-cookie
// windows.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function stashSignupAttribution(search: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = search[k];
    if (typeof v === "string" && v) utm[k] = v.slice(0, 200);
  }
  const ref = typeof search.ref === "string" && search.ref ? search.ref.slice(0, 40) : undefined;
  const service = requestedServiceLine(search.service);
  if (!ref && !service && !Object.keys(utm).length) return;
  const existing = readSignupAttribution();
  const next: SignupAttribution = {
    ref: ref ?? existing.ref,
    utm: { ...existing.utm, ...utm },
    promo: existing.promo,
    service: service ?? existing.service,
    at: Date.now(),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private-mode storage failures shouldn't break signup.
  }
}

/** Stash (or clear, with "") the promo box's contents so a signup that
 *  detours through OAuth still hands the code to bootstrap_organization. */
export function stashSignupPromoCode(code: string) {
  if (typeof window === "undefined") return;
  const existing = readSignupAttribution();
  const promo = code.trim().slice(0, 40) || undefined;
  const next: SignupAttribution = { ...existing, promo, at: Date.now() };
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
    const parsed = JSON.parse(raw) as SignupAttribution;
    if (typeof parsed !== "object" || !parsed) return {};
    if (typeof parsed.at === "number" && Date.now() - parsed.at > MAX_AGE_MS) {
      clearSignupAttribution();
      return {};
    }
    return parsed;
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
