import { useCallback, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { photoKindLabel } from "@/lib/photo-kinds";
import i18n from "@/lib/i18n";

/**
 * A visit photo, opened inside the app.
 *
 * ── THE BUG THIS REPLACES ─────────────────────────────────────────────────
 *
 * My Day's PhotoThumb wrapped every photo in
 * `<a href={signedUrl} target="_blank" rel="noreferrer">`. That signed URL is
 * a Supabase storage REST endpoint, so tapping a photo of a customer's yard
 * did this:
 *
 *   * In the native app, it left the app. iOS hands `target="_blank"` to the
 *     system browser, so the technician lands in Safari, signed out, looking
 *     at a raw `/storage/v1/object/sign/...` URL with a token in the query
 *     string, and has to find their way back to a route they were part-way
 *     through. Anything queued offline is still queued; they just cannot see
 *     it any more.
 *   * On mobile web it opens a bare tab with no way back except the browser's
 *     own controls, which the standalone PWA display mode does not show.
 *
 * The CUSTOMER has had an in-app viewer for this the whole time — see the
 * lightbox in portal-ui.tsx. Only the technician was sent out of the product
 * to look at their own work.
 *
 * ── WHY IT IS A DIALOG AND NOT A DIV ──────────────────────────────────────
 *
 * Radix gives the three things a hand-rolled overlay forgets: focus is trapped
 * while it is open and restored to the thumbnail when it closes, the rest of
 * the page is inert to a screen reader, and Escape closes it. The portal's
 * version is a bare `<div onClick={close}>` with none of that; this is the
 * shape that should replace it there too, which is why it is a component and
 * not another inline block.
 *
 * Nothing here fetches. It is handed URLs that have already been signed, so it
 * works on a cached page with no connection exactly as well as it does online.
 */
export type LightboxPhoto = {
  /** Already-signed URL. Null while it is still being signed. */
  url: string | null;
  /** `before` | `completion` | `issue` — shown as the caption. */
  kind?: string | null;
};

export function PhotoLightbox({
  photos,
  openIndex,
  onClose,
  staff = false,
}: {
  photos: LightboxPhoto[];
  /** Index to show, or null when closed. */
  openIndex: number | null;
  onClose: () => void;
  /** Opened by staff (My Day), so it speaks the language this device is set
   *  to. The customer portal leaves it off: a customer reads the business's
   *  language, not whatever their browser happens to prefer. */
  staff?: boolean;
}) {
  const { t: interfaceT } = useTranslation();
  const t = staff ? interfaceT : i18n.getFixedT("en");
  const kindLabel = (kind: string) =>
    t(`photoKind.${kind}`, { defaultValue: photoKindLabel(kind) });
  const [index, setIndex] = useState(openIndex ?? 0);
  const [failed, setFailed] = useState(false);

  // Follow the caller when it opens a different photo, and reset the error
  // state so a previously broken image is retried rather than remembered.
  useEffect(() => {
    if (openIndex !== null) {
      setIndex(openIndex);
      setFailed(false);
    }
  }, [openIndex]);

  const count = photos.length;
  const go = useCallback(
    (delta: number) => {
      if (count < 2) return;
      setFailed(false);
      setIndex((i) => (i + delta + count) % count);
    },
    [count],
  );

  // Arrow keys, for the office roles who open My Day on a laptop to check a
  // technician's work. Escape is Radix's own.
  useEffect(() => {
    if (openIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIndex, go]);

  if (openIndex === null) return null;
  const photo = photos[index];
  if (!photo) return null;

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          // Full-bleed rather than the shared DialogContent card: this is a
          // photo taken on a phone being looked at on a phone, and the card's
          // padding and max-width would letterbox it twice.
          className="fixed inset-0 z-50 flex flex-col focus:outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">
            {photo.kind
              ? t("photo.kindPhoto", { kind: kindLabel(photo.kind) })
              : t("photo.visitPhoto")}
            {count > 1 ? `, ${t("photo.position", { index: index + 1, count })}` : ""}
          </DialogPrimitive.Title>

          {/* Bar sits above the image and inside the safe area: on a notched
              phone in a full-screen WebView, `inset-0` is behind the clock. */}
          <div className="flex items-center justify-between gap-2 px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-wide text-white/90">
              {photo.kind ? kindLabel(photo.kind) : t("photo.badgeFallback")}
              {count > 1 ? ` · ${index + 1}/${count}` : ""}
            </span>
            <DialogPrimitive.Close
              className="grid h-11 w-11 place-items-center rounded-full text-white/90 transition-colors hover:bg-white/10 active:bg-white/20"
              aria-label={t("photo.close")}
            >
              <X className="h-6 w-6 shrink-0" />
            </DialogPrimitive.Close>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center p-2">
            {failed || !photo.url ? (
              <div className="px-6 text-center text-sm text-white/70">
                {photo.url ? t("photo.unavailableTitle") : t("photo.notUploadedYet")}
              </div>
            ) : (
              <img
                src={photo.url}
                alt={
                  photo.kind
                    ? t("photo.kindPhoto", { kind: kindLabel(photo.kind) })
                    : t("photo.visitPhoto")
                }
                className="max-h-full max-w-full object-contain"
                onError={() => setFailed(true)}
              />
            )}

            {count > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  aria-label={t("photo.previous")}
                  className="absolute left-1 grid h-11 w-11 place-items-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/60 active:bg-black/70"
                >
                  <ChevronLeft className="h-6 w-6 shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  aria-label={t("photo.next")}
                  className="absolute right-1 grid h-11 w-11 place-items-center rounded-full bg-black/40 text-white/90 transition-colors hover:bg-black/60 active:bg-black/70"
                >
                  <ChevronRight className="h-6 w-6 shrink-0" />
                </button>
              </>
            )}
          </div>

          <div className="pb-[max(0.75rem,env(safe-area-inset-bottom))]" />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
