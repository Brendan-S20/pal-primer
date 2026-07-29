// Server-only resolver for an org's AI provider credentials (BYOK). Reads the
// service-role-only org_ai_credentials table; falls back to the platform's own
// ANTHROPIC_API_KEY env when an org hasn't set its own key. The raw key never
// leaves the server.
import type { AiConfig } from "@/lib/ai.server";
import { DEFAULT_MODELS, resolveAiConfigFromEnv } from "@/lib/ai.server";

export async function resolveOrgAiConfig(orgId: string): Promise<AiConfig | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("org_ai_credentials")
    .select("provider, api_key, model")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (data?.api_key) {
    const provider = data.provider === "openai" ? "openai" : "anthropic";
    // IMP-1: stored encrypted at rest. Decrypting here keeps the plaintext key
    // on the server for exactly as long as the outbound call needs it.
    const { decryptSecret } = await import("@/lib/secret-encryption.server");
    return {
      provider,
      apiKey: decryptSecret(data.api_key as string),
      model: data.model || DEFAULT_MODELS[provider],
    };
  }
  // No per-org key configured → platform env fallback (if the operator set one).
  return resolveAiConfigFromEnv();
}
