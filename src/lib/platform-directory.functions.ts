import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

async function audit(
  supabaseAdmin: any,
  actor_user_id: string,
  organization_id: string | null,
  action: string,
  before_json: any,
  after_json: any,
) {
  try {
    await supabaseAdmin.from("platform_admin_audit").insert({
      actor_user_id, organization_id, action, before_json, after_json,
    });
  } catch { /* audit best-effort */ }
}

// ─────────── Announcements ───────────

export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience: string;
  starts_at: string | null;
  ends_at: string | null;
  send_email: boolean;
  email_sent_at: string | null;
  created_by: string | null;
  created_at: string;
};

export const listAnnouncements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("platform_announcements")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as AnnouncementRow[] };
  });

const createAnnouncementSchema = z.object({
  title: z.string().min(2).max(200),
  body: z.string().min(2).max(5000),
  severity: z.enum(["info", "success", "warning", "critical"]).default("info"),
  audience: z.enum(["all", "active", "trialing", "past_due", "admins"]).default("all"),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  send_email: z.boolean().default(false),
});

export const createAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createAnnouncementSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("platform_announcements")
      .insert({
        title: data.title,
        body: data.body,
        severity: data.severity,
        audience: data.audience,
        starts_at: data.starts_at ?? undefined,
        ends_at: data.ends_at ?? undefined,
        send_email: data.send_email,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "create_announcement",
        after_json: { id: row.id, title: data.title, audience: data.audience, severity: data.severity },
      });
    } catch {}
    return { id: row.id };
  });

// The caller `/hooks/announcement-emails` never had.
//
// An announcement created with "Also send email" on was emailed to nobody,
// because the only thing that sends is a cron endpoint no scheduler targets.
// Rather than schedule platform-wide outbound mail — the owner's call, not a
// cleanup task — a platform admin sends each announcement deliberately. Same
// code path a future scheduler would use, and the per-recipient idempotency key
// means having both is safe.
export const sendAnnouncementEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { sendPendingAnnouncementEmails } = await import("@/lib/announcement-emails.server");
    const result = await sendPendingAnnouncementEmails(data.id);

    // Audited like every other platform action that reaches outside the
    // product. Sending mail to every tenant is not something that should be
    // reconstructable only from the email log.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "send_announcement_emails",
        after_json: result as any,
      });
    } catch {
      /* the mail is already queued; an audit failure must not look like a
         send failure and prompt someone to press it again */
    }

    // `sent` distinguishes "nothing was due" from "we mailed nobody", which
    // are different problems and were previously the same silence.
    const first = result.summary[0];
    return {
      ok: true as const,
      found: result.processed,
      recipients: first?.recipients ?? 0,
      enqueued: first?.enqueued ?? 0,
      skipped: first?.skipped ?? null,
    };
  });

export const deleteAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("platform_announcements").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "delete_announcement",
        before_json: { id: data.id },
      });
    } catch {}
    return { ok: true };
  });

// ─────────── Global user directory ───────────
//
// ── WHAT THE DATA LAYER ACTUALLY PERMITS ──────────────────────────────────
//
// There is no email anywhere in `public`. `user_roles` holds (user_id,
// organization_id, role) and nothing else; there is no profiles table, no
// members view, no copy of `auth.users` we are allowed to join to. The only
// way this app can turn a user id into an email address is the auth admin
// API, and that API offers exactly two shapes:
//
//   getUserById(id)                  one account, one HTTP round trip
//   listUsers({ page, perPage })     a page of accounts, no filter argument
//
// `PageParams` in @supabase/auth-js is `{ page?, perPage? }`. There is no
// `filter`, no `email=eq.…`, no ordering. So "search the directory by email
// in the database" is not reachable from here at all, and anything that
// claims to is filtering a set it has already fetched.
//
// That is exactly what the previous version did, and why a person past the
// cap could not be found: it read `user_roles`, sliced the first `limit` user
// ids, spent one `getUserById` per id, and THEN applied `search` to the rows
// it happened to have. `organization_id` and `role` filtered before the slice
// so they could reach the whole directory; `search` could only ever narrow
// the first 150 rows, and user 151 did not exist as far as the console was
// concerned.
//
// ── SO THE CAP MOVED OFF THE POPULATION AND ONTO THE PAGE ─────────────────
//
// The directory is now assembled in full before anything is narrowed:
//
//   1. every `user_roles` row matching the org/role filters, read in chunks
//      of 1000 with `.range()` (the old `.limit(2000)` was a silent cap of
//      its own — 2000 role rows, no message, no way to know you had hit it);
//   2. every auth account, read with `listUsers` a page at a time, so email
//      costs one round trip per THOUSAND users instead of one per user. For
//      any directory bigger than a page this is cheaper than the old code was
//      for a single screenful, which is what makes the full scan affordable;
//   3. search and sort over that whole set, and only then slice one page.
//
// Search runs before the slice and over the complete population, so it can
// reach anybody in the directory. Paging walks whatever the search left.
//
// ── WHAT IT DOES NOT COVER, AND SAYS SO ───────────────────────────────────
//
// Both scans have ceilings, because an unbounded loop against a paginated API
// is its own outage. When a ceiling is hit the answer is incomplete, and the
// response says which scan ran short and how far it got — `scan` is returned
// on every call and the screen renders it. A capped result that looks like a
// complete one is the fault this whole change is about; it would be a poor
// trade to close it at the top and reopen it at the bottom.
//
// The population is still "users with an organization membership", unchanged.
// Accounts with no `user_roles` row at all — abandoned signups, platform
// admins — were invisible here before and still are. That is a different hole
// with a different answer (it changes what the page MEANS, not how much of it
// you can see) and it is not this change.

