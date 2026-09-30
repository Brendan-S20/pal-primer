// "Download PDF" for the office and for the customer portal.
//
// Server FUNCTIONS rather than routes because both callers authenticate the
// way every other call on their screen does: the office with the bearer token
// attachSupabaseAuth adds to each server-function call, the portal with its
// session cookie through requirePortalSession. A plain <a href> carries
// neither the first nor, from the native app, the right origin. The bytes come
// back base64 and the button saves them (src/components/DownloadPdfButton.tsx).
//
// The two token links (/pay/i/:token and /q/:token) are server ROUTES instead,
// under /api/public: see src/routes/api/public/invoice-pdf.ts.
//
// The gates themselves are in document-pdf.server.ts, one per surface, each
// the gate that surface's page already passes.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type PdfDownload = { filename: string; base64: string };

async function encode(file: { filename: string; bytes: Uint8Array }): Promise<PdfDownload> {
  const { toBase64 } = await import("@/lib/pdf/pdf-writer");
  return { filename: file.filename, base64: toBase64(file.bytes) };
}

export const downloadInvoicePdf = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { staffInvoicePdf } = await import("@/lib/document-pdf.server");
    return encode(await staffInvoicePdf(context.supabase, context.userId, data.invoiceId));
  });

export const downloadQuotePdf = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ quoteId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { staffQuotePdf } = await import("@/lib/document-pdf.server");
    return encode(await staffQuotePdf(context.supabase, context.userId, data.quoteId));
  });

export const portalDownloadInvoicePdf = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), invoiceId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token, { readOnly: true });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { portalInvoicePdf } = await import("@/lib/document-pdf.server");
    return encode(await portalInvoicePdf(supabaseAdmin, session, data.invoiceId));
  });
