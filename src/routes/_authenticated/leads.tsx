import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listLeads,
  updateLeadStatus,
  convertLeadToClient,
  getLeadFormConfig,
} from "@/lib/leads.functions";
import { Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/leads")({
  component: LeadsPage,
});

const STATUSES = ["new", "contacted", "qualified", "converted", "archived"] as const;

function LeadsPage() {
  const list = useServerFn(listLeads);
  const upd = useServerFn(updateLeadStatus);
  const convertFn = useServerFn(convertLeadToClient);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({ queryKey: ["leads"], queryFn: () => list() });
  const cfgFn = useServerFn(getLeadFormConfig);
  const cfgQ = useQuery({ queryKey: ["lead-form-config"], queryFn: () => cfgFn() });
  const formSlug = (cfgQ.data as any)?.slug as string | undefined;

  const mut = useMutation({
    mutationFn: (v: { id: string; status: (typeof STATUSES)[number] }) => upd({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const convertMut = useMutation({
    mutationFn: (id: string) => convertFn({ data: { id } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      toast.success("Converted to client");
      navigate({ to: "/clients/$clientId", params: { clientId: r.clientId } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const leads = (data ?? []).filter((l) => filter === "all" || l.status === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Prospects submitted through the public contact form.
          </p>
        </div>
        <div className="flex items-end gap-2">
          {/* The form these leads come from: see it as a prospect would, or
              jump straight into editing it (Brendan, 2026-07-14). */}
          {formSlug && (
            <a href={`/lead/${formSlug}`} target="_blank" rel="noreferrer">
              <Button variant="outline">
                <Eye className="mr-1 h-4 w-4" /> Preview form
              </Button>
            </a>
          )}
          <Link to="/settings/lead-form">
            <Button variant="outline">
              <Pencil className="mr-1 h-4 w-4" /> Edit form
            </Button>
          </Link>
          <div className="w-48">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : leads.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No leads yet. The contact form on your marketing site will land here.
        </div>
      ) : (
        <div className="space-y-3">
          {leads.map((l) => (
            <div key={l.id} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{l.name}</div>
                    <Badge variant="outline">{l.status}</Badge>
                    {l.company ? (
                      <span className="text-sm text-muted-foreground">· {l.company}</span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    <a href={`mailto:${l.email}`} className="underline">
                      {l.email}
                    </a>
                    {l.phone ? (
                      <>
                        {" · "}
                        <a href={`tel:${l.phone}`} className="underline">
                          {l.phone}
                        </a>
                      </>
                    ) : null}
                    {l.location ? <> · {l.location}</> : null}
                    {l.dog_count != null ? <> · {l.dog_count} clients</> : null}
                  </div>
                  {l.message ? (
                    <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm">{l.message}</p>
                  ) : null}
                  <div className="mt-2 text-xs text-muted-foreground">
                    {new Date(l.created_at).toLocaleString()} · source: {l.source}
                  </div>
                </div>
                <div className="flex w-40 flex-col gap-2">
                  {l.status !== "converted" && (
                    <Button
                      size="sm"
                      onClick={() => convertMut.mutate(l.id)}
                      disabled={convertMut.isPending}
                    >
                      Convert to client
                    </Button>
                  )}
                  <Select
                    value={l.status}
                    onValueChange={(v) =>
                      mut.mutate({ id: l.id, status: v as (typeof STATUSES)[number] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
