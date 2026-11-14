// The automatic deletion of a locked account's data (owner, 2026-10-09; spec
// NP-12). SHIPS DISABLED.
//
// ── HOW IT IS SWITCHED ON ─────────────────────────────────────────────────
//
// Two constants below, in one commit, after the owner has read a production
// dry run (the nightly run reports one every night while this is off, under
// `account_deletion` in its JSON, and platform admins can ask for one with
// previewAccountDeletion):
//
//   ACCOUNT_DELETION_ENABLED     = true
//   ACCOUNT_DELETION_DEPLOYED_ON = "<the day the lock reached production>"
//
// With either one unset the job only counts. It also refuses inside the
// database: purge_locked_account will not delete without a deploy date, or
// before an account's own delete_after.
//
// NEVER DELETED: an account created before TRIAL_ENFORCEMENT_FROM
// (2026-08-16). The app never locks one, and the owner's rule (2026-10-10) is
// that it keeps full access after its plan ends and is never a candidate. The
// database holds that date once, in trial_enforcement_from(); the candidate
// list excludes such an account and the purge refuses it on the row itself.
//
// ── WHEN ──────────────────────────────────────────────────────────────────
//
//   delete_after = max(locked since, ACCOUNT_DELETION_DEPLOYED_ON) + 30 days
//
// so an account already locked or cancelled before the deploy gets a full 30
// days from it, and nothing is deleted on deploy day. Choosing a plan before
// then takes the account off the list, because the list is recomputed from the
// account's live state on every run.
//
// ── WHAT ──────────────────────────────────────────────────────────────────
//
// The database half (purge_locked_account, 20261009170000) deletes or
// anonymises rows; its header lists exactly which. This half does what SQL
// cannot: it deletes the account's stored files, and it anonymises and signs
// out each member's sign-in when they belong to no other organization (the
// same treatment as Delete my account, src/lib/delete-account.functions.ts).
// SMS consent records are copied to their own table first and are never
// deleted by this job.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Off until the owner has read a production dry run. */
export const ACCOUNT_DELETION_ENABLED = false;

/**
 * The day (YYYY-MM-DD) the lock and this job reached production. Accounts
 * locked or cancelled before it are deleted no earlier than this + 30 days.
 * Null until set; with it null nothing is deleted.
 */
export const ACCOUNT_DELETION_DEPLOYED_ON: string | null = null;

/** Buckets whose objects live under `<organization id>/…`. directory-photos
 *  (#630, directory v2 step 5b) is here so a deleted business's directory
 *  photos go with it: the rows cascade with the organization, the files do
 *  not. */
export const ORG_STORAGE_BUCKETS = [
  "visit-photos",
  "waste-receipts",
  "dna-samples",
  "expense-receipts",
  "directory-photos",
] as const;

export type DeletionCandidate = {
  organization_id: string;
  reason: "trial_ended" | "plan_ended";
  locked_since: string;
  delete_after: string;
};

export type DeletionReport = {
  enabled: boolean;
  dryRun: boolean;
  /** The deploy date the dates were computed from. In a dry run before the
   *  deploy date is set, "today", i.e. "if it were switched on today". */
  deployedOn: string;
  deployedOnIsHypothetical: boolean;
  accounts: number;
  dueNow: number;
  /** Rows that would be (or were) deleted, summed over every account. */
  recordsToDelete: number;
  /** Rows kept, anonymised or as they are, summed over every account. */
  recordsKept: number;
  earliestDeleteAfter: string | null;
  perAccount: Array<{
    organizationId: string;
    reason: string;
    lockedSince: string;
    deleteAfter: string;
    due: boolean;
    deleted: Record<string, number>;
    kept: Record<string, number>;
    files?: number;
    identities?: number;
    error?: string;
  }>;
};

