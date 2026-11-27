import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicShell } from "@/components/PublicShell";
import { PasswordField } from "@/components/PasswordField";
import { isPasswordAcceptable, isPasswordRejection } from "@/lib/password-policy";
import { pageTitle } from "@/lib/page-title";
import {
  RESET_PASSWORD_PATH,
  abandonRecovery,
  cancelRecovery,
  clearRecoveryPending,
  describeUpdatePasswordError,
  establishRecoverySession,
  type EstablishResult,
  markRecoveryPending,
  passwordResetRedirectHere,
  requestPasswordReset,
  validateNewPassword,
} from "@/lib/password-recovery";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  // No hydration timer for a client-only route; see _authenticated/route.tsx.
  pendingMinMs: 0,
  head: () => ({
    meta: [{ title: pageTitle("Reset your password") }, { name: "robots", content: "noindex" }],
  }),
  component: ResetPasswordPage,
});

type Phase =
  | { kind: "verifying" }
  | { kind: "ready" }
  | { kind: "invalid"; message: string }
  | { kind: "done" };

// Every shape a recovery link can arrive in is turned into a session here
// (lib/password-recovery.ts establishRecoverySession). Until the new password
// is saved, /auth will not land this tab anywhere else: the recovery flag it
// checks is cleared only on success.
function ResetPasswordPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: "verifying" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The auth server refused the password itself (#807): said beside the
  // field, and both fields keep what was typed.
  const [passwordRejected, setPasswordRejected] = useState<string | null>(null);
  const exchange = useRef<Promise<EstablishResult> | null>(null);
  const saving = useRef<Promise<unknown> | null>(null);
  // "Cancel reset and sign out" was pressed: `leaving` while it runs, and
  // `cancels` so that work started before it knows to say and do nothing.
  const [isLeaving, setIsLeaving] = useState(false);
  const leaving = useRef(false);
  const cancels = useRef(0);
  // The link check's answer if it came back during a cancel, applied only if
  // that cancel could not sign out.
  const heldCheck = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    // PASSWORD_RECOVERY fires when supabase-js reads a recovery hash itself.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" && !cancelled && !leaving.current) {
        markRecoveryPending();
        setPhase({ kind: "ready" });
      }
    });
    // The exchange runs ONCE (a code or token is single-use), but every run
    // of this effect listens for its answer. StrictMode runs effects twice;
    // with the exchange's result tied to the first run's `cancelled`, the
    // answer arrived after that run was cleaned up and was dropped, and the
    // page sat on "Checking your reset link…" for good.
    if (!exchange.current) {
      const href = window.location.href;
      exchange.current = establishRecoverySession(supabase as never, href).then((r) => {
        // Spent tokens off the address bar, so a reload or a shared
        // screenshot does not carry them.
        if (window.location.search || window.location.hash) {
          window.history.replaceState(window.history.state, "", RESET_PASSWORD_PATH);
        }
        return r;
      });
    }
    const apply = (r: EstablishResult) => {
      if (r.ok) {
        markRecoveryPending();
        setPhase({ kind: "ready" });
      } else {
        setPhase((p) => (p.kind === "ready" ? p : { kind: "invalid", message: r.message }));
      }
    };
    void exchange.current.then((r) => {
      if (cancelled) return;
      if (leaving.current) heldCheck.current = () => apply(r);
      else apply(r);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A save started while signing out would sign the person back in.
    if (leaving.current) return;
    setError(null);
    setPasswordRejected(null);
    const invalid = validateNewPassword(password, confirm);
    if (invalid) return setError(invalid);
    setLoading(true);
    const cancelsBefore = cancels.current;
    const save = supabase.auth.updateUser({ password });
    saving.current = save;
    const { error: updateError } = await save;
    setLoading(false);
    // Cancelled while saving: the cancel signs out and decides where to go.
    if (cancels.current !== cancelsBefore) return;
    if (updateError) {
      const { message, linkDead } = describeUpdatePasswordError(updateError);
      if (linkDead) return setPhase({ kind: "invalid", message });
      if (isPasswordRejection(updateError)) return setPasswordRejected(message);
      return setError(message);
    }
    clearRecoveryPending();
    setPhase({ kind: "done" });
    // /auth lands a signed-in person on their own page.
    setTimeout(() => navigate({ to: "/auth" }), 1500);
  };

  const cancelReset = async () => {
    leaving.current = true;
    cancels.current += 1;
    setIsLeaving(true);
    setError(null);
    const left = await cancelRecovery(supabase, [exchange.current, saving.current]);
    // Released: this page is on its way out, so nothing here may run again.
    if (left) return true;
    leaving.current = false;
    setIsLeaving(false);
    heldCheck.current?.();
    heldCheck.current = null;
    return false;
  };

  return (
    <PublicShell>
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Set a new password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {phase.kind === "verifying" && "Checking your reset link…"}
          {phase.kind === "ready" && "Choose a strong password to finish resetting."}
          {phase.kind === "invalid" && "This link can't be used."}
          {phase.kind === "done" && "All set."}
        </p>
      </div>

      {/* Above the form, not below it: leaving the empty password field (the
          first press on this link) makes PasswordField add its "rule you
          broke" line, and anything under the field moves ~24px away from the
          pointer before the click completes (#983). */}
      {/* Offered while the link is still being checked too: that request may
          never be answered (#1058). */}
      {(phase.kind === "verifying" || phase.kind === "ready") && (
        <BackToSignIn label="Cancel reset and sign out" onLeave={cancelReset} />
      )}

      {phase.kind === "ready" && (
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border bg-card p-(--card-pad)"
          noValidate
        >
          <PasswordField
            id="pw"
            label="New password"
            value={password}
            onChange={(v) => {
              setPassword(v);
              setPasswordRejected(null);
            }}
            serverError={passwordRejected}
            autoFocus
          />
          <div className="space-y-2">
            <Label htmlFor="pw2">Confirm password</Label>
            <Input
              id="pw2"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={(confirm.length > 0 && confirm !== password) || undefined}
            />
            {confirm.length > 0 && confirm !== password && (
              <p className="text-xs text-destructive">Passwords don't match.</p>
            )}
          </div>
          <Button
            type="submit"
            disabled={loading || isLeaving || !isPasswordAcceptable(password) || !!passwordRejected}
            className="w-full"
          >
            {loading ? "Updating…" : "Update password"}
          </Button>
        </form>
      )}

      {phase.kind === "invalid" && <ResendResetLink message={phase.message} />}

      {phase.kind === "done" && (
        <div
          role="status"
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-400"
        >
          Password updated. Taking you in…
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
    </PublicShell>
  );
}

/** The expired/used-link state: say so, and offer a fresh link right here
 *  rather than sending the person back through sign-in to find the button. */
function ResendResetLink({ message }: { message: string }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null);
    setSending(true);
    const r = await requestPasswordReset(supabase, email, await passwordResetRedirectHere());
    setSending(false);
    setResult(
      r.ok
        ? { ok: true, text: `If ${r.sentTo} has an account, a new reset link is on its way.` }
        : { ok: false, text: r.message },
    );
  };

  return (
    <div className="space-y-4">
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
      >
        {message}
      </div>
      <form onSubmit={send} className="space-y-3 rounded-lg border bg-card p-(--card-pad)">
        <div className="space-y-2">
          <Label htmlFor="reset-email">Email</Label>
          <Input
            id="reset-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourbusiness.com"
          />
        </div>
        <Button type="submit" disabled={sending || !email.trim()} className="w-full">
          {sending ? "Sending…" : "Send a new reset link"}
        </Button>
        {result && (
          <p
            role={result.ok ? "status" : "alert"}
            className={result.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
          >
            {result.text}
          </p>
        )}
      </form>
      <BackToSignIn label="Back to sign in" />
    </div>
  );
}

/** Leaves the reset: signs this device out first, so /auth does not land the
 *  reset session, then goes to /auth (#983). If that cannot be done it says so
 *  here and the button can be pressed again (#1058). */
function BackToSignIn({
  label,
  onLeave = () => abandonRecovery(supabase),
}: {
  label: string;
  onLeave?: () => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "leaving" | "failed">("idle");
  const leave = async () => {
    if (state === "leaving") return;
    setState("leaving");
    if (await onLeave()) return navigate({ to: "/auth" });
    setState("failed");
  };
  return (
    <div className="space-y-2 text-center">
      <Button
        type="button"
        variant="outline"
        // aria-disabled, not disabled: a disabled button drops keyboard focus.
        aria-disabled={state === "leaving" || undefined}
        // Tabbing here is leaving, not a half-typed password (PasswordField).
        data-leaves-form=""
        // The press must not take the focus off the password field: its blur
        // adds a line, the centred page re-centres, and this button moves out
        // from under the pointer before the click completes (#1058).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void leave()}
        className="min-h-11 aria-disabled:opacity-50"
      >
        {state === "leaving" ? "Signing out…" : label}
      </Button>
      {state === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          We couldn't sign you out. Check your connection and try again.
        </p>
      )}
    </div>
  );
}
