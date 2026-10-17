import { createServerFn } from "@tanstack/react-start";
import { orgToday } from "@/lib/org-day";
import { formatDay } from "@/lib/format";
import { PHOTO_KINDS, PHOTO_KINDS_EMAILED, pickEmailedPhotos } from "@/lib/photo-kinds";
import {
  MAX_CHECKLIST_ID,
  MAX_CHECKLIST_ITEMS,
  checkedLabels,
  parseAnswers,
} from "@/lib/visit-checklist";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  lastServicedByStation,
  stopFactsFromRow,
  type StopFacts,
  type StopFactsRow,
} from "@/lib/stop-facts";
import { stampVisitAccess } from "@/lib/property-access";

export const getMyDay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        day: z.string(),
        // Optional: office roles (owner/office_manager/dispatcher) can preview
        // another tech's day. Ignored for techs — they always see their own.
        staffId: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Caller's own staff record (may be null for pure office/dispatch users).
    const { data: myStaffRow, error: myStaffErr } = await supabase
      .from("staff")
      .select("id, organization_id, display_name, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (myStaffErr) throw new Error(myStaffErr.message);

    // Determine which staff row to load visits for. If a staffId is supplied,
    // verify the caller has an office role in that staff's org before honoring
    // it. Otherwise fall back to the caller's own staff row.
    let targetStaff = myStaffRow;
    let previewing = false;
    if (data.staffId && data.staffId !== myStaffRow?.id) {
      const { data: roleRow } = await supabase
        .from("user_roles")
        .select("role, organization_id")
        .eq("user_id", userId)
        .maybeSingle();
      const officeRole =
        roleRow?.role === "owner" ||
        roleRow?.role === "office_manager" ||
        roleRow?.role === "dispatcher";
      if (!officeRole) throw new Error("Not authorized to preview another tech's day");
      const { data: targetRow, error: targetErr } = await supabase
        .from("staff")
        .select("id, organization_id, display_name, role")
        .eq("id", data.staffId)
        .eq("organization_id", roleRow!.organization_id!)
        .maybeSingle();
      if (targetErr) throw new Error(targetErr.message);
      if (!targetRow) throw new Error("Staff member not found in your organization");
      targetStaff = targetRow;
      previewing = true;
    }

    if (!targetStaff)
      return { staff: null, visits: [] as any[], previewing: false, canText: false };

    const { data: visits, error } = await supabase
      .from("visits")
      .select(
        // `skipped_at` was written by skip_visit and selected by nobody, so the
        // branch in my-day.tsx that renders it -- added by
        // 20260804110000 precisely so a REPLAYED skip shows the time the tech
        // actually stood at the door, not the time their signal came back --
        // has been dead since the day it was written.
        "id, organization_id, scheduled_on, status, sequence, started_at, completed_at, skipped_at, eta_start, eta_end, visit_checklist, gate_reply, gate_reply_at, skip_reason, skip_reason_code, client_id, property_id, clients(display_name, primary_phone, dna_compliance_enabled, emergency_contact_name, emergency_contact_phone, emergency_contact_may_approve_vet, vet_treatment_limit_cents), walk_group_id, pee, poo, report_note, properties(label, street, city, postal_code, latitude, longitude, account_type, has_units, access_method, key_held, parking_notes, access_notes, yard_size, earliest_service_time, latest_service_time, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes, boundary, boundary_area_sqm, dogs(id, name, temperament, species, species_note, active, vet_clinic_name, vet_clinic_phone, pet_care_instructions(feeding, meds, other_care)), waste_stations(id, label, station_number, section, location_description, sort_order, active)), zones(name), services(name, service_line, default_duration_min), visit_photos(id, storage_path, kind)",
      )
      .eq("assigned_staff_id", targetStaff.id)
      .eq("scheduled_on", data.day)
      .order("sequence", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);

    // A pet sitting stop's stay and care log (#411); nothing asked otherwise.
    const { withSitDay } = await import("@/lib/sit-day.server");
    return {
      staff: targetStaff,
      visits: await withSitDay(
        supabase,
        await withStopFacts(supabase, await stampVisitAccess(supabase, visits ?? [])),
      ),
      previewing,
      canText: await businessCanText(targetStaff.organization_id),
    };
  });

