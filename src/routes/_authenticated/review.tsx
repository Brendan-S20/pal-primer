import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ClipboardCheck, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  listReviewItems,
  resolveReviewItem,
  type ReviewItemRow,
} from "@/lib/review-queue.functions";
import { REVIEW_KIND_COPY } from "@/lib/review-queue";
import { pageTitle } from "@/lib/page-title";

// BUILD-10 — guardrail 10.5's review queue, made real.
//
// The rule said ambiguous records go here instead of being silently guessed.
// Until now "here" did not exist, so honoring the rule meant doing nothing:
// BUG-9's visits were detectable only by opening one client's Visits tab and
// squinting, and the missed-visit sweep's "left for human review" cases went
// nowhere at all.
//
// Design: every item states what is uncertain and what to do about it, in
// plain language, and links to the record. Resolving REQUIRES a note — an item
// that vanishes with no account of what was decided leaves the next reader
// exactly as uninformed as the silent guess would have.

export const Route = createFileRoute("/_authenticated/review")({
  head: () => ({ meta: [{ title: pageTitle("Needs review") }] }),
  component: ReviewPage,
});

const FILTERS = [
  { value: "open" as const, label: "Open" },
  { value: "resolved" as const, label: "Resolved" },
  { value: "dismissed" as const, label: "Dismissed" },
  { value: "all" as const, label: "All" },
];

function ReviewPage() {
  const listFn = useServerFn(listReviewItems);
  const [status, setStatus] = useState<"open" | "resolved" | "dismissed" | "all">("open");

  const q = useQuery({
    queryKey: ["review-items", status],
    queryFn: () => listFn({ data: { status } }),
  });

  return (
    <>
      <div>
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-primary shrink-0" />
          <h1 className="text-2xl font-semibold">Needs review</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Records our automated checks could not resolve on their own. Nothing here is broken or
          blocked. These are things only you can settle, so we flagged them instead of guessing.
        </p>
      </div>

      <div className="flex rounded-md border p-0.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={`touch:min-h-11 rounded px-3 py-1 text-xs font-medium transition-colors ${
              status === f.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <Card>
          <CardContent className="p-(--card-pad) text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : q.isError ? (
        <Card>
          <CardContent className="p-(--card-pad) text-sm text-destructive">
            {(q.error as Error).message}
          </CardContent>
        </Card>
      ) : (q.data?.items ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-600 shrink-0" />
            <p className="font-medium">
              {status === "open" ? "Nothing needs your attention" : "Nothing here"}
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {status === "open"
                ? "When an automated check finds a record it can't settle on its own, it lands here rather than being guessed at."
                : "No items with this status."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {q.data!.items.map((item) => (
            <ReviewCard key={item.id} item={item} listStatus={status} />
          ))}
        </div>
      )}
    </>
  );
}

function ReviewCard({
  item,
  listStatus,
}: {
  item: ReviewItemRow;
  listStatus: string;
}) {
  const qc = useQueryClient();
  const resolveFn = useServerFn(resolveReviewItem);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"resolved" | "dismissed" | null>(null);

  const copy = REVIEW_KIND_COPY[item.kind];

  const mut = useMutation({
    mutationFn: (v: { status: "resolved" | "dismissed" }) =>
      resolveFn({ data: { itemId: item.id, status: v.status, note: note.trim() } }),
    onSuccess: (r) => {
      if (r?.alreadyDecided) toast.info("Someone else already decided this one.");
      else toast.success("Recorded.");
      setOpen(false);
      setNote("");
      qc.invalidateQueries({ queryKey: ["review-items"] });
      qc.invalidateQueries({ queryKey: ["review-queue-count"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isOpen = item.status === "open";
  const noteTooShort = note.trim().length < 3;

  return (
    <Card className={isOpen ? "border-amber-300 dark:border-amber-500/40" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">{copy?.label ?? item.kind}</CardTitle>
          <div className="flex items-center gap-2">
            {item.scheduled_on && (
              <span className="text-xs text-muted-foreground">{item.scheduled_on}</span>
            )}
            <Badge variant={isOpen ? "outline" : "secondary"} className={isOpen ? "text-amber-700" : ""}>
              {item.status}
            </Badge>
          </div>
        </div>
        {item.client_name && (
          <p className="text-xs text-muted-foreground">{item.client_name}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3 pt-0 text-sm">
        {/* The reason recorded at detection time, in the tenant's terms. */}
        <p>{item.reason}</p>
        {copy && <p className="text-xs text-muted-foreground">{copy.whatItMeans}</p>}

        {item.status !== "open" && item.resolution_note && (
          <div className="rounded-md border bg-muted/40 p-2 text-xs">
            <span className="font-medium">What was decided: </span>
            {item.resolution_note}
          </div>
        )}

        {isOpen && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {item.subject_table === "visits" && (
                // Remediation happens where the record already lives. This
                // queue indexes ambiguity; it does not become a second place
                // that can edit a visit and disagree with the first.
                <Button asChild variant="outline" size="sm">
                  <Link to="/clients">Open the visit</Link>
                </Button>
              )}
              <Button size="sm" variant={open ? "secondary" : "default"} onClick={() => setOpen((v) => !v)}>
                {open ? "Cancel" : "Record a decision"}
              </Button>
              <span className="text-xs text-muted-foreground">{copy?.howToFix}</span>
            </div>

            {open && (
              <div className="space-y-2 rounded-md border p-3">
                <label className="text-xs font-medium" htmlFor={`note-${item.id}`}>
                  What did you find? <span className="text-muted-foreground">(required)</span>
                </label>
                <Textarea
                  id={`note-${item.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="e.g. Confirmed with the tech, the yard was serviced, the tablet clock was wrong."
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={noteTooShort || mut.isPending}
                    onClick={() => {
                      setPending("resolved");
                      mut.mutate({ status: "resolved" });
                    }}
                  >
                    {mut.isPending && pending === "resolved" ? "Saving…" : "Resolved"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={noteTooShort || mut.isPending}
                    onClick={() => {
                      setPending("dismissed");
                      mut.mutate({ status: "dismissed" });
                    }}
                  >
                    {mut.isPending && pending === "dismissed" ? "Saving…" : "Not a problem"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Your note is saved with the record and on the client&apos;s timeline, so anyone
                  looking later can see why this was settled the way it was.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
