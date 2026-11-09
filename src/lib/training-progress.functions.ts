import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import {
  progressText,
  scoreProblem,
  skillTrends,
  type DatedScore,
  type SkillTrend,
} from "@/lib/training-progress";
import type { TrainingDb } from "@/lib/training-packages.server";

const id = z.string().uuid();

const progressInput = z.object({
  visitId: id,
  /** The dog this record is for. Omitted: the lesson's default dog. */
  dogId: id.nullable().optional(),
  scores: z.array(z.object({ skillId: id, score: z.number().int().min(1).max(5) })).max(40),
  note: z.string().max(2000).default(""),
  trainerNote: z.string().max(2000).default(""),
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

type Dog = { id: string; name: string };

/** The active dogs at the lesson's property: the dogs a lesson is recorded for. */
async function lessonDogs(db: TrainingDb, lesson: Lesson): Promise<Dog[]> {
  const { data, error } = await db
    .from("dogs")
    .select("id, name")
    .eq("property_id", lesson.propertyId)
    .eq("organization_id", lesson.orgId)
    .eq("active", true);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Dog[]).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** The dog a lesson opens on: the package's dog when it lives at the lesson's
 *  property, otherwise the only active dog there, otherwise none. */
function defaultDog(dogs: Dog[], lesson: Lesson): Dog | null {
  return dogs.find((d) => d.id === lesson.packageDogId) ?? (dogs.length === 1 ? dogs[0] : null);
}

export const CHOOSE_LESSON_DOG = "Choose which dog this progress is for.";

/** The dog a save is about. A dog named by the caller must be at the lesson;
 *  with none named, the default, and at a house of several dogs with no
 *  default the caller has to choose. Null only where no dog is on file. */
function pickDog(dogs: Dog[], lesson: Lesson, dogId: string | null | undefined): Dog | null {
  if (dogId) {
    const dog = dogs.find((d) => d.id === dogId);
    if (!dog) throw new Error("Choose a dog at this lesson.");
    return dog;
  }
  if (!dogs.length) return null;
  const fallback = defaultDog(dogs, lesson);
  if (!fallback) throw new Error(CHOOSE_LESSON_DOG);
  return fallback;
}

const HISTORY_LESSONS = 3;
const PROGRESS_ROWS = 500;

export type LessonHistory = {
  visitId: string;
  scheduledOn: string;
  scores: { skill: string; score: number }[];
  note: string;
  trainerNote: string;
  homework: string;
};

type Embedded<T> = T | T[] | null;
function one<T>(v: Embedded<T>): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
type LessonRef = { scheduled_on: string };

/** One record's rows for this dog, from its completed lessons before this
 *  one. Keyed by the dog, so a lesson outside any package counts and a second
 *  dog at the house is never mixed in. Without a dog on file, the
 *  whole-lesson records at this property. */
// The builder is typed per table; the filters are the same on all three.
function priorRecords(query: any, lesson: Lesson, dogId: string | null) {
  const base = query
    .eq("organization_id", lesson.orgId)
    .eq("visits.status", "completed")
    .lte("visits.scheduled_on", lesson.scheduledOn)
    .neq("visit_id", lesson.visitId);
  const scoped = dogId
    ? base.eq("dog_id", dogId)
    : base.is("dog_id", null).eq("visits.property_id", lesson.propertyId);
  return scoped.limit(PROGRESS_ROWS);
}

/** The dog's last few lessons in full, and every skill's scores over time.
 *  Read through RLS, so a trainer sees the lessons they are allowed to read. */
async function dogProgress(
  db: TrainingDb,
  lesson: Lesson,
  dogId: string | null,
): Promise<{ history: LessonHistory[]; trends: SkillTrend[] }> {
  const visit = "visits!inner(scheduled_on, status, property_id)";
  const [scores, notes, homework] = await Promise.all([
    priorRecords(
      db
        .from("session_progress")
        .select(`visit_id, score, training_skills(name, sort_order), ${visit}`),
      lesson,
      dogId,
    ),
    priorRecords(
      db.from("training_session_notes").select(`visit_id, note, trainer_note, ${visit}`),
      lesson,
      dogId,
    ),
    priorRecords(db.from("homework").select(`visit_id, body, ${visit}`), lesson, dogId),
  ]);
  for (const result of [scores, notes, homework])
    if (result.error) throw new Error(result.error.message);
  type ScoreRow = {
    visit_id: string;
    score: number;
    training_skills: Embedded<{ name: string; sort_order: number }>;
    visits: Embedded<LessonRef>;
  };
  type NoteRow = {
    visit_id: string;
    note: string | null;
    trainer_note: string | null;
    visits: Embedded<LessonRef>;
  };
  type HomeworkRow = { visit_id: string; body: string; visits: Embedded<LessonRef> };
  const scoreRows = (scores.data ?? []) as ScoreRow[];
  const noteRows = (notes.data ?? []) as NoteRow[];
  const homeworkRows = (homework.data ?? []) as HomeworkRow[];

  const dated: DatedScore[] = scoreRows.flatMap((s) => {
    const skill = one(s.training_skills);
    const v = one(s.visits);
    return skill && v
      ? [
          {
            visitId: s.visit_id,
            scheduledOn: v.scheduled_on,
            skill: skill.name,
            sortOrder: skill.sort_order,
            score: s.score,
          },
        ]
      : [];
  });
  const lessons = new Map<string, string>();
  for (const row of [...scoreRows, ...noteRows, ...homeworkRows]) {
    const v = one(row.visits);
    if (v) lessons.set(row.visit_id, v.scheduled_on);
  }
  const recent = [...lessons.entries()]
    .sort(([a, x], [b, y]) => y.localeCompare(x) || b.localeCompare(a))
    .slice(0, HISTORY_LESSONS);
  const history = recent.map(([visitId, scheduledOn]) => {
    const note = noteRows.find((n) => n.visit_id === visitId);
    return {
      visitId,
      scheduledOn,
      scores: dated
        .filter((d) => d.visitId === visitId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.skill.localeCompare(b.skill))
        .map((d) => ({ skill: d.skill, score: d.score })),
      note: note?.note ?? "",
      trainerNote: note?.trainer_note ?? "",
      homework: homeworkRows.find((h) => h.visit_id === visitId)?.body ?? "",
    };
  });
  return { history, trends: skillTrends(dated) };
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
    // The skill list is the business's curriculum, set where prices are set.
    // The settings card is drawn for manage_pricing; the server asks the same.
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(db, context.userId, "manage_pricing");
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

/** Narrow a per-record query to one dog, or to the whole-lesson record. */
function forDog<Q>(query: Q, dogId: string | null): Q {
  // Every per-record builder has eq and is; the generic keeps its own type.
  const q = query as unknown as {
    eq: (col: string, v: string) => Q;
    is: (col: string, v: null) => Q;
  };
  return dogId ? q.eq("dog_id", dogId) : q.is("dog_id", null);
}

export const getSessionProgress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: id, dogId: id.nullable().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const visit = await trainingVisit(db, context.userId, data.visitId);
    const dogs = await lessonDogs(db, visit);
    // A read never refuses: a house of several dogs with no default opens on
    // the first, and the panel asks the trainer to choose.
    const named = data.dogId ? dogs.find((d) => d.id === data.dogId) : null;
    if (data.dogId && !named) throw new Error("Choose a dog at this lesson.");
    const dog = named ?? defaultDog(dogs, visit) ?? dogs[0] ?? null;
    const dogId = dog?.id ?? null;
    const [skills, scores, note, homework, org] = await Promise.all([
      db
        .from("training_skills")
        .select("id, name, sort_order, active")
        .eq("organization_id", visit.orgId)
        .eq("active", true)
        .order("sort_order")
        .order("name"),
      forDog(
        db.from("session_progress").select("skill_id, score").eq("visit_id", visit.visitId),
        dogId,
      ),
      forDog(
        db
          .from("training_session_notes")
          .select("note, trainer_note")
          .eq("visit_id", visit.visitId),
        dogId,
      ).maybeSingle(),
      forDog(
        db.from("homework").select("body, due_on").eq("visit_id", visit.visitId),
        dogId,
      ).maybeSingle(),
      db.from("organizations").select("training_share_progress").eq("id", visit.orgId).single(),
    ]);
    for (const result of [skills, scores, note, homework, org]) {
      if (result.error) throw new Error(result.error.message);
    }
    const progress = await dogProgress(db, visit, dogId);
    return {
      skills: skills.data ?? [],
      scores: scores.data ?? [],
      note: note.data?.note ?? "",
      trainerNote: note.data?.trainer_note ?? "",
      /** Whether the client portal shows `note`. It never shows `trainerNote`. */
      shared: org.data?.training_share_progress !== false,
      homework: homework.data?.body ?? "",
      homeworkDue: homework.data?.due_on ?? null,
      /** Every dog at the lesson. More than one: the panel asks which. */
      dogs,
      dog,
      /** Whether the panel opened on a dog nobody chose (several dogs, no package dog). */
      dogGuessed: !named && dogs.length > 1 && !defaultDog(dogs, visit),
      history: progress.history,
      trends: progress.trends,
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
    const trainerNote = progressText(data.trainerNote, 2000, "trainer note");
    if (trainerNote.problem) throw new Error(trainerNote.problem);
    const homework = progressText(data.homework, 2000, "homework");
    if (homework.problem) throw new Error(homework.problem);
    const dog = pickDog(await lessonDogs(db, visit), visit, data.dogId);
    const dogId = dog?.id ?? null;
    const seen = new Set<string>();
    for (const row of data.scores) {
      if (seen.has(row.skillId)) throw new Error("Score each skill once.");
      seen.add(row.skillId);
      const saved = await db.from("session_progress").upsert(
        {
          organization_id: visit.orgId,
          visit_id: visit.visitId,
          dog_id: dogId,
          skill_id: row.skillId,
          score: row.score,
        },
        { onConflict: "visit_id,dog_id,skill_id" },
      );
      if (saved.error) throw writeError(saved.error);
    }
    const drop = forDog(db.from("session_progress").delete().eq("visit_id", visit.visitId), dogId);
    const cleared =
      seen.size === 0 ? await drop : await drop.not("skill_id", "in", `(${[...seen].join(",")})`);
    if (cleared.error) throw writeError(cleared.error);
    if (note.text || trainerNote.text) {
      const saved = await db.from("training_session_notes").upsert(
        {
          visit_id: visit.visitId,
          organization_id: visit.orgId,
          dog_id: dogId,
          note: note.text || null,
          trainer_note: trainerNote.text || null,
        },
        { onConflict: "visit_id,dog_id" },
      );
      if (saved.error) throw writeError(saved.error);
    } else {
      const removed = await forDog(
        db.from("training_session_notes").delete().eq("visit_id", visit.visitId),
        dogId,
      );
      if (removed.error) throw writeError(removed.error);
    }
    if (homework.text) {
      const saved = await db.from("homework").upsert(
        {
          visit_id: visit.visitId,
          organization_id: visit.orgId,
          dog_id: dogId,
          body: homework.text,
          due_on: data.homeworkDue ?? null,
        },
        { onConflict: "visit_id,dog_id" },
      );
      if (saved.error) throw writeError(saved.error);
    } else {
      const removed = await forDog(
        db.from("homework").delete().eq("visit_id", visit.visitId),
        dogId,
      );
      if (removed.error) throw writeError(removed.error);
    }
    return { ok: true, dogId };
  });
