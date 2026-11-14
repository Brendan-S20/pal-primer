// Every directory photo is redrawn through a canvas before it is uploaded
// (#630; directory v2 step 5b). Unlike compressImage (lib/offline), there is
// no size below which a file goes up as it is, and no fallback that uploads
// the original: a canvas keeps the pixels and nothing else, so EXIF, GPS,
// XMP and comments never leave the owner's device. If the browser cannot
// redraw a file, it is not uploaded. The server strips metadata again when
// it serves a photo (lib/image-metadata.ts), for bytes that came another way.

/** The longest edge a directory photo is stored at. */
export const DIRECTORY_PHOTO_MAX_EDGE = 2000;
const QUALITY = 0.86;

export const COULD_NOT_PREPARE = "This photo could not be prepared. Try a JPEG or PNG.";

/** The photo as a fresh JPEG with no metadata, or an error. */
export async function reencodeDirectoryPhoto(file: File): Promise<File> {
  if (typeof window === "undefined" || typeof createImageBitmap !== "function")
    throw new Error(COULD_NOT_PREPARE);
  // "from-image" applies the EXIF orientation to the pixels before the EXIF
  // itself is dropped, so a portrait photo stays upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(
    () => null,
  );
  if (!bitmap) throw new Error(COULD_NOT_PREPARE);
  const scale = Math.min(1, DIRECTORY_PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error(COULD_NOT_PREPARE);
  }
  // A transparent PNG becomes a JPEG on white, not on black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", QUALITY));
  if (!blob) throw new Error(COULD_NOT_PREPARE);
  return new File([blob], "photo.jpg", { type: "image/jpeg" });
}
