import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { progressText, scoreProblem } from "@/lib/training-progress";
import type { TrainingDb } from "@/lib/training-packages.server";

const id = z.string().uuid();

const progressInput = z.object({
  visitId: id,
  scores: z.array(z.object({ skillId: id, score: z.number().int().min(1).max(5) })).max(40),
  note: z.string().max(2000).default(""),
  homework: z.string().max(2000).default(""),
  homeworkDue: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

type Lesson = {
  orgId: string;
  visitId: string;
  scheduledOn: string;
  propertyId: string;
  clientPackageId: string | null;
  packageDogId: string | null;
};

async function trainingVisit(db: TrainingDb, userId: string, visitId: string): Promise<Lesson> {
  const { orgId } = await resolveCaller(db, userId);
  const { data, error } = await db
    .from("visits")
    .select(
      "id, organization_id, scheduled_on, property_id, client_package_id, services(service_line), client_packages(dog_id)",
    )
    .eq("id", visitId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That lesson was not found.");
  const service = Array.isArray(data.services) ? data.services[0] : data.services;
  if (service?.service_line !== "training")
    throw new Error("Progress is recorded on a training lesson.");
  const pack = Array.isArray(data.client_packages) ? data.client_packages[0] : data.client_packages;
  return {
    orgId,
    visitId: data.id,
    scheduledOn: data.scheduled_on,
    propertyId: data.property_id,
    clientPackageId: data.client_package_id ?? null,
    packageDogId: pack?.dog_id ?? null,
  };
}

/** The dog this lesson is for: the package's dog when it lives at the
 * lesson's property, otherwise the only active dog there. */
async function lessonDog(db: TrainingDb, lesson: Lesson) {
  const { data, error } = await db
    .from("dogs")
    .select("id, name")
    .eq("property_id", lesson.propertyId)
    .eq("organization_id", lesson.orgId)
    .eq("active", true);
  if (error) throw new Error(error.message);
  const dogs = (data ?? []) as { id: string; name: string }[];
  return dogs.find((d) => d.id === lesson.packageDogId) ?? (dogs.length === 1 ? dogs[0] : null);
}

const HISTORY_LESSONS = 3;

export type LessonHistory = {
  visitId: string;
  scheduledOn: string;
  scores: { skill: string; score: number }[];
  note: string;
  homework: string;
};

/** The dog's last few completed lessons before this one, across its
 * packages. Without a known dog, the lessons of this package. Read through
 * RLS, so a trainer sees the lessons they are allowed to read. */
async function lessonHistory(
  db: TrainingDb,
  lesson: Lesson,
  dogId: string | null,
): Promise<LessonHistory[]> {
  let packageIds: string[] = lesson.clientPackageId ? [lesson.clientPackageId] : [];
  if (dogId) {
    const { data, error } = await db
      .from("client_packages")
      .select("id")
      .eq("organization_id", lesson.orgId)
      .eq("dog_id", dogId);
    if (error) throw new Error(error.message);
    packageIds = [
      ...new Set([...packageIds, ...((data ?? []) as { id: string }[]).map((p) => p.id)]),
    ];
  }
  if (!packageIds.length) return [];
  const { data: visits, error } = await db
    .from("visits")
    .select("id, scheduled_on")
    .eq("organization_id", lesson.orgId)
    .in("client_package_id", packageIds)
    .eq("status", "completed")
    .neq("id", lesson.visitId)
    .lte("scheduled_on", lesson.scheduledOn)
    .order("scheduled_on", { ascending: false })
    .limit(HISTORY_LESSONS);
  if (error) throw new Error(error.message);
  const rows = (visits ?? []) as { id: string; scheduled_on: string }[];
  if (!rows.length) return [];
  const ids = rows.map((v) => v.id);
  const [scores, notes, homework] = await Promise.all([
    db
      .from("session_progress")
      .select("visit_id, score, training_skills(name, sort_order)")
      .in("visit_id", ids),
    db.from("training_session_notes").select("visit_id, note").in("visit_id", ids),
    db.from("homework").select("visit_id, body").in("visit_id", ids),
  ]);
  for (const result of [scores, notes, homework])
    if (result.error) throw new Error(result.error.message);
  type ScoreRow = {
    visit_id: string;
    score: number;
    training_skills: { name: string; sort_order: number } | null;
  };
  return rows.map((v) => ({
    visitId: v.id,
    scheduledOn: v.scheduled_on,
    scores: ((scores.data ?? []) as ScoreRow[])
      .filter((s) => s.visit_id === v.id && s.training_skills)
      .sort((a, b) => a.training_skills!.sort_order - b.training_skills!.sort_order)
      .map((s) => ({ skill: s.training_skills!.name, score: s.score })),
    note:
      ((notes.data ?? []) as { visit_id: string; note: string }[]).find((n) => n.visit_id === v.id)
        ?.note ?? "",
    homework:
      ((homework.data ?? []) as { visit_id: string; body: string }[]).find(
        (h) => h.visit_id === v.id,
      )?.body ?? "",
  }));
}

function writeError(error: { code?: string; message: string }): Error {
  if (error.code === "42501") return new Error("Not authorized");
  return new Error(error.message);
}

export const listTrainingSkills = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as TrainingDb;
    const { orgId } = await resolveCaller(db, context.userId);
    const { data, error } = await db
      .from("training_skills")
      .select("id, name, sort_order, active")
      .eq("organization_id", orgId)
      .order("sort_order")
      .order("name");
    if (error) throw new Error(error.message);
    return { skills: data ?? [] };
  });

export const saveTrainingSkill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: id.optional(),
        name: z.string().trim().min(1).max(80),
        active: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const { orgId } = await resolveCaller(db, context.userId);
    const result = data.id
      ? await db
          .from("training_skills")
          .update({
            name: data.name,
            ...(data.active === undefined ? {} : { active: data.active }),
          })
          .eq("id", data.id)
          .eq("organization_id", orgId)
          .select("id")
          .single()
      : await db
          .from("training_skills")
          .insert({ organization_id: orgId, name: data.name, active: true })
          .select("id")
          .single();
    if (result.error) throw writeError(result.error);
    return { id: result.data.id };
  });

