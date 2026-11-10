import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicShell } from "@/components/PublicShell";
import { pageTitle } from "@/lib/page-title";
import {
  RESET_PASSWORD_PATH,
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
  const exchange = useRef<Promise<EstablishResult> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // PASSWORD_RECOVERY fires when supabase-js reads a recovery hash itself.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" && !cancelled) {
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
    void exchange.current.then((r) => {
      if (cancelled) return;
      if (r.ok) {
        markRecoveryPending();
        setPhase({ kind: "ready" });
      } else {
        setPhase((p) => (p.kind === "ready" ? p : { kind: "invalid", message: r.message }));
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const invalid = validateNewPassword(password, confirm);
    if (invalid) return setError(invalid);
    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) {
      const { message, linkDead } = describeUpdatePasswordError(updateError);
      if (linkDead) return setPhase({ kind: "invalid", message });
      return setError(message);
    }
    clearRecoveryPending();
    setPhase({ kind: "done" });
    // /auth lands a signed-in person on their own page.
    setTimeout(() => navigate({ to: "/auth" }), 1500);
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

      {phase.kind === "ready" && (
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border bg-card p-(--card-pad)"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="pw">New password</Label>
            <Input
              id="pw"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw2">Confirm password</Label>
            <Input
              id="pw2"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full">
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
      <p className="text-center text-sm">
        <Link
          to="/auth"
          onClick={() => clearRecoveryPending()}
          className="inline-flex min-h-11 items-center text-muted-foreground underline underline-offset-2 hover:text-primary"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
