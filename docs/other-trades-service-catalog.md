# Other trades: the service catalog and scheduling (step 2)

Status: design, not built. Written 2026-10-08 alongside step 1 (service lines,
migration `20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql`).
Size: L. Read the first section in ten minutes; the appendix is for whoever
builds it.

## The decision in one paragraph

Step 1 lets a business say what it runs and hides the pet-waste modules from
one that does not. It does **not** let a dog walker run their business,
because the data model can only book one kind of job, once a day, for dogs.
Step 2 adds a `services` table, lets plans and visits point at a service,
replaces "one visit per plan per day" with time slots, adds a weekday-set
cadence, and turns `dogs` into `pets` with a species. Each change is additive
and backfilled so that every current pet-waste org keeps working through every
deploy. Six phases, about five to seven weeks of work in total, with the risk
concentrated in phase 3 (the visit uniqueness change) and phase 5 (pricing).

## What blocks a walker today (verified against the code)

| Blocker | Where | Why it blocks |
|---|---|---|
| No service on a plan or a visit | `src/components/schedule/ScheduleCalendar.tsx:87-100` says so in as many words ("there is no services table and no per-visit service column, because the product sells one service"); `src/components/client-detail/ServicesTab.tsx:406-407` hardcodes "Recurring pet waste removal" | A walker sells a 30-minute walk, a 60-minute walk and a drop-in; there is nowhere to say which a visit is |
| One visit per plan per day | `UNIQUE (subscription_id, scheduled_on)` in `supabase/migrations/20260701161233_3e8bb77f-….sql:66` | A midday walk plus an evening walk for the same dog is two visits on one day for one plan; the insert collides |
| Cadence is an enum of five | `service_frequency` in `supabase/migrations/20260701160430_6415de81-….sql:11` (`weekly, biweekly, twice_weekly, monthly, one_time`; `every_n_days` added later) | "Mon/Wed/Fri" is not expressible; `twice_weekly` is the only day-array loop, and `generate_visits_core` honours `preferred_weekdays` for `weekly`/`biweekly` only (`20260806050000_changing-a-customers-service-day-did-nothing.sql:38-40, 78`) |
| Dogs only | `public.dogs` (`20260701160430…sql:221`), `dog_temperament` enum (`:10`), `subscriptions.dog_count` with a CHECK that residential plans carry it (`:255-264`) | A sitter's client has two cats; a groomer prices per pet and per size |
| Price is per yard, per dog, per frequency | `computeZoneVisitPrice` (`src/lib/pricing.ts:44-46`), `frequency_multipliers` default `{weekly 1.0, biweekly 1.7, twice_weekly 1.8, monthly 3.2}` (`20260701215820_…sql:10`) | A walk costs the same whether weekly or monthly; the multiplier exists because waste accumulates |
| Stop duration is per property | `properties.service_duration_min DEFAULT 8` (`20260702005539_…sql:6`), read by the route planner | A walk is 30 or 60 minutes depending on the service, not the address |

What is already universal and does not change: clients, properties, routes and
the planner (given durations), My Day, invoices and payments, the portal shell,
timesheets, reports, time windows on plans (`earliest_time`/`latest_time`,
`20260716150000_service-windows-on-subscriptions.sql:8`), the visit checklist,
photos, and step 1's `service_lines`.

## The schema, in brief

1. **`services`**: `id, organization_id, line (service_lines value), name,
   duration_min, base_price_cents, extra_pet_cents, active, sort`, plus RLS by
   org, `require_mfa_policy('public.services')`, and a unique `(organization_id,
   lower(name))`. This is what the add-on catalog (`addon_services`) almost is;
   keep add-ons separate, because an add-on rides on a visit and a service *is*
   the visit.
2. **`subscriptions.service_id`** and **`visits.service_id`**, nullable, then
   backfilled to each org's seeded "Pet waste removal" service, then NOT NULL.
   A visit copies its plan's service at generation time so editing a plan
   does not rewrite history (same rule the checklist follows).
3. **Time slots.** `visits.slot_start time` (nullable). Replace
   `UNIQUE (subscription_id, scheduled_on)` with a unique index on
   `(subscription_id, scheduled_on, coalesce(slot_start, '00:00'))`. A plan
   with no slots behaves exactly as today. A plan's slots live in
   `subscriptions.slots time[]` (e.g. `{11:00,16:00}`).
4. **Weekday-set cadence.** New `service_frequency` value `weekdays` plus
   `subscriptions.weekdays smallint[]` (0 = Sunday, the numbering
   `preferred_weekdays` already uses). `twice_weekly` becomes a special case
   that can stay as is; `generate_visits_core` gets one more branch.
5. **Pets.** New `pets` table (`species` text with a CHECK: dog, cat, other;
   `size` optional, for grooming), the dogs migrated into it with
   `species = 'dog'`, and `dogs` kept as a view over `pets WHERE species =
   'dog'` for one release so nothing reading it breaks. `subscriptions.pet_count`
   added beside `dog_count`; the residential CHECK accepts either.

