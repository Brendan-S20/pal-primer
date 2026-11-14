// Directory photos and their moderation (#630; directory v2 step 5b): the
// server functions.
//
// Owners: getMyDirectoryPhotos / addMyDirectoryPhoto / updateMyDirectoryPhoto /
// removeMyDirectoryPhoto. Each asks for an owner here, before touching
// anything, and every write runs on the CALLER's own client, where RLS (owner
// only) and the table's guard trigger ask again: a new photo is pending, the
// attestation is stamped by the database, alt is 1 to 140 characters, at
// most 8 pending or approved per business, and no owner can approve their
// own. Nothing here writes a photo with the service role. The file itself is
// uploaded from the browser into the private bucket, into the business's own
// folder, under the bucket's own owner-only policy.
//
// The moderator: listDirectoryPhotoQueue / moderateDirectoryPhoto. Platform
// admins only, asked here (assertModerator, the review queue's) and again in
// the database. The queue shows the image through a short signed URL made on
// the moderator's own client, which the bucket lets a platform admin read.
//
// Visitors never come through here: they read directory_public_listings.photos
// and fetch /d/{slug}/photos/{key} (servePublicDirectoryPhoto below).
//
// No credit line, photographer, source or licence is read, stored or
// returned anywhere in this file.

// The Supabase clients here are the untyped SupabaseClient on purpose:
// supabase/types.ts does not know the directory tables and is not edited
// here, as in directory.functions.ts; the shapes are pinned in lib/directory.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  DIRECTORY_PHOTOS_MAX,
  DIRECTORY_PHOTO_ALT_MAX,
  DIRECTORY_PHOTO_BUCKET,
  DIRECTORY_PHOTO_STATUSES,
  cleanPhotoAlt,
  isDirectoryPhotoKey,
  isDirectoryPhotoPath,
  isDirectorySlug,
  type DirectoryPhotoStatus,
} from "@/lib/directory";
import { assertModerator } from "@/lib/directory-reviews.functions";
import { stripImageMetadata } from "@/lib/image-metadata";

/** The request's own client, untyped (see the note above). */
const db = (supabase: unknown) => supabase as SupabaseClient;

export const ONLY_AN_OWNER_CHANGES_PHOTOS = "Only an owner can change the directory photos.";

/** One of the owner's own photos, as Settings shows it. */
export type MyDirectoryPhoto = {
  id: string;
  alt: string;
  position: number;
  status: DirectoryPhotoStatus;
  moderated_at: string | null;
  /** A short signed URL for the owner's own preview, or null. */
  previewUrl: string | null;
};

export type MyDirectoryPhotos = {
  canEdit: boolean;
  /** The folder to upload into ({organization id}). The owner's own, and
   *  only sent to the owner: never public. Null for anyone else. */
  folder: string | null;
  photos: MyDirectoryPhoto[];
  /** False on a database 20261112110000 has not reached. */
  available: boolean;
};

/** A photo in the moderator's queue. */
export type QueuedDirectoryPhoto = {
  id: string;
  business_name: string;
  profile_slug: string | null;
  alt: string;
  position: number;
  status: DirectoryPhotoStatus;
  rights_attested_at: string;
  created_at: string;
  updated_at: string;
  moderated_at: string | null;
  moderated_by: string | null;
  /** A short signed URL so the moderator can see the image. */
  imageUrl: string | null;
};

/** Postgres / PostgREST for "that table or function is not there yet". */
function notThereYet(error: { code?: string } | null | undefined): boolean {
  return ["42P01", "PGRST205", "PGRST202", "42883"].includes(error?.code ?? "");
}

async function caller(supabase: unknown, userId: string) {
  const { resolveCaller } = await import("@/lib/authz.server");
  return resolveCaller(supabase, userId);
}

/** How long a preview link lives. Long enough to look, short enough to rot. */
const PREVIEW_SECONDS = 600;

async function sign(sb: SupabaseClient, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const { data, error } = await sb.storage
    .from(DIRECTORY_PHOTO_BUCKET)
    .createSignedUrls(paths, PREVIEW_SECONDS);
  if (error) return out;
  for (const d of (data ?? []) as Array<{ path: string | null; signedUrl: string | null }>) {
    if (d.path && d.signedUrl) out.set(d.path, d.signedUrl);
  }
  return out;
}

/** A file older than this that no row names is a stray: an upload whose
 *  row was never written (a closed tab, a refused insert whose clean-up
 *  failed). The bucket lets an owner hold at most 3 at once. */
