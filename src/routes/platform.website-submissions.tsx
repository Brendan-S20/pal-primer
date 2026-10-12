import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Eye, MailCheck } from "lucide-react";
import {
  listWebsiteSubmissions,
  markWebsiteSubmissionStatus,
  type WebsiteSubmissionRow,
} from "@/lib/platform-website-submissions.functions";
import { WEBSITE_SUBMISSION_FORMS } from "@/lib/website-submissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/platform/website-submissions")({
  head: () => titleHead("Website forms", "Platform admin"),
  component: WebsiteSubmissionsPage,
});

const ALL = "all";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formLabel(form: string) {
  return form === "early_access" ? "Early access" : "Contact";
}

function statusTone(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "new") return "default";
  if (status === "spam") return "destructive";
  if (status === "handled") return "secondary";
  return "outline";
}

function WebsiteSubmissionsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listWebsiteSubmissions);
  const markFn = useServerFn(markWebsiteSubmissionStatus);
  const [form, setForm] = useState<string>(ALL);
  const [selected, setSelected] = useState<WebsiteSubmissionRow | null>(null);

  const listInput = useMemo(
    () => (form === ALL ? {} : { form: form as "contact" | "early_access" }),
    [form],
  );

  const q = useQuery({
    queryKey: ["platform", "website-submissions", listInput],
    queryFn: () => listFn({ data: listInput }),
  });

  const mark = useMutation({
    mutationFn: (id: string) => markFn({ data: { id, status: "handled" } }),
    onSuccess: () => {
      toast.success("Submission marked handled");
      qc.invalidateQueries({ queryKey: ["platform", "website-submissions"] });
      setSelected((row) => (row ? { ...row, status: "handled" } : row));
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const rows = q.data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Website forms</h1>
          <p className="text-sm text-muted-foreground">
            Contact and early-access submissions from houndstack.com.
          </p>
        </div>
        <Select value={form} onValueChange={setForm}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All forms</SelectItem>
            {WEBSITE_SUBMISSION_FORMS.map((value) => (
              <SelectItem key={value} value={value}>
                {formLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Submissions</CardTitle>
          <div className="text-xs text-muted-foreground">Newest first</div>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading submissions...</div>
          ) : q.isError ? (
            <div className="text-sm text-destructive">{(q.error as Error).message}</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No submissions yet.</div>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{formLabel(row.form)}</Badge>
                        <Badge variant={statusTone(row.status)}>{row.status}</Badge>
                        <span className="font-medium">{row.name}</span>
                        <span className="text-muted-foreground">{row.email}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDate(row.created_at)}
                        {row.business_name ? ` · ${row.business_name}` : ""}
                        {row.source_page ? ` · ${row.source_page}` : ""}
                      </div>
                      {row.message ? (
                        <div className="line-clamp-2 max-w-3xl text-muted-foreground">
                          {row.message}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setSelected(row)}>
                        <Eye className="mr-1 h-4 w-4 shrink-0" />
                        View
                      </Button>
                      {row.status !== "handled" ? (
                        <Button
                          size="sm"
                          disabled={mark.isPending}
                          onClick={() => mark.mutate(row.id)}
                        >
                          <MailCheck className="mr-1 h-4 w-4 shrink-0" />
                          Handled
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Submission details</DialogTitle>
          </DialogHeader>
          {selected ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{formLabel(selected.form)}</Badge>
                <Badge variant={statusTone(selected.status)}>{selected.status}</Badge>
                <span className="text-muted-foreground">{formatDate(selected.created_at)}</span>
              </div>
              <DetailGrid row={selected} />
              {selected.message ? (
                <div>
                  <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                    Message
                  </div>
                  <div className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3">
                    {selected.message}
                  </div>
                </div>
              ) : null}
              {selected.payload && Object.keys(selected.payload).length > 0 ? (
                <div>
                  <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                    Other fields
                  </div>
                  <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
                    {JSON.stringify(selected.payload, null, 2)}
                  </pre>
                </div>
              ) : null}
              {selected.status !== "handled" ? (
                <Button disabled={mark.isPending} onClick={() => mark.mutate(selected.id)}>
                  <MailCheck className="mr-1 h-4 w-4 shrink-0" />
                  Mark handled
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailGrid({ row }: { row: WebsiteSubmissionRow }) {
  const items = [
    ["Name", row.name],
    ["Email", row.email],
    ["Business", row.business_name],
    ["Phone", row.phone],
    ["Source page", row.source_page],
    ["User agent", row.user_agent],
    ["IP hash", row.ip_hash],
    ["Handled at", row.handled_at ? formatDate(row.handled_at) : null],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label ?? ""} className="min-w-0">
          <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
          <div className="break-words">{value || "Not provided"}</div>
        </div>
      ))}
    </div>
  );
}
