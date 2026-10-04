// The tables whose row counts are watched every night and must come back
// exactly in every restore drill.
//
// One list, imported by every script that counts, so the nightly summary and
// the drill cannot drift into checking different things. auth.users is here
// because a restore that brings back every invoice and none of the logins is
// a restore nobody can use: every account is a row in auth.users, and the
// public tables point at it.
//
// MUST_NOT_BE_EMPTY is the guard against the failure this repo keeps finding
// in other checks: "every restored count equals every dumped count" is TRUE of
// a dump that contained nothing. Production has tenants and accounts; a dump
// with none of either is broken, whatever the comparison says.

export const KEY_TABLES = [
  "public.organizations",
  "public.clients",
  "public.properties",
  "public.visits",
  "public.invoices",
  "public.payments",
  "auth.users",
];

export const MUST_NOT_BE_EMPTY = ["public.organizations", "auth.users"];