/** Whether this business can text its clients at all: only from its own
 *  subaccount, which until per-business numbers clear carrier registration
 *  no business has. The card hides "Text reminder" rather than offer a button
 *  that can only fail. "On my way" stays: it goes by email when it can't text. */
async function businessCanText(orgId: string): Promise<boolean> {
  try {
    // The same switch every other texting control reads (lib/client-texting).
    const { orgCanTextClients } = await import("@/lib/twilio-credentials.server");
    return await orgCanTextClients(orgId);
  } catch (e) {
    console.warn("texting-number lookup failed; hiding Text reminder", e);
    return false;
  }
}

const VISIT_NOTICE_DEADLINE_MS = 2_500;

/** lib/keep-alive.server.ts's KeepAlive, spelled here so this file, which the
 *  browser bundle also reads, imports nothing from a .server module. */
type KeepAlive = (job: Promise<unknown>) => void;

/**
 * How long Complete waits for one notice before answering the tech.
 *
 * Work that misses the deadline keeps going, and the tech is told the notices
 * are "still sending". On a Worker that is only true if the work is handed to
 * waitUntil (`keepAlive`, lib/keep-alive.server.ts): a promise nobody holds can
 * be cut off once the response has gone out, and the email never sends. Where
 * there is no waitUntil (Node in dev, vitest) `keepAlive` does nothing and the
 * promise runs on by itself.
 */
async function withNoticeDeadline<T>(
  label: string,
  work: Promise<T>,
  keepAlive: KeepAlive,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), VISIT_NOTICE_DEADLINE_MS);
  });
  const result = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    keepAlive(work.catch((e) => console.error(`${label} failed after timeout`, e)));
    return { timedOut: true };
  }
  return { timedOut: false, value: result as T };
}

/**
 * What the card needs that the visit's own row does not carry: the dog count
 * the subscription is priced on, how the customer pays and what they owe
 * (my_day_stop_facts -- a tech cannot read subscriptions, invoices or
 * payments, and should not be able to), and when each waste station was last
 * serviced, by the rule the office's stations panel uses.
 *
 * Neither is allowed to cost the tech their day. A failure here -- the
 * function not yet on a database, a slow log query -- leaves `stop_facts`
 * null and the stations without a date, and the card says less rather than
 * the page saying nothing.
 */
async function withStopFacts<V extends { id: string; properties?: unknown }>(
  supabase: SupabaseClient<Database>,
  visits: V[],
): Promise<(V & { stop_facts: StopFacts | null })[]> {
  type Props = { waste_stations?: { id: string }[] | null } | null;
  const propsOf = (v: V) => (v.properties ?? null) as Props;
  const facts = new Map<string, StopFacts>();
  if (visits.length) {
    try {
      const { data: rows, error } = await supabase.rpc("my_day_stop_facts", {
        _visit_ids: visits.map((v) => v.id),
      });
      if (error) throw error;
      for (const r of (rows ?? []) as StopFactsRow[]) facts.set(r.visit_id, stopFactsFromRow(r));
    } catch (e) {
      console.warn("my_day_stop_facts failed; the cards will omit dog counts and payment", e);
    }
  }

  const stationIds = visits.flatMap((v) => (propsOf(v)?.waste_stations ?? []).map((s) => s.id));
  let lastServiced: Record<string, string> = {};
  if (stationIds.length) {
    try {
      const { data: logs, error } = await supabase
        .from("station_service_logs")
        .select("waste_station_id, serviced_at, visits(scheduled_on)")
        .in("waste_station_id", stationIds)
        .order("serviced_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      lastServiced = lastServicedByStation(
        (logs ?? []) as Parameters<typeof lastServicedByStation>[0],
      );
    } catch (e) {
      console.warn("station last-serviced lookup failed", e);
    }
  }

  return visits.map((v) => {
    const p = propsOf(v);
    return {
      ...v,
      stop_facts: facts.get(v.id) ?? null,
      properties: p
        ? {
            ...p,
            waste_stations: (p.waste_stations ?? []).map((s) => ({
              ...s,
              last_serviced_on: lastServiced[s.id] ?? null,
            })),
          }
        : v.properties,
    };
  });
}

