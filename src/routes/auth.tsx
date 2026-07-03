import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { bootstrapOrganization } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/scoop";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: `Sign in — ${APP_NAME}` },
      { name: "description", content: `Sign in to ${APP_NAME}.` },
    ],
  }),
  component: AuthPage,
});

// Where a given role should land immediately after sign-in.
async function landingPathForUser(userId: string): Promise<string> {
  // Platform admins always land in the platform console — never inside a tenant
  // dashboard (impersonation uses a separate magic-link session for that).
  const { data: isPlatform } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (isPlatform) return "/platform";

  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  const role = data?.role;
  if (role === "tech") return "/my-day";
  if (role === "dispatcher") return "/routes";
  if (role === "owner" || role === "office_manager") return "/dashboard";
  // No role yet (fresh signup) → dashboard triggers onboarding.
  return "/dashboard";
}

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If already signed in, bounce to the right landing page for our role.
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) {
        const to = await landingPathForUser(data.user.id);
        navigate({ to });
      }
    });
  }, [navigate]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return setError(error.message);
    const to = data.user ? await landingPathForUser(data.user.id) : "/dashboard";
    navigate({ to });
  };


  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: signUpErr } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    if (signUpErr) {
      setLoading(false);
      return setError(signUpErr.message);
    }
    // If email confirmation is off, we have a session and can bootstrap.
    const { data: sess } = await supabase.auth.getSession();
    if (sess.session) {
      try {
        await bootstrapOrganization({ data: { orgName, displayName } });
        setLoading(false);
        navigate({ to: "/dashboard" });
        return;
      } catch (err) {
        setLoading(false);
        return setError(err instanceof Error ? err.message : "Failed to create organization");
      }
    }
    setLoading(false);
    setError("Check your email to confirm your account, then sign in.");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-semibold">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{APP_DESCRIPTION}</p>
        </div>

        <div className="space-y-3 rounded-lg border bg-card p-4">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={loading}
            onClick={async () => {
              setError(null);
              setLoading(true);
              try {
                const result = await lovable.auth.signInWithOAuth("google", {
                  redirect_uri: window.location.origin,
                });
                if (result.error) {
                  setLoading(false);
                  return setError(result.error.message ?? "Google sign-in failed");
                }
                if (result.redirected) return; // browser will redirect
                // Popup flow completed with session → role-aware landing.
                const { data } = await supabase.auth.getUser();
                const to = data.user ? await landingPathForUser(data.user.id) : "/dashboard";
                navigate({ to });
              } catch (err) {
                setLoading(false);
                setError(err instanceof Error ? err.message : "Google sign-in failed");
              }
            }}
          >
            Continue with Google
          </Button>
          <div className="relative text-center text-xs text-muted-foreground">
            <span className="bg-card px-2">or use email</span>
          </div>
        </div>

        <Tabs defaultValue="signin" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Create account</TabsTrigger>
          </TabsList>

          <TabsContent value="signin">
            <form onSubmit={handleSignIn} className="space-y-4 rounded-lg border bg-card p-6">
              <div className="space-y-2">
                <Label htmlFor="si-email">Email</Label>
                <Input id="si-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="si-pw">Password</Label>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!email) { setError("Enter your email above, then click Forgot password."); return; }
                      setError(null); setLoading(true);
                      const { error } = await supabase.auth.resetPasswordForEmail(email, {
                        redirectTo: `${window.location.origin}/reset-password`,
                      });
                      setLoading(false);
                      if (error) setError(error.message);
                      else setError("Check your email for a reset link.");
                    }}
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-primary"
                  >
                    Forgot password?
                  </button>
                </div>
                <Input id="si-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </TabsContent>


          <TabsContent value="signup">
            <form onSubmit={handleSignUp} className="space-y-4 rounded-lg border bg-card p-6">
              <div className="space-y-2">
                <Label htmlFor="su-org">Company name</Label>
                <Input id="su-org" required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Pet Waste Removal" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="su-name">Your name</Label>
                <Input id="su-name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="su-email">Email</Label>
                <Input id="su-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="su-pw">Password</Label>
                <Input id="su-pw" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Creating…" : "Create account"}
              </Button>
            </form>
          </TabsContent>
        </Tabs>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