## How each part of the product changes

- **Pricing and quotes.** Price = the service's base price + extra-pet fee per
  pet beyond the first, × units (1 per visit, minutes ÷ 60 per hour, nights
  per night), × the line's frequency multiplier (flat 1.0 for every line
  except pet waste; step 1's `LINE_SEEDS` holds the proposed values). Zone
  pricing and area pricing stay the pet-waste path, chosen when the service's
  line is `pet_waste`. `public_quote` gains a `_service_id` argument.
  *Built 2026-10-11 (phase 5): the rule is `public.service_price_cents`
  (migration `20261011100000`) and `servicePriceCents` (`src/lib/services.ts`),
  held to one table by `tests/a-walk-is-priced-as-a-walk.test.ts`; the drift
  report compares a non-waste plan against its service; the invoice line names
  the visit's service (`20261011100100`); the portal lists the business's
  services and the request records the one asked for (`20261011100200`).
  Hourly prices round once, to the cent, by the minute. The public paths
  followed the same day (migration `20261011150000`): `public_services(_slug)`
  is the anon door onto the catalog (same gate and slug resolution as
  `public_quote`, active and priced services plus the zone-priced pet-waste
  one, no organization column); the signup and quote form shows a picker when
  there is more than one and passes `_service_id` to both quote calls; the
  pick is recorded on `leads.service_id` and `signup_requests.service_id` and
  copied onto the plan the webhook provisions; the AI receptionist gets a
  `list_services` tool and books a service through `portal_request_one_off`
  and `bookOneOffVisit` at the service's price. A business that sells one
  thing sees none of it, held there by
  `tests/a-stranger-can-see-what-is-for-sale.test.ts`.*
- **Visit generation.** Per plan: for each day the cadence selects, one visit
  per slot (one, with a null slot, when the plan has none). Duration copied
  from the service onto the visit.
- **Invoicing.** The line item reads the visit's service name instead of the
  hardcoded one. Nothing else changes: the price is already on the visit.
- **Portal booking.** The one-off booking (`src/lib/one-off-booking.ts`) lists
  the org's active services instead of "extra cleanup"; the re-clean button
  (hidden for non-waste orgs since step 1) stays pet-waste-only.
- **Imports.** `src/lib/import-services.ts` maps a row's service name to a
  `services` row, creating it on first sight; weekday words already parse.
- **Routing durations.** The planner reads `visits.duration_min` when set,
  falling back to `properties.service_duration_min`. A slot becomes the
  visit's time window when the plan has none.
- **My Day.** Shows the service name and slot on the card; the yard outline
  prompt is already hidden for non-waste orgs.

## Migration order (zero downtime for today's orgs)

Each step deploys and runs on its own; at no point does a pet-waste org see a
difference.

1. Create `services`; seed one "Pet waste removal" service per org from its
   zone base prices (the replay-safe way: an `INSERT … SELECT` over whatever
   orgs exist, no assertion about how many). Ship the read-only Services
   settings page.
2. Add nullable `service_id` to plans and visits; backfill; the app starts
   writing it; then `SET NOT NULL` in a later file once the backfill is proven.
3. Add `slot_start`; create the new unique index `CONCURRENTLY` in its own
   file (no transaction), then drop the old constraint in the next file. Every
   `ON CONFLICT (subscription_id, scheduled_on)` in `src/` and in SQL functions
   moves to the new index first; a test lists them.
4. Add `weekdays` frequency and array; teach `generate_visits_core`.
5. Pricing by service; `public_quote` and the wizard read the service.
6. `pets` table, migrate dogs, `dogs` becomes a view; species in the UI.
   Then make the other lines bookable in `BOOKABLE_SERVICE_LINES` and the
   onboarding seeds below.

## What each trade's onboarding seeds

