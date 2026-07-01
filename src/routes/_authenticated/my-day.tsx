import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  getMyDay,
  startVisit,
  completeVisit,
  skipVisit,
  recordVisitPhoto,
} from "@/lib/my-day.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/my-day")({
  component: MyDay,
});

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 10);
}

function MyDay() {
  const [day, setDay] = useState(todayISO());
  const fn = useServerFn(getMyDay);
  const { data, isLoading } = useQuery({
    queryKey: ["my-day", day],
    queryFn: () => fn({ data: { day } }),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;

  const visits = data?.visits ?? [];
  const staff = data?.staff;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">My day</h1>
          <p className="text-sm text-muted-foreground">
            {staff ? `${staff.display_name} · ${staff.role}` : "Not on any staff record"}
          </p>
        </div>
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>

      {!staff && (
        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          Your user is not linked to a staff record yet. Ask an owner to add you.
        </div>
      )}

      {staff && visits.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          Nothing scheduled for you on this day.
        </div>
      )}

      <ol className="space-y-3">
        {visits.map((v: any, idx: number) => (
          <VisitCard key={v.id} visit={v} index={idx + 1} day={day} />
        ))}
      </ol>
    </div>
  );
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    scheduled: "bg-muted text-muted-foreground",
    in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    skipped: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    canceled: "bg-destructive/15 text-destructive",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-muted"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function VisitCard({ visit, index, day }: { visit: any; index: number; day: string }) {
  const qc = useQueryClient();
  const startFn = useServerFn(startVisit);
  const completeFn = useServerFn(completeVisit);
  const skipFn = useServerFn(skipVisit);
  const photoFn = useServerFn(recordVisitPhoto);

  const [showSkip, setShowSkip] = useState(false);
  const [reason, setReason] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["my-day", day] });

  const start = useMutation({
    mutationFn: () => startFn({ data: { visitId: visit.id } }),
    onSuccess: () => {
      toast.success("Started");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const complete = useMutation({
    mutationFn: () => completeFn({ data: { visitId: visit.id } }),
    onSuccess: () => {
      toast.success("Completed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const skip = useMutation({
    mutationFn: () => skipFn({ data: { visitId: visit.id, reason } }),
    onSuccess: () => {
      toast.success("Marked skipped");
      setShowSkip(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadPhoto = async (file: File) => {
    setUploading(true);
    try {
      // Need organization_id for the storage path. Fetch on demand.
      const { data: vRow, error: vErr } = await supabase
        .from("visits")
        .select("organization_id")
        .eq("id", visit.id)
        .single();
      if (vErr) throw vErr;

      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${vRow.organization_id}/${visit.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("visit-photos")
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
      if (upErr) throw upErr;

      await photoFn({ data: { visitId: visit.id, storagePath: path, kind: "completion" } });
      toast.success("Photo uploaded");
      invalidate();
    } catch (e: any) {
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const photos = visit.visit_photos ?? [];
  const hasCompletionPhoto = photos.some((p: any) => p.kind === "completion");
  const done = visit.status === "completed";
  const skipped = visit.status === "skipped";
  const inProg = visit.status === "in_progress";
  const scheduled = visit.status === "scheduled";
  const finalStatus = done || skipped;

  return (
    <li className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">#{visit.sequence ?? index}</span>
            {visit.zones?.name && <span>· {visit.zones.name}</span>}
            {statusBadge(visit.status)}
          </div>
          <div className="mt-1 truncate text-base font-semibold">
            {visit.clients?.display_name ?? "Client"}
          </div>
          <div className="text-sm text-muted-foreground">
            {visit.properties?.street}
            {visit.properties?.city ? `, ${visit.properties.city}` : ""}
            {visit.properties?.postal_code ? ` ${visit.properties.postal_code}` : ""}
          </div>
          {(visit.properties?.gate_code || visit.properties?.dog_in_yard_during_service) && (
            <div className="mt-2 space-y-1 text-xs">
              {visit.properties?.gate_code && (
                <div>
                  <span className="text-muted-foreground">Gate:</span>{" "}
                  <span className="font-mono">{visit.properties.gate_code}</span>
                </div>
              )}
              {visit.properties?.dog_in_yard_during_service && (
                <div className="text-amber-600 dark:text-amber-400">⚠ Dog in yard during service</div>
              )}
            </div>
          )}
          {visit.properties?.access_notes && (
            <div className="mt-1 text-xs text-muted-foreground">{visit.properties.access_notes}</div>
          )}
          {visit.clients?.primary_phone && (
            <a
              href={`tel:${visit.clients.primary_phone}`}
              className="mt-2 inline-block text-xs text-primary underline"
            >
              Call {visit.clients.primary_phone}
            </a>
          )}
          {skipped && visit.skip_reason && (
            <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              Skipped: {visit.skip_reason}
            </div>
          )}
        </div>
      </div>

      {!finalStatus && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPhoto(f);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? "Uploading…" : hasCompletionPhoto ? "Add another photo" : "Take completion photo"}
            </Button>
            {photos.length > 0 && (
              <span className="text-xs text-muted-foreground">{photos.length} photo(s)</span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {scheduled && (
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
                Start
              </Button>
            )}
            <Button
              size="sm"
              variant="default"
              disabled={!hasCompletionPhoto || complete.isPending || (!inProg && !scheduled)}
              onClick={() => complete.mutate()}
              title={hasCompletionPhoto ? "" : "Add a completion photo first"}
            >
              Complete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSkip((s) => !s)}>
              Skip
            </Button>
          </div>

          {showSkip && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (e.g. gate locked, dog aggressive)…"
                rows={2}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!reason.trim() || skip.isPending}
                  onClick={() => skip.mutate()}
                >
                  Confirm skip
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowSkip(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
