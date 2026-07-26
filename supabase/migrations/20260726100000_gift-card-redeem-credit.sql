-- Gift card redemption must actually move money (P0 audit finding): the old
-- redeem_gift_card decremented the card and wrote a gift_card_redemptions row
-- but credited NOBODY — the redeemed dollars vanished. Rewrite the RPC so a
-- redemption:
--   * requires a client (_client_id is mandatory and must belong to the org),
--   * posts a +N credit_ledger entry via the same post_credit_entry RPC every
--     other ledger writer uses (which also increments
--     clients.credit_balance_cents), mirroring addClientCredit,
--   * records the client on the redemption row (already a column; now always
--     populated),
--   * and — like apply_credit_to_invoice — enforces manage_client_billing
--     in-function, because the function is SECURITY DEFINER and callable by
--     any authenticated user with an arbitrary _org_id.

DROP FUNCTION IF EXISTS public.redeem_gift_card(UUID, TEXT, INTEGER, UUID, UUID, TEXT);

CREATE FUNCTION public.redeem_gift_card(
  _org_id UUID,
  _code TEXT,
  _amount_cents INTEGER,
  _client_id UUID,
  _invoice_id UUID DEFAULT NULL,
  _note TEXT DEFAULT NULL
) RETURNS TABLE (redeemed_cents INTEGER, remaining_cents INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_card public.gift_cards%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_apply INTEGER;
BEGIN
  -- Staff callers need the billing capability for the org; service-role
  -- callers (auth.uid() IS NULL) are trusted.
  IF auth.uid() IS NOT NULL
     AND NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF _amount_cents <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  IF _client_id IS NULL THEN RAISE EXCEPTION 'a client is required to redeem a gift card'; END IF;

  SELECT * INTO v_client FROM public.clients
    WHERE id = _client_id AND organization_id = _org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'client not found'; END IF;

  SELECT * INTO v_card FROM public.gift_cards
    WHERE organization_id = _org_id AND code = _code
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift card not found'; END IF;
  IF v_card.status <> 'active' THEN RAISE EXCEPTION 'gift card not active'; END IF;
  IF v_card.expires_at IS NOT NULL AND v_card.expires_at < now() THEN
    RAISE EXCEPTION 'gift card expired';
  END IF;
  IF v_card.remaining_balance_cents <= 0 THEN
    RAISE EXCEPTION 'gift card depleted';
  END IF;

  v_apply := LEAST(_amount_cents, v_card.remaining_balance_cents);

  UPDATE public.gift_cards
    SET remaining_balance_cents = remaining_balance_cents - v_apply,
        status = CASE WHEN remaining_balance_cents - v_apply <= 0 THEN 'depleted' ELSE status END
    WHERE id = v_card.id;

  INSERT INTO public.gift_card_redemptions
    (organization_id, gift_card_id, client_id, invoice_id, amount_cents, note, created_by)
  VALUES
    (_org_id, v_card.id, _client_id, _invoice_id, v_apply, _note, auth.uid());

  -- The actual money movement: +N to the client's credit balance with a
  -- ledger entry (post_credit_entry also increments credit_balance_cents).
  PERFORM public.post_credit_entry(
    _org_id, _client_id, v_apply, 'adjustment',
    _invoice_id, NULL,
    'Gift card ' || _code || ' redeemed' || COALESCE(': ' || NULLIF(_note, ''), '')
  );

  RETURN QUERY SELECT v_apply, (v_card.remaining_balance_cents - v_apply);
END; $$;

REVOKE ALL ON FUNCTION public.redeem_gift_card(UUID, TEXT, INTEGER, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_gift_card(UUID, TEXT, INTEGER, UUID, UUID, TEXT) TO authenticated, service_role;
