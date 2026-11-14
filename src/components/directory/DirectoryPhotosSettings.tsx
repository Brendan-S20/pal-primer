import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, ArrowUp, ImagePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  DIRECTORY_PHOTOS_MAX,
  DIRECTORY_PHOTO_ALT_MAX,
  DIRECTORY_PHOTO_ATTESTATION,
  DIRECTORY_PHOTO_BUCKET,
  DIRECTORY_PHOTO_STATUS_LABEL,
  DIRECTORY_PHOTO_TYPES,
  cleanPhotoAlt,
  countsTowardPhotoLimit,
  directoryPhotoPath,
  photoAltProblem,
  photoFileProblem,
} from "@/lib/directory";
import {
  addMyDirectoryPhoto,
  getMyDirectoryPhotos,
  removeMyDirectoryPhoto,
  updateMyDirectoryPhoto,
  type MyDirectoryPhoto,
} from "@/lib/directory-photos.functions";

// Settings → Directory listing → Photos (#630; directory v2 step 5b).
//
// Up to eight of the business's own photos, each with required alt text, and
// each held for review by HoundStack before it shows on the listing (the same
// model as reviews). Uploading needs the owner's attestation, in these exact
// words: DIRECTORY_PHOTO_ATTESTATION. One photo at a time, so every photo has
// its own description.
//
// A photo is saved as soon as it is uploaded, on its own: it is not part of
// the profile's Save button, because the file is already in storage by then.
// Owner only, in the server functions and in the database.
//
// No credit line, photographer or source is asked for or shown here.

const ACCEPT = Object.keys(DIRECTORY_PHOTO_TYPES).join(",");
const STATUS_TONE = {
  pending: "outline",
  approved: "secondary",
  rejected: "destructive",
} as const;

