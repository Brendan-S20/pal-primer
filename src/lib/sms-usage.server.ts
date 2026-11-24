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

/** What sent a text. `compliance` kinds (STOP/HELP replies, consent
 *  confirmations) are never blocked by the ceiling. */
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

const NEVER_BLOCKED: ReadonlySet<SmsKind> = new Set(["consent", "stop_help", "inbound"]);

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
    const terms: TextingTerms = {
      included: r.segments_included == null ? d.included : Number(r.segments_included),
      blockSize: r.block_size == null ? d.blockSize : Number(r.block_size),
      blockCents: r.block_cents == null ? d.blockCents : Number(r.block_cents),
      ceilingBlocks: d.ceilingBlocks,
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
 *  ceiling. Fails OPEN if the state cannot be read: a metering outage must not
 *  silence texts, and the recount still bills what was sent. */
export async function assertUnderTextingCeiling(orgId: string, kind: SmsKind): Promise<void> {
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
