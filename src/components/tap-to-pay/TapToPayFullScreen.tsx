// A full-screen Tap to Pay surface: the announcement (Apple 3.1, 3.3, 6.2) and
// the merchant education (4.x). Full screen because Apple's guide asks for it
// for the awareness moment, and because on a phone a card in a sheet leaves
// most of the screen to whatever was behind it. Safe-area padded on every
// side, scrolls inside itself (never the page), and closes on Escape.
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TapToPayFullScreen({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] outline-none"
    >
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-5 pb-6 pt-2">
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="h-4 w-4 shrink-0" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
