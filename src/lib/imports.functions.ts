import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization found for this user.");
  return data.organization_id as string;
}

export const IMPORT_SOURCES = [
  "generic_csv",
  "sweepgo",
  "jobber",
  "housecall_pro",
  "time_to_pet",
  "gorilla_desk",
  "quoteiq_family",
] as const;

// Canonical client target fields.
export const CLIENT_TARGET_FIELDS = [
  "display_name",
  "account_type",
  "primary_email",
  "primary_phone",
  "external_id",
  "notes",
] as const;
export type ClientTargetField = (typeof CLIENT_TARGET_FIELDS)[number];

// Per-source default header presets (target field -> array of source headers to try).
export const SOURCE_PRESETS: Record<string, Record<ClientTargetField, string[]>> = {
  generic_csv: {
    display_name: ["name", "display_name", "client name", "full name"],
    account_type: ["type", "account_type", "account type"],
    primary_email: ["email", "email address"],
    primary_phone: ["phone", "phone number", "mobile"],
    external_id: ["id", "external_id", "client id"],
    notes: ["notes", "note", "comments"],
  },
  sweepgo: {
    display_name: ["Client Name", "Customer Name", "Name"],
    account_type: ["Account Type", "Type"],
    primary_email: ["Email", "Email Address"],
    primary_phone: ["Phone", "Mobile", "Phone Number"],
    external_id: ["Client ID", "Customer ID", "ID"],
    notes: ["Notes"],
  },
  jobber: {
    display_name: ["Company/Client name", "Client name", "Name"],
    account_type: ["Client type", "Type"],
    primary_email: ["Email", "Primary email"],
    primary_phone: ["Mobile phone number", "Phone", "Primary phone number"],
    external_id: ["Client ID", "ID"],
    notes: ["Notes"],
  },
  housecall_pro: {
    display_name: ["Customer Name", "Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone", "Mobile"],
    external_id: ["Customer ID", "ID"],
    notes: ["Notes"],
  },
  time_to_pet: {
    display_name: ["Client", "Client Name", "Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone", "Mobile"],
    external_id: ["Client ID", "ID"],
    notes: ["Notes"],
  },
  gorilla_desk: {
    display_name: ["Customer", "Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone"],
    external_id: ["Customer ID", "ID"],
    notes: ["Notes"],
  },
  quoteiq_family: {
    display_name: ["Name", "Client Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone"],
    external_id: ["ID"],
    notes: ["Notes"],
  },
};

export function autoMap(source: string, headers: string[]): Record<ClientTargetField, string | null> {
  const preset = SOURCE_PRESETS[source] ?? SOURCE_PRESETS.generic_csv;
  const lc = headers.map((h) => h.toLowerCase().trim());
  const result: Record<string, string | null> = {};
  for (const field of CLIENT_TARGET_FIELDS) {
    let pick: string | null = null;
    for (const candidate of preset[field]) {
      const idx = lc.indexOf(candidate.toLowerCase().trim());
      if (idx !== -1) {
        pick = headers[idx];
        break;
      }
    }
    result[field] = pick;
  }
  return result as Record<ClientTargetField, string | null>;
}

function normalizeAccountType(v: unknown): "residential" | "commercial" {
  const s = String(v ?? "").toLowerCase().trim();
  if (s.startsWith("comm") || s.includes("business") || s.includes("hoa") || s.includes("commercial")) return "commercial";
  return "residential";
}

function mapRow(
  raw: Record<string, any>,
  mapping: Record<string, string | null>,
): { mapped: Record<string, any>; error: string | null } {
  const get = (field: ClientTargetField) => {
    const src = mapping[field];
    if (!src) return null;
    const v = raw[src];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  const display_name = get("display_name");
  if (!display_name) return { mapped: {}, error: "Missing display_name" };
  const email = get("primary_email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { mapped: {}, error: `Invalid email: ${email}` };
  }
  return {
    mapped: {
      display_name,
      account_type: normalizeAccountType(get("account_type")),
      primary_email: email,
      primary_phone: get("primary_phone"),
      external_id: get("external_id"),
      notes: get("notes"),
    },
    error: null,
  };
}

// ---------- Server functions ----------

export const listImportBatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("import_batches")
      .select("id, source, entity, filename, status, stats, error, committed_at, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { batches: data ?? [] };
  });

export const getImportBatch = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: batch, error: be } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", data.batchId)
      .single();
    if (be) throw new Error(be.message);
    const { data: rows, error: re } = await supabase
      .from("import_rows")
      .select("id, row_num, raw, mapped, action, target_id, error")
      .eq("batch_id", data.batchId)
      .order("row_num", { ascending: true })
      .limit(2000);
    if (re) throw new Error(re.message);
    return { batch, rows: rows ?? [] };
  });

const previewSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  filename: z.string().optional(),
  mapping: z.record(z.string(), z.string().nullable()),
  rows: z.array(z.record(z.string(), z.any())).min(1).max(5000),
});

export const previewImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => previewSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    // Existing clients for dedupe (by external_id and by lower(email))
    const { data: existing, error: exErr } = await supabase
      .from("clients")
      .select("id, primary_email, import_external_id, import_source")
      .eq("organization_id", orgId);
    if (exErr) throw new Error(exErr.message);
    const byExternal = new Map<string, string>();
    const byEmail = new Map<string, string>();
    for (const c of existing ?? []) {
      if (c.import_external_id && c.import_source === data.source) {
        byExternal.set(c.import_external_id, c.id);
      }
      if (c.primary_email) byEmail.set(c.primary_email.toLowerCase(), c.id);
    }

    // Create batch
    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .insert({
        organization_id: orgId,
        created_by: userId,
        source: data.source,
        entity: "clients",
        filename: data.filename ?? null,
        status: "previewing",
        mapping: data.mapping,
      })
      .select("id")
      .single();
    if (bErr) throw new Error(bErr.message);
    const batchId = batch.id as string;

    // Map + classify rows
    const rowsToInsert: any[] = [];
    let create = 0, update = 0, skip = 0, errors = 0;
    data.rows.forEach((raw, idx) => {
      const { mapped, error } = mapRow(raw, data.mapping as any);
      if (error) {
        errors += 1;
        rowsToInsert.push({
          batch_id: batchId, organization_id: orgId, row_num: idx + 1,
          raw, mapped: null, action: "error", target_id: null, error,
        });
        return;
      }
      let action: "create" | "update" | "skip" = "create";
      let target_id: string | null = null;
      if (mapped.external_id && byExternal.has(mapped.external_id)) {
        action = "update";
        target_id = byExternal.get(mapped.external_id)!;
      } else if (mapped.primary_email && byEmail.has(mapped.primary_email.toLowerCase())) {
        action = "skip";
        target_id = byEmail.get(mapped.primary_email.toLowerCase())!;
      }
      if (action === "create") create += 1;
      else if (action === "update") update += 1;
      else skip += 1;
      rowsToInsert.push({
        batch_id: batchId, organization_id: orgId, row_num: idx + 1,
        raw, mapped, action, target_id, error: null,
      });
    });

    // Batch insert in chunks of 500
    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500);
      const { error: iErr } = await supabase.from("import_rows").insert(chunk);
      if (iErr) throw new Error(iErr.message);
    }

    const stats = { total: data.rows.length, create, update, skip, errors };
    await supabase.from("import_batches").update({ stats }).eq("id", batchId);

    return { batchId, stats };
  });

export const commitImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .select("id, status, source, organization_id")
      .eq("id", data.batchId)
      .single();
    if (bErr) throw new Error(bErr.message);
    if (batch.organization_id !== orgId) throw new Error("Forbidden");
    if (batch.status !== "previewing") throw new Error(`Batch is ${batch.status}; cannot commit.`);

    const { data: rows, error: rErr } = await supabase
      .from("import_rows")
      .select("id, mapped, action, target_id")
      .eq("batch_id", data.batchId)
      .in("action", ["create", "update"]);
    if (rErr) throw new Error(rErr.message);

    let created = 0, updated = 0, failed = 0;
    for (const row of rows ?? []) {
      const m = row.mapped as any;
      try {
        if (row.action === "create") {
          const { data: ins, error: cErr } = await supabase
            .from("clients")
            .insert({
              organization_id: orgId,
              display_name: m.display_name,
              account_type: m.account_type,
              primary_email: m.primary_email,
              primary_phone: m.primary_phone,
              notes: m.notes,
              import_source: batch.source,
              import_external_id: m.external_id,
              import_batch_id: batch.id,
            })
            .select("id")
            .single();
          if (cErr) throw cErr;
          await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
          created += 1;
        } else if (row.action === "update" && row.target_id) {
          const { error: uErr } = await supabase
            .from("clients")
            .update({
              display_name: m.display_name,
              account_type: m.account_type,
              primary_email: m.primary_email,
              primary_phone: m.primary_phone,
              notes: m.notes,
            })
            .eq("id", row.target_id);
          if (uErr) throw uErr;
          updated += 1;
        }
      } catch (e: any) {
        failed += 1;
        await supabase.from("import_rows").update({
          action: "error",
          error: e?.message ?? String(e),
        }).eq("id", row.id);
      }
    }

    const stats = { created, updated, failed };
    await supabase.from("import_batches").update({
      status: failed && !created && !updated ? "failed" : "committed",
      stats,
      committed_at: new Date().toISOString(),
    }).eq("id", data.batchId);

    return stats;
  });

export const cancelImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("import_batches")
      .update({ status: "cancelled" })
      .eq("id", data.batchId)
      .eq("status", "previewing");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
