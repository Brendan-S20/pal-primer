// Shared visit-generation kick (QA follow-up 1.6): every mutation that can
// change the schedule (service create/edit/resume, wizard onboarding) calls
// this instead of waiting for the nightly job, so an active service never
// sits with zero visits. Generation is idempotent (ON CONFLICT DO NOTHING
// in generate_visits_core), so calling it repeatedly is safe.

export const GENERATION_HORIZON_DAYS = 60;

export async function generateVisitHorizon(supabase: any, orgId: string): Promise<number> {
  const through = new Date();
  through.setDate(through.getDate() + GENERATION_HORIZON_DAYS);
  const throughISO = `${through.getFullYear()}-${String(through.getMonth() + 1).padStart(2, "0")}-${String(through.getDate()).padStart(2, "0")}`;
  const { data, error } = await supabase.rpc("generate_visits_through", {
    _org_id: orgId,
    _through: throughISO,
  });
  if (error) {
    // Non-fatal: the mutation that triggered this already succeeded; the
    // nightly job will still catch up. Surface in logs for diagnosis.
    console.warn("visit generation failed:", error.message);
    return 0;
  }
  return (data as number) ?? 0;
}
