import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listAnnouncements, createAnnouncement, deleteAnnouncement,
} from "@/lib/platform-directory.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Trash2, Megaphone } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/platform/announcements")({
  component: AnnouncementsPage,
});

const SEV_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  info: "outline", success: "default", warning: "secondary", critical: "destructive",
};

function AnnouncementsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listAnnouncements);
  const createFn = useServerFn(createAnnouncement);
  const delFn = useServerFn(deleteAnnouncement);

  const q = useQuery({ queryKey: ["platform", "announcements"], queryFn: () => listFn() });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: "", body: "", severity: "info" as const,
    audience: "all" as const, starts_at: "", ends_at: "", send_email: false,
  });

  const create = useMutation({
    mutationFn: (v: any) => createFn({ data: v }),
    onSuccess: () => {
      toast.success("Announcement published");
      setOpen(false);
      setForm({ title: "", body: "", severity: "info", audience: "all", starts_at: "", ends_at: "", send_email: false });
      qc.invalidateQueries({ queryKey: ["platform", "announcements"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const del = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "announcements"] }),
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  function submit() {
    create.mutate({
      title: form.title,
      body: form.body,
      severity: form.severity,
      audience: form.audience,
      starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : null,
      ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null,
      send_email: form.send_email,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Announcements</h1>
          <p className="text-sm text-muted-foreground">Broadcast in-app banners to tenants. Optionally email them too.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>New announcement</Button></DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Publish announcement</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Title</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
              <div><Label>Body</Label><Textarea value={form.body} rows={5} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Markdown-lite. Keep it short — banners get truncated." /></div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Severity</Label>
                  <Select value={form.severity} onValueChange={(v: any) => setForm({ ...form, severity: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="success">Success</SelectItem>
                      <SelectItem value="warning">Warning</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Audience</Label>
                  <Select value={form.audience} onValueChange={(v: any) => setForm({ ...form, audience: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All tenants</SelectItem>
                      <SelectItem value="active">Active plans</SelectItem>
                      <SelectItem value="trialing">Trialing</SelectItem>
                      <SelectItem value="past_due">Past-due</SelectItem>
                      <SelectItem value="admins">Owners & admins only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Starts</Label><Input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></div>
                <div><Label>Ends</Label><Input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></div>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="text-sm font-medium">Also send email</div>
                  <div className="text-xs text-muted-foreground">Sends when the announcement first goes live.</div>
                </div>
                <Switch checked={form.send_email} onCheckedChange={(v) => setForm({ ...form, send_email: v })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={submit} disabled={create.isPending || !form.title || !form.body}>Publish</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {(q.data?.rows ?? []).map((a) => {
          const now = Date.now();
          const live =
            (!a.starts_at || new Date(a.starts_at).getTime() <= now) &&
            (!a.ends_at || new Date(a.ends_at).getTime() >= now);
          return (
            <Card key={a.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div>
                  <CardTitle className="text-base">
                    <span className="mr-2">{a.title}</span>
                    <Badge variant={SEV_TONE[a.severity] ?? "outline"}>{a.severity}</Badge>
                    <Badge variant="outline" className="ml-1">{a.audience}</Badge>
                    {live ? <Badge className="ml-1">Live</Badge> : <Badge variant="secondary" className="ml-1">Scheduled/ended</Badge>}
                    {a.send_email && a.email_sent_at ? <Badge variant="outline" className="ml-1">Emailed</Badge> : null}
                  </CardTitle>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {a.starts_at ? `Starts ${new Date(a.starts_at).toLocaleString()}` : "No start"} · {a.ends_at ? `Ends ${new Date(a.ends_at).toLocaleString()}` : "No end"}
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => del.mutate(a.id)} aria-label="Delete">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm">{a.body}</CardContent>
            </Card>
          );
        })}
        {q.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (q.data?.rows ?? []).length === 0 ? (
          <EmptyState
            icon={<Megaphone className="h-5 w-5" />}
            title="No announcements yet"
            description="Publish a banner to notify tenants about maintenance, new features, or important updates."
          />
        ) : null}
      </div>
    </div>
  );
}