export type PlatformUserRow = {
  user_id: string;
  email: string | null;
  last_sign_in_at: string | null;
  created_at: string | null;
  organizations: Array<{ id: string; name: string; role: string }>;
};

/** How much of the directory each scan actually managed to read. */
export type DirectoryScan = {
  /** `user_roles` rows read. */
  membershipRows: number;
  /** False when the membership scan hit its ceiling — rows exist that we did not read. */
  membershipsComplete: boolean;
  /** Auth accounts read (whole-directory scan plus any per-user fallbacks). */
  accounts: number;
  /** False when we could not resolve an email for every member of the directory. */
  accountsComplete: boolean;
};

export type PlatformUsersPage = {
  rows: PlatformUserRow[];
  /** Users matching the current filters and search across the WHOLE directory, not this page. */
  total: number;
  /** The offset actually used — clamped, so it is never past the end of `total`. */
  offset: number;
  limit: number;
  scan: DirectoryScan;
};

// PostgREST's own default ceiling is 1000 rows per request; asking for more in
// one call just gets silently trimmed, which is the thing we are here to stop.
const MEMBERSHIP_CHUNK = 1000;
const MAX_MEMBERSHIP_ROWS = 100_000;
// GoTrue's admin list endpoint tops out at 1000 per page in a default install.
const ACCOUNT_PAGE_SIZE = 1000;
const MAX_ACCOUNT_PAGES = 50;
// Above this many members we keep paging the account list; below it, one
// getUserById per unresolved member is the cheaper of the two.
const MAX_DIRECT_LOOKUPS = 2000;
const LOOKUP_CONCURRENCY = 20;

type MembershipRow = { user_id: string; role: string; organization_id: string | null };

/**
 * Every `user_roles` row matching the org/role filters, in chunks, in a stable
 * order. `.range()` needs a total order or two chunks can overlap and drop a
 * row between them, so it orders by (user_id, id) — `id` is the primary key,
 * which makes the order total whatever else collides.
 */
