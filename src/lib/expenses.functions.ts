// Expenses: the server half.
//
// Every read and write here goes through the CALLER's Supabase client, so the
// policies in 20260929090000_nobody-knew-what-a-route-cost.sql are the
// boundary, not this file: the office (view_financials) reads and writes the
// organization's expenses, anybody else only rows filed against their own
// staff row. What this file adds is shape -- the input is validated, a
// non-office caller's expense is always filed as their own, and a day in the
// future is refused on the org's calendar -- and it never widens what the
// database would allow. The one service-role write is the org's mileage rate,
// behind manage_settings, which is how every other org setting is written.
//
// Mileage is priced by the database trigger from the org's rate, stored on the
// row, and never repriced. The amount sent for a mileage row is a preview and
// is overwritten.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import {
  EXPENSE_AMOUNT_MAX_CENTS,
  EXPENSE_CATEGORIES,
  EXPENSE_MILES_MAX,
  IRS_STANDARD_MILEAGE_RATE_CENTS,
  mileageAmountCents,
  monthBounds,
} from "@/lib/expenses";

type Db = any;

export const EXPENSE_COLUMNS =
  "id, organization_id, staff_id, spent_on, category, amount_cents, miles, mileage_rate_cents, vendor, note, receipt_path, created_by, created_at, updated_at";

export type Expense = {
  id: string;
  organization_id: string;
  staff_id: string | null;
  spent_on: string;
  category: string;
  amount_cents: number;
  miles: number | string | null;
  mileage_rate_cents: number | string | null;
  vendor: string | null;
  note: string | null;
  receipt_path: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date (YYYY-MM-DD)");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a month (YYYY-MM)");

/** The caller's organization, role, own staff row, and the org's calendar
 *  and rate. The staff row is the one the `own` policy asks about. */
async function loadCaller(supabase: Db, userId: string) {
  const { orgId, role } = await resolveCaller(supabase, userId);
  const [staff, org] = await Promise.all([
    supabase
      .from("staff")
      .select("id, display_name")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("organizations")
      .select("timezone, mileage_rate_cents")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  if (staff.error) throw new Error(staff.error.message);
  if (org.error) throw new Error(org.error.message);
  const timezone = (org.data?.timezone as string | null) || DEFAULT_ORG_TIMEZONE;
  return {
    orgId,
    role,
    isOffice: hasPermission(role, "view_financials"),
    canSetRate: hasPermission(role, "manage_settings"),
    myStaff: (staff.data as { id: string; display_name: string } | null) ?? null,
    timezone,
    today: orgToday(timezone),
    mileageRateCents: Number(org.data?.mileage_rate_cents ?? IRS_STANDARD_MILEAGE_RATE_CENTS),
  };
}

/** What the field sheet needs to preview a mileage amount. Cheap, and not on
 *  the app shell's getMyOrg on purpose: a column that is not there yet (code
 *  deployed before the migration) must break this sheet's preview, not the
 *  whole signed-in app. */
export const getExpenseSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const me = await loadCaller(context.supabase as Db, context.userId);
    return {
      mileageRateCents: me.mileageRateCents,
      timezone: me.timezone,
      today: me.today,
      myStaffId: me.myStaff?.id ?? null,
    };
  });

export const listExpenses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        month,
        category: z.enum(EXPENSE_CATEGORIES).optional(),
        /** A staff id, or "none" for expenses that are nobody's. Office only;
         *  anybody else's list is their own whatever this says. */
        staffId: z.union([z.string().uuid(), z.literal("none")]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as Db;
    const { userId } = context;
    const me = await loadCaller(supabase, userId);
    const { from, to } = monthBounds(data.month);

    let q = supabase
      .from("expenses")
      .select(EXPENSE_COLUMNS)
      .eq("organization_id", me.orgId)
      .gte("spent_on", from)
      .lte("spent_on", to);
    if (data.category) q = q.eq("category", data.category);
    if (me.isOffice) {
      if (data.staffId === "none") q = q.is("staff_id", null);
      else if (data.staffId) q = q.eq("staff_id", data.staffId);
    } else {
      // The policy already says so. Saying it here too means a tech's list is
      // their own even on a database where somebody loosened the policy.
      if (!me.myStaff) {
        return { ...me, month: data.month, staff: [], expenses: [] as Expense[] };
      }
      q = q.eq("staff_id", me.myStaff.id);
    }
    const { data: rows, error } = await q
      .order("spent_on", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(2000);
    if (error) throw new Error(error.message);

    // Names for the picker and the rows. The office sees the team; anybody
    // else sees only themselves.
    let staff: { id: string; display_name: string; active: boolean }[] = [];
    if (me.isOffice) {
      const res = await supabase
        .from("staff")
        .select("id, display_name, active")
        .eq("organization_id", me.orgId)
        .order("display_name", { ascending: true });
      if (res.error) throw new Error(res.error.message);
      staff = res.data ?? [];
    } else if (me.myStaff) {
      staff = [{ id: me.myStaff.id, display_name: me.myStaff.display_name, active: true }];
    }

    return { ...me, month: data.month, staff, expenses: (rows ?? []) as Expense[] };
  });

