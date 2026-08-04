-- Nine tables still carried the pre-permission-matrix `is_org_member` read
-- from 2026-07-01, while every server read of the same data has since required
-- `view_client_directory` — a permission `tech` deliberately does not hold.
--
-- `permissions.ts:14` defines it as "client names/addresses BEYOND the caller's
-- own assigned work". The server honoured that; the tables did not.
--
-- ── WHAT A TECH COULD DO ──────────────────────────────────────────────────
--
-- With the publishable key that ships to every browser and their own ordinary
-- JWT: `GET /rest/v1/clients?select=*` — every customer in the organization.
-- Names, phone numbers, emails, churn scores, and `portal_token`, which is a
-- bearer credential for that customer's portal. `properties` adds every home
-- address, gate code, lock box code and access note. `subscriptions` adds what
-- each neighbour pays. `messages` adds every SMS thread with every customer.
--
-- This is the same table set `neighbor_leads` was tightened away from in
-- 20260801090000 ("whoever may see the client directory"). That sweep named
-- nine tables and did not reach these.
--
-- ── WHY NOT SIMPLY REQUIRE THE PERMISSION ─────────────────────────────────
--
-- Because a tech has to see the customers on their own route. /my-day joins
-- `clients`, `properties` and `zones` onto their assigned visits and runs on
-- the caller's own client, under RLS. A blanket `view_client_directory` would
-- empty a tech's day — the app would look broken for the only role that uses
-- it in the field.
--
-- So the rule is the one the permission's own definition states: the directory
-- if you may see the directory, otherwise exactly the rows attached to work
-- assigned to you. Two SECURITY DEFINER helpers answer that, because the
-- membership lookup they need is itself behind RLS.

-- ── The two helpers ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.may_read_client(_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = _client_id
       AND (
         public.has_permission(auth.uid(), c.organization_id, 'view_client_directory')
         -- ...or this customer is on the caller's own route.
         OR EXISTS (
           SELECT 1
             FROM public.visits v
             JOIN public.staff s ON s.id = v.assigned_staff_id
            WHERE v.client_id = c.id
              AND s.user_id = auth.uid()
         )
       )
  );
$$;

COMMENT ON FUNCTION public.may_read_client(uuid) IS
  'May the caller see this customer? True with view_client_directory, or when the customer has a visit assigned to the caller. SECURITY DEFINER because the visits/staff lookup it needs is itself behind RLS.';

CREATE OR REPLACE FUNCTION public.may_read_property(_property_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE p.id = _property_id
       AND (
         public.has_permission(auth.uid(), p.organization_id, 'view_client_directory')
         OR EXISTS (
           SELECT 1
             FROM public.visits v
             JOIN public.staff s ON s.id = v.assigned_staff_id
            WHERE v.property_id = p.id
              AND s.user_id = auth.uid()
         )
       )
  );
$$;

COMMENT ON FUNCTION public.may_read_property(uuid) IS
  'May the caller see this address? Same rule as may_read_client — the directory, or the properties on the caller''s own route. Gate codes and access notes live here.';