async function loadMemberships(
  supabaseAdmin: any,
  filters: { organization_id?: string; role?: string },
): Promise<{ rows: MembershipRow[]; complete: boolean }> {
  const rows: MembershipRow[] = [];
  for (let from = 0; from < MAX_MEMBERSHIP_ROWS; from += MEMBERSHIP_CHUNK) {
    let q = supabaseAdmin
      .from("user_roles")
      .select("id, user_id, role, organization_id")
      .order("user_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + MEMBERSHIP_CHUNK - 1);
    if (filters.organization_id) q = q.eq("organization_id", filters.organization_id);
    if (filters.role) q = q.eq("role", filters.role);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as MembershipRow[];
    rows.push(...batch);
    if (batch.length < MEMBERSHIP_CHUNK) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/** Organization names for the ids we actually have, in `.in()`-sized batches. */
async function loadOrgNames(supabaseAdmin: any, orgIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const slice = orgIds.slice(i, i + 200);
    if (!slice.length) break;
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("id, name")
      .in("id", slice);
    if (error) throw new Error(error.message);
    for (const o of (data ?? []) as Array<{ id: string; name: string }>) names.set(o.id, o.name);
  }
  return names;
}

export type AccountInfo = {
  email: string | null;
  last_sign_in_at: string | null;
  created_at: string | null;
};

const accountInfo = (u: any): AccountInfo => ({
  email: u.email ?? null,
  last_sign_in_at: u.last_sign_in_at ?? null,
  created_at: u.created_at ?? null,
});

/**
 * Emails, sign-in and creation times for every member of the directory.
 *
 * Strategy is decided by one probe page rather than guessed. If the whole auth
 * user table fits in a page we already have everything after one round trip.
 * If it does not, a directory small enough to look up member by member is
 * cheaper that way than paging past accounts we have no interest in; a bigger
 * one keeps paging. `complete` is false only if we finish still missing an
 * email for somebody the caller is going to be shown.
 *
 * Exported because that last sentence is the whole no-silent-caps promise, and
 * a promise about a loop with two ceilings in it should be exercised rather
 * than described.
 */
export async function loadAccounts(
  supabaseAdmin: any,
  memberIds: string[],
): Promise<{ byId: Map<string, AccountInfo>; accounts: number; complete: boolean }> {
  const byId = new Map<string, AccountInfo>();
  let scannedPages = 0;
  let exhausted = false;

  const readPage = async (page: number) => {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: ACCOUNT_PAGE_SIZE,
    });
    if (error) throw new Error(error.message);
    const users = (data?.users ?? []) as any[];
    for (const u of users) byId.set(u.id, accountInfo(u));
    scannedPages += 1;
    return users.length;
  };

  const firstPage = await readPage(1);
  exhausted = firstPage < ACCOUNT_PAGE_SIZE;

  const stillMissing = () => memberIds.filter((id) => !byId.has(id));

  if (!exhausted && memberIds.length > MAX_DIRECT_LOOKUPS) {
    while (!exhausted && scannedPages < MAX_ACCOUNT_PAGES) {
      const n = await readPage(scannedPages + 1);
      exhausted = n < ACCOUNT_PAGE_SIZE;
    }
  }

  let missing = stillMissing();
  if (missing.length && missing.length <= MAX_DIRECT_LOOKUPS) {
    for (let i = 0; i < missing.length; i += LOOKUP_CONCURRENCY) {
      await Promise.all(
        missing.slice(i, i + LOOKUP_CONCURRENCY).map(async (uid) => {
          try {
            const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
            if (u?.user) byId.set(uid, accountInfo(u.user));
          } catch {
            /* one unreadable account must not blank the page; it shows as an id
               and `complete` goes false below, which the screen reports. */
          }
        }),
      );
    }
    missing = stillMissing();
  }

  return { byId, accounts: byId.size, complete: missing.length === 0 };
}

/** Case-insensitive match on email, user id, or any organization name. */
export function matchesDirectorySearch(row: PlatformUserRow, search: string): boolean {
  const s = search.toLowerCase().trim();
  if (!s) return true;
  return (
    (row.email ?? "").toLowerCase().includes(s) ||
    row.user_id.toLowerCase().includes(s) ||
    row.organizations.some((o) => o.name.toLowerCase().includes(s))
  );
}