export const getSessionProgress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: id }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const visit = await trainingVisit(db, context.userId, data.visitId);
    const [skills, scores, note, homework] = await Promise.all([
      db
        .from("training_skills")
        .select("id, name, sort_order, active")
        .eq("organization_id", visit.orgId)
        .eq("active", true)
        .order("sort_order")
        .order("name"),
      db.from("session_progress").select("skill_id, score").eq("visit_id", visit.visitId),
      db.from("training_session_notes").select("note").eq("visit_id", visit.visitId).maybeSingle(),
      db.from("homework").select("body, due_on").eq("visit_id", visit.visitId).maybeSingle(),
    ]);
    for (const result of [skills, scores, note, homework]) {
      if (result.error) throw new Error(result.error.message);
    }
    const dog = await lessonDog(db, visit);
    return {
      skills: skills.data ?? [],
      scores: scores.data ?? [],
      note: note.data?.note ?? "",
      homework: homework.data?.body ?? "",
      homeworkDue: homework.data?.due_on ?? null,
      dog,
      history: await lessonHistory(db, visit, dog?.id ?? null),
    };
  });

export const saveSessionProgress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => progressInput.parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const visit = await trainingVisit(db, context.userId, data.visitId);
    for (const row of data.scores) {
      const problem = scoreProblem(row.score);
      if (problem) throw new Error(problem);
    }
    const note = progressText(data.note, 2000, "session note");
    if (note.problem) throw new Error(note.problem);
    const homework = progressText(data.homework, 2000, "homework");
    if (homework.problem) throw new Error(homework.problem);
    const seen = new Set<string>();
    for (const row of data.scores) {
      if (seen.has(row.skillId)) throw new Error("Score each skill once.");
      seen.add(row.skillId);
      const saved = await db.from("session_progress").upsert(
        {
          organization_id: visit.orgId,
          visit_id: visit.visitId,
          skill_id: row.skillId,
          score: row.score,
        },
        { onConflict: "visit_id,skill_id" },
      );
      if (saved.error) throw writeError(saved.error);
    }
    const drop = db.from("session_progress").delete().eq("visit_id", visit.visitId);
    const cleared =
      seen.size === 0 ? await drop : await drop.not("skill_id", "in", `(${[...seen].join(",")})`);
    if (cleared.error) throw writeError(cleared.error);
    if (note.text) {
      const saved = await db.from("training_session_notes").upsert({
        visit_id: visit.visitId,
        organization_id: visit.orgId,
        note: note.text,
      });
      if (saved.error) throw writeError(saved.error);
    } else {
      const removed = await db
        .from("training_session_notes")
        .delete()
        .eq("visit_id", visit.visitId);
      if (removed.error) throw writeError(removed.error);
    }
    if (homework.text) {
      const dog = await lessonDog(db, visit);
      const saved = await db.from("homework").upsert({
        visit_id: visit.visitId,
        organization_id: visit.orgId,
        dog_id: dog?.id ?? null,
        body: homework.text,
        due_on: data.homeworkDue ?? null,
      });
      if (saved.error) throw writeError(saved.error);
    } else {
      const removed = await db.from("homework").delete().eq("visit_id", visit.visitId);
      if (removed.error) throw writeError(removed.error);
    }
    return { ok: true };
  });
