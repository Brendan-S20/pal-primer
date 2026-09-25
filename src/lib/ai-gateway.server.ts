// Server-only Lovable AI Gateway provider for the Vercel AI SDK.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/** The one model the gateway path runs. It was declared separately in
 *  digest.server.ts and ai-receptionist.server.ts — two copies of a string
 *  that selects a MODEL can drift, and a drifted copy is a silent model
 *  change on a customer-facing surface. Both import it from here now. */
export const GATEWAY_MODEL_ID = "google/gemini-3-flash-preview";

export function createLovableAiGatewayProvider(apiKey: string) {
  return createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: { "Lovable-API-Key": apiKey },
  });
}
