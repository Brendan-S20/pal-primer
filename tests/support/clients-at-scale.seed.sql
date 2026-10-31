-- Grows the E2E tenant to 5,000 clients for tests/clients-at-scale.test.ts
-- (#617). LOCAL DATABASE ONLY: run after `npm run test:e2e:seed`, as the
-- postgres superuser, e.g.
--   psql postgresql://postgres:postgres@127.0.0.1:54422/postgres \
--     -v org="'<org id the seed printed>'" -f tests/support/clients-at-scale.seed.sql
-- session_replication_role skips triggers (the plan limit among them) so the
-- rows go in at once; the reads being measured do not depend on them.
begin;
set local session_replication_role = replica;
with org as (select :org::uuid id),
c as (
  insert into clients (id, organization_id, display_name, account_type, primary_email, primary_phone, active, tags, churn_score, company, import_external_id)
  select gen_random_uuid(), org.id,
    case when g % 97 = 0 then 'José Núñez ' || g else 'Scale Client ' || g end,
    (case when g % 4 = 1 then 'commercial' else 'residential' end)::account_type,
    'scale' || g || '@example.test', '(312) 555-' || lpad((g % 10000)::text, 4, '0'),
    g % 10 <> 0, case when g % 2 = 0 then array['Weekly'] else array['VIP'] end, (g % 100),
    case when g % 50 = 0 then 'Harbor Point HOA' end, 'JOB-' || g
  from org, generate_series(1, 4990) g
  returning id, organization_id
),
p as (
  insert into properties (id, organization_id, client_id, street, city, postal_code)
  select gen_random_uuid(), c.organization_id, c.id, (100 + row_number() over ())::text || ' Oak Street', 'Chicago', '60610' from c
  returning id, organization_id, client_id
),
d as (
  insert into dogs (organization_id, property_id, name) select p.organization_id, p.id, 'Rex' from p returning 1
),
s as (
  insert into subscriptions (organization_id, client_id, property_id, account_type, frequency, price_cents, status, dog_count)
  select p.organization_id, p.client_id, p.id, 'residential', 'weekly', 2400, 'active', 1 from p where random() < 0.7 returning 1
)
insert into invoices (organization_id, client_id, number, period_end, status, total_cents)
select p.organization_id, p.client_id, 100000 + row_number() over (), current_date, 'open', 4500 from p where random() < 0.2;
commit;
analyze clients; analyze properties; analyze dogs; analyze subscriptions; analyze invoices;
