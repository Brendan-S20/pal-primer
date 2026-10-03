// What is switched on at launch, in one place.
//
// Marketing posts are the one tenant-facing feature that stays a language
// model after 2026-10-03, because writing a Facebook post is a job about words
// rather than about numbers we already hold. It is not live at launch: the
// panel says "coming soon" and the server function refuses, so it cannot be
// reached by calling it directly either. The code behind it is kept intact,
// and turning it on is this one line.
export const MARKETING_AI_LAUNCHED = false;
