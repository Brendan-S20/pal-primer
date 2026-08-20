import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { TenantSignupShell } from "@/components/marketing/TenantSignupShell";
import { getSignupStatus } from "@/lib/signup.functions";

const searchSchema = z.object({ sr: z.string().uuid().optional() });

export const Route = createFileRoute("/signup/success")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({ meta: [{ title: "You're in, welcome" }] }),
  component: SuccessPage,
});

function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

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
  const failed = status === "failed";
  const refunded = !!q.data?.refunded;

  return (
    <TenantSignupShell
      orgName={q.data?.orgName ?? null}
      logoUrl={q.data?.logoUrl}
      brandColor={q.data?.brandColor}
    >
      <section className="mx-auto max-w-2xl px-6 py-24 text-center">
        {/* The headline has to survive the failure case. "Payment received!"
            over a green tick was shown even when provisioning had failed and
            the money was about to go back, which is the single most confusing
            thing this page could say to someone whose card was just charged. */}
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl ${
            failed ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary"
          }`}
        >
          {failed ? "!" : "✓"}
        </div>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">
          {failed
            ? "We couldn't finish setting up your account"
            : `Payment received${name ? `, ${name.split(" ")[0]}` : ""}!`}
        </h1>

        {/* What the customer is told about their money must be what actually
            happened to it. The webhook refunds the charge when provisioning
            fails and records `refunded_at` only once Stripe has accepted the
            refund, so these three branches are the three real states:
            provisioned, failed-and-refunded, and failed-with-the-refund-itself-
            failing. The last one promises a person will fix it by hand, because
            that is the only thing left that is true. */}
        <p className="mt-3 text-muted-foreground">
          {status === "provisioned" ? (
            "Your account is set up. We just emailed you a private portal link."
          ) : failed ? (
            refunded ? (
              <>
                Something went wrong on our end, so we've cancelled the signup and refunded your
                card in full
                {q.data?.refundedAmountCents
                  ? ` (${money(q.data.refundedAmountCents, q.data.currency ?? "usd")})`
                  : ""}
                . It usually lands back on your statement within 5–10 business days, and no service
                has been scheduled. Please get in touch if you'd still like to sign up.
              </>
            ) : (
              <>
                Something went wrong on our end after your payment went through. We've flagged it
                and someone will contact you by email shortly to either finish setting you up or
                return your money. You will not be left paying for a service you don't have.
              </>
            )
          ) : (
            "Setting up your account. This takes just a few seconds…"
          )}
        </p>
        <p className="mt-8 text-xs text-muted-foreground">
          {failed
            ? "You can close this tab. We have your details and we'll be in touch."
            : "You can close this tab. Check your inbox for next steps."}
        </p>
      </section>
    </TenantSignupShell>
  );
}
