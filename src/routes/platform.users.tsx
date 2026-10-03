import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listPlatformUsers,
  getPlatformUserDetail,
  sendPasswordReset,
  updatePlatformUserEmail,
  updatePlatformUserPhone,
  removePlatformUserMfa,
} from "@/lib/platform-directory.functions";
import { startImpersonation } from "@/lib/platform.functions";
import { launchImpersonationTab } from "@/lib/impersonation-launch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useRowSelection } from "@/hooks/useRowSelection";
import { humanizeRole } from "@/lib/humanize";
import {
  ChevronLeft, ChevronRight, Copy, KeyRound, Loader2, ShieldOff, UserCog, Users,
} from "lucide-react";
import { humanizeEnum } from "@/lib/humanize";
import { formatDateTime, formatDay } from "@/lib/format";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/platform/users")({
  head: () => titleHead("Users", "Platform admin"),
  component: UsersPage,
});

// One page of the directory. The server will not return more than 200 in a
// single call; 50 is a screenful you can actually read and keeps each page's
// email hydration small.
const PAGE_SIZE = 50;

function UsersPage() {
  // `searchInput` is what is being typed; `search` is what has been asked for.
  // They are separate because a committed search is a full-directory scan on
  // the server, which is not something to do once per keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // A different search or role is a different result set; page 9 of the old
  // one is not a position in the new one.
  useEffect(() => {
    setPage(0);
  }, [search, role]);

  const listFn = useServerFn(listPlatformUsers);
  const q = useQuery({
    queryKey: ["platform", "users", role, search, page],
    queryFn: () =>
      listFn({
        data: {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          // Searching is now the server's job over the whole directory, not a
          // filter this page applies to the rows it was already given. That
          // distinction is the entire fix: the old screen fetched 150 users
          // and searched those, so user 151 could not be found by anybody.
          ...(search ? { search } : {}),
          ...(role !== "all" ? { role: role as any } : {}),
        },
      }),
    // Paging without this blanks the table on every press.
    placeholderData: keepPreviousData,
  });

  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const limit = q.data?.limit ?? PAGE_SIZE;
  // The server clamps the offset to the last page that exists, so a narrowing
  // search cannot strand you on an empty page that reads as "no matches".
  const offset = q.data?.offset ?? page * PAGE_SIZE;
  const scan = q.data?.scan;
  const currentPage = Math.floor(offset / limit);
  const pageCount = Math.max(1, Math.ceil(total / limit));

  // Re-sync only against a FRESH answer. While `keepPreviousData` is holding
  // the last page on screen, `q.data.offset` still describes the page you just
  // left — acting on it here would push you straight back to it and the Next
  // button would appear not to work.
  useEffect(() => {
    if (q.data && !q.isPlaceholderData && currentPage !== page) setPage(currentPage);
  }, [q.data, q.isPlaceholderData, currentPage, page]);

  const firstShown = total === 0 ? 0 : offset + 1;
  const lastShown = Math.min(offset + rows.length, total);
  const narrowed = !!search || role !== "all";

  const qc = useQueryClient();
  const { confirm, dialog: bulkDialog } = useConfirmDialog();
  const resetFn = useServerFn(sendPasswordReset);
  const selectableIds = useMemo(
    () => rows.filter((r) => !!r.email).map((r) => r.user_id),
    [rows],
  );
  // Selection is per page: turning the page is as much a change of what is in
  // front of you as changing the filter is.
  const sel = useRowSelection(selectableIds, `${search}|${role}|${page}`);

  const bulkResetM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((userId) => resetFn({ data: { userId } })),
      );
      let sent = 0;
      let linkOnly = 0;
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        if ((r.value as any)?.sent) sent += 1;
        else linkOnly += 1;
      }
      const ok = sent + linkOnly;
      return { ok, sent, linkOnly, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Sent ${r.ok} of ${r.ok + r.failed} password resets — ${r.failed} failed`);
      else toast.success(`Sent ${r.ok} password reset${r.ok === 1 ? "" : "s"}`);
      if (r.linkOnly) {
        // Bulk deliberately never surfaces raw recovery links; without email
        // configured the reset must go through the per-user dialog.
        toast.info(
          `Email isn't configured for ${r.linkOnly} reset${r.linkOnly === 1 ? "" : "s"} — open the user's detail dialog to copy the link securely.`,
          { duration: 8000 },
        );
      }
      sel.clear();
      qc.invalidateQueries({ queryKey: ["platform", "users"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Global directory across every tenant. Search runs over the whole directory, not the page
          in front of you. Click a row for details and account actions.
        </p>
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-base">Directory</CardTitle>
            <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search email, user id or org…"
                aria-label="Search the whole user directory"
                className="w-full sm:w-64"
              />
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                  <SelectItem value="office_manager">Office manager</SelectItem>
                  <SelectItem value="dispatcher">Dispatcher</SelectItem>
                  <SelectItem value="tech">Tech</SelectItem>

                </SelectContent>
              </Select>
            </div>
          </div>
          {/* The count is stated on every render, not only when something is
              cut off. "150 rows" and "the first 150 of 1,240 rows" looked
              identical before, and one of them was a lie. */}
          <p className="text-sm text-muted-foreground" data-testid="directory-range">
            {q.isLoading
              ? "Loading the directory…"
              : total === 0
                ? narrowed
                  ? "No users match."
                  : "No users in the directory yet."
                : `Showing ${firstShown.toLocaleString()}–${lastShown.toLocaleString()} of ${total.toLocaleString()} ${narrowed ? "matching " : ""}user${total === 1 ? "" : "s"} with an organization membership.`}
          </p>
          {/* The population here is memberships, not accounts. Saying "12 users"
              beside a database holding 22 of them reads as a census, and the ten
              it leaves out are exactly the ones somebody would come here looking
              for: an abandoned signup, or a platform admin, who holds zero
              user_roles rows by design and is therefore invisible on this page.
              Rendered only when the number is knowable — `unattached` is null
              under a filter or a short scan, and null means "not answerable",
              not none. */}
          {scan && scan.unattached ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {scan.unattached.toLocaleString()} other account
              {scan.unattached === 1 ? " holds" : "s hold"} no role in any organization —
              abandoned signups and platform admins — so {scan.unattached === 1 ? "it is" : "they are"}{" "}
              not listed here.
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          {/* A scan that ran short says so. Everything on this screen is a
              count of something, and a count nobody can trust is worse than
              no count. */}
          {scan && (!scan.membershipsComplete || !scan.accountsComplete) ? (
            <div
              role="status"
              className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950"
            >
              <p className="font-medium">This directory is incomplete — the numbers below undercount.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {!scan.membershipsComplete ? (
                  <li>
                    Stopped after reading {scan.membershipRows.toLocaleString()} organization
                    memberships. Users past that point are not counted or searched.
                  </li>
                ) : null}
                {!scan.accountsComplete ? (
                  <li>
                    Read {scan.accounts.toLocaleString()} accounts but could not resolve an email
                    for every user shown. Rows without one show a user id, and a search by email
                    will not match them.
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {/* Bulk action bar */}
          {sel.count > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
              <span className="font-medium">{sel.count} selected on this page</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkResetM.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Send ${sel.count} password reset${sel.count === 1 ? "" : "s"}?`,
                        description:
                          "Each selected user gets a password-reset email with a single-use recovery link. Their current password stays valid until they use it.",
                        confirmLabel: "Send resets",
                      })
                    )
                      bulkResetM.mutate(sel.selectedIds);
                  }}
                >
                  <KeyRound className="mr-1 h-4 w-4 shrink-0" />
                  {bulkResetM.isPending ? "Sending…" : "Send password reset"}
                </Button>
                <Button size="sm" variant="ghost" onClick={sel.clear}>
                  Clear
                </Button>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={sel.allSelected}
                      onCheckedChange={sel.toggleAll}
                      aria-label="Select every user on this page that has an email"
                    />
                  </TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Organizations & role</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => (
                  <TableRow
                    key={u.user_id}
                    className="cursor-pointer"
                    onClick={() => setSelectedUserId(u.user_id)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {u.email ? (
                        <Checkbox
                          checked={sel.isSelected(u.user_id)}
                          onCheckedChange={(v) => sel.toggle(u.user_id, v === true)}
                          aria-label={`Select ${u.email}`}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="font-medium">
                      {u.email ?? <code className="text-xs">{u.user_id.slice(0, 12)}</code>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {u.organizations.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No org</span>
                        ) : (
                          u.organizations.map((o) => (
                            <Link
                              key={`${o.id}-${o.role}`}
                              to="/platform/tenants/$id"
                              params={{ id: o.id }}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-accent"
                            >
                              <span>{o.name}</span>
                              <Badge variant="outline" className="text-3xs">{humanizeRole(o.role)}</Badge>
                            </Link>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : "-"}</TableCell>
                    <TableCell className="text-sm">{u.created_at ? formatDay(u.created_at) : "-"}</TableCell>
                  </TableRow>
                ))}
                {q.isLoading ? (
                  <TableRow><TableCell colSpan={5}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="py-6">
                    <EmptyState
                      icon={<Users className="h-5 w-5 shrink-0" />}
                      title={narrowed ? "No users match" : "No users yet"}
                      description={
                        narrowed
                          ? "Every tenant was searched, so this is not a paging artefact. Note that this directory lists people who hold a role in an organization: an account with no membership — an abandoned signup, or a platform admin — will not appear however you search. Try a different email, user id or organization name, or clear the role filter."
                          : "Nobody holds a role in any organization yet."
                      }
                    />
                  </TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          {/* ── THE PAGER ────────────────────────────────────────────────────
              Labelled buttons, not bare arrows: `size="sm"` carries the 44px
              touch floor from ui/button.tsx, and the row wraps rather than
              pushing itself off a 360px screen. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {total === 0
                ? "Nothing to page through."
                : `Page ${(currentPage + 1).toLocaleString()} of ${pageCount.toLocaleString()}`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="min-w-28"
                disabled={currentPage <= 0 || q.isFetching}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="mr-1 h-4 w-4 shrink-0" />
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-w-28"
                disabled={currentPage >= pageCount - 1 || q.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4 shrink-0" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {bulkDialog}
      <UserDetailDialog userId={selectedUserId} onClose={() => setSelectedUserId(null)} />
    </div>
  );
}

function UserDetailDialog({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const detailFn = useServerFn(getPlatformUserDetail);
  const resetFn = useServerFn(sendPasswordReset);
  const emailFn = useServerFn(updatePlatformUserEmail);
  const phoneFn = useServerFn(updatePlatformUserPhone);
  const mfaFn = useServerFn(removePlatformUserMfa);
  const impersonateFn = useServerFn(startImpersonation);

  const [emailDraft, setEmailDraft] = useState("");
  const [phoneDraft, setPhoneDraft] = useState("");
  // Which of the user's organizations to impersonate them inside. A user can
  // hold roles in several, and startImpersonation mints a grant for ONE.
  const [impersonateOrg, setImpersonateOrg] = useState("");
  // Set only when email sending isn't configured: the admin must relay it.
  const [resetLink, setResetLink] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["platform", "user-detail", userId],
    queryFn: () => detailFn({ data: { userId: userId! } }),
    enabled: !!userId,
  });
  const d = q.data;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["platform", "user-detail", userId] });
    qc.invalidateQueries({ queryKey: ["platform", "users"] });
  };

  const reset = useMutation({
    mutationFn: () => resetFn({ data: { userId: userId! } }),
    onSuccess: (r) => {
      if (r.sent) {
        toast.success(`Password reset email sent to ${r.email}`);
      } else {
        setResetLink(r.actionLink);
        toast.info("Email isn't configured — copy the reset link and share it securely.");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateEmail = useMutation({
    mutationFn: (email: string) => emailFn({ data: { userId: userId!, email } }),
    onSuccess: () => {
      toast.success("Email updated");
      setEmailDraft("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updatePhone = useMutation({
    mutationFn: (phone: string | null) => phoneFn({ data: { userId: userId!, phone } }),
    onSuccess: (_r, phone) => {
      toast.success(phone ? "Phone updated" : "Phone cleared");
      setPhoneDraft("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMfa = useMutation({
    mutationFn: () => mfaFn({ data: { userId: userId! } }),
    onSuccess: (r) => {
      toast.success(`Removed ${r.removed} MFA factor${r.removed === 1 ? "" : "s"}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * ── WHY IMPERSONATION BELONGS HERE TOO ────────────────────────────────
   *
   * startImpersonation takes (organization_id, target_user_id) and had exactly
   * one caller: the tenant detail page, which can only ever offer one tenant's
   * users, from an unfiltered <select>. This directory is the only place in
   * the console where a person can be found by email across every tenant, and
   * it already holds both ids on every row — so the one action you actually
   * want after finding someone was the one action you had to leave to perform.
   *
   * Nothing about the grant changes: the same server function, the same
   * platform-admin check, the same 2-minute single-use token, the same
   * tab-scoped session, the same audit rows.
   */
  const impersonate = useMutation({
    mutationFn: (organizationId: string) =>
      launchImpersonationTab(impersonateFn as never, {
        organizationId,
        targetUserId: userId!,
      }),
    onSuccess: (res, organizationId) => {
      const org = d?.organizations.find((o) => o.id === organizationId);
      toast.success(
        `Impersonating ${res.targetEmail} in ${org?.name ?? "their organization"} — opened in a new tab`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const close = () => {
    setEmailDraft("");
    setPhoneDraft("");
    setResetLink(null);
    setImpersonateOrg("");
    onClose();
  };

  return (
    <Dialog open={!!userId} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        {dialog}
        <DialogHeader>
          <DialogTitle>User detail</DialogTitle>
        </DialogHeader>
        {q.isLoading || !d ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" /> Loading…
          </div>
        ) : (
          <div className="space-y-5">
            {/* Two columns of email address and timestamp do not fit a 360px
                phone; they stack below `sm` instead of overflowing. */}
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <div className="text-xs text-muted-foreground">Email</div>
                <div className="break-all font-medium">{d.email ?? "-"}</div>
                {/* email_confirmed_at has been fetched since this dialog was
                    written and shown nowhere — and "Change email" confirms the
                    new address immediately, so this is the only place the one
                    email action's effect is visible. */}
                {d.email ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {d.email_confirmed_at
                      ? `Confirmed ${formatDay(d.email_confirmed_at)}`
                      : "Not confirmed"}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Phone</div>
                <div className="font-medium">{d.phone ?? "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Created</div>
                <div>{d.created_at ? formatDateTime(d.created_at) : "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Last sign-in</div>
                <div>{d.last_sign_in_at ? formatDateTime(d.last_sign_in_at) : "Never"}</div>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                Organizations
              </div>
              {d.organizations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No org memberships.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {d.organizations.map((o) => (
                    <Link
                      key={`${o.id}-${o.role}`}
                      to="/platform/tenants/$id"
                      params={{ id: o.id }}
                      className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-accent"
                    >
                      <span>{o.name}</span>
                      <Badge variant="outline" className="text-3xs">{humanizeRole(o.role)}</Badge>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                MFA factors
              </div>
              {d.mfa_factors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No MFA factors enrolled.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {d.mfa_factors.map((f) => (
                    <li key={f.id} className="flex items-center gap-2">
                      <Badge variant="secondary" className="uppercase">{f.factor_type}</Badge>
                      <span>{f.friendly_name ?? "Unnamed factor"}</span>
                      {/* BUG-4: raw MFA factor status enum. */}
                      <span className="text-xs text-muted-foreground">
                        ({humanizeEnum(f.status)})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-3 border-t pt-4">
              <div className="text-xs font-medium uppercase text-muted-foreground">Actions</div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reset.isPending || !d.email}
                  onClick={() => reset.mutate()}
                >
                  <KeyRound className="mr-1 h-4 w-4 shrink-0" />
                  {reset.isPending ? "Sending…" : "Send password reset"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={removeMfa.isPending || d.mfa_factors.length === 0}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Remove all MFA factors?",
                        description:
                          `This deletes ${d.mfa_factors.length} enrolled factor${d.mfa_factors.length === 1 ? "" : "s"} for ${d.email ?? "this user"}. ` +
                          "They'll be able to sign in with just their password until they re-enroll. Only do this after verifying the user's identity.",
                        destructive: true,
                        confirmLabel: "Remove MFA",
                      })
                    ) {
                      removeMfa.mutate();
                    }
                  }}
                >
                  <ShieldOff className="mr-1 h-4 w-4 shrink-0" />
                  {removeMfa.isPending ? "Removing…" : "Remove MFA"}
                </Button>
              </div>

              {d.organizations.length > 0 ? (
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="impersonate-org">
                    Impersonate in
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    <select
                      id="impersonate-org"
                      className="h-11 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:h-9"
                      value={impersonateOrg || d.organizations[0].id}
                      onChange={(e) => setImpersonateOrg(e.target.value)}
                    >
                      {d.organizations.map((o) => (
                        <option key={`${o.id}-${o.role}`} value={o.id}>
                          {o.name} ({humanizeRole(o.role)})
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={impersonate.isPending}
                      onClick={async () => {
                        const orgId = impersonateOrg || d.organizations[0].id;
                        const org = d.organizations.find((o) => o.id === orgId);
                        if (
                          await confirm({
                            title: `Impersonate ${d.email ?? "this user"} in ${org?.name ?? "their organization"}?`,
                            description:
                              `A new tab opens a read/write session AS ${d.email ?? "this user"} inside ${org?.name ?? "that organization"}, with their ${humanizeRole(org?.role).toLowerCase()} permissions. ` +
                              "Your own platform-admin session in this tab is not affected, and everything you do in there is written to the audit trail under your name.",
                            confirmLabel: "Impersonate",
                          })
                        )
                          impersonate.mutate(orgId);
                      }}
                    >
                      <UserCog className="mr-1 h-4 w-4 shrink-0" />
                      {impersonate.isPending ? "Starting…" : "Impersonate"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resetLink ? (
                <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950">
                  <p className="font-medium">
                    Email isn't configured, so the reset link is shown here instead. Share it
                    securely (directly with the verified user only) — anyone with this link can set
                    the account's password.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1">
                      {resetLink}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(resetLink);
                          toast.success("Link copied");
                        } catch {
                          toast.error("Couldn't copy — select the link text manually");
                        }
                      }}
                    >
                      <Copy className="mr-1 h-3 w-3 shrink-0" /> Copy
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <form
                  className="space-y-1.5"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const next = emailDraft.trim();
                    if (!next) return;
                    if (
                      await confirm({
                        title: "Change this user's email?",
                        description:
                          `${d.email ?? "This user"} will sign in as ${next} from now on. ` +
                          "The new address is marked confirmed immediately — verify you have it right.",
                        confirmLabel: "Change email",
                      })
                    ) {
                      updateEmail.mutate(next);
                    }
                  }}
                >
                  <Label className="text-xs">Change email</Label>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      value={emailDraft}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      placeholder={d.email ?? "new@email.com"}
                      className="h-9"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      disabled={updateEmail.isPending || !emailDraft.trim()}
                    >
                      {updateEmail.isPending ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </form>

                <div className="space-y-1.5">
                  <Label className="text-xs">Change phone (E.164)</Label>
                  <div className="flex gap-2">
                    <Input
                      value={phoneDraft}
                      onChange={(e) => setPhoneDraft(e.target.value)}
                      placeholder={d.phone ?? "+15555550123"}
                      className="h-9"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updatePhone.isPending || !phoneDraft.trim()}
                      onClick={() => updatePhone.mutate(phoneDraft.trim())}
                    >
                      {updatePhone.isPending ? "Saving…" : "Save"}
                    </Button>
                    {d.phone ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={updatePhone.isPending}
                        onClick={() => updatePhone.mutate(null)}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
