import { createFileRoute, useNavigate, redirect, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Shield, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/admin")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Platform operator sign-in" },
      { name: "robots", content: "noindex" },
    ],
  }),
  beforeLoad: async () => {
    // If already signed in AND platform admin, bounce straight in.
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      const { data: isAdmin } = await supabase.rpc("is_platform_admin", { _user_id: data.user.id });
      if (isAdmin) throw redirect({ to: "/platform" });
    }
  },
  component: AdminLoginPage,
});

function AdminLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { data: signIn, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr || !signIn.user) {
      setLoading(false);
      return setError(signInErr?.message ?? "Sign-in failed");
    }
    const { data: isAdmin, error: roleErr } = await supabase.rpc("is_platform_admin", {
      _user_id: signIn.user.id,
    });
    setLoading(false);
    if (roleErr) return setError(roleErr.message);
    if (!isAdmin) {
      await supabase.auth.signOut();
      return setError("This account is not a platform operator.");
    }
    navigate({ to: "/platform" });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-4">
      <div className="w-full max-w-md space-y-6 text-slate-50">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 ring-1 ring-primary/40">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <h1 className="mt-4 text-2xl font-semibold">Platform operator sign-in</h1>
          <p className="mt-1 text-sm text-slate-300">
            Restricted console for superadmins. Tenant users sign in{" "}
            <Link to="/auth" className="underline underline-offset-2 hover:text-primary">
              here
            </Link>
            .
          </p>
        </div>

        <form
          onSubmit={handleSignIn}
          className="space-y-4 rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur"
        >
          <div className="space-y-2">
            <Label htmlFor="admin-email" className="text-slate-200">Operator email</Label>
            <Input
              id="admin-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-slate-950/60 text-slate-50 placeholder:text-slate-500"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-pw" className="text-slate-200">Password</Label>
            <Input
              id="admin-pw"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-slate-950/60 text-slate-50 placeholder:text-slate-500"
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Verifying…" : "Sign in to console"}
          </Button>
        </form>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>{error}</div>
          </div>
        )}
      </div>
    </div>
  );
}