export const listMyDayFieldStaff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role, organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    const officeRole =
      roleRow?.role === "owner" ||
      roleRow?.role === "office_manager" ||
      roleRow?.role === "dispatcher";
    if (!officeRole || !roleRow?.organization_id)
      return { staff: [] as { id: string; display_name: string; role: string }[] };
    const { data, error } = await supabase
      .from("staff")
      .select("id, display_name, role, active, is_field_tech")
      .eq("organization_id", roleRow.organization_id)
      .eq("active", true)
      .order("display_name", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []).filter((s: any) => s.is_field_tech !== false);
    return {
      staff: rows.map((s: any) => ({ id: s.id, display_name: s.display_name, role: s.role })),
    };
  });

export const startVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        /** When the tech actually started, for a REPLAYED action. */
        startedAt: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("start_visit", {
      _visit_id: data.visitId,
      _started_at: data.startedAt ?? undefined,
    });
    if (error) throw new Error(error.message);
    // The same line the lock screen's Start writes (visit-activity.server.ts).
    const { logVisitStarted } = await import("@/lib/visit-activity.server");
    await logVisitStarted(context.supabase, { visitId: data.visitId, actorUserId: context.userId });
    return { ok: true };
  });

export const completeVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        // When the tech actually finished, for a REPLAYED action. Absent on the
        // live path. The SQL decides whether to believe it — a phone clock is a
        // hint, never the safeguard — and records the replay in
        // completion_source either way.
        completedAt: z.string().datetime().optional(),
        /** What the tech wants the office to know. */
        note: z.string().trim().max(1000).optional(),
        /** Why there is no completion photo, when the org requires one. The
         *  SQL decides whether it is needed. */
        noPhotoReason: z.string().trim().max(300).optional(),
        /** The ids of the checklist items the tech checked. The SQL refuses
         *  the completion while a required one is missing, and copies each
         *  item's label from the owner's list onto the visit. */
        checkedItems: z
          .array(z.string().min(1).max(MAX_CHECKLIST_ID))
          .max(MAX_CHECKLIST_ITEMS)
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("complete_visit", {
      _visit_id: data.visitId,
      _completed_at: data.completedAt ?? undefined,
      _note: data.note || undefined,
      _no_photo_reason: data.noPhotoReason || undefined,
      _checked_items: data.checkedItems ?? undefined,
    });
    if (error) throw new Error(error.message);
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select("organization_id, client_id, property_id, scheduled_on")
        .eq("id", data.visitId)
        .single();
      if (v) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: v.organization_id,
          clientId: v.client_id,
          propertyId: v.property_id,
          actorUserId: context.userId,
          kind: "visit.completed",
          summary: `Completed the visit scheduled for ${v.scheduled_on}`,
        });
      }
    } catch (e) {
      console.warn("visit.completed activity log failed", data.visitId, e);
    }

    const sentClientNotices: Array<"completion_email" | "push" | "review_sms" | "review_email"> =
      [];
    let noticesPending = false;
    // What a notice that misses its deadline is handed to, so "still
    // sending" stays true after this returns (see withNoticeDeadline).
    const { keepAliveForThisRequest } = await import("@/lib/keep-alive.server");
    const keepAlive = await keepAliveForThisRequest();

    // The office hears when the route is finished, or when the NEXT stop is
    // now going to be late (field-notify.server.ts). It is not a client
    // notice, so a timeout here must not make the tech's toast say client
    // notices are still sending. Start it now and await it near the return so
    // it does not add another wait before the client-facing work begins.
    const routeNoticeDone = (async () => {
      try {
        const { afterStopResolved } = await import("@/lib/field-notify.server");
        await withNoticeDeadline(
          "route follow-up after completion",
          afterStopResolved({ visitId: data.visitId, actorUserId: context.userId }),
          keepAlive,
        );
      } catch (e) {
        console.warn("route follow-up after completion failed", data.visitId, e);
      }
    })();

    // Fire visit-completed email (best-effort)
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select(
          "organization_id, client_id, scheduled_on, visit_checklist, properties(street, city, visit_contact_email), organizations(email_visit_checklist), services(service_line)",
        )
        .eq("id", data.visitId)
        .single();
      if (v) {
        const prop: any = Array.isArray((v as any).properties)
          ? (v as any).properties[0]
          : (v as any).properties;
        const address = prop ? [prop.street, prop.city].filter(Boolean).join(", ") : undefined;
        // What the tech checked, when the owner has chosen to tell the
        // customer (Settings -> Preferences -> Finishing a visit; off by
        // default). Only CHECKED items: "Water bowl checked: no" is the
        // office's business, not a line in a thank-you email.
        const org: any = Array.isArray((v as any).organizations)
          ? (v as any).organizations[0]
          : (v as any).organizations;
        const checklist = org?.email_visit_checklist
          ? checkedLabels(parseAnswers((v as any).visit_checklist))
          : [];
        // The template has always drawn up to three photos and nothing ever
        // passed it any, so the proof a customer was paying for stayed on the
        // server. The bucket is private: these are signed links, long enough
        // to outlive a slow inbox, from the service client because the tech's
        // own session cannot sign for an email it is not going to open.
        //
        // The latched-gate photo travels separately so the email can say what
        // it is: a customer whose dog got out wants THAT picture, captioned,
        // not a fourth "after" shot they have to recognise as a gate.
        let photoUrls: string[] = [];
        let gatePhotoUrl: string | undefined;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: photos } = await supabaseAdmin
            .from("visit_photos")
            .select("storage_path, kind")
            .eq("visit_id", data.visitId)
            .in("kind", PHOTO_KINDS_EMAILED)
            .order("created_at");
          const { completion, gate } = pickEmailedPhotos(
            (photos ?? []) as { storage_path: string; kind: string }[],
          );
          const paths = gate ? [...completion, gate] : completion;
          if (paths.length) {
            const { data: signed } = await supabaseAdmin.storage
              .from("visit-photos")
              .createSignedUrls(paths, 30 * 24 * 3600);
            const urlFor = new Map((signed ?? []).map((x) => [x.path, x.signedUrl] as const));
            photoUrls = completion.map((p) => urlFor.get(p)).filter((u): u is string => !!u);
            gatePhotoUrl = (gate && urlFor.get(gate)) || undefined;
          }
        } catch (e) {
          console.warn("visit-completed photos could not be signed", data.visitId, e);
        }
        // A dog walk's email is a walk report (#410). A pet sitting visit's
        // email is a visit report (#411), read only for a sitting visit.
        // Null for every other visit, which leaves the email and push as they
        // were. Both reads finish before the sends, which stay on the notice
        // deadline so a slow inbox does not hold the tech's button.
        const svc: any = Array.isArray((v as any).services)
          ? (v as any).services[0]
          : (v as any).services;
        const sitting = svc?.service_line === "pet_sitting";
        const [{ walkCompletionFor }, sitReport, { enqueueAppEmail }, { sendPushToClient }] =
          await Promise.all([
            import("@/lib/walk-report.server"),
            sitting ? import("@/lib/sit-report.server") : Promise.resolve(null),
            import("@/lib/email/enqueue.server"),
            import("@/lib/push.server"),
          ]);
        const [walk, sit] = await Promise.all([
          walkCompletionFor(data.visitId),
          sitReport ? sitReport.sitCompletionFor(data.visitId) : Promise.resolve(null),
        ]);
        const [emailResult, pushResult, sitFollowup] = await Promise.all([
          withNoticeDeadline(
            "visit-completed email enqueue",
            enqueueAppEmail({
              organizationId: v.organization_id,
              clientId: v.client_id,
              templateName: "visit-completed",
              notifyKey: "notify_email_visit_completed",
              idempotencyKey: `visit-done-${data.visitId}`,
              // P3.5: visit emails go to the property's own contact when one is
              // set (tenant/manager); billing emails stay with the client.
              toOverride: prop?.visit_contact_email || undefined,
              templateData: {
                // "Mon, Sep 28", not the column's 2026-09-28.
                visitDate: formatDay(v.scheduled_on),
                address,
                photoUrls,
                gatePhotoUrl,
                checklist,
                ...(walk ? { walk: walk.email } : {}),
                ...(sit ? { sit: sit.email } : {}),
              },
            }),
            keepAlive,
          ),
          withNoticeDeadline(
            "visit-completed push",
            sendPushToClient(v.client_id, {
              title: walk ? walk.push.title : sit ? sit.push.title : "Visit completed",
              body: walk
                ? walk.push.body
                : sit
                  ? sit.push.body
                  : address
                    ? `We just cleaned up at ${address}.`
                    : "Your yard visit is complete.",
              tag: `visit-${data.visitId}`,
              url: "/portal",
            }),
            keepAlive,
          ),
          // Missed medication email, and the stay summary after the last
          // visit. Never throws.
          sitReport
            ? withNoticeDeadline(
                "sit follow-up after completion",
                sitReport.afterSitCompleted(data.visitId),
                keepAlive,
              )
            : Promise.resolve(null),
        ]);
        if (emailResult.timedOut) noticesPending = true;
        else if ((emailResult.value as { ok?: boolean })?.ok)
          sentClientNotices.push("completion_email");
        if (pushResult.timedOut) noticesPending = true;
        else if (((pushResult.value as { sent?: number })?.sent ?? 0) > 0)
          sentClientNotices.push("push");
        if (sitFollowup?.timedOut) noticesPending = true;
      }
    } catch (e) {
      console.error("visit-completed email failed", e);
    }

    // Best-effort: fire an automated Google review SMS if org enabled it and
    // this client hasn't been asked recently. Only completed visits qualify.
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select(
          "organization_id, client_id, clients(id, display_name, sms_opt_out, comms_paused, primary_phone, review_asked_at), organizations!inner(name, review_ask_enabled, google_review_url, review_ask_template)",
        )
        .eq("id", data.visitId)
        .single();
      const c: any =
        v && (Array.isArray((v as any).clients) ? (v as any).clients[0] : (v as any).clients);
      const o: any =
        v &&
        (Array.isArray((v as any).organizations)
          ? (v as any).organizations[0]
          : (v as any).organizations);
      const ninetyDaysAgo = Date.now() - 90 * 24 * 3600_000;
      const eligible =
        o?.review_ask_enabled &&
        o?.google_review_url &&
        c?.id &&
        // Imported comms hold: no automated review asks (SMS or email) until
        // the org initiates contact with this client.
        !c?.comms_paused &&
        (!c?.review_asked_at || new Date(c.review_asked_at).getTime() < ninetyDaysAgo);
      if (eligible) {
        const orgId = (v as any).organization_id;
        // Review asks ride the business's OWN subaccount; without one, email
        // (never the platform SMS number, which texts account holders only).
        const { endCustomerSmsSender } = await import("@/lib/twilio-credentials.server");
        const sender = await endCustomerSmsSender(orgId);
        // Same consent gate as every other sender. Without it the nightly
        // job is the single largest source of un-consented traffic, which is
        // precisely what a toll-free number gets shut off for.
        const { data: mayTextDaily } = await (context.supabase as any).rpc("client_may_be_texted", {
          _client_id: c.id,
        });
        if (sender && mayTextDaily && c.primary_phone) {
          const firstName = (c.display_name ?? "").split(/\s+/)[0] || "there";
          const template =
            (o.review_ask_template && String(o.review_ask_template).trim()) ||
            `Hi {name}, thanks for choosing ${o.name ?? "us"}! If we did a great job, a quick review would mean the world: {link} Reply STOP to opt out.`;
          const body = template
            .replace(/\{name\}/g, firstName)
            .replace(/\{link\}/g, o.google_review_url);
          const { sendTwilioSms } = await import("@/lib/twilio.server");
          try {
            // The send and its record are one piece of work, so a text that
            // lands after the deadline is still logged and still marks the
            // client asked; otherwise the next visit would ask again.
            const smsResult = await withNoticeDeadline(
              "review SMS",
              sendTwilioSms({
                to: c.primary_phone,
                body,
                from: sender.from ?? undefined,
                messagingServiceSid: sender.messagingServiceSid ?? undefined,
                credentials: sender.credentials,
              }).then(async (res) => {
                await context.supabase.from("messages").insert({
                  organization_id: orgId,
                  client_id: c.id,
                  visit_id: data.visitId,
                  direction: "outbound",
                  body,
                  from_number: sender.from,
                  to_number: c.primary_phone,
                  twilio_sid: res.sid,
                  status: (res.status || "sent") as any,
                });
                await context.supabase.rpc("mark_review_asked", { _client_id: c.id });
                return res;
              }),
              keepAlive,
            );
            if (smsResult.timedOut) {
              noticesPending = true;
            } else {
              sentClientNotices.push("review_sms");
            }
          } catch (err) {
            console.error("auto review SMS failed", err);
          }
        } else {
          const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
          const reviewEmail = await withNoticeDeadline(
            "review email enqueue",
            enqueueAppEmail({
              organizationId: orgId,
              clientId: c.id,
              templateName: "review-request",
              notifyKey: "notify_email_review_request",
              idempotencyKey: `review-${c.id}-${new Date().toISOString().slice(0, 10)}`,
              templateData: { reviewUrl: o.google_review_url },
            }).then(async (r) => {
              // Marked with the enqueue, for the same reason as the text.
              if ((r as { ok?: boolean })?.ok)
                await context.supabase.rpc("mark_review_asked", { _client_id: c.id });
              return r;
            }),
            keepAlive,
          );
          if (reviewEmail.timedOut) {
            noticesPending = true;
          } else if ((reviewEmail.value as { ok?: boolean })?.ok) {
            sentClientNotices.push("review_email");
          }
        }
      }
    } catch (e) {
      console.error("auto review request failed", e);
    }
    // A lesson that leaves one session on its package tells the client and
    // the office, once. One read for any other visit. Never throws.
    const { afterLessonSessionChange } = await import("@/lib/training-portal.server");
    await afterLessonSessionChange(data.visitId);
    await routeNoticeDone;
    return { ok: true, notificationSummary: { sent: sentClientNotices, pending: noticesPending } };
  });

