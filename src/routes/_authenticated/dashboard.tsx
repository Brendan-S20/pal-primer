import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const fn = useServerFn(getMyOrg);
  const { data, isLoading } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;

  const org = data?.organization;
  if (!org) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h1 className="text-xl font-semibold">No organization yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign out and use the Create account tab to finish onboarding.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{org.name}</h1>
        <p className="text-sm text-muted-foreground">Signed in as {org.role}</p>
      </div>

      <OnboardingChecklist />



      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Active clients</div>
          <div className="mt-2 text-3xl font-semibold">{org.active_client_count}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {org.active_client_count <= 3 ? "Free tier (≤3 active)" : "Paid tier"}
          </div>
        </div>
      </div>

      <div>
        <Link to="/clients">
          <Button variant="outline">Manage clients →</Button>
        </Link>
      </div>
    </div>
  );
}
