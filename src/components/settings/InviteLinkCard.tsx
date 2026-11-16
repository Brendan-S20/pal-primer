// The link of the invite just sent, kept on the invite form (#775).
//
// Before this, Copy link existed only on a pending-invite row and in the
// warning toast, so an owner who read "use Copy link below" on an empty form
// found nothing to copy, and one whose email DID go out had no way to copy the
// link at all once the toast was gone. This card stays until the next send or
// until it is put away, and shows the link whether or not the email went out.

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inviteLinkCardStatus } from "@/lib/invite-copy";

export type SentInvite = {
  /** The invite's id, so revoking it can take the card away. */
  id?: string;
  email: string;
  link: string;
  emailSent: boolean | undefined;
  action: "created" | "resent";
};

export function InviteLinkCard({
  sent,
  onCopy,
  onDismiss,
}: {
  sent: SentInvite;
  onCopy: (link: string) => void;
  onDismiss: () => void;
}) {
  const status = inviteLinkCardStatus(sent.action, sent.email, sent.emailSent);
  return (
    <div
      className={
        "space-y-2 rounded-md border p-3 " +
        (status.tone === "warning" ? "border-amber-500/60 bg-amber-500/10" : "bg-muted/30")
      }
      data-invite-link-card
      role="status"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words text-sm">{status.message}</p>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="shrink-0"
          aria-label="Hide invite link"
          onClick={onDismiss}
        >
          <X className="h-4 w-4 shrink-0" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Read-only so the link can still be selected by hand when the
            clipboard is refused. `min-w-0` lets a long link give way instead
            of pushing Copy link off a phone. */}
        <Input
          readOnly
          value={sent.link}
          aria-label={`Invite link for ${sent.email}`}
          className="min-w-0 flex-1 basis-56 text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" className="shrink-0" onClick={() => onCopy(sent.link)}>
          Copy link
        </Button>
      </div>
    </div>
  );
}
