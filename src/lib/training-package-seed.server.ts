import type { TrainingDb } from "@/lib/training-packages.server";

/** Never reactivate or reprice an owner's existing package. */
export async function seedTrainingPackage(db: TrainingDb, orgId: string) {
  const { data: service, error } = await db
    .from("services")
    .select("id")
    .eq("organization_id", orgId)
    .eq("service_line", "training")
    .eq("name", "Private lesson (60 min)")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!service) return;
  const existing = await db
    .from("service_packages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("service_id", service.id)
    .eq("name", "6-session package")
    .limit(1);
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.length) return;
  const inserted = await db
    .from("service_packages")
    .insert({
      organization_id: orgId,
      service_id: service.id,
      name: "6-session package",
      sessions_count: 6,
      expires_after_days: 90,
      price_cents: 0,
      active: false,
    });
  if (inserted.error) throw new Error(inserted.error.message);
}
