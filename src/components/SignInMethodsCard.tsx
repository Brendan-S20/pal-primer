// The ways back into this account, and the rule that stops you locking
// yourself out of one.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// Somebody signs up with Facebook, loses the Facebook account, and their
// business is gone. Not their data -- the invoices and the routes are all
// still there -- but there is no door left, and support cannot open one
// without a manual identity edit.
//
// So: every provider is listed, connected or not, with one action each. A
// person who signed up with Facebook can attach their email or Google before
// anything goes wrong, and a person who no longer trusts a provider can detach
// it.
//
// ── THE ONE RULE THAT MATTERS ────────────────────────────────────────────
//
// You cannot remove your last way in. Supabase enforces this server-side too
// -- unlinkIdentity refuses the final identity -- but its refusal arrives as a
// generic error after the tap, which reads as a bug. The button is disabled
// with the reason on it instead, so the answer arrives before the attempt.
//
// Email is deliberately NOT unlinkable here. It is the recovery route that
// works when a provider is the thing that has gone wrong, and this card exists
// because of exactly that scenario.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";

type Provider = "google" | "apple" | "facebook";

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: "google", label: "Google" },
  { id: "apple", label: "Apple" },
  { id: "facebook", label: "Facebook" },
];

export function SignInMethodsCard() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["auth-identities"],
    queryFn: async () => {
      const { data, error } = await supabase.auth.getUserIdentities();
      if (error) throw new Error(error.message);
      return data?.identities ?? [];
    },
  });

  const identities = q.data ?? [];
  const has = (p: string) => identities.some((i: any) => i.provider === p);
  // Email counts as a way in. Someone who signed up with a provider may have
  // no email identity at all, which is precisely the lockout this card is for.
  const ways = identities.length;

  const link = useMutation({
    mutationFn: async (provider: Provider) => {
      setPending(provider);
      if (IS_NATIVE_BUNDLE) {
        // Same reason as sign-in: Google refuses OAuth in an embedded WebView,
        // so linking has to leave the app the same way signing in does.
        const { NATIVE_OAUTH_REDIRECT } = await import("@/lib/native-oauth");
        const { data, error } = await supabase.auth.linkIdentity({
          provider,
          options: { redirectTo: NATIVE_OAUTH_REDIRECT, skipBrowserRedirect: true },
        });
        if (error) throw new Error(error.message);
        if (!data?.url) throw new Error("No link URL was returned.");
        const { Browser } = await import("@capacitor/browser");
        await Browser.open({ url: data.url });
        return;
      }
      const { error } = await supabase.auth.linkIdentity({ provider });
      if (error) throw new Error(error.message);
    },
    onError: (e: Error) => {
      setPending(null);
      // Manual linking is off by default on a Supabase project, and the error
      // says so in a way nobody can act on. Name the setting.
      toast.error(
        /manual linking|not enabled/i.test(e.message)
          ? "Linking is turned off for this project. Enable Manual Linking in Supabase → Authentication → Providers."
          : e.message,
      );
    },
    onSuccess: () => {
      setPending(null);
      void qc.invalidateQueries({ queryKey: ["auth-identities"] });
    },
  });

  const unlink = useMutation({
    mutationFn: async (identity: any) => {
      setPending(identity.provider);
      const { error } = await supabase.auth.unlinkIdentity(identity);
      if (error) throw new Error(error.message);
    },
    onError: (e: Error) => {
      setPending(null);
      toast.error(e.message);
    },
    onSuccess: () => {
      setPending(null);
      toast.success("Disconnected.");
      void qc.invalidateQueries({ queryKey: ["auth-identities"] });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Ways to sign in</CardTitle>
        <CardDescription>
          Connect more than one, so losing an account somewhere else never locks you out of your
          workspace. You cannot remove your last one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {q.isError && (
          <p className="text-xs text-destructive">Couldn&apos;t load your sign-in methods.</p>
        )}

        {identities
          .filter((i: any) => i.provider === "email")
          .map((i: any) => (
            <div
              key={i.identity_id ?? "email"}
              className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <span className="text-sm">
                Email
                <span className="block text-xs text-muted-foreground">
                  {(i.identity_data as any)?.email ?? "connected"}
                </span>
              </span>
              <span className="text-2xs text-muted-foreground">Always available</span>
            </div>
          ))}

        {PROVIDERS.map(({ id, label }) => {
          const identity = identities.find((i: any) => i.provider === id);
          const connected = has(id);
          const isLast = connected && ways <= 1;
          const busy = pending === id;
          return (
            <div
              key={id}
              className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <span className="text-sm">
                {label}
                <span className="block text-xs text-muted-foreground">
                  {connected ? "Connected" : "Not connected"}
                </span>
              </span>
              {connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isLast || busy}
                  title={isLast ? "This is your only way to sign in" : undefined}
                  onClick={() => unlink.mutate(identity)}
                >
                  {busy ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Unlink className="mr-1 h-4 w-4" />
                  )}
                  {isLast ? "Only way in" : "Disconnect"}
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => link.mutate(id)}>
                  {busy ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="mr-1 h-4 w-4" />
                  )}
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