function sum(o: Record<string, number> | null | undefined): number {
  return Object.values(o ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** Every object under `<prefix>/` in a bucket, depth first. */
async function listAll(
  storage: SupabaseClient["storage"],
  bucket: string,
  prefix: string,
  out: string[] = [],
): Promise<string[]> {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await storage.from(bucket).list(prefix, { limit: 1000, offset });
    // A bucket a migration has not created yet (directory-photos is created by
    // 20261112110000, applied after the code ships) holds no files to delete.
    if (error && /bucket not found/i.test(error.message)) return out;
    if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
    for (const item of data ?? []) {
      const path = `${prefix}/${item.name}`;
      // Folders come back with no id.
      if (item.id == null) await listAll(storage, bucket, path, out);
      else out.push(path);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function deleteOrgFiles(admin: SupabaseClient, orgId: string): Promise<number> {
  let removed = 0;
  for (const bucket of ORG_STORAGE_BUCKETS) {
    const paths = await listAll(admin.storage, bucket, orgId);
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (error) throw new Error(`${bucket}: ${error.message}`);
      removed += Math.min(100, paths.length - i);
    }
  }
  return removed;
}

/** Members who will have no organization left once this one is purged. */
async function membersOnlyHere(admin: SupabaseClient, orgId: string): Promise<string[]> {
  const { data: here } = await admin
    .from("user_roles")
    .select("user_id")
    .eq("organization_id", orgId);
  const ids = [...new Set(((here ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))];
  const only: string[] = [];
  for (const id of ids) {
    const { data: all } = await admin
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", id);
    if (
      ((all ?? []) as Array<{ organization_id: string }>).every((r) => r.organization_id === orgId)
    )
      only.push(id);
  }
  return only;
}

async function anonymiseIdentities(admin: SupabaseClient, userIds: string[]): Promise<number> {
  let n = 0;
  for (const id of userIds) {
    await admin.auth.admin.updateUserById(id, {
      email: `deleted-${id}@deleted.invalid`,
      // null clears the number; the SDK's type only admits a string.
      phone: null as unknown as string,
      user_metadata: {},
      app_metadata: { deleted_at: new Date().toISOString(), deleted_by: "account_deletion_job" },
    });
    await admin.auth.admin.signOut(id, "global").catch(() => undefined);
    n += 1;
  }
  return n;
}

export async function runAccountDeletion(
  opts: {
    now?: Date;
    /** Count only, whatever the switches say (the platform preview). */
    forceDryRun?: boolean;
    admin?: SupabaseClient;
    enabled?: boolean;
    deployedOn?: string | null;
  } = {},
): Promise<DeletionReport> {
  const now = opts.now ?? new Date();
  const enabled = opts.enabled ?? ACCOUNT_DELETION_ENABLED;
  const configured = opts.deployedOn !== undefined ? opts.deployedOn : ACCOUNT_DELETION_DEPLOYED_ON;
  const dryRun = !!opts.forceDryRun || !enabled || !configured;
  const deployedOn = configured ?? now.toISOString().slice(0, 10);
  const admin =
    opts.admin ??
    ((await import("@/integrations/supabase/client.server"))
      .supabaseAdmin as unknown as SupabaseClient);

  const { data: rows, error } = await admin.rpc("account_deletion_candidates", {
    _deployed_on: deployedOn,
    _now: now.toISOString(),
  });
  if (error) throw new Error(`account_deletion_candidates: ${error.message}`);
  const candidates = (rows ?? []) as DeletionCandidate[];

  const report: DeletionReport = {
    enabled,
    dryRun,
    deployedOn,
    deployedOnIsHypothetical: !configured,
    accounts: candidates.length,
    dueNow: 0,
    recordsToDelete: 0,
    recordsKept: 0,
    earliestDeleteAfter: null,
    perAccount: [],
  };

  if (!dryRun) {
    // Keep the schedule: first sight of each account, so a cancellation with
    // no end date on file is dated from when the job first saw it. Accounts
    // that chose a plan are taken off it.
    for (const c of candidates) {
      await admin.from("account_deletion_schedule").upsert(
        {
          organization_id: c.organization_id,
          reason: c.reason,
          locked_since: c.locked_since,
          delete_after: c.delete_after,
          last_seen_at: now.toISOString(),
        },
        { onConflict: "organization_id" },
      );
    }
    const ids = new Set(candidates.map((c) => c.organization_id));
    const { data: scheduled } = await admin
      .from("account_deletion_schedule")
      .select("organization_id")
      .is("purged_at", null);
    for (const s of (scheduled ?? []) as Array<{ organization_id: string }>) {
      if (!ids.has(s.organization_id)) {
        await admin
          .from("account_deletion_schedule")
          .delete()
          .eq("organization_id", s.organization_id);
      }
    }
  }

  for (const c of candidates) {
    const due = Date.parse(c.delete_after) <= now.getTime();
    if (due) report.dueNow += 1;
    if (!report.earliestDeleteAfter || c.delete_after < report.earliestDeleteAfter) {
      report.earliestDeleteAfter = c.delete_after;
    }
    const entry: DeletionReport["perAccount"][number] = {
      organizationId: c.organization_id,
      reason: c.reason,
      lockedSince: c.locked_since,
      deleteAfter: c.delete_after,
      due,
      deleted: {},
      kept: {},
    };
    try {
      const real = !dryRun && due;
      if (real) {
        // Ask the database first, as a dry run: purge_locked_account refuses an
        // account it must never delete (created before the grandfather date,
        // not a candidate, not due). The files go before the real purge, so
        // without this a refusal would come after they were already gone.
        const { error: checkErr } = await admin.rpc("purge_locked_account", {
          _org: c.organization_id,
          _dry_run: true,
          _deployed_on: deployedOn,
          _now: now.toISOString(),
        });
        if (checkErr) throw new Error(checkErr.message);
        // Files and sign-ins next: the rows that say where they are and who
        // they belong to are what the purge removes.
        entry.files = await deleteOrgFiles(admin, c.organization_id);
        const people = await membersOnlyHere(admin, c.organization_id);
        const { data: result, error: pErr } = await admin.rpc("purge_locked_account", {
          _org: c.organization_id,
          _dry_run: false,
          _deployed_on: deployedOn,
          _now: now.toISOString(),
        });
        if (pErr) throw new Error(pErr.message);
        entry.deleted = result?.delete ?? {};
        entry.kept = result?.keep ?? {};
        entry.identities = await anonymiseIdentities(admin, people);
      } else {
        const { data: result, error: pErr } = await admin.rpc("purge_locked_account", {
          _org: c.organization_id,
          _dry_run: true,
          _deployed_on: deployedOn,
          _now: now.toISOString(),
        });
        if (pErr) throw new Error(pErr.message);
        entry.deleted = result?.delete ?? {};
        entry.kept = result?.keep ?? {};
      }
    } catch (e) {
      entry.error = (e as Error).message;
    }
    report.recordsToDelete += sum(entry.deleted);
    report.recordsKept += sum(entry.kept);
    report.perAccount.push(entry);
  }
  return report;
}
