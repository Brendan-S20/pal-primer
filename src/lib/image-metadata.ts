// Strip metadata from an image before it is served to the public (#630;
// directory v2 step 5b). A phone photo carries EXIF, and EXIF can carry GPS:
// a directory photo served as uploaded would publish where the owner stood.
// The Settings page re-encodes every directory photo through a canvas before
// upload, which drops all of it; this is the server's half, for bytes that
// reached the bucket some other way (an owner calling Storage directly).
//
// Pure byte surgery, no decoding: the pixels are untouched.
//   JPEG  drops APP1 (EXIF, XMP), APP3..APP15 and COM segments before the
//         scan; keeps APP0 (JFIF) and APP2 (ICC colour profile).
//   PNG   drops eXIf, tEXt, zTXt, iTXt and tIME chunks.
//   WebP  drops EXIF and XMP chunks and clears their flags in VP8X.
// Anything it cannot parse returns null, and the caller serves nothing.

export type StrippableType = "image/jpeg" | "image/png" | "image/webp";

export function stripImageMetadata(
  bytes: Uint8Array,
  type: StrippableType,
): Uint8Array<ArrayBuffer> | null {
  try {
    if (type === "image/jpeg") return stripJpeg(bytes);
    if (type === "image/png") return stripPng(bytes);
    if (type === "image/webp") return stripWebp(bytes);
  } catch {
    return null;
  }
  return null;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function stripJpeg(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // Fill bytes between segments.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Start of scan: everything from here on is image data.
    if (marker === 0xda) {
      parts.push(b.subarray(i));
      return concat(parts);
    }
    // Markers with no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    const drop = marker === 0xe1 || (marker >= 0xe3 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (b.length < 8 || PNG_SIG.some((x, k) => b[k] !== x)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let ended = false;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  return ended ? concat(parts) : null;
}

function stripWebp(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const tag = (at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  if (b.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  const parts: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const id = tag(i);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > b.length) return null;
    if (id === "EXIF" || id === "XMP ") {
      i = end;
      continue;
    }
    const chunk = b.slice(i, Math.min(end, b.length));
    // VP8X flags: bit 3 EXIF, bit 2 XMP. Cleared, since those chunks are gone.
    if (id === "VP8X" && chunk.length > 8) chunk[8] &= ~0x0c;
    parts.push(chunk);
    i = end;
  }
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  const size = body.length + 4;
  head.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff], 4);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([head, body]);
}
