-- QA finding 7: the name-split backfill treated commercial clients like
-- people ("Acme Property Management" -> first "Acme", last "Property
-- Management"). Companies belong in company, with no person-name parts.
UPDATE public.clients
   SET company = display_name,
       first_name = NULL,
       last_name = NULL
 WHERE account_type = 'commercial'
   AND company IS NULL
   AND (first_name IS NOT NULL OR last_name IS NOT NULL);