export const skipVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        reason: z.string().min(1).max(500),
        code: z
          .enum([
            "client_cancelled_late",
            "gate_locked",
            "dog_outside",
            "weather",
            "our_fault",
            "access_blocked",
            "unsafe_conditions",
            "other",
            "key_failed",
            "no_one_home",
            "dog_unwell",
          ])
          .default("other"),
        /** When the tech actually skipped, for a REPLAYED action. */
        skippedAt: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("skip_visit", {
      _visit_id: data.visitId,
      _reason: data.reason,
      _code: data.code,
      _skipped_at: data.skippedAt ?? undefined,
    });
    if (error) throw new Error(error.message);
    // The office hears it with the reason, once (a replayed skip is the same
    // skip), and then whatever a resolved stop means for the day: finished,
    // or the next stop late. Never throws.
    const { notifyVisitSkipped } = await import("@/lib/field-notify.server");
    await notifyVisitSkipped({ visitId: data.visitId, actorUserId: context.userId });
    // A late-canceled lesson can use a session. Never throws.
    const { afterLessonSessionChange } = await import("@/lib/training-portal.server");
    await afterLessonSessionChange(data.visitId);
    // A dog walk's client hears it too (#410); nothing for any other visit.
    const { notifyWalkNotDone } = await import("@/lib/walk-notify.server");
    await notifyWalkNotDone({ visitId: data.visitId, kind: "skipped" });
    return { ok: true };
  });

