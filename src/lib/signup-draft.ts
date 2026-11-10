// What a person has typed into /get-started, kept so the page cannot come
// back empty (#785 (a)).
//
// Onboarding QA, 2026-11-09: "Your business", Continue, then "Create my
// workspace" (the first submit took about 15 seconds), and the page dropped
// back to a BLANK "Create your account" form: email and password empty, no
// error, and no account created. The second attempt worked. Every field on
// that page was component state, so anything that drew the page afresh (a
// reload, a remount, a second tab in a shared browser) started it again from
// nothing, and nothing on screen could say what had happened.
//
// Now the page writes what it has as it goes, reads it back when it is drawn,
// and, if it was drawn while "Create my workspace" was still working, says so
// rather than pretending it is a first visit.
//
// ── WHAT IS KEPT ──────────────────────────────────────────────────────────
//
// This tab's sessionStorage, the same place lib/signup-email.ts hands the
// address over in (#651): per tab, gone when the tab closes, never in a URL.
// NEVER the password. A restored form asks for it once more, and the message
// says why.

export const SIGNUP_DRAFT_KEY = "hs:signup-draft";

/** A draft older than this belongs to an earlier visit, not to this one. */
export const SIGNUP_DRAFT_TTL_MS = 30 * 60_000;

export const SIGNUP_INTERRUPTED_MESSAGE =
  "Creating your workspace was interrupted before it finished. Your details are still here: enter your password and press Create my workspace again. If it says the email already has an account, sign in instead and we'll finish setting it up.";

export type SignupDraft = {
  step: number;
  email: string;
  orgName: string;
  displayName: string;
  phone: string;
  smsConsent: boolean;
  promoCode: string;
  /** "Create my workspace" was pressed and had not finished or failed. */
  creating: boolean;
  at: number;
};

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveSignupDraft(draft: Omit<SignupDraft, "at">, now = Date.now()): void {
  // Nothing typed yet: nothing worth keeping, and nothing to restore later.
  if (!draft.email.trim() && !draft.orgName.trim() && !draft.displayName.trim()) return;
  const clean: SignupDraft = {
    step: draft.step,
    email: draft.email,
    orgName: draft.orgName,
    displayName: draft.displayName,
    phone: draft.phone,
    smsConsent: draft.smsConsent,
    promoCode: draft.promoCode,
    creating: draft.creating,
    at: now,
  };
  try {
    store()?.setItem(SIGNUP_DRAFT_KEY, JSON.stringify(clean));
  } catch {
    /* storage full or off: the page works as it always did */
  }
}

export function readSignupDraft(now = Date.now()): SignupDraft | null {
  try {
    const raw = store()?.getItem(SIGNUP_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SignupDraft>;
    if (typeof d.at !== "number" || now - d.at > SIGNUP_DRAFT_TTL_MS || now < d.at) {
      clearSignupDraft();
      return null;
    }
    return {
      step: d.step === 1 || d.step === 2 ? d.step : 0,
      email: typeof d.email === "string" ? d.email : "",
      orgName: typeof d.orgName === "string" ? d.orgName : "",
      displayName: typeof d.displayName === "string" ? d.displayName : "",
      phone: typeof d.phone === "string" ? d.phone : "",
      smsConsent: d.smsConsent === true,
      promoCode: typeof d.promoCode === "string" ? d.promoCode : "",
      creating: d.creating === true,
      at: d.at,
    };
  } catch {
    return null;
  }
}

/** The workspace exists, or the person chose another way in. */
export function clearSignupDraft(): void {
  try {
    store()?.removeItem(SIGNUP_DRAFT_KEY);
  } catch {
    /* nothing to clear */
  }
}
