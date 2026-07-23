import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listPlatformUsers,
  getPlatformUserDetail,
  sendPasswordReset,
  updatePlatformUserEmail,
  updatePlatformUserPhone,
  removePlatformUserMfa,
} from "@/lib/platform-directory.functions";
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
import { Copy, KeyRound, Loader2, ShieldOff, Users } from "lucide-react";

export const Route = createFileRoute("/platform/users")({
  component: UsersPage,
});

function UsersPage() {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<string>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const listFn = useServerFn(listPlatformUsers);
  const q = useQuery({
    queryKey: ["platform", "users", role],
    queryFn: () => listFn({ data: { limit: 150, ...(role !== "all" ? { role: role as any } : {}) } }),
  });

  const rows = q.data?.rows ?? [];
  const filtered = search.trim()
    ? rows.filter((r) => {
        const s = search.toLowerCase();
        return (r.email ?? "").toLowerCase().includes(s) ||
          r.organizations.some((o) => o.name.toLowerCase().includes(s));
      })
    : rows;

  // Multi-select for bulk password resets (Invoices-page pattern). Only rows
  // with an email are selectable — sendPasswordReset requires one. The
  // clearKey drops the selection when the search/role filter changes.
  const qc = useQueryClient();
  const { confirm, dialog: bulkDialog } = useConfirmDialog();
  const resetFn = useServerFn(sendPasswordReset);
  const selectableIds = useMemo(
    () => filtered.filter((r) => !!r.email).map((r) => r.user_id),
    [filtered],
  );
  const sel = useRowSelection(selectableIds, `${search}|${role}`);

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
          Global directory across every tenant. Shows up to 150 users at a time. Click a row for
          details and account actions.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center gap-3">
          <CardTitle className="text-base">Directory</CardTitle>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search email or org…"
              className="w-64"
            />
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
                <SelectItem value="office_manager">Office manager</SelectItem>
                <SelectItem value="dispatcher">Dispatcher</SelectItem>
                <SelectItem value="tech">Tech</SelectItem>

              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {/* Bulk action bar */}
          {sel.count > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
              <span className="font-medium">{sel.count} selected</span>
              <div className="flex gap-2">
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
                  <KeyRound className="mr-1 h-4 w-4" />
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
                      aria-label="Select all users with an email"
                    />
                  </TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Organizations & role</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => (
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
                              <Badge variant="outline" className="text-[10px]">{humanizeRole(o.role)}</Badge>
                            </Link>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "-"}</TableCell>
                    <TableCell className="text-sm">{u.created_at ? new Date(u.created_at).toLocaleDateString() : "-"}</TableCell>
                  </TableRow>
                ))}
                {q.isLoading ? (
                  <TableRow><TableCell colSpan={5}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="py-6">
                    <EmptyState
                      icon={<Users className="h-5 w-5" />}
                      title="No users match"
                      description="Try clearing the search or picking a different role filter."
                    />
                  </TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
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

  const [emailDraft, setEmailDraft] = useState("");
  const [phoneDraft, setPhoneDraft] = useState("");
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

  const close = () => {
    setEmailDraft("");
    setPhoneDraft("");
    setResetLink(null);
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
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Email</div>
                <div className="break-all font-medium">{d.email ?? "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Phone</div>
                <div className="font-medium">{d.phone ?? "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Created</div>
                <div>{d.created_at ? new Date(d.created_at).toLocaleString() : "-"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Last sign-in</div>
                <div>{d.last_sign_in_at ? new Date(d.last_sign_in_at).toLocaleString() : "Never"}</div>
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
                      <Badge variant="outline" className="text-[10px]">{humanizeRole(o.role)}</Badge>
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
                      <span className="text-xs text-muted-foreground">({f.status})</span>
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
                  <KeyRound className="mr-1 h-4 w-4" />
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
                  <ShieldOff className="mr-1 h-4 w-4" />
                  {removeMfa.isPending ? "Removing…" : "Remove MFA"}
                </Button>
              </div>

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
                      <Copy className="mr-1 h-3 w-3" /> Copy
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
