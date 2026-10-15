import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { WebsiteSubmissionForm } from "@/lib/website-submissions";

export type WebsiteSubmissionStatus = "new" | "handled" | "spam";
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type DbError = { message: string };
type DbResult<T> = { data: T | null; error: DbError | null };
type DbQuery<T> = PromiseLike<DbResult<T>> & {
  select(columns: string): DbQuery<T>;
  order(column: string, options: { ascending: boolean }): DbQuery<T>;
  limit(count: number): DbQuery<T>;
  eq(column: string, value: unknown): DbQuery<T>;
  update(value: Record<string, unknown>): DbQuery<T>;
};
type PlatformSupabase = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<DbResult<unknown>>;
};
type UntypedAdmin = {
  from(table: string): DbQuery<unknown>;
};

export interface WebsiteSubmissionRow {
  id: string;
  created_at: string;
  form: WebsiteSubmissionForm;
  name: string;
  email: string;
  business_name: string | null;
  phone: string | null;
  message: string | null;
  payload: Record<string, JsonValue> | null;
  source_page: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  status: WebsiteSubmissionStatus;
  handled_at: string | null;
  handled_by: string | null;
}

async function assertPlatformAdmin(supabase: PlatformSupabase, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

const listSchema = z.object({
  form: z.enum(["contact", "early_access"]).optional(),
  status: z.enum(["new", "handled", "spam"]).optional(),
});

export const listWebsiteSubmissions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => listSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as UntypedAdmin;
    let query = admin
      .from("website_submissions")
      .select(
        "id, created_at, form, name, email, business_name, phone, message, payload, source_page, ip_hash, user_agent, status, handled_at, handled_by",
      )
      .order("created_at", { ascending: false })
      .limit(200);

    if (data.form) query = query.eq("form", data.form);
    if (data.status) query = query.eq("status", data.status);

    const { data: rows, error } = (await query) as DbResult<WebsiteSubmissionRow[]>;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as WebsiteSubmissionRow[] };
  });

const markSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["new", "handled", "spam"]).default("handled"),
});

export const markWebsiteSubmissionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => markSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as UntypedAdmin;
    const patch =
      data.status === "handled"
        ? {
            status: data.status,
            handled_at: new Date().toISOString(),
            handled_by: context.userId,
          }
        : { status: data.status, handled_at: null, handled_by: null };

    const { error } = await admin.from("website_submissions").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "update_website_submission",
        before_json: null,
        after_json: { id: data.id, ...patch },
      });
    } catch {
      // Audit is best effort, matching the rest of the platform console.
    }

    return { ok: true };
  });
