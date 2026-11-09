// POST /api/public/website-submissions
//
// Accepts JSON or application/x-www-form-urlencoded from houndstack.com only.
//
// Fields:
//   form: "contact" or "early_access", required.
//   name: string, required, max 120.
//   email: string, required, max 254.
//   business_name: string, optional, max 160.
//   phone: string, optional, max 50.
//   message: string, required for "contact", optional for "early_access", max 4000.
//   source_page: string, optional, max 500.
//   website_url: honeypot, optional. If filled, the request returns ok and is not stored.
//   started_at: timestamp in epoch milliseconds or ISO format, optional. If supplied
//     and less than 3 seconds old, the request returns ok and is not stored.
//   Any other fields are stored in payload as JSON.
//
// Notification email goes to WEBSITE_SUBMISSIONS_NOTIFY_EMAIL, falling back to
// support@houndstack.com when the variable is unset or blank.
import { createFileRoute } from "@tanstack/react-router";
import { callerAddress } from "@/lib/public-form-guard";
import {
  WEBSITE_SUBMISSION_RATE_LIMIT,
  corsHeadersForOrigin,
  validateWebsiteSubmission,
} from "@/lib/website-submissions";

const FALLBACK_NOTIFY_EMAIL = "support@houndstack.com";
const FROM_EMAIL = "HoundStack <noreply@notify.houndstack.com>";

type ParsedBody = Record<string, unknown>;
type DbError = { message: string };
type DbResult<T> = { data: T | null; error: DbError | null; count?: number | null };
type DbQuery<T> = PromiseLike<DbResult<T>> & {
  select(columns: string, options?: { count?: "exact"; head?: boolean }): DbQuery<T>;
  gte(column: string, value: string): DbQuery<T>;
  eq(column: string, value: unknown): DbQuery<T>;
  is(column: string, value: null): DbQuery<T>;
  insert(value: unknown): DbQuery<T>;
  single(): DbQuery<T>;
};
type WebsiteSubmissionAdmin = {
  from(table: string): DbQuery<unknown>;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<DbResult<unknown>>;
};

