import { Checkbox } from "@/components/ui/checkbox";
import { welcomeEmailPreview } from "@/lib/welcome-email";

/**
 * "Email them a welcome" on the new-client wizard's last step, with who it
 * goes to and what it says, BEFORE Create client is pressed. Unchecked unless
 * the person ticks it (see src/lib/welcome-email.ts for why).
 *
 * With welcome emails turned off in Settings the server would refuse the send
 * (org_toggle_off), so the box is disabled and says so instead of promising a
 * send that will not happen.
 */
export function WelcomeEmailOptIn({
  email,
  orgName,
  checked,
  onCheckedChange,
  turnedOffInSettings = false,
}: {
  email: string;
  orgName: string | null | undefined;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  turnedOffInSettings?: boolean;
}) {
  const preview = welcomeEmailPreview(orgName);
  const on = checked && !turnedOffInSettings;
  return (
    <div className="mt-6 rounded-md border p-3" data-welcome-email-opt-in>
      <div className="flex items-start gap-3">
        <Checkbox
          id="send-welcome"
          className="mt-0.5"
          checked={on}
          disabled={turnedOffInSettings}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor="send-welcome" className="cursor-pointer text-sm font-medium">
            Email them a welcome
          </label>
          {turnedOffInSettings ? (
            <p className="text-xs text-muted-foreground">
              Welcome emails are off in Settings, Emails, so nothing will be sent to{" "}
              <bdi className="break-all">{email}</bdi>.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {on ? "Sent when you press Create client" : "Nothing is sent unless you tick this"}{" "}
                to <bdi className="break-all">{email}</bdi>.
                {!on && " You can send it later from the client's page."}
              </p>
              <p className="text-xs text-muted-foreground">
                Subject: <span className="font-medium text-foreground">{preview.subject}</span>
              </p>
              <p className="text-xs text-muted-foreground">{preview.summary}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
