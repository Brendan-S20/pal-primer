import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { lookupInviteByToken, acceptPlatformInvite } from "@/lib/platform-onboarding.functions";
import { supabase } from "@/integrations/supabase/client";
import { useOfflineSignOut } from "@/hooks/useOfflineSignOut";
import { humanizeRole } from "@/lib/humanize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/invite/$token")({
  head: () => ({ meta: [
    { title: pageTitle("Accept invite") },
    { name: "robots", content: "noindex" },
  ] }),
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const lookupFn = useServerFn(lookupInviteByToken);
  const acceptFn = useServerFn(acceptPlatformInvite);
  const [session, setSession] = useState<{ email: string | null } | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const { signOut, dialog: signOutDialog } = useOfflineSignOut();

  const q = useQuery({
    queryKey: ["invite", token],
    queryFn: () => lookupFn({ data: { token } }),
  });

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setSession(data.user ? { email: data.user.email ?? null } : null);
      setCheckingSession(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s?.user ? { email: s.user.email ?? null } : null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const acceptM = useMutation({
    mutationFn: () => acceptFn({ data: { token } }),
    onSuccess: () => {
      toast.success("Welcome aboard!");
      navigate({ to: "/dashboard" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Platform invite</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {q.isLoading || checkingSession ? (
            <div className="text-sm text-muted-foreground">Checking invite…</div>
          ) : !q.data?.ok ? (
            <div className="flex items-start gap-2 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <div className="font-medium">Can't use this invite</div>
                <div className="text-muted-foreground">
                  {q.data?.reason === "expired" ? "This invite has expired."
                   : q.data?.reason === "revoked" ? "This invite was revoked."
                   : q.data?.reason === "accepted" ? "This invite has already been used."
                   : "Invite not found."}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-1 text-sm">
                <div className="text-muted-foreground">You've been invited to join</div>
                <div className="text-lg font-semibold">
                  {q.data.organization_name ?? "a new organization"}
                </div>
                {/* "as", "· for" and the address are four flex items on one
                    line, and the monospace address alone is most of a phone's
                    width. Wrapping is the only way this fits; the address still
                    needs somewhere to break when it is the whole line. */}
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  as <Badge variant="outline">{humanizeRole(q.data.role)}</Badge> · for <span className="break-all font-mono">{q.data.email}</span>
                </div>
              </div>

              {!session ? (
                <div className="space-y-2">
                  <div className="text-sm text-muted-foreground">
                    Sign in as <strong>{q.data.email}</strong> to accept.
                  </div>
                  <Button className="w-full" onClick={() =>
                    navigate({ to: "/auth", search: { redirect: `/invite/${token}` } as any })}>
                    Sign in
                  </Button>
                </div>
              ) : session.email?.toLowerCase() !== q.data.email?.toLowerCase() ? (
                <div className="space-y-2">
                  <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                    You're signed in as <strong>{session.email}</strong>, but this invite is for{" "}
                    <strong>{q.data.email}</strong>. Sign out and sign back in with the right email.
                  </div>
                  <Button variant="outline" className="w-full" onClick={async () => {
                    // Switching accounts on a shared device: the outgoing
                    // account's cached day, queued jobs and photos of customer
                    // property must not survive the switch — and unsynced work
                    // is pushed before any of it is dropped. If they decide to
                    // keep it, stay put rather than half-switching.
                    if (!(await signOut())) return;
                    navigate({ to: "/auth", search: { redirect: `/invite/${token}` } as any });
                  }}>
                    Sign out &amp; switch accounts
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 text-sm text-emerald-700">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>Signed in as <strong>{session.email}</strong>, ready to accept.</div>
                  </div>
                  <Button className="w-full" disabled={acceptM.isPending} onClick={() => acceptM.mutate()}>
                    {acceptM.isPending ? "Accepting…" : "Accept invite"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      {signOutDialog}
    </div>
  );
}
