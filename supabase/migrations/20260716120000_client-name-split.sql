-- QA follow-up 4.2: split client names into first/last (+ optional company)
-- with display-name logic. display_name stays the canonical rendered name
-- everywhere; the parts let the edit drawer and future exports work
-- properly. Backfill: first word -> first_name, remainder -> last_name.
ALTER TABLE public.clients
  ADD COLUMN first_name text,
  ADD COLUMN last_name text,
  ADD COLUMN company text;

UPDATE public.clients
   SET first_name = NULLIF(split_part(btrim(display_name), ' ', 1), ''),
       last_name = NULLIF(btrim(substring(btrim(display_name) FROM position(' ' IN btrim(display_name) || ' '))), '')
 WHERE display_name IS NOT NULL AND first_name IS NULL;
