import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import {
  listDirectoryPhotoQueue,
  moderateDirectoryPhoto,
  type QueuedDirectoryPhoto,
} from "@/lib/directory-photos.functions";
import { DIRECTORY_PHOTO_STATUSES, type DirectoryPhotoStatus } from "@/lib/directory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { titleHead } from "@/lib/page-title";
import { formatDateTime } from "@/lib/format";

// The directory's photo moderation queue (#630; directory v2 step 5b). The same
// model as /platform/directory-reviews: no photo is public until a HoundStack
// moderator approves it here, the platform console is reached by platform
// admins only, and the server function and the database both ask again
// (is_platform_admin) before showing or changing anything.
//
// Each photo shows with its description and when the owner attested that
// they took it or have the rights to use it and it is not AI-generated. The
// image comes through a short signed link; its storage path never reaches
// this page. No credit line is shown.

export const Route = createFileRoute("/platform/directory-photos")({
  head: () => titleHead("Directory photos", "Platform admin"),
  component: DirectoryPhotosPage,
});

const STATUS_LABEL: Record<DirectoryPhotoStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
};

function DirectoryPhotosPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listDirectoryPhotoQueue);
  const moderateFn = useServerFn(moderateDirectoryPhoto);
  const [status, setStatus] = useState<DirectoryPhotoStatus>("pending");

  const q = useQuery({
    queryKey: ["platform", "directory-photos", status],
    queryFn: () => listFn({ data: { status } }),
  });

  const moderate = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) => moderateFn({ data: v }),
    onSuccess: (_r, v) => {
      toast.success(v.approve ? "Approved: the photo is public" : "Rejected: it will not show");
      qc.invalidateQueries({ queryKey: ["platform", "directory-photos"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const rows = q.data?.photos ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Directory photos</h1>
          <p className="text-sm text-muted-foreground">
            No photo is public until it is approved here. Approve only a real photo of the
            business's own work that matches its description.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show photos">
          {DIRECTORY_PHOTO_STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? "default" : "outline"}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
            >
              {STATUS_LABEL[s]}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{STATUS_LABEL[status]}</CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading photos...</div>
          ) : q.isError ? (
            <div className="text-sm text-destructive">{(q.error as Error).message}</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">Nothing here.</div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((r) => (
                <PhotoRow
                  key={r.id}
                  photo={r}
                  busy={moderate.isPending}
                  onApprove={() => moderate.mutate({ id: r.id, approve: true })}
                  onReject={() => moderate.mutate({ id: r.id, approve: false })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PhotoRow({
  photo: r,
  busy,
  onApprove,
  onReject,
}: {
  photo: QueuedDirectoryPhoto;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <li className="min-w-0 space-y-3 rounded-lg border p-3 text-sm" data-directory-photo-queue>
      <div className="aspect-[4/3] overflow-hidden rounded-md bg-muted">
        {r.imageUrl ? (
          <img src={r.imageUrl} alt={r.alt} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
            The file could not be loaded.
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium break-words">{r.business_name}</span>
        <Badge variant="outline">{STATUS_LABEL[r.status]}</Badge>
      </div>
      <p className="break-words">
        <span className="text-muted-foreground">Description: </span>
        {r.alt}
      </p>
      <p className="text-xs text-muted-foreground">
        Rights and not AI-generated attested {formatDateTime(r.rights_attested_at)}
        {r.created_at !== r.updated_at ? ` · changed ${formatDateTime(r.updated_at)}` : ""}
        {r.moderated_at && r.moderated_by
          ? ` · decided ${formatDateTime(r.moderated_at)} by moderator ${r.moderated_by.slice(0, 8)}`
          : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {r.status !== "approved" ? (
          <Button size="sm" className="gap-1" disabled={busy} onClick={onApprove}>
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            Approve
          </Button>
        ) : null}
        {r.status !== "rejected" ? (
          <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={onReject}>
            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
            Reject
          </Button>
        ) : null}
      </div>
    </li>
  );
}
