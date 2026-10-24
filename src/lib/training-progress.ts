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
