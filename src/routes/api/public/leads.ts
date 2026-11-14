// Public JSON endpoint for a lead form embedded on a tenant's own website.
//
// POST https://app.houndstack.com/api/public/leads
//
// That host was wrong on this line until 2026-08-10: it read
// `www.app.houndstack.com`, which no longer has a DNS record at all. The app's
// own lead page (routes/lead.$slug.tsx) posts to the relative path and was
// never affected — but a tenant embedding this form copies the absolute URL
// from a line exactly like this one, and a Resend webhook configured against
// the same stale host sat disabled for eight days before anyone noticed. A
// test now pins every `VERB https://…` comment in the repo to appOrigin(); see
// tests/one-app-origin.test.ts.
//
// CORS: allow all origins, because the callers are tenant websites on domains
// this app does not know ahead of time. Narrowing it means echoing the request
// Origin against a site the tenant has registered, which needs somewhere to
// store that — not built, and deliberately not half-built here.
//
// Since 20261009220000 this is also the only way a lead gets in from outside.
// It used to write with the publishable key, under an INSERT policy that let
// anyone holding that key (every browser) post straight to /rest/v1/leads past
// everything below. That policy is gone and the write is the service role's,
// behind the honeypot, the time-to-submit check and the rate limit in
// lib/public-form-guard.ts. A refusal says one calm thing and writes nothing. A
// lead that IS written is told to the office (lib/lead-notify.server.ts).
//
// A quote from HoundStack's own directory (#630) comes here too, naming the
// business by its DIRECTORY slug instead of its portal slug. That slug
// resolves only while the profile is published (directory_org_for_quote,
// service role), the lead is stored as source = 'directory', and a second
// quote from the same email to the same business within 24 hours is merged
// into the first, if it is still open, rather than written twice: appended,
// bumped and told as a repeat (#920, lib/directory-repeat.ts).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import {
  CALM_REFUSAL,
  ELAPSED_FIELD,
  HONEYPOT_FIELD,
  callerAddress,
  screenSubmission,
} from "@/lib/public-form-guard";
import { bookingLinkOffersLine, type ServiceLine } from "@/lib/service-lines";
import { isRequestedAsAStay } from "@/lib/public-services";
import {
  MAX_ADD_ONS,
  bookingExtrasFromRows,
  cleanAddOnIds,
  cleanPetSizes,
  extrasNote,
  messageWithExtras,
} from "@/lib/booking-extras";
import { PET_SIZES } from "@/lib/groom";
import {
  bookingDetailsColumns,
  bookingDetailsSchema,
  bookingDetailsProblem,
  normalizeBookingDetails,
} from "@/lib/booking-details";
import { DIRECTORY_LEAD_SOURCE, DIRECTORY_QUOTE_MERGE_HOURS, cleanZip } from "@/lib/directory";
import {
  OPEN_LEAD_STATUS,
  REPEAT_ACTIVITY_KIND,
  appendRepeatNote,
  askFingerprint,
  askFromLeadRow,
  isDoubleTap,
  repeatNoteBlock,
  type DirectoryAsk,
  type LeadAskColumns,
} from "@/lib/directory-repeat";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

const leadSchema = z
  .object({
    // Which business this lead belongs to (the tenant's portal slug). Required so
    // an embedded/hosted form routes to the right org (finding #25).
    // Optional only because a directory quote names `directory_slug` instead;
    // exactly one of the two is required (refined below).
    slug: z.string().trim().min(1).max(120).optional(),
    // A quote from the directory (#630): the business's published directory
    // slug. Never a portal slug, and never resolved for an unpublished profile.
    directory_slug: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(255),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    company: z.string().trim().max(120).optional().or(z.literal("")),
    location: z.string().trim().max(200).optional().or(z.literal("")),
    dog_count: z.coerce.number().int().min(0).max(999).optional().nullable(),
    frequency: z.string().trim().max(40).optional().or(z.literal("")),
    message: z.string().trim().max(2000).optional().or(z.literal("")),
    source: z.string().trim().max(60).optional(),
    // The service asked about (phase 5), when the business offers more than
    // one. An id from public_services, checked below against the business the
    // slug resolved to; a business that sells one thing never sends it.
    service_id: z.string().uuid().optional().nullable(),
    // The extras picked for that service on the booking link (#560): add-on
    // ids and a size per pet. Named on the lead for the office, read back from
    // the business's own rows; a website's own form sends neither.
    add_on_ids: z.array(z.string().uuid()).max(MAX_ADD_ONS).optional(),
    pet_sizes: z
      .array(z.enum([...PET_SIZES, ""] as [string, ...string[]]))
      .max(20)
      .optional(),
    // The first visit's answers (#527): the pets by name, how to get in, and
    // when to start. All optional here; see the check below for why.
    ...bookingDetailsSchema.shape,
    // The spam filters (public-form-guard.ts). Unknown rather than a bounded
    // string, so a script that stuffs the honeypot with a novel gets the same
    // calm refusal as one that writes a word, not a validation error naming it.
    [HONEYPOT_FIELD]: z.unknown().optional(),
    [ELAPSED_FIELD]: z.unknown().optional(),
  })
  .refine((d) => !!d.slug !== !!d.directory_slug, {
    message: "Name the business by exactly one of slug or directory_slug",
  });

