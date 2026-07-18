-- Frequency-change requests (QA round 3, deferred C4/G4 item).
--
-- portal_change_frequency previously applied immediately regardless of the
-- org's portal_auto_apply_changes toggle — the "Request change" button was a
-- label only, and the office had nothing structured to action. Now, when
-- auto-apply is off, the change files a structured qc_ticket the Concerns page
-- can apply in one click (mirroring the vacation-hold request flow), and the
-- org's portal_allow_frequency_change toggle is enforced server-side.
--
-- Return type changes void -> text ('applied' | 'requested' | 'unchanged')
-- so the portal can word its confirmation, hence DROP + CREATE.

DROP FUNCTION IF EXISTS public.portal_change_frequency(uuid, uuid, public.service_frequency);

CREATE FUNCTION public.portal_change_frequency(
  _token uuid, _subscription_id uuid, _new_frequency public.service_frequency
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _cid uuid; _org uuid; _cur public.service_frequency;
  _allow boolean; _auto boolean;
BEGIN
  SELECT c.id, c.organization_id, o.portal_allow_frequency_change, o.portal_auto_apply_changes
    INTO _cid, _org, _allow, _auto
    FROM public.clients c
    JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  IF NOT COALESCE(_allow, false) THEN
    RAISE EXCEPTION 'Frequency changes are not enabled for this account';
  END IF;

  SELECT frequency INTO _cur FROM public.subscriptions
   WHERE id = _subscription_id AND client_id = _cid;
  IF _cur IS NULL THEN RAISE EXCEPTION 'Subscription not found'; END IF;
  IF _new_frequency = 'one_time' THEN RAISE EXCEPTION 'Cannot switch to one-time via portal'; END IF;
  IF _new_frequency = _cur THEN RETURN 'unchanged'; END IF;

  IF NOT COALESCE(_auto, false) THEN
    -- One live request per subscription: re-submitting before the office acts
    -- doesn't stack tickets (same guard the vacation-hold flow grew in QA).
    IF NOT EXISTS (
      SELECT 1 FROM public.qc_tickets t
       WHERE t.client_id = _cid
         AND t.status <> 'resolved'
         AND t.message LIKE 'Frequency change requested: %(subscription ' || _subscription_id || ')%'
    ) THEN
      INSERT INTO public.qc_tickets(organization_id, client_id, category, message, status)
      VALUES (_org, _cid, 'other',
        format('Frequency change requested: %s → %s (subscription %s).',
               _cur, _new_frequency, _subscription_id),
        'open');
    END IF;
    RETURN 'requested';
  END IF;

  UPDATE public.subscriptions
     SET frequency = _new_frequency, updated_at = now()
   WHERE id = _subscription_id;

  DELETE FROM public.visits v
   WHERE v.subscription_id = _subscription_id
     AND v.scheduled_on > CURRENT_DATE
     AND v.status = 'scheduled'
     AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items li WHERE li.visit_id = v.id);
  RETURN 'applied';
END; $$;