export function DirectoryPhotosSettings({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyDirectoryPhotos);
  const addFn = useServerFn(addMyDirectoryPhoto);
  const updateFn = useServerFn(updateMyDirectoryPhoto);
  const removeFn = useServerFn(removeMyDirectoryPhoto);
  const q = useQuery({ queryKey: ["my-directory-photos"], queryFn: () => getFn({}) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["my-directory-photos"] });

  const photos = q.data?.photos ?? [];
  const counted = photos.filter((p) => countsTowardPhotoLimit(p.status)).length;
  const full = counted >= DIRECTORY_PHOTOS_MAX;
  const canEdit = !!q.data?.canEdit && !disabled;

  const move = useMutation({
    mutationFn: async ({ id, by }: { id: string; by: -1 | 1 }) => {
      const order = photos.map((p) => p.id);
      const i = order.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      // Positions become 0..n-1 in the new order. Only alt and position are
      // sent, and alt unchanged, so no photo goes back for review.
      for (const [pos, pid] of order.entries()) {
        const p = photos.find((x) => x.id === pid)!;
        if (p.position !== pos) await updateFn({ data: { id: pid, alt: p.alt, position: pos } });
      }
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Photo removed");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) return null;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-directory-photos>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">Photos</h3>
          <p className="text-xs text-muted-foreground">
            Up to {DIRECTORY_PHOTOS_MAX} of your own photos. HoundStack checks each one before it
            shows on your listing. Describe each photo for people who cannot see it.
          </p>
        </div>
        {q.data?.canEdit ? (
          <Badge variant="outline" className="shrink-0">
            {counted} of {DIRECTORY_PHOTOS_MAX}
          </Badge>
        ) : null}
      </div>

      {q.isError ? (
        <p className="text-sm text-destructive">
          Couldn't load your photos. Try again in a moment.
        </p>
      ) : !q.data?.available ? (
        <p className="text-sm text-muted-foreground">Photos are not available yet.</p>
      ) : !q.data.canEdit ? (
        <p className="text-sm text-muted-foreground">Only an owner can add or change photos.</p>
      ) : (
        <>
          {photos.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4">
              {photos.map((p, i) => (
                <PhotoCard
                  key={p.id}
                  photo={p}
                  first={i === 0}
                  last={i === photos.length - 1}
                  disabled={!canEdit || move.isPending || remove.isPending}
                  onMove={(by) => move.mutate({ id: p.id, by })}
                  onRemove={() => remove.mutate(p.id)}
                  onSaveAlt={async (alt) => {
                    await updateFn({ data: { id: p.id, alt, position: p.position } });
                    refresh();
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No photos yet.</p>
          )}

          {full ? (
            <p className="text-sm text-muted-foreground">
              You have {DIRECTORY_PHOTOS_MAX} photos waiting or shown. Remove one to add another. A
              photo that was not approved does not count.
            </p>
          ) : (
            <AddPhoto
              folder={q.data.folder}
              nextPosition={Math.min(
                99,
                photos.reduce((m, p) => Math.max(m, p.position + 1), 0),
              )}
              disabled={!canEdit}
              onAdd={addFn}
              onAdded={refresh}
            />
          )}
        </>
      )}
    </section>
  );
}

function PhotoCard({
  photo: p,
  first,
  last,
  disabled,
  onMove,
  onRemove,
  onSaveAlt,
}: {
  photo: MyDirectoryPhoto;
  first: boolean;
  last: boolean;
  disabled: boolean;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onSaveAlt: (alt: string) => Promise<void>;
}) {
  const id = useId();
  const [alt, setAlt] = useState(p.alt);
  useEffect(() => setAlt(p.alt), [p.alt]);
  const problem = photoAltProblem(alt);
  const changed = cleanPhotoAlt(alt) !== p.alt;
  const save = useMutation({
    mutationFn: () => onSaveAlt(cleanPhotoAlt(alt)),
    onSuccess: () =>
      toast.success(
        p.status === "pending"
          ? "Description saved"
          : "Description saved. HoundStack will check it again.",
      ),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <li className="space-y-3 rounded-lg border p-3" data-directory-photo={p.status}>
      <div className="aspect-[4/3] overflow-hidden rounded-md bg-muted">
        {p.previewUrl ? (
          <img
            src={p.previewUrl}
            alt={p.alt}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : null}
      </div>
      <Badge variant={STATUS_TONE[p.status]} className="w-fit max-w-full">
        {DIRECTORY_PHOTO_STATUS_LABEL[p.status]}
      </Badge>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-alt`}>Description</Label>
        <Input
          id={`${id}-alt`}
          value={alt}
          maxLength={DIRECTORY_PHOTO_ALT_MAX + 20}
          onChange={(e) => setAlt(e.target.value)}
          disabled={disabled}
          aria-invalid={!!problem}
        />
        <p className={`text-xs ${problem ? "text-destructive" : "text-muted-foreground"}`}>
          {problem ?? `${cleanPhotoAlt(alt).length} of ${DIRECTORY_PHOTO_ALT_MAX} characters`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {changed ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled || !!problem || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save description"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={disabled || first}
          onClick={() => onMove(-1)}
          aria-label={`Move "${p.alt}" earlier`}
        >
          <ArrowUp className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={disabled || last}
          onClick={() => onMove(1)}
          aria-label={`Move "${p.alt}" later`}
        >
          <ArrowDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ms-auto gap-1"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Remove
        </Button>
      </div>
    </li>
  );
}

function AddPhoto({
  folder,
  nextPosition,
  disabled,
  onAdd,
  onAdded,
}: {
  folder: string | null;
  nextPosition: number;
  disabled: boolean;
  onAdd: (args: {
    data: { path: string; alt: string; position: number; attested: true };
  }) => Promise<unknown>;
  onAdded: () => void;
}) {
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [attested, setAttested] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const fileProblem = file ? photoFileProblem(file) : null;
  const altProblem = alt ? photoAltProblem(alt) : null;
  const ready = !!file && !fileProblem && !photoAltProblem(alt) && attested && !!folder;

  const upload = useMutation({
    mutationFn: async () => {
      if (!file || !folder) throw new Error("Choose a photo first.");
      if (!attested) throw new Error(`Tick "${DIRECTORY_PHOTO_ATTESTATION}" first.`);
      // Always redrawn, whatever its size: the upload carries pixels only,
      // never the file's EXIF or GPS.
      const { reencodeDirectoryPhoto } = await import("@/lib/directory-photo-reencode");
      const clean = await reencodeDirectoryPhoto(file);
      const path = directoryPhotoPath(folder, crypto.randomUUID(), "image/jpeg");
      const { error } = await supabase.storage
        .from(DIRECTORY_PHOTO_BUCKET)
        .upload(path, clean, { contentType: "image/jpeg", upsert: false });
      if (error) throw new Error(error.message);
      try {
        await onAdd({
          data: { path, alt: cleanPhotoAlt(alt), position: nextPosition, attested: true },
        });
      } catch (e) {
        // No row was written, so the file is not kept either.
        await supabase.storage.from(DIRECTORY_PHOTO_BUCKET).remove([path]);
        throw e;
      }
    },
    onSuccess: () => {
      toast.success("Photo uploaded. HoundStack will check it before it shows.");
      setFile(null);
      setAlt("");
      setAttested(false);
      setInputKey((k) => k + 1);
      onAdded();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3" data-directory-photo-add>
      <div className="font-medium">Add a photo</div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div className="aspect-[4/3] overflow-hidden rounded-md bg-muted">
          {preview ? (
            <img src={preview} alt={cleanPhotoAlt(alt)} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <ImagePlus className="h-8 w-8 shrink-0" aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-file`}>Photo</Label>
            <Input
              key={inputKey}
              id={`${id}-file`}
              type="file"
              accept={ACCEPT}
              disabled={disabled}
              className="min-h-11"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className={`text-xs ${fileProblem ? "text-destructive" : "text-muted-foreground"}`}>
              {fileProblem ?? "JPEG, PNG or WebP, under 5 MB."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-alt`}>Description of this photo</Label>
            <Input
              id={`${id}-alt`}
              value={alt}
              maxLength={DIRECTORY_PHOTO_ALT_MAX + 20}
              disabled={disabled}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="For example: a latched gate after a visit"
              aria-invalid={!!altProblem}
            />
            <p className={`text-xs ${altProblem ? "text-destructive" : "text-muted-foreground"}`}>
              {altProblem ??
                `Required. ${cleanPhotoAlt(alt).length} of ${DIRECTORY_PHOTO_ALT_MAX} characters.`}
            </p>
          </div>
          <label className="flex min-h-11 items-start gap-3">
            <Checkbox
              checked={attested}
              onCheckedChange={(v) => setAttested(v === true)}
              disabled={disabled}
              className="mt-0.5"
              aria-required="true"
            />
            <span className="min-w-0 text-sm" data-directory-photo-attestation>
              {DIRECTORY_PHOTO_ATTESTATION}
            </span>
          </label>
          <Button
            type="button"
            className="gap-1"
            disabled={disabled || !ready || upload.isPending}
            onClick={() => upload.mutate()}
          >
            <ImagePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
            {upload.isPending ? "Uploading…" : "Upload photo"}
          </Button>
        </div>
      </div>
    </div>
  );
}
