import { createFileRoute } from "@tanstack/react-router";

// GET /api/public/quote-pdf?token=<quotes.public_token>
//
// The quote behind a /q/:token link, as a PDF. NO auth, the same capability
// model as the quote page: it reads through public_quote_document, the one
// function getPublicQuote uses, which answers nothing for a DRAFT. So a draft's
// PDF is a 404 identical to a mistyped token's. See
// src/lib/document-pdf.server.ts.
export const Route = createFileRoute("/api/public/quote-pdf")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token") ?? "";
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { publicQuotePdf, pdfResponse } = await import("@/lib/document-pdf.server");
        return pdfResponse(await publicQuotePdf(supabaseAdmin, token));
      },
    },
  },
});