export const recordVisitPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        storagePath: z.string().min(1),
        kind: z.enum(PHOTO_KINDS).default("completion"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: v, error: vErr } = await supabase
      .from("visits")
      .select("organization_id")
      .eq("id", data.visitId)
      .single();
    if (vErr) throw new Error(vErr.message);

    // Idempotent, because this is the second of two steps and the offline queue
    // replays the pair. The upload can land and this call's RESPONSE be lost --
    // a dropped connection, the 45s deadline -- and the replay then re-records
    // a path already recorded, showing the customer the same photograph twice.
    //
    // `ignoreDuplicates` needs the unique index added in 20260903110000; with
    // the storage UPDATE policy from the same file it is what finally makes a
    // photo action safe to replay however far it got the first time.
    const { error } = await supabase.from("visit_photos").upsert(
      {
        visit_id: data.visitId,
        organization_id: v.organization_id,
        uploaded_by: userId,
        storage_path: data.storagePath,
        kind: data.kind,
      },
      { onConflict: "visit_id,storage_path", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── BUILD-11: end-of-day close-out ───────────────────────────────────────────
//
// A visit the tech started and never finished is currently immortal: the
// nightly missed-visit job skips anything with a started_at, so nothing ever
// resolves it and it simply drops off the tech's day when the date rolls over.
//
// Nothing here completes anything on its own. This finds the open visits worth
// ASKING about; the tech answers, and confirmOpenVisit records their answer.

/** Open visits belonging to the calling tech that are past the point where they
 *  can still plausibly be in progress. Scoped to the caller's own staff row —
 *  this is a prompt about your own forgotten work, not a supervision tool. */
export const listVisitsAwaitingCloseOut = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: staffRow } = await supabase
      .from("staff")
      .select("id, organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!staffRow) return { visits: [] as OpenVisitRow[] };

    const { data: org } = await (supabase as any)
      .from("organizations")
      .select("timezone, workday_end")
      .eq("id", staffRow.organization_id)
      .maybeSingle();

    // Org-local, never UTC — the same rule the portal's "today" follows, and
    // for the same reason: a tech west of UTC would otherwise be prompted about
    // today's visit hours before their day is actually over (BUG-12).
    const { DEFAULT_TIMEZONE } = await import("@/lib/route-window");
    const tz = org?.timezone || DEFAULT_TIMEZONE;
    const now = new Date();
    // The third hand-rolled copy of this formatter. One definition now.
    const orgLocalToday = orgToday(tz, now);
    const orgLocalTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);

    // Bounded lookback: a visit open for months is a data problem for the
    // office, not something to nag a tech about every morning forever.
    const since = new Date(now.getTime() - 14 * 86400_000).toISOString().slice(0, 10);

    const { data: rows, error } = await (supabase as any)
      .from("visits")
      .select(
        "id, scheduled_on, started_at, status, clients(display_name), properties(street, city)",
      )
      .eq("assigned_staff_id", staffRow.id)
      .eq("status", "in_progress")
      .gte("scheduled_on", since)
      .order("scheduled_on", { ascending: true });
    if (error) throw new Error(error.message);

    const { isVisitAwaitingCloseOut } = await import("@/lib/visit-lifecycle");
    const visits = (rows ?? []).filter((v: any) =>
      isVisitAwaitingCloseOut(v, orgLocalToday, orgLocalTime, org?.workday_end ?? null),
    );
    return { visits: visits as OpenVisitRow[] };
  });