export const STRAY_UPLOAD_MINUTES = 10;

/** Remove the owner's strays, on the owner's own client. Best effort: the
 *  bucket's own cap is what bounds them; this frees the room again. */
async function sweepStrayUploads(sb: SupabaseClient, orgId: string, named: string[]) {
  const { data, error } = await sb.storage
    .from(DIRECTORY_PHOTO_BUCKET)
    .list(orgId, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  if (error || !data) return;
  const cutoff = Date.now() - STRAY_UPLOAD_MINUTES * 60_000;
  const keep = new Set(named);
  const strays = data
    .filter((o) => o.id && o.created_at && Date.parse(o.created_at) < cutoff)
    .map((o) => `${orgId}/${o.name}`)
    .filter((path) => !keep.has(path));
  if (!strays.length) return;
  const { error: rmErr } = await sb.storage.from(DIRECTORY_PHOTO_BUCKET).remove(strays);
  if (rmErr) console.error("directory photo strays not removed", orgId, rmErr);
}

export const getMyDirectoryPhotos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyDirectoryPhotos> => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") return { canEdit: false, folder: null, photos: [], available: true };
    const sb = db(context.supabase);
    const { data, error } = await sb
      .from("directory_profile_photos")
      .select("id, path, alt, position, status, moderated_at")
      .eq("organization_id", orgId)
      .order("position")
      .order("created_at");
    if (error) {
      if (notThereYet(error)) return { canEdit: true, folder: null, photos: [], available: false };
      throw new Error(error.message);
    }
    const rows = (data ?? []) as Array<{
      id: string;
      path: string;
      alt: string;
      position: number;
      status: DirectoryPhotoStatus;
      moderated_at: string | null;
    }>;
    await sweepStrayUploads(
      sb,
      orgId,
      rows.map((r) => r.path),
    );
    const signed = await sign(
      sb,
      rows.map((r) => r.path),
    );
    return {
      canEdit: true,
      folder: orgId,
      available: true,
      photos: rows.map((r) => ({
        id: r.id,
        alt: r.alt,
        position: r.position,
        status: r.status,
        moderated_at: r.moderated_at,
        previewUrl: signed.get(r.path) ?? null,
      })),
    };
  });

export const addDirectoryPhotoSchema = z.object({
  path: z.string().max(200),
  alt: z
    .string()
    .max(2000)
    .transform(cleanPhotoAlt)
    .pipe(
      z
        .string()
        .min(1, "Describe the photo for people who cannot see it.")
        .max(
          DIRECTORY_PHOTO_ALT_MAX,
          `Keep the description to ${DIRECTORY_PHOTO_ALT_MAX} characters.`,
        ),
    ),
  position: z.number().int().min(0).max(99),
  // The attestation is ticked, or there is no upload.
  attested: z.literal(true, {
    errorMap: () => ({
      message:
        "Confirm you took these photos or have the rights to use them, and they are not AI-generated.",
    }),
  }),
});

export const addMyDirectoryPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addDirectoryPhotoSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") throw new Error(ONLY_AN_OWNER_CHANGES_PHOTOS);
    if (!isDirectoryPhotoPath(data.path, orgId))
      throw new Error("That upload is not in your folder.");
    const { data: row, error } = await db(context.supabase)
      .from("directory_profile_photos")
      .insert({
        organization_id: orgId,
        path: data.path,
        alt: data.alt,
        position: data.position,
        // Any value: the database stamps now(). Present only because the
        // owner ticked the attestation (data.attested is literally true).
        rights_attested_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) {
      if (/at most 8 photos/i.test(error.message))
        throw new Error(`A listing has at most ${DIRECTORY_PHOTOS_MAX} photos. Remove one first.`);
      throw new Error(error.message);
    }
    return { id: row.id as string };
  });

export const updateMyDirectoryPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        alt: addDirectoryPhotoSchema.shape.alt,
        position: z.number().int().min(0).max(99),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") throw new Error(ONLY_AN_OWNER_CHANGES_PHOTOS);
    // Only alt and position: the client role holds UPDATE on nothing else.
    // A new alt sends the photo back for review (the database does that).
    const { error } = await db(context.supabase)
      .from("directory_profile_photos")
      .update({ alt: data.alt, position: data.position })
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) {
      if (/at most 8 photos/i.test(error.message))
        throw new Error(`A listing has at most ${DIRECTORY_PHOTOS_MAX} photos. Remove one first.`);
      throw new Error(error.message);
    }
    return { ok: true };
  });

