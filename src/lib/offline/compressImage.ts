// Client-side downscale + re-encode for photos captured on phones.
// Modern phone cameras produce 3-8 MB HEIC/JPEG files; on slow field LTE
// that's a 20-60s upload. We downscale to a max edge of 1600px and re-encode
// as JPEG q≈0.82, which typically lands under 300 KB while staying sharp
// enough for "did this yard get scooped" evidence.

const MAX_EDGE = 1600;
const QUALITY = 0.82;
// Skip work for anything that's already small enough — most re-uploads and
// screenshots fit here and don't need a canvas round-trip.
const SKIP_UNDER_BYTES = 300 * 1024;

export interface CompressedPhoto {
  file: File;
  contentType: string;
  ext: string;
}

function passthrough(file: File): CompressedPhoto {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  return { file, contentType: file.type || "image/jpeg", ext };
}

export async function compressImage(file: File): Promise<CompressedPhoto> {
  if (typeof window === "undefined") return passthrough(file);
  if (!file.type.startsWith("image/")) return passthrough(file);
  if (file.size <= SKIP_UNDER_BYTES) return passthrough(file);
  // HEIC decoding is inconsistent in canvas across browsers; let it upload
  // as-is so at least the server keeps the original.
  if (/heic|heif/i.test(file.type)) return passthrough(file);

  try {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return passthrough(file);

    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) {
      bitmap.close?.();
      return passthrough(file);
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob: Blob | null =
      "convertToBlob" in canvas
        ? await (canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality: QUALITY })
        : await new Promise((res) =>
            (canvas as HTMLCanvasElement).toBlob(res, "image/jpeg", QUALITY),
          );
    if (!blob) return passthrough(file);
    // If compression made it *bigger* (rare, tiny inputs), keep the original.
    if (blob.size >= file.size) return passthrough(file);

    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    const out = new File([blob], `${base}.jpg`, { type: "image/jpeg" });
    return { file: out, contentType: "image/jpeg", ext: "jpg" };
  } catch {
    return passthrough(file);
  }
}
