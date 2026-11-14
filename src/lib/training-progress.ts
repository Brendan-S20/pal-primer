/** The skills a new training business starts with. The owner renames them. */
export const DEFAULT_TRAINING_SKILLS = ["Sit", "Down", "Stay", "Leash manners", "Come"] as const;

export type SkillScore = { skillId: string; score: number };

/** Why a score cannot be saved, or null when it is 1 through 5. */
export function scoreProblem(score: unknown): string | null {
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5)
    return "Score each skill from 1 to 5.";
  return null;
}

/** A trimmed note, or a sentence when it is too long. A blank field is neither. */
export function progressText(
  value: string,
  max: number,
  what: string,
): { text: string | null; problem: string | null } {
  const text = value.trim();
  if (!text) return { text: null, problem: null };
  if (text.length > max)
    return { text: null, problem: `Keep the ${what} to ${max} characters or fewer.` };
  return { text, problem: null };
}

/** One score a dog was given on one lesson. */
export type DatedScore = {
  visitId: string;
  scheduledOn: string;
  skill: string;
  sortOrder: number;
  score: number;
};

/** A skill's scores for one dog, oldest first, with where it started and stands. */
export type SkillTrend = {
  skill: string;
  /** The last few scores, oldest first. */
  scores: number[];
  first: number;
  latest: number;
  /** How many lessons scored this skill. */
  lessons: number;
};

const TREND_POINTS = 6;

/** Each skill's progress for one dog over time, in the business's skill
 *  order. A skill scored twice on one lesson counts once (the later row). */
export function skillTrends(rows: readonly DatedScore[], points = TREND_POINTS): SkillTrend[] {
  const bySkill = new Map<string, { sort: number; byLesson: Map<string, DatedScore> }>();
  for (const row of rows) {
    const entry = bySkill.get(row.skill) ?? { sort: row.sortOrder, byLesson: new Map() };
    entry.byLesson.set(row.visitId, row);
    bySkill.set(row.skill, entry);
  }
  return [...bySkill.entries()]
    .sort(([a, x], [b, y]) => x.sort - y.sort || a.localeCompare(b))
    .map(([skill, { byLesson }]) => {
      const ordered = [...byLesson.values()].sort(
        (a, b) => a.scheduledOn.localeCompare(b.scheduledOn) || a.visitId.localeCompare(b.visitId),
      );
      return {
        skill,
        scores: ordered.slice(-points).map((r) => r.score),
        first: ordered[0].score,
        latest: ordered[ordered.length - 1].score,
        lessons: ordered.length,
      };
    });
}
