import { createFileRoute } from "@tanstack/react-router";

// GET /api/public/invoice-pdf?token=<invoices.public_token>
//
// The invoice behind a pay link, as a PDF. NO auth, by design and exactly as
// the pay page itself (/pay/i/:token, getPublicInvoice): the unguessable
// public_token is the capability. A route rather than a server function so the
// pay page can offer a plain link, which a phone opens in its PDF viewer and
// which works in the in-app browsers a texted link lands in, where a script-
// built download often does not. See src/lib/document-pdf.server.ts for the
// gate, and for why the customer's email is left off this one.
export const Route = createFileRoute("/api/public/invoice-pdf")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token") ?? "";
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { publicInvoicePdf, pdfResponse } = await import("@/lib/document-pdf.server");
        return pdfResponse(await publicInvoicePdf(supabaseAdmin, token));
      },
    },
  },
});