/** Alphabetical by email, ids last, user id as the tiebreak. */
function compareDirectoryRows(a: PlatformUserRow, b: PlatformUserRow): number {
  const ae = a.email?.toLowerCase() ?? "";
  const be = b.email?.toLowerCase() ?? "";
  if (ae !== be) {
    if (!ae) return 1;
    if (!be) return -1;
    return ae < be ? -1 : 1;
  }
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

/**
 * Narrow, order, then take one page — in that order, which is the whole point.
 *
 * Exported and pure so the ordering can be tested for what it is: searching a
 * directory of four hundred for the four-hundredth person has to find them,
 * and it only does if the filter runs over the whole set and the slice runs
 * last. Doing it the other way round type-checks, reads fine, and is the bug.
 *
 * The offset is clamped to the last page that exists, so narrowing a search
 * while on page nine lands on the last page of the new result rather than on
 * an empty one that looks like "no matches".
 */
export function selectDirectoryPage(
  all: PlatformUserRow[],
  opts: { search?: string | null; offset: number; limit: number },
): { rows: PlatformUserRow[]; total: number; offset: number } {
  const search = opts.search?.trim() ?? "";
  const matched = search ? all.filter((r) => matchesDirectorySearch(r, search)) : all.slice();
  matched.sort(compareDirectoryRows);

  const limit = Math.max(1, opts.limit);
  const total = matched.length;
  const lastPageStart = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
  const offset = Math.min(Math.max(0, opts.offset), lastPageStart);

  return { rows: matched.slice(offset, offset + limit), total, offset };
}

const listUsersSchema = z.object({
  search: z.string().max(200).optional(),
  role: z.enum(["owner", "office_manager", "dispatcher", "tech"]).optional(),
  organization_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const listPlatformUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => listUsersSchema.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<PlatformUsersPage> => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // org/role filter in the query, so they narrow the population itself.
    const memberships = await loadMemberships(supabaseAdmin, {
      organization_id: data.organization_id,
      role: data.role,
    });

    const memberIds = Array.from(new Set(memberships.rows.map((r) => r.user_id)));
    const orgIds = Array.from(
      new Set(memberships.rows.map((r) => r.organization_id).filter(Boolean)),
    ) as string[];

    const [orgName, accounts] = await Promise.all([
      loadOrgNames(supabaseAdmin, orgIds),
      memberIds.length
        ? loadAccounts(supabaseAdmin, memberIds)
        : Promise.resolve({ byId: new Map<string, AccountInfo>(), accounts: 0, complete: true }),
    ]);

    const orgsByUser = new Map<string, PlatformUserRow["organizations"]>();
    for (const r of memberships.rows) {
      const list = orgsByUser.get(r.user_id) ?? [];
      if (r.organization_id) {
        list.push({
          id: r.organization_id,
          name: orgName.get(r.organization_id) ?? "-",
          role: r.role,
        });
      }
      orgsByUser.set(r.user_id, list);
    }

    const all: PlatformUserRow[] = memberIds.map((uid) => {
      const info = accounts.byId.get(uid);
      return {
        user_id: uid,
        email: info?.email ?? null,
        last_sign_in_at: info?.last_sign_in_at ?? null,
        created_at: info?.created_at ?? null,
        organizations: orgsByUser.get(uid) ?? [],
      };
    });

    const page = selectDirectoryPage(all, {
      search: data.search,
      offset: data.offset,
      limit: data.limit,
    });

    return {
      rows: page.rows,
      total: page.total,
      offset: page.offset,
      limit: data.limit,
      scan: {
        membershipRows: memberships.rows.length,
        membershipsComplete: memberships.complete,
        accounts: accounts.accounts,
        accountsComplete: accounts.complete,
      },
    };
  });

// ─────────── User detail + auth admin actions ───────────
// All platform-admin gated, audit-logged, and executed with
// supabaseAdmin.auth.admin.* (service role) — never the caller's session.

const userIdSchema = z.object({ userId: z.string().uuid() });

export type PlatformUserDetail = {
  user_id: string;
  email: string | null;
  phone: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  organizations: Array<{ id: string; name: string; role: string }>;
  mfa_factors: Array<{
    id: string;
    factor_type: string;
    friendly_name: string | null;
    status: string;
    created_at: string | null;
  }>;
};

export const getPlatformUserDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => userIdSchema.parse(d))
  .handler(async ({ data, context }): Promise<PlatformUserDetail> => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: userRes, error: userErr }, factorsRes, rolesRes] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(data.userId),
      supabaseAdmin.auth.admin.mfa.listFactors({ userId: data.userId }),
      supabaseAdmin.from("user_roles").select("organization_id, role").eq("user_id", data.userId),
    ]);
    if (userErr) throw new Error(userErr.message);
    const user = userRes.user;
    if (!user) throw new Error("User not found");

    const orgIds = Array.from(
      new Set((rolesRes.data ?? []).map((r) => r.organization_id).filter(Boolean)),
    ) as string[];
    const { data: orgs } = orgIds.length
      ? await supabaseAdmin.from("organizations").select("id, name").in("id", orgIds)
      : { data: [] as { id: string; name: string }[] };
    const orgName = new Map((orgs ?? []).map((o) => [o.id, o.name] as const));

    return {
      user_id: user.id,
      email: user.email ?? null,
      phone: user.phone || null,
      created_at: user.created_at ?? null,
      last_sign_in_at: user.last_sign_in_at ?? null,
      email_confirmed_at: user.email_confirmed_at ?? null,
      organizations: (rolesRes.data ?? [])
        .filter((r) => r.organization_id)
        .map((r) => ({
          id: r.organization_id as string,
          name: orgName.get(r.organization_id as string) ?? "-",
          role: r.role,
        })),
      mfa_factors: (factorsRes.data?.factors ?? []).map((f: any) => ({
        id: f.id,
        factor_type: f.factor_type,
        friendly_name: f.friendly_name ?? null,
        status: f.status,
        created_at: f.created_at ?? null,
      })),
    };
  });

