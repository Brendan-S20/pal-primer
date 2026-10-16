import { RECEPTIONIST_LAUNCHED } from "@/lib/receptionist-launch";

// What is switched on at launch, in one place.
//
// Marketing posts are the one tenant-facing feature that stays a language
// model after 2026-10-03, because writing a Facebook post is a job about words
// rather than about numbers we already hold. It is not live at launch: the
// panel says "coming soon" and the server function refuses, so it cannot be
// reached by calling it directly either. The code behind it is kept intact,
// and turning it on is this one line.
export const MARKETING_AI_LAUNCHED = false;

/** Is any feature that runs on a model live? The receptionist and marketing
 *  posts are the only two. While neither is, Settings > AI usage says AI is
 *  coming soon and shows no error card and no meter: a "temporarily
 *  unavailable ... configuration issue" warning about features nobody can
 *  use yet reads as a broken account (#428). */
export const ANY_AI_FEATURE_LIVE = MARKETING_AI_LAUNCHED || RECEPTIONIST_LAUNCHED;
