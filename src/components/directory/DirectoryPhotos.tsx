import type { DirectoryPhoto } from "@/lib/directory-brand";
import { cn } from "@/lib/utils";

/**
 * One of the directory's licensed photos (#898). Lazy unless it is the first
 * thing on screen, and always given its width and height so the browser
 * reserves the box before the file arrives (no layout shift). The frame's
 * aspect is set by the caller; the picture covers it.
 */
export function DirectoryPicture({
  photo,
  className,
  eager = false,
}: {
  photo: DirectoryPhoto;
  className?: string;
  eager?: boolean;
}) {
  return (
    <img
      src={photo.src}
      alt={photo.alt}
      width={photo.width}
      height={photo.height}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={cn("block h-full w-full object-cover", className)}
      data-directory-photo
    />
  );
}

/**
 * The visible credit for every photo on the page: the photographer's Pexels
 * name and a link to the photo on Pexels. Only names and links recorded in
 * lib/directory-brand.ts, never typed here.
 */
export function DirectoryPhotoCredits({ photos }: { photos: readonly DirectoryPhoto[] }) {
  if (photos.length === 0) return null;
  return (
    <section
      aria-label="Photo credits"
      className="border-t pt-4 text-xs text-muted-foreground"
      data-directory-photo-credits
    >
      <p className="font-medium">
        Photos from Pexels, used under the{" "}
        <a
          href="https://www.pexels.com/license/"
          className="text-[#B33F22] underline underline-offset-2"
          rel="noopener"
        >
          Pexels License
        </a>
        :
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {photos.map((p) => (
          <li key={p.src} className="min-w-0 break-words">
            <a
              href={p.pexelsUrl}
              className="text-[#B33F22] underline underline-offset-2"
              rel="noopener"
            >
              {p.title}
            </a>{" "}
            by {p.credit}
          </li>
        ))}
      </ul>
    </section>
  );
}
