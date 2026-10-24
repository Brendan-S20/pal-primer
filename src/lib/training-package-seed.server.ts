import { defaultServiceSeedsFor } from "@/lib/services";
import type { TrainingDb } from "@/lib/training-packages.server";
import { DEFAULT_TRAINING_SKILLS } from "@/lib/training-progress";

/** The two training services, the inactive 6-session package, and the starter
 *  skills, each only when that row is missing. Safe to call more than once. */
export async function ensureTrainingDefaults(db: TrainingDb, orgId: string) {
  const seeds = defaultServiceSeedsFor(["training"]);
  const { data: existing, error: readError } = await db
    .from("services")
    .select("name")
    .eq("organization_id", orgId);
  if (readError) throw new Error(readError.message);
  const have = new Set(
    (existing ?? [])
      .map((s) => s.name?.trim().toLowerCase())
      .filter((name): name is string => !!name),
  );
  for (const seed of seeds) {
    const key = seed.name.trim().toLowerCase();
    if (have.has(key)) continue;
    const { error } = await db.from("services").insert({
      ...seed,
      name: seed.name.trim(),
      organization_id: orgId,
    });
    if (error && error.code !== "23505") throw new Error(error.message);
    have.add(key);
  }
  await seedTrainingPackage(db, orgId);
  await seedTrainingSkills(db, orgId);
}

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
  const inserted = await db.from("service_packages").insert({
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

/** The usual skills, once. A business that already has any skill is left as written. */
export async function seedTrainingSkills(db: TrainingDb, orgId: string) {
  const existing = await db
    .from("training_skills")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1);
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.length) return;
  const inserted = await db.from("training_skills").insert(
    DEFAULT_TRAINING_SKILLS.map((name, sort_order) => ({
      organization_id: orgId,
      name,
      sort_order,
      active: true,
    })),
  );
  if (inserted.error) throw new Error(inserted.error.message);
}