/** What the directory alias (api/public/directory.quotes.ts) asks of the
 *  same handler: CORS headers of its own, and only directory quotes. */
export type PublicLeadOptions = {
  cors: Record<string, string>;
  /** Refuse a body that names a business by its portal slug. */
  directoryOnly?: boolean;
};

/** The whole POST, shared by /api/public/leads (CORS *, tenant websites) and
 *  /api/public/directory/quotes (CORS for the directory apps only). One
 *  handler, so the honeypot, time check, rate limit and write are the same
 *  code on both paths. */
export async function handlePublicLeadPost(
  request: Request,
  { cors, directoryOnly = false }: PublicLeadOptions = { cors: CORS },
): Promise<Response> {
  const jsonHeaders = { "Content-Type": "application/json", ...cors };
  const refused = (status: number) =>
    new Response(JSON.stringify({ error: CALM_REFUSAL }), { status, headers: jsonHeaders });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  const parsed = leadSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: "Invalid input", details: parsed.error.flatten() }),
      { status: 400, headers: jsonHeaders },
    );
  }
  const data = parsed.data;

  // The two checks that need nothing but the body, before anything is
  // looked up or written.
  const screened = screenSubmission({
    honeypot: data[HONEYPOT_FIELD],
    elapsedMs: data[ELAPSED_FIELD],
  });
  if (!screened.ok) {
    console.warn("public lead refused", screened.reason);
    return refused(400);
  }

  // The directory alias takes directory quotes only: a tenant's own lead form
  // names its portal slug and posts to /api/public/leads, under CORS *.
  if (directoryOnly && !data.directory_slug) {
    return new Response(JSON.stringify({ error: "Invalid input" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  // A directory quote's location is a ZIP, cleaned by the same rule the search
  // takes (cleanZip in lib/directory.ts): five digits, or refused. So a quoted
  // `"48201"` or a `4820%` is never stored on a lead. A tenant's own form keeps
  // its free-text location (a street, a city), as before.
  const directoryZip = data.directory_slug ? cleanZip(data.location) : null;
  if (data.directory_slug && !directoryZip) {
    return new Response(JSON.stringify({ error: "Enter a five-digit ZIP code." }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const supabase = createClient<Database>(
    resolveSupabaseUrl(),
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } },
  );
  // Resolve the tenant from its public slug (SECURITY DEFINER RPC, so it
  // works for the anonymous key). Lead capture matches portal_slug and is
  // not gated on public_signup_enabled (#3).
  //
  // A directory quote resolves its directory slug instead, and only a
  // PUBLISHED profile of a live business answers. That lookup is the
  // service role's (a visitor cannot turn a slug into an org id), and
  // `source` is then 'directory' whatever the body said. A body that
  // claims 'directory' without a directory slug is refused: that label
  // means "came through the directory" and nothing else may write it.
  const fromDirectory = !!data.directory_slug;
  if (!fromDirectory && data.source === DIRECTORY_LEAD_SOURCE) {
    return new Response(JSON.stringify({ error: "Invalid input" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  let orgId: string | null = null;
  if (fromDirectory) {
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const { data: dirOrg } = await (admin as any).rpc("directory_org_for_quote", {
      _slug: data.directory_slug,
    });
    orgId = typeof dirOrg === "string" ? dirOrg : null;
  } else {
    const { data: orgRows } = await supabase.rpc("public_get_org_for_lead_form", {
      _slug: data.slug!,
    });
    orgId = (orgRows as Array<{ id: string }> | null)?.[0]?.id ?? null;
  }
  if (!orgId) {
    return new Response(JSON.stringify({ error: "Unknown business" }), {
      status: 404,
      headers: jsonHeaders,
    });
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // The service named has to be THIS business's. Another business's id,
  // or one that does not exist, is a body the form never sends, so it is
  // the same refusal as any other malformed input, before a turn is
  // taken or anything is written. A deactivated service of this business
  // is still recorded: the person asked for it, and the office should
  // know that, even if it is no longer sold. A service on a line that is
  // still Coming soon is refused the same way (#506): the form never
  // lists one (publicServiceChoices), so naming one is a hand-built body.
  // Coming soon is the platform switch, read at runtime (#531). Every
  // live line is on the link, walking, training and grooming included
  // (bookingLinkOffersLine, #560).
  let service: { id: string; name: string; stay: boolean; line: string } | null = null;
  if (data.service_id) {
    const { data: svc } = await (supabaseAdmin.from("services") as any)
      .select("id, name, service_line, price_unit")
      .eq("id", data.service_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    const { loadServiceLineAvailability } = await import("@/lib/service-line-availability.server");
    if (!svc?.id || !bookingLinkOffersLine(svc.service_line, await loadServiceLineAvailability())) {
      return new Response(JSON.stringify({ error: "Invalid input" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    service = {
      id: svc.id as string,
      name: (svc.name as string) ?? "",
      stay: isRequestedAsAStay(svc),
      line: svc.service_line as string,
    };
  }

  // The extras, by name, for the office (#560). Only the service's own
  // line's add-ons are named; an id that is not one is dropped rather
  // than refused, because the person still asked and the office should
  // still hear about it. The price is the office's to confirm.
  let extras: string | null = null;
  if (service && service.line !== "pet_waste") {
    const wanted = cleanAddOnIds(data.add_on_ids);
    let names: string[] = [];
    if (wanted.length) {
      const { data: rows } = await (supabaseAdmin.from("addon_services") as any)
        .select("id, name, service_line, unit_price_cents, active")
        .eq("organization_id", orgId)
        .in("id", wanted);
      names = bookingExtrasFromRows(rows, [], [service.line as ServiceLine], []).addOns.map(
        (a) => a.name,
      );
    }
    extras = extrasNote(names, cleanPetSizes(data.pet_sizes, data.dog_count ?? 0));
  }
  // A stay (priced per night, #546) is a request for dates, not a
  // cadence: whatever frequency a body carries, the lead stores none,
  // so the office never reads "Weekly" on an Overnight stay.
  const frequency = service?.stay ? null : data.frequency || null;

  // The first visit's answers, held to the business's settings. Only
  // what was SENT is checked: a start date before the business can
  // come is refused, but a required question left out is not, because
  // this endpoint is also the one a tenant's own website posts to, and
  // a form embedded before #527 has no such fields. Turning "required"
  // on in Settings must not silently stop the website's leads. The
  // booking link itself enforces required in the browser.
  let detailsConfig = normalizeBookingDetails(null);
  try {
    const { data: org } = await (supabaseAdmin.from("organizations") as any)
      .select("lead_form_config")
      .eq("id", orgId)
      .maybeSingle();
    const cfg = org?.lead_form_config;
    detailsConfig = normalizeBookingDetails(
      cfg && typeof cfg === "object" ? (cfg as any).details : null,
    );
  } catch (e) {
    console.error("public lead booking details lookup failed", orgId, e);
  }
  const detailsAnswer = {
    pets: data.pets,
    dogCount: data.dog_count ?? null,
    accessNotes: data.access_notes,
    preferredStartDate: data.preferred_start_date,
  };
  const detailsProblem = bookingDetailsProblem(
    { ...detailsConfig, pets: "optional", access: "optional", startDate: "optional" },
    detailsAnswer,
    new Date().toISOString().slice(0, 10),
  );
  if (detailsProblem) {
    return new Response(JSON.stringify({ error: detailsProblem }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  const details = bookingDetailsColumns(detailsConfig, detailsAnswer);

  const { takePublicFormTurn } = await import("@/lib/public-form-guard.server");
  const turn = await takePublicFormTurn(
    supabaseAdmin as any,
    orgId,
    callerAddress((h) => request.headers.get(h)),
  );
  if (!turn.ok) {
    console.warn("public lead rate-limited", orgId, turn.reason);
    return refused(429);
  }

  // The service role, so status and the three workflow stamps are what
  // this line says and nothing the caller sent: a submission is always a
  // new, untouched lead. That was the dropped INSERT policy's rule; it
  // lives where the write is now.
  const source = fromDirectory ? DIRECTORY_LEAD_SOURCE : data.source || "website";
  const location = fromDirectory ? directoryZip : data.location || null;

  // A directory quote sent twice (a double tap, or the same person
  // asking again tomorrow morning) is ONE lead: within 24 hours, the
  // same email to the same business is merged into the OPEN lead it
  // already has (#920, lib/directory-repeat.ts). The new ask is appended
  // to that lead, updated_at moves, and the office is told it is a repeat;
  // a double tap is recorded and tells nobody. A lead the office has
  // already acted on takes no merge: the ask becomes a new lead below.
  // The turn above was still taken, so a script repeating itself is still
  // rate limited.
  if (fromDirectory) {
    const since = new Date(Date.now() - DIRECTORY_QUOTE_MERGE_HOURS * 3_600_000).toISOString();
    const { data: earlier } = await (supabaseAdmin.from("leads") as any)
      // The first ask's columns (LeadAskColumns), written out so the select
      // scanners (an-embed-names-its-foreign-key) can read it.
      .select(
        "id, created_at, message, service_id, dog_count, frequency, location, pets, access_notes, preferred_start_date",
      )
      .eq("organization_id", orgId)
      .eq("source", DIRECTORY_LEAD_SOURCE)
      .eq("email", data.email.toLowerCase())
      .eq("status", OPEN_LEAD_STATUS)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (earlier?.id) {
      const outcome = await mergeRepeatDirectoryQuote(supabaseAdmin, {
        orgId,
        lead: earlier,
        name: data.name,
        source,
        serviceName: service?.name ?? null,
        ask: {
          message: messageWithExtras(data.message, extras) || null,
          serviceId: service?.id ?? null,
          dogCount: data.dog_count ?? null,
          frequency,
          location,
          pets: details.pets,
          accessNotes: details.access_notes,
          preferredStartDate: details.preferred_start_date,
        },
      });
      if (outcome === "failed") {
        return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
          status: 500,
          headers: jsonHeaders,
        });
      }
      if (outcome === "merged") {
        return new Response(JSON.stringify({ ok: true, merged: true, serviceArea: "unknown" }), {
          status: 200,
          headers: jsonHeaders,
        });
      }
      // "closed": the office acted on the lead between the read and the
      // write. Not open any more, so this ask is a new lead, below.
    }
  }
  const { data: lead, error } = await (supabaseAdmin.from("leads") as any)
    .insert({
      organization_id: orgId,
      name: data.name,
      email: data.email.toLowerCase(),
      phone: data.phone || null,
      company: data.company || null,
      location,
      dog_count: data.dog_count ?? null,
      frequency,
      message: messageWithExtras(data.message, extras) || null,
      source,
      status: "new",
      // Only when one was named: a lead from a business that sells one
      // thing is the row it always was, with no service_id key at all.
      ...(service ? { service_id: service.id } : {}),
      // Only the answers given: a lead from an older embedded form is
      // the row it always was.
      ...Object.fromEntries(Object.entries(details).filter(([, v]) => v != null)),
    })
    .select("id")
    .single();
  if (error || !lead?.id) {
    // Postgres's words are for us, not for a homeowner.
    console.error("public lead insert failed", orgId, error?.message);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const { notifyOfficeOfNewLead } = await import("@/lib/lead-notify.server");
  await notifyOfficeOfNewLead({
    orgId,
    leadId: lead.id as string,
    name: data.name,
    source,
    location,
    dogCount: data.dog_count ?? null,
    frequency,
    serviceName: service?.name ?? null,
  });

  // Whether a zone lists this ZIP (R2-25), so the thank-you can say so
  // rather than leave an out-of-area visitor waiting for a call. The
  // office's own verdict on /leads, read the same way; any doubt is
  // "unknown" and the visitor reads the usual thank-you. The lead is
  // saved either way: this is a word to the visitor, not a refusal.
  let serviceArea: "inside" | "outside" | "unknown" = "unknown";
  try {
    const { leadServiceAreas } = await import("@/lib/lead-service-area.server");
    [serviceArea] = await leadServiceAreas(supabaseAdmin, orgId, [location]);
  } catch (e) {
    console.error("public lead service area check failed", orgId, e);
  }

  return new Response(JSON.stringify({ ok: true, serviceArea }), {
    status: 201,
    headers: jsonHeaders,
  });
}

/**
 * Record a repeat directory quote on the open lead it repeats (#920). The
 * rules are written down in lib/directory-repeat.ts. "merged" when the lead
 * took it; "closed" when the lead stopped being open before the write landed
 * (the caller inserts a new lead instead); "failed" when the write errored,
 * so the person is asked to try again rather than shown a success that
 * recorded nothing.
 */
async function mergeRepeatDirectoryQuote(
  admin: any,
  opts: {
    orgId: string;
    lead: LeadAskColumns & { id: string; created_at: string };
    name: string;
    source: string;
    serviceName: string | null;
    ask: DirectoryAsk;
  },
): Promise<"merged" | "closed" | "failed"> {
  const { orgId, lead, ask } = opts;
  const now = new Date();
  const previous = askFromLeadRow(lead);
  const fingerprint = askFingerprint(ask);

  // The last ask on this lead: the latest repeat, or the lead itself.
  let last: { fingerprint: string; at: string } = {
    fingerprint: askFingerprint(previous),
    at: lead.created_at,
  };
  try {
    const { data: latest } = await admin
      .from("activity_log")
      .select("meta, created_at")
      .eq("organization_id", orgId)
      .eq("kind", REPEAT_ACTIVITY_KIND)
      .eq("meta->>lead_id", lead.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const fp = latest?.meta?.fingerprint;
    if (typeof fp === "string" && latest?.created_at) {
      last = { fingerprint: fp, at: latest.created_at };
    }
  } catch (e) {
    console.error("repeat quote: last ask lookup failed", orgId, lead.id, e);
  }
  const doubleTap = isDoubleTap({ ask, last, now });

  const message = doubleTap
    ? null
    : appendRepeatNote(
        lead.message ?? null,
        repeatNoteBlock({ ask, previous, serviceName: opts.serviceName, at: now }),
      );
  const { data: updated, error } = await admin
    .from("leads")
    .update({ updated_at: now.toISOString(), ...(message ? { message } : {}) })
    .eq("id", lead.id)
    .eq("status", OPEN_LEAD_STATUS)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("repeat quote: lead update failed", orgId, lead.id, error.message);
    return "failed";
  }
  if (!updated?.id) return "closed";

  const requestId = crypto.randomUUID();
  const { logActivity } = await import("@/lib/activity.server");
  await logActivity(admin, {
    orgId,
    actorLabel: "Directory quote",
    kind: REPEAT_ACTIVITY_KIND,
    summary: doubleTap
      ? `${opts.name} sent the same quote request again`
      : `${opts.name} asked again${opts.serviceName ? ` about ${opts.serviceName}` : ""}`,
    meta: {
      lead_id: lead.id,
      request_id: requestId,
      fingerprint,
      double_tap: doubleTap,
      appended_to_message: !!message,
      message: ask.message,
      service_id: ask.serviceId,
      service_name: opts.serviceName,
      dog_count: ask.dogCount,
      frequency: ask.frequency,
      location: ask.location,
      pets: ask.pets,
      access_notes: ask.accessNotes,
      preferred_start_date: ask.preferredStartDate,
    },
  });

  if (!doubleTap) {
    const { notifyOfficeOfRepeatLead } = await import("@/lib/lead-notify.server");
    await notifyOfficeOfRepeatLead({
      orgId,
      leadId: lead.id,
      requestId,
      name: opts.name,
      source: opts.source,
      location: ask.location,
      dogCount: ask.dogCount,
      frequency: ask.frequency,
      serviceName: opts.serviceName,
    });
  }
  return "merged";
}

export const Route = createFileRoute("/api/public/leads")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => handlePublicLeadPost(request, { cors: CORS }),
    },
  },
});
