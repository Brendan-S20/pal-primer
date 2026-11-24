// #988 — record every text's segments, read where an org stands, and enforce
// the monthly ceiling. Recording NEVER throws: a metering failure must not
// stop a text a client is waiting for, and it is logged loudly instead.

import { orgLocalDay, DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import {
  countSegments,
  DEFAULT_TEXTING_TERMS,
  ceilingSegments,
  type SmsEncoding,
  type TextingTerms,
} from "@/lib/sms-segments";
import { TEXTING_USAGE_BILLING_LIVE } from "@/lib/texting-launch";

/** What sent a text. The kinds in NEVER_BLOCKED are never stopped by the
 *  ceiling. */
export type SmsKind =
  | "client_message"
  | "on_my_way"
  | "reminder"
  | "review_request"
  | "portal_code"
  | "payment_notice"
  | "consent"
  | "stop_help"
  | "inbound";

/** Never stopped by the ceiling: compliance texts (STOP/HELP replies, consent
 *  confirmations), what came in, and a client's portal sign-in code. A
 *  one-time code is transactional: blocking it locks a client out of the
 *  portal, and the business cannot tell why. */
export const NEVER_BLOCKED: ReadonlySet<SmsKind> = new Set([
  "consent",
  "stop_help",
  "inbound",
  "portal_code",
]);

/** The ledger key for a TwiML reply to an inbound text. Twilio sends the reply
 *  itself and reports no SID for it, so it is keyed to the inbound message it
 *  answers: a retried webhook records the same key, and the unique index on
 *  `twilio_sid` counts it once. No inbound SID, no key (each such row counts). */
export function twimlReplySid(inboundSid: string | null | undefined): string | null {
  return inboundSid ? `${inboundSid}:reply` : null;
}

export class TextingCeilingReached extends Error {
  constructor(public readonly orgId: string) {
    super("This business has reached its monthly texting ceiling.");
    this.name = "TextingCeilingReached";
  }
}

type Admin = {
  from: (t: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as Admin;
}

export type SmsUsageState = {
  periodMonth: string;
  segmentsUsed: number;
  terms: TextingTerms;
  blocksOwed: number;
  overageCents: number;
  ceilingSegments: number;
};

export async function readSmsUsageState(orgId: string): Promise<SmsUsageState | null> {
  try {
    const db = await admin();
    const { data, error } = await db.rpc("sms_usage_state", { _org_id: orgId });
    if (error) throw error;
    const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!r) return null;
    const d = DEFAULT_TEXTING_TERMS;
    const included = r.segments_included == null ? d.included : Number(r.segments_included);
    const blockSize = r.block_size == null ? d.blockSize : Number(r.block_size);
    // The catalog row's ceiling, not the code default: sms_usage_state returns
    // it as segments (included + blocks * size), so the blocks are read back
    // out of it. The default is only for a row that does not set one.
    const ceilingBlocks =
      r.ceiling_segments == null || !(blockSize > 0)
        ? d.ceilingBlocks
        : Math.max(0, Math.round((Number(r.ceiling_segments) - included) / blockSize));
    const terms: TextingTerms = {
      included,
      blockSize,
      blockCents: r.block_cents == null ? d.blockCents : Number(r.block_cents),
      ceilingBlocks,
    };
    return {
      periodMonth: String(r.period_month ?? ""),
      segmentsUsed: Number(r.segments_used ?? 0),
      terms,
      blocksOwed: Number(r.blocks_owed ?? 0),
      overageCents: Number(r.overage_cents ?? 0),
      ceilingSegments:
        r.ceiling_segments == null ? ceilingSegments(terms) : Number(r.ceiling_segments),
    };
  } catch (e) {
    console.error("[sms-usage] state read failed", orgId, e);
    return null;
  }
}

/** Throws TextingCeilingReached when an automatic text would go past the
 *  ceiling. Does nothing at all while TEXTING_USAGE_BILLING_LIVE is off
 *  (lib/texting-launch): the text is still counted, it is never stopped.
 *  Fails OPEN if the state cannot be read: a metering outage must not
 *  silence texts, and the recount still bills what was sent. */
export async function assertUnderTextingCeiling(
  orgId: string,
  kind: SmsKind,
  live: boolean = TEXTING_USAGE_BILLING_LIVE,
): Promise<void> {
  if (!live) return;
  if (NEVER_BLOCKED.has(kind)) return;
  const s = await readSmsUsageState(orgId);
  if (s && s.segmentsUsed >= s.ceilingSegments) throw new TextingCeilingReached(orgId);
}

/** Write one ledger row. Idempotent on `twilioSid`. Never throws. */
export async function recordSmsSegments(i: {
  orgId: string;
  direction: "outbound" | "inbound";
  kind: SmsKind;
  body: string;
  twilioSid?: string | null;
  /** Twilio's own count, when it reported one. */
  numSegments?: number | null;
  price?: number | null;
  now?: Date;
}): Promise<void> {
  try {
    const local = countSegments(i.body);
    const reported = i.numSegments != null && i.numSegments > 0 ? i.numSegments : null;
    const db = await admin();
    const { data: org } = await db
      .from("organizations")
      .select("timezone")
      .eq("id", i.orgId)
      .maybeSingle();
    const tz = (org as { timezone?: string | null } | null)?.timezone || DEFAULT_ORG_TIMEZONE;
    const month = `${orgLocalDay(i.now ?? new Date(), tz).slice(0, 7)}-01`;
    const row = {
      organization_id: i.orgId,
      period_month: month,
      direction: i.direction,
      kind: i.kind,
      twilio_sid: i.twilioSid ?? null,
      num_segments: reported ?? Math.max(1, local.segments),
      encoding: local.encoding as SmsEncoding,
      price: i.price ?? null,
    };
    const q = db.from("sms_usage_events");
    const { error } = i.twilioSid
      ? await q.upsert(row, { onConflict: "twilio_sid", ignoreDuplicates: true })
      : await q.insert(row);
    if (error) throw error;
  } catch (e) {
    console.error("[sms-usage] could not record segments", i.orgId, i.kind, e);
  }
}
