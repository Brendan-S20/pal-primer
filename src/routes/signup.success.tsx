import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { getSignupStatus } from "@/lib/signup.functions";

const searchSchema = z.object({ sr: z.string().uuid().optional() });

export const Route = createFileRoute("/signup/success")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({ meta: [{ title: "You're in, welcome" }] }),
  component: SuccessPage,
});

function SuccessPage() {
  const { sr } = Route.useSearch();
  const fn = useServerFn(getSignupStatus);
  const q = useQuery({
    queryKey: ["signup-status", sr],
    queryFn: () => (sr ? fn({ data: { id: sr } }) : Promise.resolve(null)),
    enabled: !!sr,
    refetchInterval: (query) => {
      const d = query.state.data as { status?: string } | null | undefined;
      return d?.status === "provisioned" || d?.status === "failed" ? false : 2000;
    },
  });

  const status = q.data?.status;
  const name = q.data?.name;

  return (
    <MarketingLayout>
      <section className="mx-auto max-w-2xl px-6 py-24 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary text-2xl">
          ✓
        </div>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">
          Payment received{name ? `, ${name.split(" ")[0]}` : ""}!
        </h1>
        <p className="mt-3 text-muted-foreground">
          {status === "provisioned"
            ? "Your account is set up. We just emailed you a private portal link."
            : status === "failed"
              ? "We got your payment, but hit a snag creating your account. We'll follow up by email shortly."
              : "Setting up your account. This takes just a few seconds…"}
        </p>
        <p className="mt-8 text-xs text-muted-foreground">
          You can close this tab. Check your inbox for next steps.
        </p>
      </section>
    </MarketingLayout>
  );
}