export type OpenVisitRow = {
  id: string;
  scheduled_on: string;
  started_at: string | null;
  status: string;
  clients?: { display_name?: string | null } | null;
  properties?: { street?: string | null; city?: string | null } | null;
};

/** Record the tech's answer about a visit they left open.
 *
 *  The completion time is the tech's ASSERTION, not a measurement, so it is
 *  stored with completion_source='late_confirmation' and validated in the
 *  database against the recorded start. That is what stops this path from
 *  recreating the BUG-9 rows (completion == start) by construction. */
export const confirmOpenVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        completed: z.boolean(),
        // Required when completed; ignored otherwise. Validated server-side
        // against started_at — the client hint is never the safeguard.
        completedAt: z.string().datetime().optional(),
        note: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.completed && !data.completedAt) {
      throw new Error("Tell us what time the visit finished");
    }

    const { data: outcome, error } = await (supabase as any).rpc("confirm_open_visit", {
      _visit_id: data.visitId,
      _completed: data.completed,
      _completed_at: data.completedAt ?? undefined,
      _note: data.note ?? null,
    });
    if (error) throw new Error(error.message);

    // The tech's own lock screen, if that day's route is on it: a stop that
    // read "in progress" is now done or missed. No route watch, on purpose:
    // the watch tells the tech whose day it is, and this is that tech closing
    // out their own stop (confirm_open_visit refuses anyone else), so it
    // would always be telling the actor about their own action, which the
    // watch never does.
    if (outcome === "completed" || outcome === "missed") {
      const { routeDaysForVisits, refreshRouteLiveActivities } =
        await import("@/lib/push-liveactivity.server");
      await refreshRouteLiveActivities(await routeDaysForVisits([data.visitId]));
    }

    // Audit the assertion, not just the state change: a completion nobody
    // measured should be legible as such on the timeline afterwards (10.6).
    try {
      const { data: v } = await supabase
        .from("visits")
        .select("organization_id, client_id, property_id, scheduled_on")
        .eq("id", data.visitId)
        .single();
      if (v && outcome !== "already_resolved") {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(supabase, {
          orgId: v.organization_id,
          clientId: v.client_id,
          propertyId: v.property_id,
          actorUserId: userId,
          kind: outcome === "completed" ? "visit.completed_late" : "visit.missed_confirmed",
          summary:
            outcome === "completed"
              ? `Confirmed after the fact that the ${v.scheduled_on} visit was completed (finish time entered by the tech, not measured)`
              : `Confirmed the ${v.scheduled_on} visit was left unfinished`,
          meta: { visit_id: data.visitId, completed_at: data.completedAt ?? null },
        });
      }
    } catch {
      /* audit is best-effort — never block the close-out */
    }

    return { outcome: (outcome ?? "already_resolved") as string };
  });

