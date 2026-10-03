// A new quote, blank or started from a lead (/quotes/new?fromLead=<id>, the
// "Send a quote" action on /leads). The lead's id is the only thing in the
// URL; its details are read server-side, like the new-client wizard does.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import {
  QuoteEditor,
  blankEditorLine,
  type QuoteEditorValues,
} from "@/components/quotes/QuoteEditor";
import { getLeadForConversion } from "@/lib/leads.functions";
import { isSyntheticLeadEmail } from "@/lib/lead-conversion";
import { defaultQuoteValidUntil } from "@/lib/quotes";
import { useOrgToday } from "@/hooks/useOrgToday";
import { pageTitle } from "@/lib/page-title";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/_authenticated/quotes/new")({
  head: () => ({ meta: [{ title: pageTitle("New quote") }] }),
  validateSearch: (s: Record<string, unknown>): { fromLead?: string } => ({
    fromLead: typeof s.fromLead === "string" && UUID.test(s.fromLead) ? s.fromLead : undefined,
  }),
  component: NewQuotePage,
});

function NewQuotePage() {
  const { fromLead } = Route.useSearch();
  const navigate = useNavigate();
  const today = useOrgToday();
  const getLeadFn = useServerFn(getLeadForConversion);
  const leadQ = useQuery({
    enabled: !!fromLead,
    queryKey: ["lead-for-quote", fromLead],
    queryFn: () => getLeadFn({ data: { id: fromLead! } }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const blank: QuoteEditorValues = {
    mode: "client",
    clientId: "",
    prospectName: "",
    prospectEmail: "",
    prospectPhone: "",
    leadId: null,
    title: "",
    message: "",
    validUntil: defaultQuoteValidUntil(today),
    deposit: "",
    // One per-visit line, priced for you when the person has an address. A
    // one-time line is a button away; a blank line is ignored on save.
    lines: [blankEditorLine(true)],
  };

  const header = (
    <div>
      <Link to="/quotes" className="text-sm text-muted-foreground hover:underline">
        ← Quotes
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">New quote</h1>
    </div>
  );

  let body;
  if (fromLead && leadQ.isPending) {
    body = <Card className="p-6 text-sm text-muted-foreground">Loading the lead…</Card>;
  } else if (fromLead && leadQ.isError) {
    body = (
      <Card className="p-6 text-sm" role="alert">
        {(leadQ.error as Error).message || "That lead could not be loaded."}
      </Card>
    );
  } else if (fromLead && leadQ.data) {
    const { lead, existingClient } = leadQ.data;
    // A lead whose email is already a client's is quoted as that client, so
    // the acceptance lands on the record the office already has.
    const initial: QuoteEditorValues = existingClient
      ? { ...blank, mode: "client", clientId: existingClient.id, leadId: lead.id }
      : {
          ...blank,
          mode: "prospect",
          prospectName: lead.name,
          prospectEmail: isSyntheticLeadEmail(lead.email) ? "" : lead.email,
          prospectPhone: lead.phone ?? "",
          leadId: lead.id,
          title: lead.location ? `Service at ${lead.location}` : "",
        };
    body = (
      <QuoteEditor
        key={lead.id}
        initial={initial}
        today={today}
        leadName={lead.name}
        onSaved={(id) => navigate({ to: "/quotes/$quoteId", params: { quoteId: id } })}
      />
    );
  } else {
    body = (
      <QuoteEditor
        key="blank"
        initial={blank}
        today={today}
        onSaved={(id) => navigate({ to: "/quotes/$quoteId", params: { quoteId: id } })}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {header}
      {body}
    </div>
  );
}