export const removeMyDirectoryPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") throw new Error(ONLY_AN_OWNER_CHANGES_PHOTOS);
    const sb = db(context.supabase);
    const { data: rows, error } = await sb
      .from("directory_profile_photos")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .select("path");
    if (error) throw new Error(error.message);
    const paths = ((rows ?? []) as Array<{ path: string }>).map((r) => r.path);
    // The row first, then the file: while a row names a file the bucket
    // refuses to delete it (or upload over it), so an approved photo cannot
    // be swapped. With the row gone the file is the owner's to delete, on
    // their own client. A file left behind is unreachable (no row names it)
    // and the next sweep removes it.
    if (paths.length) {
      const { error: rmErr } = await sb.storage.from(DIRECTORY_PHOTO_BUCKET).remove(paths);
      if (rmErr) console.error("directory photo file not removed", orgId, rmErr);
    }
    return { ok: true };
  });

// ── The moderator ──────────────────────────────────────────────────────────

export const listDirectoryPhotoQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ status: z.enum(DIRECTORY_PHOTO_STATUSES).default("pending") }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertModerator(context.supabase, context.userId);
    const sb = db(context.supabase);
    const { data: rows, error } = await sb.rpc("directory_photo_queue", { _status: data.status });
    if (error) throw new Error(error.message);
    const list = (rows ?? []) as Array<Omit<QueuedDirectoryPhoto, "imageUrl"> & { path: string }>;
    const signed = await sign(
      sb,
      list.map((r) => r.path),
    );
    // The path goes no further than this function: the page gets the
    // signed link and never the path itself.
    return {
      photos: list.map(({ path, ...r }) => ({
        ...r,
        imageUrl: signed.get(path) ?? null,
      })) as QueuedDirectoryPhoto[],
    };
  });

export const moderateDirectoryPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), approve: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertModerator(context.supabase, context.userId);
    const { error } = await db(context.supabase).rpc("moderate_directory_photo", {
      _id: data.id,
      _approve: data.approve,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── What a visitor fetches ─────────────────────────────────────────────────

/** How long a browser or CDN may keep a served photo. A photo rejected after
 *  approval stops being served by the origin at once and from caches within
 *  this many seconds. */
export const PUBLIC_PHOTO_MAX_AGE = 300;

/**
 * GET /d/{slug}/photos/{key}: the bytes of an APPROVED photo of a published
 * listing of a live business, with its metadata stripped, or 404. The lookup (directory_photo_object,
 * service role only) reads directory_public_listings, so this serves exactly
 * what the listing shows. The storage path never leaves the server: no
 * redirect, no signed URL, just the image.
 */
export async function servePublicDirectoryPhoto(
  slugRaw: string,
  keyRaw: string,
): Promise<Response> {
  const slug = slugRaw.trim().toLowerCase();
  const key = keyRaw.trim().toLowerCase();
  const notFound = () =>
    new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  if (!isDirectorySlug(slug) || !isDirectoryPhotoKey(key)) return notFound();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = db(supabaseAdmin);
  const { data: rows, error } = await admin.rpc("directory_photo_object", {
    _slug: slug,
    _key: key,
  });
  if (error) {
    console.error("directory photo lookup failed", slug, error);
    return notFound();
  }
  const path = ((rows ?? []) as Array<{ path: string }>)[0]?.path;
  if (!path) return notFound();
  const { data: blob, error: dlErr } = await admin.storage
    .from(DIRECTORY_PHOTO_BUCKET)
    .download(path);
  if (dlErr || !blob) {
    console.error("directory photo file missing", slug, dlErr);
    return notFound();
  }
  const ext = path.split(".").at(-1);
  const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  // No EXIF, GPS, XMP or text chunks reach a visitor, whatever was uploaded.
  // Bytes that cannot be parsed are not served at all.
  const clean = stripImageMetadata(new Uint8Array(await blob.arrayBuffer()), type);
  if (!clean) {
    console.error("directory photo could not be cleaned", slug);
    return notFound();
  }
  return new Response(clean, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": `public, max-age=${PUBLIC_PHOTO_MAX_AGE}`,
      "X-Content-Type-Options": "nosniff",
      // A directory photo is not a page for search engines either.
      "X-Robots-Tag": "noindex",
    },
  });
}
