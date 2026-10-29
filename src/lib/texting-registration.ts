import { z } from "zod";

// BUILD-3 (#538): what an owner files to turn on texting, and how its status
// reads. Shared by Settings → Texting and the server, so the form and the
// check behind it cannot disagree about what is required.
//
// The model, as Product locked it: one Twilio subaccount per business,
// registered in that business's own name (toll-free verification by default).
// HoundStack's own toll-free number texts account holders only and is never a
// sender for a business's client (lib/twilio-credentials.server).

/** Business types as the owner reads them, and as Twilio wants them: the
 *  Trust Hub business profile and the toll-free verification each have their
 *  own list. */
export const BUSINESS_TYPES = {
  sole_proprietor: {
    label: "Sole proprietor",
    trustHub: "Sole Proprietorship",
    tollFree: "SOLE_PROPRIETOR",
  },
  partnership: { label: "Partnership", trustHub: "Partnership", tollFree: "PRIVATE_PROFIT" },
  llc: { label: "LLC", trustHub: "Limited Liability Corporation", tollFree: "PRIVATE_PROFIT" },
  corporation: { label: "Corporation", trustHub: "Corporation", tollFree: "PRIVATE_PROFIT" },
  nonprofit: { label: "Nonprofit", trustHub: "Non-profit Corporation", tollFree: "NON_PROFIT" },
} as const;
export type BusinessType = keyof typeof BUSINESS_TYPES;

/** Domain of a URL or email, lowercased, without a leading "www.". */
export function domainOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.includes("@") && !v.includes("/"))
    return (
      v
        .split("@")
        .pop()
        ?.replace(/^www\./, "") || null
    );
  try {
    return new URL(v).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Same site: equal, or one a subdomain of the other (shop.example.com and
 *  example.com are one business's domain). */
export function sameSite(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** A US or Canadian number in E.164, or null. */
export function toE164(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use a full address that starts with https://");

const phone = z
  .string()
  .trim()
  .max(40)
  .refine((v) => toE164(v) !== null, "Enter a full phone number with area code");

export const contactSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required").max(80),
  last_name: z.string().trim().min(1, "Last name is required").max(80),
  title: z.string().trim().min(1, "Job title is required").max(80),
  email: z.string().trim().email("Enter an email address").max(255),
  phone,
});
export type RegistrationContact = z.infer<typeof contactSchema>;

/** Everything the owner files except the EIN, which is sent to Twilio and
 *  never stored, so it travels beside this rather than inside it. */
export const registrationDetailsSchema = z
  .object({
    legal_name: z
      .string()
      .trim()
      .min(2, "Enter the legal name exactly as on the EIN letter")
      .max(200),
    business_type: z.enum(Object.keys(BUSINESS_TYPES) as [BusinessType, ...BusinessType[]]),
    dba: z.string().trim().max(200).optional().or(z.literal("")),
    street: z.string().trim().min(3, "Street address is required").max(200),
    street2: z.string().trim().max(200).optional().or(z.literal("")),
    city: z.string().trim().min(2, "City is required").max(120),
    region: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Use the two-letter state code"),
    postal_code: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, "Enter a five-digit ZIP code"),
    website_url: httpsUrl,
    privacy_url: httpsUrl,
    terms_url: httpsUrl,
    business_email: z.string().trim().email("Enter an email address").max(255),
    business_phone: phone,
    contacts: z.array(contactSchema).length(2, "Add two authorized contacts"),
  })
  .superRefine((d, ctx) => {
    const site = domainOf(d.website_url);
    // Twilio rejects a verification whose policy pages live somewhere other
    // than the business's own site, and needs Privacy and Terms on separate
    // pages (error 30493, since Sep 15 2026).
    for (const key of ["privacy_url", "terms_url"] as const) {
      if (!sameSite(domainOf(d[key]), site)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "This page has to be on your own website's domain",
        });
      }
    }
    if (d.privacy_url.trim().replace(/\/+$/, "") === d.terms_url.trim().replace(/\/+$/, "")) {
      ctx.addIssue({
        code: "custom",
        path: ["terms_url"],
        message: "Terms and Privacy Policy need their own separate pages",
      });
    }
    if (!sameSite(domainOf(d.business_email), site)) {
      ctx.addIssue({
        code: "custom",
        path: ["business_email"],
        message: "Use an email address on your website's domain",
      });
    }
  });