function json(data: unknown, status: number, headers: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function formDataToObject(formData: FormData): ParsedBody {
  const body: ParsedBody = {};
  for (const [key, value] of formData.entries()) {
    const next = typeof value === "string" ? value : value.name;
    const current = body[key];
    if (current === undefined) body[key] = next;
    else if (Array.isArray(current)) current.push(next);
    else body[key] = [current, next];
  }
  return body;
}

async function parseBody(request: Request): Promise<ParsedBody | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as ParsedBody) : null;
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    return formDataToObject(await request.formData());
  }
  return null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function line(label: string, value: string | null | undefined): string {
  if (!value) return "";
  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`;
}

function textLine(label: string, value: string | null | undefined): string {
  return value ? `${label}: ${value}\n` : "";
}

function notificationRecipient(): string {
  const configured = process.env.WEBSITE_SUBMISSIONS_NOTIFY_EMAIL?.trim();
  return configured || FALLBACK_NOTIFY_EMAIL;
}

function subjectSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

async function enqueueNotificationEmail(
  supabaseAdmin: WebsiteSubmissionAdmin,
  row: {
    id: string;
    form: string;
    name: string;
    email: string;
    business_name: string | null;
    phone: string | null;
    message: string | null;
    source_page: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const to = notificationRecipient();
  const messageId = crypto.randomUUID();
  const label = "website_submission";
  const subject = `Website ${row.form === "early_access" ? "early access" : "contact"}: ${subjectSafe(row.name)}`;
  const payloadText = Object.keys(row.payload).length
    ? `\nOther fields:\n${JSON.stringify(row.payload, null, 2)}\n`
    : "";
  const html = [
    `<h1>New website ${escapeHtml(row.form.replace("_", " "))} submission</h1>`,
    line("Name", row.name),
    line("Email", row.email),
    line("Business", row.business_name),
    line("Phone", row.phone),
    line("Source page", row.source_page),
    line("Message", row.message),
    Object.keys(row.payload).length
      ? `<pre>${escapeHtml(JSON.stringify(row.payload, null, 2))}</pre>`
      : "",
    line("Submission id", row.id),
  ].join("");
  const text =
    `New website ${row.form.replace("_", " ")} submission\n\n` +
    textLine("Name", row.name) +
    textLine("Email", row.email) +
    textLine("Business", row.business_name) +
    textLine("Phone", row.phone) +
    textLine("Source page", row.source_page) +
    textLine("Message", row.message) +
    payloadText +
    textLine("Submission id", row.id);

  await supabaseAdmin.from("email_send_log").insert({
    message_id: messageId,
    template_name: label,
    recipient_email: to.toLowerCase(),
    status: "pending",
    metadata: { website_submission_id: row.id },
  });

  const { error } = await supabaseAdmin.rpc("enqueue_email", {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId,
      to,
      from: FROM_EMAIL,
      sender_domain: "notify.houndstack.com",
      subject,
      html,
      text,
      purpose: "transactional",
      label,
      idempotency_key: `website-submission-${row.id}`,
      queued_at: new Date().toISOString(),
    },
  });
  if (error) {
    await supabaseAdmin.from("email_send_log").insert({
      message_id: messageId,
      template_name: label,
      recipient_email: to.toLowerCase(),
      status: "failed",
      error_message: error.message,
      metadata: { website_submission_id: row.id },
    });
    throw new Error(error.message);
  }
}

export const Route = createFileRoute("/api/public/website-submissions")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const headers = corsHeadersForOrigin(request.headers.get("origin"));
        if (!headers) return json({ error: "Forbidden" }, 403, {});
        return new Response(null, { status: 204, headers });
      },
      POST: async ({ request }) => {
        const cors = corsHeadersForOrigin(request.headers.get("origin"));
        if (!cors) return json({ error: "Forbidden" }, 403, {});

        let body: ParsedBody | null = null;
        try {
          body = await parseBody(request);
        } catch {
          return json({ error: "Invalid request body" }, 400, cors);
        }
        if (!body) return json({ error: "Unsupported content type" }, 415, cors);

        const validated = validateWebsiteSubmission(body);
        if (!validated.ok) {
          if ("dropped" in validated) return json({ ok: true }, 200, cors);
          return json(
            { error: validated.error, details: validated.details },
            validated.status,
            cors,
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as WebsiteSubmissionAdmin;
        const ip = callerAddress((header) => request.headers.get(header));
        const ipHash = ip ? await sha256(`houndstack-website-submissions:v1:${ip}`) : null;
        const since = new Date(
          Date.now() - WEBSITE_SUBMISSION_RATE_LIMIT.windowMinutes * 60_000,
        ).toISOString();

        let rateQuery = admin
          .from("website_submissions")
          .select("id", { count: "exact", head: true })
          .gte("created_at", since);
        rateQuery = ipHash ? rateQuery.eq("ip_hash", ipHash) : rateQuery.is("ip_hash", null);
        const { count, error: rateError } = await rateQuery;
        if (rateError) {
          console.error("website submission rate limit failed", rateError.message);
          return json({ error: "Something went wrong. Please try again." }, 500, cors);
        }
        if ((count ?? 0) >= WEBSITE_SUBMISSION_RATE_LIMIT.max) {
          return json({ error: "Too many submissions. Please wait a few minutes." }, 429, cors);
        }

        const row = {
          ...validated.data,
          ip_hash: ipHash,
          user_agent: request.headers.get("user-agent")?.slice(0, 500) || null,
          status: "new",
        };
        const insertResult = (await admin
          .from("website_submissions")
          .insert(row)
          .select("id")
          .single()) as DbResult<{ id: string }>;
        const { data: inserted, error: insertError } = insertResult;
        if (insertError || !inserted?.id) {
          console.error("website submission insert failed", insertError?.message);
          return json({ error: "Something went wrong. Please try again." }, 500, cors);
        }

        try {
          await enqueueNotificationEmail(admin, { id: inserted.id as string, ...validated.data });
        } catch (error) {
          console.error("website submission notification failed", inserted.id, error);
        }

        return json({ ok: true }, 201, cors);
      },
    },
  },
});
