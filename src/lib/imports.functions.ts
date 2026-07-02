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

export const IMPORT_ENTITIES = ["clients", "properties", "dogs"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

// ---------- Target fields per entity ----------

export const CLIENT_TARGET_FIELDS = [
  "display_name",
  "account_type",
  "primary_email",
  "primary_phone",
  "external_id",
  "notes",
] as const;
export type ClientTargetField = (typeof CLIENT_TARGET_FIELDS)[number];

export const PROPERTY_TARGET_FIELDS = [
  "client_external_id",
  "label",
  "street",
  "city",
  "region",
  "postal_code",
  "gate_code",
  "notes",
] as const;
export type PropertyTargetField = (typeof PROPERTY_TARGET_FIELDS)[number];

export const DOG_TARGET_FIELDS = [
  "client_external_id",
  "name",
  "breed",
  "weight_class",
  "notes",
] as const;
export type DogTargetField = (typeof DOG_TARGET_FIELDS)[number];

export const TARGET_FIELDS_BY_ENTITY: Record<ImportEntity, readonly string[]> = {
  clients: CLIENT_TARGET_FIELDS,
  properties: PROPERTY_TARGET_FIELDS,
  dogs: DOG_TARGET_FIELDS,
};

// ---------- Per-source header presets ----------

type PresetMap = Record<string, string[]>;

const CLIENT_PRESETS: Record<string, PresetMap> = {
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

const PROPERTY_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "customer_id", "client external id", "external_id"],
    label: ["label", "location", "site", "property"],
    street: ["street", "address", "address_line_1", "street address"],
    city: ["city"],
    region: ["region", "province", "region"],
    postal_code: ["postal_code", "zip", "zip_code", "postcode"],
    gate_code: ["gate code", "gate_code", "gate"],
    notes: ["notes", "note", "instructions"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    label: ["Property Name", "Location Name"],
    street: ["Street", "Address"],
    city: ["City"],
    region: ["State", "Province"],
    postal_code: ["Zip", "Postal Code"],
    gate_code: ["Gate Code"],
    notes: ["Notes", "Service Notes"],
  },
  jobber: {
    client_external_id: ["Client ID"],
    label: ["Property name"],
    street: ["Street 1", "Street"],
    city: ["City"],
    region: ["Province/State", "State"],
    postal_code: ["Postal/Zip Code", "Postal code", "Zip"],
    gate_code: ["Gate Code"],
    notes: ["Property notes", "Notes"],
  },
  housecall_pro: {
    client_external_id: ["Customer ID"],
    label: ["Address Name"],
    street: ["Street", "Address"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
  time_to_pet: {
    client_external_id: ["Client ID"],
    label: ["Location"],
    street: ["Street"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
  gorilla_desk: {
    client_external_id: ["Customer ID"],
    label: ["Location"],
    street: ["Street"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
  quoteiq_family: {
    client_external_id: ["Client ID"],
    label: ["Location"],
    street: ["Street"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
};

const DOG_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "customer_id", "external_id"],
    name: ["name", "dog name", "pet name"],
    breed: ["breed"],
    weight_class: ["weight", "weight_class", "weight (lbs)"],
    notes: ["notes", "note"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    name: ["Dog Name", "Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight", "Weight (lbs)"],
    notes: ["Notes"],
  },
  jobber: {
    client_external_id: ["Client ID"],
    name: ["Pet name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  housecall_pro: {
    client_external_id: ["Customer ID"],
    name: ["Pet Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  time_to_pet: {
    client_external_id: ["Client ID"],
    name: ["Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  gorilla_desk: {
    client_external_id: ["Customer ID"],
    name: ["Pet Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  quoteiq_family: {
    client_external_id: ["Client ID"],
    name: ["Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
};

// Backward compatibility
export const SOURCE_PRESETS = CLIENT_PRESETS;

function presetsForEntity(entity: ImportEntity): Record<string, PresetMap> {
  if (entity === "properties") return PROPERTY_PRESETS;
  if (entity === "dogs") return DOG_PRESETS;
  return CLIENT_PRESETS;
}

export function autoMap(
  source: string,
  headers: string[],
  entity: ImportEntity = "clients",
): Record<string, string | null> {
  const presets = presetsForEntity(entity);
  const preset = presets[source] ?? presets.generic_csv;
  const fields = TARGET_FIELDS_BY_ENTITY[entity];
  const lc = headers.map((h) => h.toLowerCase().trim());
  const result: Record<string, string | null> = {};
  for (const field of fields) {
    let pick: string | null = null;
    const candidates = preset[field] ?? [];
    for (const c of candidates) {
      const idx = lc.indexOf(c.toLowerCase().trim());
      if (idx !== -1) {
        pick = headers[idx];
        break;
      }
    }
    result[field] = pick;
  }
  return result;
}

// ---------- Row normalization ----------

function normalizeAccountType(v: unknown): "residential" | "commercial" {
  const s = String(v ?? "").toLowerCase().trim();
  if (s.startsWith("comm") || s.includes("business") || s.includes("hoa") || s.includes("commercial")) return "commercial";
  return "residential";
}

function normalizePhone(v: string | null): string | null {
  if (!v) return null;
  const digits = v.replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return v.trim();
}

// Case-insensitive lookup across common column-name synonyms in the raw row.
function rawLookup(raw: Record<string, any>, names: string[]): string | null {
  const keys = Object.keys(raw);
  const lc = keys.map((k) => k.toLowerCase().trim());
  for (const n of names) {
    const idx = lc.indexOf(n.toLowerCase().trim());
    if (idx !== -1) {
      const v = raw[keys[idx]];
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return null;
}

const FIRST_NAME_COLUMNS = ["First Name", "First name", "first_name", "Given Name"];
const LAST_NAME_COLUMNS = ["Last Name", "Last name", "last_name", "Family Name", "Surname"];
const ADDRESS_2_COLUMNS = ["Street 2", "Address Line 2", "address_line_2", "Address 2", "Unit", "Apt", "Suite"];

function getStr(raw: Record<string, any>, mapping: Record<string, string | null>, field: string): string | null {
  const src = mapping[field];
  if (!src) return null;
  const v = raw[src];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function mapClientRow(raw: Record<string, any>, mapping: Record<string, string | null>) {
  let display_name = getStr(raw, mapping, "display_name");
  if (!display_name) {
    const first = rawLookup(raw, FIRST_NAME_COLUMNS);
    const last = rawLookup(raw, LAST_NAME_COLUMNS);
    const combined = [first, last].filter(Boolean).join(" ").trim();
    if (combined) display_name = combined;
  }
  if (!display_name) return { mapped: null, error: "Missing display_name (or First Name + Last Name)" };
  const email = getStr(raw, mapping, "primary_email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { mapped: null, error: `Invalid email: ${email}` };
  }
  return {
    mapped: {
      display_name,
      account_type: normalizeAccountType(getStr(raw, mapping, "account_type")),
      primary_email: email,
      primary_phone: normalizePhone(getStr(raw, mapping, "primary_phone")),
      external_id: getStr(raw, mapping, "external_id"),
      notes: getStr(raw, mapping, "notes"),
    },
    error: null as string | null,
  };
}

function mapPropertyRow(raw: Record<string, any>, mapping: Record<string, string | null>) {
  const client_external_id = getStr(raw, mapping, "client_external_id");
  if (!client_external_id) return { mapped: null, error: "Missing client_external_id (link to client)" };
  let street = getStr(raw, mapping, "street");
  if (!street) return { mapped: null, error: "Missing street" };
  const line2 = rawLookup(raw, ADDRESS_2_COLUMNS);
  if (line2) street = `${street}, ${line2}`;
  return {
    mapped: {
      client_external_id,
      label: getStr(raw, mapping, "label"),
      street,
      city: getStr(raw, mapping, "city"),
      region: getStr(raw, mapping, "region"),
      postal_code: getStr(raw, mapping, "postal_code"),
      gate_code: getStr(raw, mapping, "gate_code"),
      notes: getStr(raw, mapping, "notes"),
    },
    error: null as string | null,
  };
}

function mapDogRow(raw: Record<string, any>, mapping: Record<string, string | null>) {
  const client_external_id = getStr(raw, mapping, "client_external_id");
  if (!client_external_id) return { mapped: null, error: "Missing client_external_id (link to client)" };
  const name = getStr(raw, mapping, "name");
  if (!name) return { mapped: null, error: "Missing dog name" };
  const wRaw = getStr(raw, mapping, "weight_class");
  let weightClass: string | null = null;
  if (wRaw) {
    const n = Number(wRaw.replace(/[^\d.]/g, ""));
    if (!Number.isNaN(n) && n > 0) {
      weightClass = n < 25 ? "small" : n < 60 ? "medium" : "large";
    } else {
      weightClass = wRaw.toLowerCase();
    }
  }
  return {
    mapped: {
      client_external_id,
      name,
      breed: getStr(raw, mapping, "breed"),
      weight_class: weightClass,
      notes: getStr(raw, mapping, "notes"),
    },
    error: null as string | null,
  };
}

function mapRow(entity: ImportEntity, raw: Record<string, any>, mapping: Record<string, string | null>) {
  if (entity === "properties") return mapPropertyRow(raw, mapping);
  if (entity === "dogs") return mapDogRow(raw, mapping);
  return mapClientRow(raw, mapping);
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
  entity: z.enum(IMPORT_ENTITIES).default("clients"),
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
    const entity = data.entity;

    // Load existing rows for dedupe/linking depending on entity
    const { data: existingClients, error: ecErr } = await supabase
      .from("clients")
      .select("id, primary_email, import_external_id, import_source, display_name")
      .eq("organization_id", orgId);
    if (ecErr) throw new Error(ecErr.message);
    const clientByExternal = new Map<string, string>();
    const clientByEmail = new Map<string, string>();
    for (const c of existingClients ?? []) {
      if (c.import_external_id && c.import_source === data.source) {
        clientByExternal.set(c.import_external_id, c.id);
      }
      if (c.primary_email) clientByEmail.set(c.primary_email.toLowerCase(), c.id);
    }

    let existingPropertyKeys = new Set<string>();
    let existingDogKeys = new Set<string>();
    if (entity === "properties") {
      const { data: props } = await supabase
        .from("properties")
        .select("client_id, street, postal_code")
        .eq("organization_id", orgId);
      for (const p of props ?? []) {
        existingPropertyKeys.add(`${p.client_id}::${(p.street ?? "").toLowerCase()}::${p.postal_code ?? ""}`);
      }
    } else if (entity === "dogs") {
      const { data: dogs } = await supabase
        .from("dogs")
        .select("property_id, name, properties!inner(client_id)")
        .eq("organization_id", orgId);
      for (const d of (dogs ?? []) as any[]) {
        const cid = d.properties?.client_id;
        if (cid) existingDogKeys.add(`${cid}::${(d.name ?? "").toLowerCase()}`);
      }
    }

    // Create batch
    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .insert({
        organization_id: orgId,
        created_by: userId,
        source: data.source,
        entity,
        filename: data.filename ?? null,
        status: "previewing",
        mapping: data.mapping,
      })
      .select("id")
      .single();
    if (bErr) throw new Error(bErr.message);
    const batchId = batch.id as string;

    const rowsToInsert: any[] = [];
    let create = 0, update = 0, skip = 0, errors = 0;

    data.rows.forEach((raw, idx) => {
      const { mapped, error } = mapRow(entity, raw, data.mapping as any);
      if (error || !mapped) {
        errors += 1;
        rowsToInsert.push({
          batch_id: batchId, organization_id: orgId, row_num: idx + 1,
          raw, mapped: null, action: "error", target_id: null, error,
        });
        return;
      }
      let action: "create" | "update" | "skip" = "create";
      let target_id: string | null = null;

      if (entity === "clients") {
        const m = mapped as any;
        if (m.external_id && clientByExternal.has(m.external_id)) {
          action = "update";
          target_id = clientByExternal.get(m.external_id)!;
        } else if (m.primary_email && clientByEmail.has(m.primary_email.toLowerCase())) {
          action = "skip";
          target_id = clientByEmail.get(m.primary_email.toLowerCase())!;
        }
      } else if (entity === "properties") {
        const m = mapped as any;
        const clientId = clientByExternal.get(m.client_external_id);
        if (!clientId) {
          errors += 1;
          rowsToInsert.push({
            batch_id: batchId, organization_id: orgId, row_num: idx + 1,
            raw, mapped, action: "error", target_id: null,
            error: `No client with external id ${m.client_external_id} (import clients first)`,
          });
          return;
        }
        target_id = clientId;
        const key = `${clientId}::${m.street.toLowerCase()}::${m.postal_code ?? ""}`;
        if (existingPropertyKeys.has(key)) action = "skip";
      } else if (entity === "dogs") {
        const m = mapped as any;
        const clientId = clientByExternal.get(m.client_external_id);
        if (!clientId) {
          errors += 1;
          rowsToInsert.push({
            batch_id: batchId, organization_id: orgId, row_num: idx + 1,
            raw, mapped, action: "error", target_id: null,
            error: `No client with external id ${m.client_external_id} (import clients first)`,
          });
          return;
        }
        target_id = clientId;
        const key = `${clientId}::${m.name.toLowerCase()}`;
        if (existingDogKeys.has(key)) action = "skip";
      }

      if (action === "create") create += 1;
      else if (action === "update") update += 1;
      else skip += 1;
      rowsToInsert.push({
        batch_id: batchId, organization_id: orgId, row_num: idx + 1,
        raw, mapped, action, target_id, error: null,
      });
    });

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
      .select("id, status, source, entity, organization_id")
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

    const entity = (batch.entity ?? "clients") as ImportEntity;
    let created = 0, updated = 0, failed = 0;

    for (const row of rows ?? []) {
      const m = row.mapped as any;
      try {
        if (entity === "clients") {
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
              .select("id").single();
            if (cErr) throw cErr;
            await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
            created += 1;
          } else if (row.action === "update" && row.target_id) {
            const { error: uErr } = await supabase.from("clients").update({
              display_name: m.display_name,
              account_type: m.account_type,
              primary_email: m.primary_email,
              primary_phone: m.primary_phone,
              notes: m.notes,
            }).eq("id", row.target_id);
            if (uErr) throw uErr;
            updated += 1;
          }
        } else if (entity === "properties") {
          if (row.action === "create" && row.target_id) {
            const { data: ins, error: cErr } = await supabase
              .from("properties")
              .insert({
                organization_id: orgId,
                client_id: row.target_id,
                label: m.label,
                street: m.street,
                city: m.city,
                region: m.region,
                postal_code: m.postal_code,
                gate_code: m.gate_code,
                access_notes: m.notes,
              })
              .select("id").single();
            if (cErr) throw cErr;
            await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
            created += 1;
          }
        } else if (entity === "dogs") {
          if (row.action === "create" && row.target_id) {
            // Attach to client's first property
            const { data: prop, error: pErr } = await supabase
              .from("properties")
              .select("id")
              .eq("organization_id", orgId)
              .eq("client_id", row.target_id)
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (pErr) throw pErr;
            if (!prop) throw new Error("Client has no property; import a property first");
            const { data: ins, error: cErr } = await supabase
              .from("dogs")
              .insert({
                organization_id: orgId,
                property_id: prop.id,
                name: m.name,
                breed: m.breed,
                weight_class: m.weight_class,
                notes: m.notes,
              })
              .select("id").single();
            if (cErr) throw cErr;
            await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
            created += 1;
          }
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