export type RegistrationDetails = z.infer<typeof registrationDetailsSchema>;

/** Nine digits, with or without the dash. Never stored; never logged. */
export const einSchema = z
  .string()
  .trim()
  .refine((v) => /^\d{2}-?\d{7}$/.test(v), "Enter the nine-digit EIN, like 12-3456789");

export function einDigits(ein: string): string {
  return ein.replace(/\D/g, "");
}

/** "12-3456789" as Twilio's forms show it. */
export function einFormatted(ein: string): string {
  const d = einDigits(ein);
  return `${d.slice(0, 2)}-${d.slice(2)}`;
}

// ── Status ─────────────────────────────────────────────────────────────────

export const REGISTRATION_STATUSES = [
  "draft",
  "submitting",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "failed",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Twilio's toll-free verification status, in ours. Anything unknown stays
 *  "submitted": still with Twilio, still not sending. */
export function statusFromVerification(
  twilioStatus: string | null | undefined,
): RegistrationStatus {
  switch ((twilioStatus ?? "").toUpperCase()) {
    case "TWILIO_APPROVED":
      return "approved";
    case "TWILIO_REJECTED":
      return "rejected";
    case "IN_REVIEW":
      return "in_review";
    case "PENDING_REVIEW":
    default:
      return "submitted";
  }
}

/** What Twilio says about review time, quoted rather than promised. */
export const TWILIO_REVIEW_TIME = "Twilio says review takes up to three business days.";

export type StatusSummary = {
  status: RegistrationStatus | "not_started";
  title: string;
  detail: string;
  tone: "neutral" | "waiting" | "good" | "bad";
};

/** One status in plain words, for Settings. */
export function describeStatus(
  r: {
    status: RegistrationStatus;
    phone_number?: string | null;
    rejection_reason?: string | null;
    resubmit_deadline?: string | null;
    last_error?: string | null;
  } | null,
  formatDate: (iso: string) => string = (iso) => iso.slice(0, 10),
): StatusSummary {
  if (!r) {
    return {
      status: "not_started",
      title: "Not started",
      detail: "Fill in your business details below to get your own texting number.",
      tone: "neutral",
    };
  }
  switch (r.status) {
    case "draft":
      return {
        status: "draft",
        title: "Waiting on your details",
        detail: "Your details are saved. Add your EIN and submit when everything is filled in.",
        tone: "neutral",
      };
    case "submitting":
      return {
        status: "submitting",
        title: "Setting up your number",
        detail: "We're creating your account and number with Twilio. This takes a minute or two.",
        tone: "waiting",
      };
    case "submitted":
      return {
        status: "submitted",
        title: "Submitted to carriers",
        detail: `Your number${r.phone_number ? ` ${r.phone_number}` : ""} is waiting for carrier review. ${TWILIO_REVIEW_TIME} It cannot send texts until it is approved.`,
        tone: "waiting",
      };
    case "in_review":
      return {
        status: "in_review",
        title: "In review",
        detail: `Carriers are reviewing your registration. ${TWILIO_REVIEW_TIME} Your number cannot send texts until it is approved.`,
        tone: "waiting",
      };
    case "approved":
      return {
        status: "approved",
        title: "Approved and live",
        detail: `Texts to your clients go out from ${r.phone_number ?? "your number"}.`,
        tone: "good",
      };
    case "rejected": {
      const by = r.resubmit_deadline
        ? ` Fix it and resubmit by ${formatDate(r.resubmit_deadline)}.`
        : " Fix it and resubmit.";
      return {
        status: "rejected",
        title: "Rejected",
        detail: `${r.rejection_reason?.trim() || "Twilio did not give a reason."}${by}`,
        tone: "bad",
      };
    }
    case "failed":
      return {
        status: "failed",
        title: "Setup stopped",
        detail: `${r.last_error?.trim() || "Something went wrong talking to Twilio."} Check your details and submit again.`,
        tone: "bad",
      };
  }
}

/** Whether the owner can edit and (re)submit from this state. */
export function canSubmit(status: RegistrationStatus | null): boolean {
  return status === null || status === "draft" || status === "rejected" || status === "failed";
}