REVOKE ALL ON FUNCTION public.may_read_client(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.may_read_property(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.may_read_client(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.may_read_property(uuid) TO authenticated, service_role;

-- ── The reads ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Members read clients" ON public.clients;
CREATE POLICY "Read clients you may see" ON public.clients
  FOR SELECT USING (public.may_read_client(id));

DROP POLICY IF EXISTS "Members read properties" ON public.properties;
CREATE POLICY "Read properties you may see" ON public.properties
  FOR SELECT USING (public.may_read_property(id));

DROP POLICY IF EXISTS "Members read dogs" ON public.dogs;
CREATE POLICY "Read dogs on properties you may see" ON public.dogs
  FOR SELECT USING (public.may_read_property(property_id));

-- What each customer PAYS. A tech never needs a price to do the work.
DROP POLICY IF EXISTS "Members read subscriptions" ON public.subscriptions;
CREATE POLICY "Read subscriptions with the directory" ON public.subscriptions
  FOR SELECT USING (
    public.has_permission(auth.uid(), organization_id, 'view_client_directory')
  );

-- Re-stated UNCHANGED. `tests/rls-is-the-boundary.test.ts` reads the LAST
-- migration that mentions a table and expects to find that table's whole
-- policy set there — so adding only a SELECT policy in a newer file hides the
-- write rule from the guard, and the guard reports the table as ungated rather
-- than failing. Every table this migration touches restates its write policy
-- for the same reason.
DROP POLICY IF EXISTS "subscriptions: priced by whoever sets pricing" ON public.subscriptions;
CREATE POLICY "subscriptions: priced by whoever sets pricing" ON public.subscriptions
  FOR ALL
  USING (public.has_permission(auth.uid(), organization_id, 'manage_pricing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_pricing'));

-- Every SMS thread with every customer.
DROP POLICY IF EXISTS "org members read messages" ON public.messages;
CREATE POLICY "Read messages with the directory" ON public.messages
  FOR SELECT USING (
    public.has_permission(auth.uid(), organization_id, 'view_client_directory')
  );

DROP POLICY IF EXISTS "review_items_select" ON public.review_items;
CREATE POLICY "Read review items with the directory" ON public.review_items
  FOR SELECT USING (
    public.has_permission(auth.uid(), organization_id, 'view_client_directory')
  );

DROP POLICY IF EXISTS "activity_log_select" ON public.activity_log;
CREATE POLICY "Read activity log with the directory" ON public.activity_log
  FOR SELECT USING (
    public.has_permission(auth.uid(), organization_id, 'view_client_directory')
  );

-- `visits` READ stays org-wide on purpose: the schedule board, the route map
-- and coverage checks are legitimately org-wide, and a visit row carries no
-- contact details of its own — the joined client/property rows are what carry
-- them, and those are now filtered above.

-- ── staff: home addresses, and the seat count that drives the SaaS bill ────
--
-- `can_write_org` includes dispatcher. Every server path is `manage_users`
-- (owner + office_manager) and `users.functions.ts:258` says so in as many
-- words: "not dispatcher-reachable (I7)". A dispatcher could PATCH
-- /rest/v1/staff to rewrite a colleague's `start_address`, flip `active`
-- (bypassing set_staff_active), or insert rows — which drives
-- tg_staff_maintain_seat_count and therefore the org's per-employee bill.
DROP POLICY IF EXISTS "Managers write staff" ON public.staff;
CREATE POLICY "Managers write staff" ON public.staff
  FOR ALL
  USING (public.has_permission(auth.uid(), organization_id, 'manage_users'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_users'));

-- ── addon_services: the priced catalog the field flow bills against ────────
--
-- Its siblings addon_charges and addon_subscriptions were moved to
-- manage_client_billing in 20260708200000. This one was left on can_write_org,
-- so a dispatcher could rewrite the unit prices that create_addon_charge bills
-- techs' field add-ons at.
DROP POLICY IF EXISTS "addon_services writable by managers" ON public.addon_services;
CREATE POLICY "Managers write addon services" ON public.addon_services
  FOR ALL
  USING (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));

DROP POLICY IF EXISTS "addon_requests_write" ON public.addon_requests;
CREATE POLICY "Managers update addon requests" ON public.addon_requests
  FOR UPDATE
  USING (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));

-- ── franchise royalty invoices: DELIBERATELY LEFT ALONE ───────────────────
--
-- The audit flagged that this table's SELECT sits on `can_write_org` while the
-- server requires `manage_franchise` + the Enterprise entitlement, and
-- proposed narrowing it. It should not be narrowed.
--
-- `tests/franchise-royalty-invoice-authz.test.ts:48` asserts, by name, that it
-- "lets the office READ settlements" — written when this exact table was
-- audited and its FOR ALL policy split. The decision recorded there is that
-- reading what a location owes is an office function while CHANGING it is the
-- franchise owner's. Narrowing the read would have emptied the franchise
-- office screens and overridden a considered choice on the strength of a
-- server/table asymmetry that is intentional.
