import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Export your data (NP-12): one file with the business's records, for an owner.
//
// Open on any plan, and for 30 days after a cancelled plan ends. NOT during a
// trial lock: a trial that ended without a plan reaches the plan picker and
// checkout only (owner, Oct 9).
//
// Read through the service role and filtered to the caller's organization on
// every table, so what is in the file is decided here and not by whichever
// policies happen to exist on each table.

/** What goes in the file. Each is read with `organization_id = <org>`. */
export const EXPORT_TABLES = [
  "clients",
  "properties",
  "dogs",
  "subscriptions",
  "visits",
  "invoices",
  "payments",
  "credit_ledger",
  "quotes",
  "leads",
  "zones",
  "expenses",
  "staff",
] as const;

/** A row as it comes back from PostgREST: plain JSON. */
type ExportRow = Record<string, string | number | boolean | null | object>;

const PAGE = 1000;
const MAX_ROWS_PER_TABLE = 50_000;

export const exportAccountData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_org_billing");
    const [{ lockForOrg }, { exportAllowed }] = await Promise.all([
      import("@/lib/account-lock.server"),
      import("@/lib/account-lock"),
    ]);
    const lock = await lockForOrg(orgId);
    if (!exportAllowed(lock)) {
      throw new Error(
        lock.locked && lock.reason === "plan_ended"
          ? "The 30 days to export this account's data have passed."
          : "Your account is locked. Choose a plan to unlock it.",
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;
    const { data: org } = await admin
      .from("organizations")
      .select("id, name, timezone, created_at")
      .eq("id", orgId)
      .maybeSingle();

    const tables: Record<string, ExportRow[]> = {};
    const truncated: string[] = [];
    for (const table of EXPORT_TABLES) {
      const rows: ExportRow[] = [];
      for (let from = 0; from < MAX_ROWS_PER_TABLE; from += PAGE) {
        const { data, error } = await admin
          .from(table)
          .select("*")
          .eq("organization_id", orgId)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`Couldn't export ${table}: ${error.message}`);
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
        if (from + PAGE >= MAX_ROWS_PER_TABLE) truncated.push(table);
      }
      tables[table] = rows;
    }

    // Line items have no organization column; they come by their invoices.
    const invoiceIds = tables.invoices.map((i) => String(i.id));
    const lineItems: ExportRow[] = [];
    for (let i = 0; i < invoiceIds.length; i += 200) {
      const { data, error } = await admin
        .from("invoice_line_items")
        .select("*")
        .in("invoice_id", invoiceIds.slice(i, i + 200));
      if (error) throw new Error(`Couldn't export invoice_line_items: ${error.message}`);
      lineItems.push(...(data ?? []));
    }
    tables.invoice_line_items = lineItems;

    return {
      exported_at: new Date().toISOString(),
      organization: (org ?? { id: orgId }) as ExportRow,
      truncated,
      tables,
    };
  });