| Line | Services seeded | Checklist suggestions | Cadence default |
|---|---|---|---|
| Pet waste | "Pet waste removal" (today's zone pricing) | today's four (`SUGGESTED_CHECKLIST`) | weekly |
| Dog walking | "30-minute walk", "60-minute walk", "Drop-in visit (20 min)" | collected and returned; locked and latched; water; note left | weekdays Mon–Fri, one slot |
| Pet sitting | "Drop-in (30 min)", "Overnight stay" | fed and watered; medication; litter/yard; locked, lights | one-time date range |
| Mobile grooming | "Bath and brush (60 min)", "Full groom (90 min)", "Nail trim (15 min)" | coat checked; nails; ears; returned dry | every 4–6 weeks |

Prices are left blank on purpose, as the first-cleanup tiers are: a suggested
number is the one that ships unread. Checklists and add-on examples are
already in `LINE_SEEDS` (`src/lib/service-lines.ts`) and a test holds the
pet-waste values identical to today's.

## Terminology (about ten keys)

Through i18next **context**, so the base key stays and each line adds a
variant: `t("term.visit", { context: line })` falls back to `term.visit` when
there is no `term.visit_dog_walking`. All four locales (en, es, ar, zh) get
every variant, and `tests/en-and-es-have-the-same-keys.test.ts` already
requires it.

| Key | pet_waste (base) | dog_walking | pet_sitting | mobile_grooming |
|---|---|---|---|---|
| `term.visit` | Visit | Walk | Visit | Appointment |
| `term.service` | Cleanup | Walk | Sit | Groom |
| `term.pet` | Dog | Dog | Pet | Pet |
| `term.site` | Yard | Home | Home | Driveway |
| `term.complete` | Mark cleaned | Mark walked | Mark done | Mark groomed |
| `term.firstVisit` | First cleanup | Meet and greet | Meet and greet | First groom |
| `term.skip` | Skip cleanup | Skip walk | Skip visit | Skip appointment |
| `term.notes` | Yard notes | Walk notes | Care notes | Groom notes |
| `term.access` | Gate code | Key or lockbox | Key or lockbox | Parking |
| `term.photo` | Yard photo | Walk photo | Visit photo | After photo |

A multi-line org (pet waste plus walking) uses the base term on shared
screens and the visit's own service line on a visit card.

## Phases, sizes, risks

| # | Phase | Size | Main risk |
|---|---|---|---|
| 1 | `services` table, seed, Services settings page | S | Seeding per org must replay into an empty DB (no assertion about org count) |
| 2 | `service_id` on plans and visits, backfill, write path | M | Two writers during the window (app and SQL functions); NOT NULL only after a proof that nothing writes null |
| 3 | Time slots, swap the uniqueness | M | Every `ON CONFLICT` target must move first or generation silently doubles or fails; index built `CONCURRENTLY` |
| 4 | Weekday-set cadence | S | `generate_visits_core` is shared by nightly and on-demand generation; mutation-test against the 20260806 fix |
| 5 | Pricing and quotes by service | M | Repricing must not touch pet-waste plans; `pricing-drift` and the public quote must agree (one function, as first cleanup does) |
| 6 | Pets, species, open the other lines | M | `dogs` → view must keep every RLS path and the portal's dog list; the tech screens need new i18n keys in four locales |

Cross-cutting risks: the Lovable agent edits `src/` and needs the new rule
(below) in project knowledge before phase 2; the viewport fixtures need a
non-waste dataset with services, slots and cats, or the sweeps measure the
fallback (step 1 added the first such fixture).

---

## Appendix

### A. Proposed DDL sketch (phase 1–3)

```sql
CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  line text NOT NULL CHECK (line IN ('pet_waste','dog_walking','pet_sitting','mobile_grooming','other')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  duration_min smallint NOT NULL CHECK (duration_min BETWEEN 1 AND 720),
  base_price_cents integer CHECK (base_price_cents >= 0),
  extra_pet_cents integer NOT NULL DEFAULT 0 CHECK (extra_pet_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  sort smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX services_org_name ON public.services (organization_id, lower(name));
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.services');
-- members read; manage_pricing writes (same split as zones)

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id);
ALTER TABLE public.visits        ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id);
ALTER TABLE public.visits        ADD COLUMN IF NOT EXISTS slot_start time;
ALTER TABLE public.visits        ADD COLUMN IF NOT EXISTS duration_min smallint;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS slots time[];
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS weekdays smallint[];

-- separate file, no transaction:
CREATE UNIQUE INDEX CONCURRENTLY visits_sub_day_slot
  ON public.visits (subscription_id, scheduled_on, coalesce(slot_start, '00:00'::time));
-- next file:
ALTER TABLE public.visits DROP CONSTRAINT visits_subscription_id_scheduled_on_key;
```

Check the actual constraint name on a replayed database before writing the
drop; the 20260701 file declares it inline, so Postgres named it.

### B. Things step 1 deliberately left for step 2

- `BOOKABLE_SERVICE_LINES` is `["pet_waste"]`; phase 6 widens it, and the
  "coming soon" badges on Settings → Business defaults go away by themselves.
- `LINE_SEEDS.*.frequencyMultipliers` and `estTime` for the new lines are
  data only; signup reads them when it seeds a non-waste org.
- `/get-started` (the Twilio-reviewed signup) has no line picker. Adding one is
  a separate change with its own review, after phase 6.
- The public signup (`src/components/signup/SignupFlow.tsx`) is pet-waste
  shaped throughout (dog count, "when was your yard last cleaned"); it is not
  gated in step 1 because hiding the first-cleanup line while the server still
  charged it would misstate the total. It becomes service-driven in phase 5.
- Photo kinds and skip reasons are still waste-flavoured codes; they move to
  terminology keys in phase 6.

### C. The rule to add to CLAUDE.md and Lovable knowledge when phase 2 lands

"A visit says what service it is. Every insert into `visits` sets
`service_id`; nothing reads a service name from a constant." Enforced by a test
that scans `src/` and `supabase/migrations/` for visit inserts without it,
parsed rather than grepped, the way the fragment-key rule is.
