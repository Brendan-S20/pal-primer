/** What a dog-walking client can report about a walk (#410). Pure, so the
 *  portal, the server function and the tests read one copy.
 *
 *  A walk is not a yard visit. "Missed spot" and "Wrong yard serviced" mean
 *  nothing on a walk, and the re-clean guarantee is for pet waste only. So a
 *  walk gets its own list of issues.
 *
 *  qc_tickets.category is a CHECK constraint, and this adds nothing to it.
 *  Each walk issue is stored as a category the table already takes, with the
 *  issue in plain words at the start of the message, so the office reads what
 *  the client picked.
 *
 *  The portal shows the English. It speaks the business's language (CLAUDE.md,
 *  "What stays English"). The other three are here so the copy exists the day
 *  the portal follows a language, and a test holds all four to the same codes. */

export const WALK_ISSUE_CODES = [
  "walk_short",
  "walker_late",
  "dog_problem",
  "left_unsecured",
  "walk_other",
] as const;
export type WalkIssue = (typeof WALK_ISSUE_CODES)[number];

/** The yard options a walk never offers and the server refuses on a walk. */
export const YARD_ONLY_CONCERNS = ["missed_spot", "wrong_yard"] as const;

/** The existing qc_tickets category each walk issue is stored as. */
export const WALK_ISSUE_CATEGORY: Record<WalkIssue, "other" | "gate_left_open"> = {
  walk_short: "other",
  walker_late: "other",
  dog_problem: "other",
  left_unsecured: "gate_left_open",
  walk_other: "other",
};

export const WALK_ISSUE_LABELS: Record<"en" | "es" | "ar" | "zh", Record<WalkIssue, string>> = {
  en: {
    walk_short: "The walk was shorter than booked",
    walker_late: "The walker was late or did not come",
    dog_problem: "My dog came back hurt, dirty or off lead",
    left_unsecured: "A gate, door or key was left unsecured",
    walk_other: "Something else",
  },
  es: {
    walk_short: "El paseo fue más corto de lo reservado",
    walker_late: "El paseador llegó tarde o no vino",
    dog_problem: "Mi perro volvió herido, sucio o sin correa",
    left_unsecured: "Una reja, puerta o llave quedó sin asegurar",
    walk_other: "Otra cosa",
  },
  ar: {
    walk_short: "كانت النزهة أقصر من المحجوز",
    walker_late: "تأخر المُمشّي أو لم يأتِ",
    dog_problem: "عاد كلبي مصابًا أو متسخًا أو بلا مقود",
    left_unsecured: "تُركت بوابة أو باب أو مفتاح دون تأمين",
    walk_other: "شيء آخر",
  },
  zh: {
    walk_short: "遛狗时间比预订的短",
    walker_late: "遛狗员迟到或没有来",
    dog_problem: "我的狗回来时受伤、弄脏或没拴绳",
    left_unsecured: "大门、房门或钥匙没有锁好",
    walk_other: "其他",
  },
};

/** The portal's options for a walk, in English. */
export const WALK_CONCERN_OPTIONS: Array<{ value: WalkIssue; label: string }> = WALK_ISSUE_CODES.map(
  (value) => ({ value, label: WALK_ISSUE_LABELS.en[value] }),
);

export function isWalkIssue(v: unknown): v is WalkIssue {
  return typeof v === "string" && (WALK_ISSUE_CODES as readonly string[]).includes(v);
}

/** What is stored for a walk issue: an existing category, and the message
 *  with the issue in front of it. */
export function walkConcernRow(
  issue: WalkIssue,
  message: string,
): { category: "other" | "gate_left_open"; message: string } {
  const head = `Walk: ${WALK_ISSUE_LABELS.en[issue]}.`;
  const body = message.trim();
  return { category: WALK_ISSUE_CATEGORY[issue], message: body ? `${head} ${body}` : head };
}

/** Whether a visit's service line is a dog walk. */
export function isWalkLine(serviceLine: string | null | undefined): boolean {
  return serviceLine === "dog_walking";
}
