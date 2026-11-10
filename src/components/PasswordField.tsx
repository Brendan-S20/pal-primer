import { useId, useState } from "react";
import { Check, Circle, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkPassword } from "@/lib/password-policy";
import { cn } from "@/lib/utils";

// The one field every "choose a password" form uses (#807). The rules from
// lib/password-policy.ts are listed under it before anything is typed, each
// one ticks as it is met while typing, and once the person has typed or left
// the field the first rule still broken is named beside it. The form keeps
// Continue disabled on `checkPassword(value).ok`, from the same list.
//
// `serverError` is the auth server's answer when it still refuses a password
// the list passed (a leaked-password check): shown here, on the field, rather
// than at the top of a later step with no password field on it.

type Props = {
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  serverError?: string | null;
  autoComplete?: string;
  autoFocus?: boolean;
  /** Extra help under the rules, e.g. why it is asked for again. */
  hint?: React.ReactNode;
};

export function PasswordField({
  id,
  label = "Password",
  value,
  onChange,
  serverError,
  autoComplete = "new-password",
  autoFocus,
  hint,
}: Props) {
  const [blurred, setBlurred] = useState(false);
  const check = checkPassword(value);
  // Typed something, or left the field: the rule it breaks is named now,
  // not when Continue is pressed and not three steps later.
  const touched = blurred || value.length > 0;
  const problem = touched ? check.failing[0] : undefined;
  const rulesId = useId();
  const problemId = useId();
  const serverId = useId();
  const describedBy = [rulesId, problem && problemId, serverError && serverId]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        required
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setBlurred(true)}
        aria-invalid={!!problem || !!serverError || undefined}
        aria-describedby={describedBy}
      />
      <ul id={rulesId} className="space-y-1 text-xs" data-password-rules="">
        {check.rules
          .filter(({ rule, met }) => rule.listed || !met)
          .map(({ rule, met }) => {
            const broken = touched && !met;
            return (
              <li
                key={rule.id}
                data-rule={rule.id}
                data-met={met ? "true" : "false"}
                className={cn(
                  "flex min-w-0 items-start gap-1.5",
                  met
                    ? "text-emerald-700 dark:text-emerald-400"
                    : broken
                      ? "text-destructive"
                      : "text-muted-foreground",
                )}
              >
                {met ? (
                  <Check aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
                ) : broken ? (
                  <X aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Circle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 break-words">
                  {rule.label}
                  <span className="sr-only">{met ? " (met)" : " (not met yet)"}</span>
                </span>
              </li>
            );
          })}
      </ul>
      {problem && (
        <p
          id={problemId}
          role="alert"
          className="text-xs text-destructive"
          data-password-problem=""
        >
          {problem.problem}
        </p>
      )}
      {serverError && (
        <p
          id={serverId}
          role="alert"
          className="break-words text-sm text-destructive"
          data-password-server-error=""
        >
          {serverError}
        </p>
      )}
      {hint}
    </div>
  );
}
