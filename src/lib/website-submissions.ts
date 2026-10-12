import { z } from "zod";

export const WEBSITE_SUBMISSION_FORMS = ["contact", "early_access"] as const;
export type WebsiteSubmissionForm = (typeof WEBSITE_SUBMISSION_FORMS)[number];

export const WEBSITE_SUBMISSION_ALLOWED_ORIGINS = new Set([
  "https://houndstack.com",
  "https://www.houndstack.com",
]);

export const WEBSITE_SUBMISSION_HONEYPOT_FIELD = "website_url";
export const WEBSITE_SUBMISSION_STARTED_AT_FIELD = "started_at";
export const WEBSITE_SUBMISSION_MIN_FILL_MS = 3_000;
export const WEBSITE_SUBMISSION_RATE_LIMIT = {
  max: 5,
  windowMinutes: 10,
} as const;

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const baseSchema = z
  .object({
    form: z.enum(WEBSITE_SUBMISSION_FORMS),
    name: z.string().trim().min(1, "Name is required").max(120),
    email: z
      .string()
      .trim()
      .min(1, "Email is required")
      .max(254)
      .refine((value) => emailRe.test(value), "Email is invalid"),
    business_name: z.string().trim().max(160).optional().or(z.literal("")),
    phone: z.string().trim().max(50).optional().or(z.literal("")),
    message: z.string().trim().max(4000).optional().or(z.literal("")),
    source_page: z.string().trim().max(500).optional().or(z.literal("")),
    [WEBSITE_SUBMISSION_HONEYPOT_FIELD]: z.unknown().optional(),
    [WEBSITE_SUBMISSION_STARTED_AT_FIELD]: z.unknown().optional(),
  })
  .passthrough();

export type WebsiteSubmissionInput = z.infer<typeof baseSchema>;

export type WebsiteSubmissionValidation =
  | {
      ok: true;
      data: {
        form: WebsiteSubmissionForm;
        name: string;
        email: string;
        business_name: string | null;
        phone: string | null;
        message: string | null;
        source_page: string | null;
        payload: Record<string, unknown>;
      };
    }
  | { ok: false; status: 400; error: string; details?: unknown }
  | { ok: false; status: 200; dropped: true; reason: "honeypot" | "too_fast" };

export function corsHeadersForOrigin(origin: string | null): HeadersInit | null {
  if (!origin || !WEBSITE_SUBMISSION_ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function isAllowedWebsiteSubmissionOrigin(origin: string | null): boolean {
  return !!corsHeadersForOrigin(origin);
}

function isFilled(value: unknown): boolean {
  return value != null && String(value).trim() !== "";
}

function startedAtMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanNullable(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function payloadFrom(input: WebsiteSubmissionInput): Record<string, unknown> {
  const reserved = new Set([
    "form",
    "name",
    "email",
    "business_name",
    "phone",
    "message",
    "source_page",
    WEBSITE_SUBMISSION_HONEYPOT_FIELD,
    WEBSITE_SUBMISSION_STARTED_AT_FIELD,
  ]);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!reserved.has(key)) payload[key] = value;
  }
  return payload;
}

export function validateWebsiteSubmission(
  body: unknown,
  nowMs = Date.now(),
): WebsiteSubmissionValidation {
  const parsed = baseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: "Invalid input",
      details: parsed.error.flatten(),
    };
  }

  const data = parsed.data;
  if (isFilled(data[WEBSITE_SUBMISSION_HONEYPOT_FIELD])) {
    return { ok: false, status: 200, dropped: true, reason: "honeypot" };
  }

  const started = startedAtMs(data[WEBSITE_SUBMISSION_STARTED_AT_FIELD]);
  if (started != null && nowMs - started < WEBSITE_SUBMISSION_MIN_FILL_MS) {
    return { ok: false, status: 200, dropped: true, reason: "too_fast" };
  }

  const payload = payloadFrom(data);
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 10_000) {
    return { ok: false, status: 400, error: "Payload is too large" };
  }

  return {
    ok: true,
    data: {
      form: data.form,
      name: data.name.trim(),
      email: data.email.trim().toLowerCase(),
      business_name: cleanNullable(data.business_name),
      phone: cleanNullable(data.phone),
      message: cleanNullable(data.message),
      source_page: cleanNullable(data.source_page),
      payload,
    },
  };
}
