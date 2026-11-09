// The client's portal, shown inside the app (#660).
//
// "Preview portal" used to open a new window, and the native build's "Open
// portal" handed the link to the system browser. On Android that left the app
// for Chrome, and the link named the production host whatever API the build
// talked to, so a dev or staging build reached production with local tokens.
// Now both stay in the app: a sheet holding the portal in a frame.
//
// On the web the frame loads the portal from THIS origin (`src` is a path), so
// the read-only preview session that `previewClientPortal` just set as a
// cookie on this origin is the one the frame sends. In the native build the
// caller passes `linkUrl(...)`, which is the API origin the build already
// talks to; the frame shows the portal as a customer first sees it.
//
// Full width on a phone, a wide panel from `sm` up. The frame takes whatever
// height is left, so nothing scrolls the page; the portal scrolls itself.
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function PortalPreviewSheet({
  src,
  open,
  onOpenChange,
  title,
  description,
  newTab,
}: {
  /** What the frame loads: a path on the web, an absolute URL in native. */
  src: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Offer "Open in new tab" (web only: native has no tabs). */
  newTab?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-3xl">
        <SheetHeader className="min-w-0 pe-10 text-start">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {newTab && src && (
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={src} target="_blank" rel="noopener">
                <ExternalLink className="me-1 h-3.5 w-3.5 shrink-0" aria-hidden />
                Open in new tab
              </a>
            </Button>
          </div>
        )}
        {src && (
          <iframe
            key={src}
            src={src}
            title={title}
            className="min-h-0 w-full flex-1 rounded-md border bg-background"
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
