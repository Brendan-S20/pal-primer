// Server-only half of the calendar feed: making a token and hashing one.
//
// The token is 32 bytes from the OS CSPRNG. The database stores its SHA-256
// and never the token, so the only copy of a working URL is the one shown to
// the person once, when they make it. Looking a token up means hashing what
// arrived and asking the unique index for that digest: the comparison is on a
// value the caller cannot steer byte by byte, which is what makes it safe
// against timing without a constant-time compare of our own.

import { createHash, randomBytes } from "node:crypto";
import { FEED_TOKEN_RE } from "@/lib/calendar-feed";

export function newFeedToken(): string {
  const t = randomBytes(32).toString("base64url");
  // 32 bytes is always 43 base64url characters; this cannot fail, and if it
  // ever did the route would refuse every link made with it.
  if (!FEED_TOKEN_RE.test(t)) throw new Error("token shape");
  return t;
}

export function hashFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