export type ExpenseList = Awaited<ReturnType<typeof listExpenses>>;

const expenseFields = z
  .object({
    spentOn: isoDay,
    category: z.enum(EXPENSE_CATEGORIES),
    /** Required unless category is mileage, where the database prices it. */
    amountCents: z.number().int().min(1).max(EXPENSE_AMOUNT_MAX_CENTS).optional(),
    miles: z.number().positive().max(EXPENSE_MILES_MAX).optional(),
    vendor: z.string().trim().max(120).optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
    receiptPath: z.string().max(300).optional().nullable(),
  })
  .refine((v) => (v.category === "mileage" ? v.miles != null : v.amountCents != null), {
    message: "Enter an amount, or the miles for a mileage expense.",
  });

function rowFields(v: z.infer<typeof expenseFields>, orgId: string, today: string) {
  if (v.spentOn > today) {
    throw new Error("An expense cannot be dated in the future.");
  }
  if (v.receiptPath && !v.receiptPath.startsWith(`${orgId}/`)) {
    throw new Error("That receipt is not filed under your organization.");
  }
  const mileage = v.category === "mileage";
  return {
    spent_on: v.spentOn,
    category: v.category,
    // A placeholder the trigger overwrites for mileage, so the NOT NULL is
    // satisfied by the same arithmetic the database will do.
    amount_cents: mileage
      ? Math.max(1, mileageAmountCents(v.miles ?? 0, IRS_STANDARD_MILEAGE_RATE_CENTS))
      : v.amountCents!,
    miles: mileage ? v.miles : null,
    vendor: v.vendor?.trim() || null,
    note: v.note?.trim() || null,
    ...(v.receiptPath !== undefined ? { receipt_path: v.receiptPath || null } : {}),
  };
}

/**
 * Log an expense. Idempotent on `id`: the field app mints the id on the device,
 * so a replay of a request that had in fact landed finds the row and does
 * nothing, rather than logging the same fuel receipt twice.
 */
export const createExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        /** File it against the caller's own staff row (My Day). */
        mine: z.boolean().optional(),
        /** Whose it is, for the office. Ignored for anybody else. */
        staffId: z.string().uuid().nullable().optional(),
        fields: expenseFields,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as Db;
    const { userId } = context;
    const me = await loadCaller(supabase, userId);

    let staffId: string | null;
    if (data.mine || !me.isOffice) {
      if (!me.myStaff) {
        throw new Error("Only a member of the team with a staff profile can log an expense.");
      }
      staffId = me.myStaff.id;
    } else {
      staffId = data.staffId ?? null;
    }

    const row = {
      id: data.id,
      organization_id: me.orgId,
      staff_id: staffId,
      ...rowFields(data.fields, me.orgId, me.today),
    };
    const { error } = await supabase
      .from("expenses")
      .upsert(row, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { id: data.id };
  });

export const updateExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        staffId: z.string().uuid().nullable().optional(),
        fields: expenseFields,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as Db;
    const { userId } = context;
    const me = await loadCaller(supabase, userId);

    const { data: before, error: readErr } = await supabase
      .from("expenses")
      .select("id, receipt_path")
      .eq("id", data.id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!before) throw new Error("That expense was not found.");

    const patch: Record<string, unknown> = rowFields(data.fields, me.orgId, me.today);
    // Only the office decides whose an expense is.
    if (me.isOffice && data.staffId !== undefined) patch.staff_id = data.staffId;

    const { data: updated, error } = await supabase
      .from("expenses")
      .update(patch)
      .eq("id", data.id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!updated?.length) throw new Error("You can only change your own expenses.");

    // A replaced receipt leaves nothing behind. Best effort: the row is right
    // either way, and a stray object is a storage cost, not a wrong number.
    const replaced =
      data.fields.receiptPath !== undefined &&
      before.receipt_path &&
      before.receipt_path !== (data.fields.receiptPath || null);
    if (replaced) {
      await supabase.storage.from("expense-receipts").remove([before.receipt_path]);
    }
    return { id: data.id };
  });

export const deleteExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as Db;
    const { data: gone, error } = await supabase
      .from("expenses")
      .delete()
      .eq("id", data.id)
      .select("id, receipt_path");
    if (error) throw new Error(error.message);
    if (!gone?.length) throw new Error("You can only delete your own expenses.");
    const path = gone[0].receipt_path as string | null;
    if (path) await supabase.storage.from("expense-receipts").remove([path]);
    return { ok: true };
  });

/** The org's mileage rate. Changes what the NEXT mileage expense is priced at;
 *  every row already logged keeps the rate it was priced at. */
export const setMileageRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ rateCents: z.number().positive().lt(1000) }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    // numeric(6,2): hundredths of a cent, rounded here so the stored rate is
    // the one the form showed.
    const rateCents = Math.round(data.rateCents * 100) / 100;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("organizations")
      .update({ mileage_rate_cents: rateCents })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { rateCents };
  });
