import { appUrl } from "@/lib/app-origin";
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { humanizeRole } from "@/lib/humanize";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listPlatformInvites,
  createPlatformInvite,
  revokePlatformInvite,
  resendPlatformInvite,
  listOrgsMinimal,
  type PlatformInviteRow,
} from "@/lib/platform-onboarding.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Copy, Send, X, Plus, Link2 } from "lucide-react";
import { toast } from "sonner";
import { formatDay } from "@/lib/format";

export const Route = createFileRoute("/platform/invites")({
  head: () => ({
    meta: [{ title: "Invites · Platform admin" }, { name: "robots", content: "noindex" }],
  }),
  component: InvitesPage,
});

/** Values only; the words come from humanizeRole. Matches the role enum
 *  createPlatformInvite validates against, so the form cannot offer a role the
 *  server will reject. */
const PLATFORM_INVITE_ROLES = ["owner", "office_manager", "dispatcher", "tech"] as const;

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  accepted: "secondary",
  revoked: "outline",
  expired: "outline",
};

function inviteUrl(token: string) {
  if (typeof window === "undefined") return `/invite/${token}`;
  // appUrl(): an invite link emailed to somebody outside this device. From
  // the native binary the page origin is `capacitor://localhost`, which would
  // make every invite sent from the app unopenable.
  return appUrl(`/invite/${token}`);
}

function InvitesPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPlatformInvites);
  const revokeFn = useServerFn(revokePlatformInvite);
  const resendFn = useServerFn(resendPlatformInvite);
  const q = useQuery({ queryKey: ["platform", "invites"], queryFn: () => listFn() });

  const revokeM = useMutation({
    mutationFn: (id: string) => revokeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Invite revoked");
      qc.invalidateQueries({ queryKey: ["platform", "invites"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const resendM = useMutation({
    mutationFn: (id: string) => resendFn({ data: { id, extra_days: 7 } }),
    onSuccess: (r) => {
      navigator.clipboard.writeText(inviteUrl(r.token)).catch(() => {});
      toast.success("New link copied to clipboard");
      qc.invalidateQueries({ queryKey: ["platform", "invites"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows: PlatformInviteRow[] = q.data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Invites</h1>
          <p className="text-sm text-muted-foreground">
            Admin-sent invitations. New-org invites create the organization on acceptance.
          </p>
        </div>
        <NewInviteDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {q.isLoading ? "Loading…" : `${rows.length} invites`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No invites yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Sent by</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.email}</TableCell>
                      <TableCell>
                        {r.organization_name ?? (
                          <span className="text-muted-foreground italic">new org</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{humanizeRole(r.role)}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_TONE[r.status]}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDay(r.expires_at)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.invited_by_email ?? "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {r.status === "pending" && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  navigator.clipboard
                                    .writeText(inviteUrl(r.token))
                                    .then(() => toast.success("Link copied"));
                                }}
                              >
                                <Copy className="h-4 w-4 shrink-0" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => revokeM.mutate(r.id)}
                              >
                                <X className="h-4 w-4 shrink-0" />
                              </Button>
                            </>
                          )}
                          {(r.status === "expired" || r.status === "revoked") && (
                            <Button variant="ghost" size="sm" onClick={() => resendM.mutate(r.id)}>
                              <Send className="mr-1 h-4 w-4 shrink-0" /> Renew
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NewInviteDialog() {
  const qc = useQueryClient();
  const createFn = useServerFn(createPlatformInvite);
  const orgsFn = useServerFn(listOrgsMinimal);
  const orgs = useQuery({ queryKey: ["platform", "orgs-min"], queryFn: () => orgsFn() });

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "office_manager" | "dispatcher" | "tech">("owner");
  const [orgName, setOrgName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  const createM = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          email,
          role,
          organization_id: mode === "existing" ? orgId : null,
          organization_name: mode === "new" ? orgName : null,
          expires_in_days: 7,
        },
      }),
    onSuccess: (r) => {
      const link = inviteUrl(r.token);
      setCreatedLink(link);
      navigator.clipboard.writeText(link).catch(() => {});
      toast.success("Invite created. Link copied to clipboard");
      qc.invalidateQueries({ queryKey: ["platform", "invites"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  function reset() {
    setEmail("");
    setOrgName("");
    setOrgId("");
    setCreatedLink(null);
    setMode("new");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4 shrink-0" /> New invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New platform invite</DialogTitle>
          <DialogDescription>
            Create a single-use invite link and email it to a new tenant owner.
          </DialogDescription>
        </DialogHeader>
        {createdLink ? (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Invite created. Share this single-use link:
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <code className="flex-1 break-all text-xs">{createdLink}</code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(createdLink).then(() => toast.success("Copied"));
                }}
              >
                <Copy className="h-4 w-4 shrink-0" />
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreatedLink(null)}>
                Create another
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                variant={mode === "new" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("new")}
              >
                Create new org
              </Button>
              <Button
                variant={mode === "existing" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("existing")}
              >
                Join existing org
              </Button>
            </div>
            <div className="space-y-1">
              <Label>Recipient email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@company.com"
              />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as any)}
                className="w-full rounded-md border bg-background px-2 py-2 text-sm"
              >
                {/* The drift this pass was looking for, found in the wild: this
                    list said "Tech" while the table below it — same page, four
                    lines of JSX away — renders humanizeRole and says
                    "Technician". Nobody chose two words; the second list was
                    just typed later. Both now read from the one map. */}
                {PLATFORM_INVITE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {humanizeRole(r)}
                  </option>
                ))}
              </select>
            </div>
            {mode === "new" ? (
              <div className="space-y-1">
                <Label>Organization name</Label>
                <Input
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Acme Scoop Co."
                />
              </div>
            ) : (
              <div className="space-y-1">
                <Label>Organization</Label>
                <select
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  className="w-full rounded-md border bg-background px-2 py-2 text-sm"
                >
                  <option value="">Select…</option>
                  {(orgs.data?.rows ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !email ||
                  createM.isPending ||
                  (mode === "new" && !orgName) ||
                  (mode === "existing" && !orgId)
                }
                onClick={() => createM.mutate()}
              >
                Create invite
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
