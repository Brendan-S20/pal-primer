import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listPlatformSignupRequests, approvePlatformSignupRequest, denyPlatformSignupRequest,
  type PlatformSignupRequestRow,
} from "@/lib/platform-onboarding.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Check, X, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/platform/signup-requests")({
  head: () => ({ meta: [{ title: "Signup requests · Platform admin" }, { name: "robots", content: "noindex" }] }),
  component: SignupRequestsPage,
});

function inviteUrl(token: string) {
  if (typeof window === "undefined") return `/invite/${token}`;
  return `${window.location.origin}/invite/${token}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function SignupRequestsPage() {
  const listFn = useServerFn(listPlatformSignupRequests);
  const q = useQuery({ queryKey: ["platform", "signup-requests"], queryFn: () => listFn() });
  const rows = q.data?.rows ?? [];
  const pending = rows.filter((r) => r.status === "pending");
  const approved = rows.filter((r) => r.status === "approved");
  const denied = rows.filter((r) => r.status === "denied");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Signup requests</h1>
          <p className="text-sm text-muted-foreground">
            Applications from the public <code>/request-access</code> form.
          </p>
        </div>
        <a href="/request-access" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          Public form <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <Tabs defaultValue="pending" className="w-full">
        <TabsList>
          <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
          <TabsTrigger value="approved">Approved ({approved.length})</TabsTrigger>
          <TabsTrigger value="denied">Denied ({denied.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="pt-4"><RequestList rows={pending} /></TabsContent>
        <TabsContent value="approved" className="pt-4"><RequestList rows={approved} /></TabsContent>
        <TabsContent value="denied" className="pt-4"><RequestList rows={denied} /></TabsContent>
      </Tabs>
    </div>
  );
}

function RequestList({ rows }: { rows: PlatformSignupRequestRow[] }) {
  if (rows.length === 0) {
    return <Card><CardContent className="py-6 text-sm text-muted-foreground">Nothing here.</CardContent></Card>;
  }
  return (
    <div className="grid gap-3">
      {rows.map((r) => <RequestCard key={r.id} r={r} />)}
    </div>
  );
}

function RequestCard({ r }: { r: PlatformSignupRequestRow }) {
  const qc = useQueryClient();
  const approveFn = useServerFn(approvePlatformSignupRequest);
  const denyFn = useServerFn(denyPlatformSignupRequest);
  const [reason, setReason] = useState("");

  const approveM = useMutation({
    mutationFn: () => approveFn({ data: { id: r.id } }),
    onSuccess: (res) => {
      const link = inviteUrl(res.invite_token);
      navigator.clipboard.writeText(link).catch(() => {});
      toast.success("Approved — invite link copied");
      qc.invalidateQueries({ queryKey: ["platform", "signup-requests"] });
      qc.invalidateQueries({ queryKey: ["platform", "invites"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const denyM = useMutation({
    mutationFn: () => denyFn({ data: { id: r.id, reason } }),
    onSuccess: () => {
      toast.success("Denied");
      qc.invalidateQueries({ queryKey: ["platform", "signup-requests"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{r.organization_name}</CardTitle>
            <div className="mt-1 text-sm text-muted-foreground">
              {r.contact_name} · <a href={`mailto:${r.contact_email}`} className="hover:underline">{r.contact_email}</a>
              {r.contact_phone && <> · {r.contact_phone}</>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={r.status === "pending" ? "default" : r.status === "approved" ? "secondary" : "outline"}>
              {r.status}
            </Badge>
            <span className="text-xs text-muted-foreground">{fmtDate(r.created_at)}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-3">
          {r.website && (
            <div>
              <div className="text-xs text-muted-foreground">Website</div>
              <a href={r.website.startsWith("http") ? r.website : `https://${r.website}`}
                target="_blank" rel="noreferrer" className="hover:underline">{r.website}</a>
            </div>
          )}
          {typeof r.approx_client_count === "number" && (
            <div>
              <div className="text-xs text-muted-foreground">Approx clients</div>
              <div>{r.approx_client_count.toLocaleString()}</div>
            </div>
          )}
        </div>
        {r.notes && (
          <div>
            <div className="text-xs text-muted-foreground">Notes</div>
            <div className="whitespace-pre-wrap">{r.notes}</div>
          </div>
        )}
        {r.denial_reason && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <strong>Denied:</strong> {r.denial_reason}
            {r.reviewed_by_email && <> · by {r.reviewed_by_email}</>}
          </div>
        )}
        {r.status === "approved" && r.created_invite_id && (
          <div className="rounded-md border bg-muted/30 p-2 text-xs">
            Invite generated · <a href="/platform/invites" className="underline">manage in Invites</a>
            {r.reviewed_by_email && <> · approved by {r.reviewed_by_email}</>}
          </div>
        )}

        {r.status === "pending" && (
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <X className="mr-1 h-4 w-4" /> Deny
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Deny signup request</AlertDialogTitle>
                  <AlertDialogDescription>Reason (kept internal, not emailed).</AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-1">
                  <Label htmlFor={`reason-${r.id}`}>Reason</Label>
                  <Textarea id={`reason-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction disabled={!reason.trim() || denyM.isPending} onClick={() => denyM.mutate()}>
                    Deny
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button size="sm" onClick={() => approveM.mutate()} disabled={approveM.isPending}>
              <Check className="mr-1 h-4 w-4" /> Approve &amp; invite
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