/**
 * Generates a Supabase recovery link for the user and emails it via Resend
 * (the same direct-send pattern the concerns reply / invite emails use).
 * If email isn't configured, the link is returned so the admin can hand it
 * to the user out of band (the UI shows a copy button + a warning).
 */
export const sendPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => userIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: userRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (userErr) throw new Error(userErr.message);
    const email = userRes.user?.email;
    if (!email) throw new Error("This user has no email on file.");

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
    });
    if (linkErr) throw new Error(linkErr.message);
    const actionLink = linkData.properties?.action_link;
    if (!actionLink) throw new Error("Failed to generate a recovery link.");

    let delivered = false;
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "HoundStack <noreply@notify.houndstack.com>",
          to: [email],
          subject: "Reset your HoundStack password",
          html:
            `<p>A password reset was requested for your HoundStack account by platform support.</p>` +
            `<p><a href="${actionLink}">Click here to set a new password</a>. The link expires shortly and can only be used once.</p>` +
            `<p>If you didn't expect this, you can ignore this email — your password is unchanged.</p>`,
          text: `A password reset was requested for your HoundStack account by platform support. Set a new password here: ${actionLink}\n\nIf you didn't expect this, ignore this email.`,
        }),
      });
      if (!res.ok) {
        const b = await res.text().catch(() => "");
        throw new Error(`Couldn't send the reset email${b ? `: ${b.slice(0, 140)}` : ""}`);
      }
      delivered = true;
    }

    await audit(supabaseAdmin, context.userId, null, "send_password_reset", null, {
      target_user_id: data.userId,
      email,
      delivered_via: delivered ? "email" : "link_returned_to_admin",
    });

    // Only expose the raw link when there's no way to deliver it directly.
    return delivered
      ? { sent: true as const, email }
      : { sent: false as const, email, actionLink };
  });

const updateEmailSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().trim().email().max(254),
});

export const updatePlatformUserEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateEmailSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: beforeRes, error: beforeErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (beforeErr) throw new Error(beforeErr.message);
    if (!beforeRes.user) throw new Error("User not found");
    const oldEmail = beforeRes.user.email ?? null;

    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      email: data.email,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);

    await audit(
      supabaseAdmin,
      context.userId,
      null,
      "update_user_email",
      { target_user_id: data.userId, email: oldEmail },
      { target_user_id: data.userId, email: data.email },
    );
    return { ok: true };
  });

const updatePhoneSchema = z.object({
  userId: z.string().uuid(),
  // E.164-ish: "+" then 7-15 digits. null clears the phone.
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +15555550123")
    .nullable(),
});

export const updatePlatformUserPhone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updatePhoneSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: beforeRes, error: beforeErr } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (beforeErr) throw new Error(beforeErr.message);
    if (!beforeRes.user) throw new Error("User not found");
    const oldPhone = beforeRes.user.phone || null;

    // GoTrue clears the phone when given an empty string.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      phone: data.phone ?? "",
    });
    if (error) throw new Error(error.message);

    await audit(
      supabaseAdmin,
      context.userId,
      null,
      "update_user_phone",
      { target_user_id: data.userId, phone: oldPhone },
      { target_user_id: data.userId, phone: data.phone },
    );
    return { ok: true };
  });

export const removePlatformUserMfa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => userIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: factorsData, error: listErr } = await supabaseAdmin.auth.admin.mfa.listFactors({
      userId: data.userId,
    });
    if (listErr) throw new Error(listErr.message);
    const factors = factorsData?.factors ?? [];

    // Attempt every factor even if one fails, then audit what ACTUALLY
    // happened — throwing mid-loop would leave MFA half-removed with no
    // audit record at all.
    let removed = 0;
    const failures: string[] = [];
    for (const f of factors) {
      const { error } = await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: f.id,
        userId: data.userId,
      });
      if (error) failures.push(error.message);
      else removed++;
    }

    await audit(
      supabaseAdmin,
      context.userId,
      null,
      "remove_user_mfa",
      { target_user_id: data.userId, factor_count: factors.length },
      { target_user_id: data.userId, factor_count: factors.length - removed, removed, failures },
    );
    if (failures.length) {
      throw new Error(
        `Removed ${removed} of ${factors.length} factors; ${failures.length} failed: ${failures[0]}`,
      );
    }
    return { ok: true, removed };
  });
