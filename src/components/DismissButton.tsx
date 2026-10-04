import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * The X on a banner that can be put away (see src/lib/dismissible.ts for when
 * it comes back).
 *
 * A 16px glyph centred in a 44px box, the ui/dialog.tsx and ui/sheet.tsx
 * pattern, at every width: the banner looks the same and the target is
 * hittable. Banners pull it into their own padding with a negative margin
 * (`-my-2` and the like) so the box does not make a one-line notice taller.
 *
 * The label goes through t() because the banners that carry it are drawn in
 * the app shell, which a technician reads too.
 */
export function DismissButton({
  onClick,
  label,
  className,
}: {
  onClick: () => void;
  /** What is being dismissed, for a screen reader. Defaults to "Dismiss". */
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const name = label ?? t("common.dismiss");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      title={name}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-current opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <X className="h-4 w-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
