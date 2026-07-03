import { createFileRoute } from "@tanstack/react-router";
import { randomBytes } from "crypto";

async function handle(request: Request) {
  const token = request.headers.get("x-bootstrap-token");
  const expected = process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN;
  if (!expected || !token || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email) return new Response("email required", { status: 400 });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Idempotent guard: refuse if a platform_admin already exists
  const { count } = await supabaseAdmin
    .from("user_roles")
    .select("id", { head: true, count: "exact" })
    .eq("role", "platform_admin");
  if ((count ?? 0) > 0) {
    return new Response(JSON.stringify({ error: "platform_admin already exists" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }

  // Pick any org to attach to (platform admins are global; org is bookkeeping)
  const { data: org, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (orgErr || !org) {
    return new Response(JSON.stringify({ error: "no organization exists yet" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Generate a strong human-typable temp password
  const tempPassword =
    randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12) + "!A9";

  // Create-or-fetch user
  let userId: string | null = null;
  const created = await supabaseAdmin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { must_change_password: true, full_name: "Platform Admin" },
  });
  if (created.error) {
    // Maybe already exists — look them up and reset their password
    const listed = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const found = listed.data?.users?.find((u) => u.email?.toLowerCase() === email);
    if (!found) {
      return new Response(JSON.stringify({ error: created.error.message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    userId = found.id;
    const upd = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: tempPassword,
      email_confirm: true,
      user_metadata: { must_change_password: true, full_name: "Platform Admin" },
    });
    if (upd.error) {
      return new Response(JSON.stringify({ error: upd.error.message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  } else {
    userId = created.data.user!.id;
  }

  // Grant platform_admin role
  const { error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .upsert(
      { user_id: userId, role: "platform_admin", organization_id: org.id },
      { onConflict: "user_id,role,organization_id" },
    );
  if (roleErr) {
    return new Response(JSON.stringify({ error: roleErr.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      email,
      temp_password: tempPassword,
      user_id: userId,
      organization: org,
      note: "Sign in, then change the password immediately in Settings.",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export const Route = createFileRoute("/api/public/hooks/bootstrap-admin")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