/**
 * The technician's own next two weeks: which days they work, and how big each
 * one is.
 *
 * ── "HOW MANY ROUTES" HAS NO LITERAL ANSWER, AND THAT IS THE FINDING ──────
 *
 * There is no routes table in this database. No shifts table either. A
 * "route" in this product is not a record — it is a technician plus a date,
 * and the set of visits carrying that pair. /routes is a day BOARD, which is
 * why it is office-only: it shows everyone's work and lets you move it
 * between people.
 *
 * So a technician's schedule cannot count routes; it counts the things a
 * route is made of. Per working day: how many stops, how many are already
 * done, which zones the day touches, and when the first and last stop are
 * due. A day with no assigned visits is not a working day and does not
 * appear — which is exactly "which days they work", read out of the only
 * data that knows.
 *
 * ── WHY THIS IS NOT JUST GRANTING /routes TO TECHS ───────────────────────
 *
 * That page assigns work. A technician looking up whether they are on
 * tomorrow does not need, and should not have, a control that moves
 * somebody else's stops onto somebody else's van. This reads one staff row —
 * their own — and returns counts.
 */
export const getMyUpcomingDays = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        /** How far ahead to look. Bounded so a bad caller cannot ask for a year. */
        days: z.number().int().min(1).max(60).optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: staffRow, error: staffErr } = await supabase
      .from("staff")
      .select("id, organization_id, display_name")
      .eq("user_id", userId)
      .maybeSingle();
    if (staffErr) throw new Error(staffErr.message);
    // An account with no staff row is not a technician. My Day already says so
    // in its own words; this returns empty rather than inventing a schedule.
    if (!staffRow) return { staff: null, days: [] as UpcomingDay[] };

    const horizon = data.days ?? 14;

    // Org-local, never UTC. A technician west of UTC asking "am I on tomorrow"
    // late in the evening would otherwise be shown a window starting on a day
    // that, for them, has not begun — the same BUG-12 reasoning the close-out
    // prompt above follows, and the reason orgToday exists at all.
    const { data: org } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", staffRow.organization_id)
      .maybeSingle();
    const { DEFAULT_TIMEZONE } = await import("@/lib/route-window");
    const today = orgToday(org?.timezone || DEFAULT_TIMEZONE);
    const until = new Date(`${today}T00:00:00Z`);
    until.setUTCDate(until.getUTCDate() + horizon - 1);
    const lastDay = until.toISOString().slice(0, 10);

    const { data: visits, error } = await supabase
      .from("visits")
      .select("scheduled_on, status, eta_start, eta_end, zones(name)")
      .eq("assigned_staff_id", staffRow.id)
      .gte("scheduled_on", today)
      .lte("scheduled_on", lastDay)
      .order("scheduled_on", { ascending: true });
    if (error) throw new Error(error.message);

    const byDay = new Map<string, UpcomingDay>();
    for (const v of (visits ?? []) as any[]) {
      const key = v.scheduled_on as string;
      let day = byDay.get(key);
      if (!day) {
        day = { date: key, stops: 0, done: 0, zones: [], firstEta: null, lastEta: null };
        byDay.set(key, day);
      }
      day.stops += 1;
      // "Done" is completed OR skipped: both are stops the technician no longer
      // has to drive to, and a day showing 6 left when 2 were skipped would be
      // wrong in the direction that makes people stop trusting the number.
      if (v.status === "completed" || v.status === "skipped") day.done += 1;
      const zone = v.zones?.name as string | undefined;
      if (zone && !day.zones.includes(zone)) day.zones.push(zone);
      // Bare clock strings are not comparable across days, and eta_* are
      // timestamptz — compare the instants, keep the ISO string.
      if (v.eta_start && (!day.firstEta || v.eta_start < day.firstEta)) day.firstEta = v.eta_start;
      if (v.eta_end && (!day.lastEta || v.eta_end > day.lastEta)) day.lastEta = v.eta_end;
    }

    return {
      staff: staffRow,
      days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  });

export type UpcomingDay = {
  date: string;
  stops: number;
  done: number;
  zones: string[];
  firstEta: string | null;
  lastEta: string | null;
};
