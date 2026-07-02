
-- Promo codes
CREATE TABLE public.promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  description TEXT,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value_cents INTEGER,        -- for fixed
  discount_percent NUMERIC(5,2),       -- for percent (0-100)
  applies_to TEXT NOT NULL DEFAULT 'first_visit' CHECK (applies_to IN ('first_visit','recurring','one_time')),
  recurring_cycles INTEGER,            -- N cycles when applies_to = recurring
  max_redemptions INTEGER,             -- overall cap
  redemption_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.promo_codes TO authenticated;
GRANT ALL ON public.promo_codes TO service_role;
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read promo codes" ON public.promo_codes
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));
CREATE POLICY "org members write promo codes" ON public.promo_codes
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE INDEX promo_codes_org_code_idx ON public.promo_codes(organization_id, code);

-- Gift cards
CREATE TABLE public.gift_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  initial_balance_cents INTEGER NOT NULL CHECK (initial_balance_cents > 0),
  remaining_balance_cents INTEGER NOT NULL,
  purchaser_email TEXT,
  purchaser_name TEXT,
  recipient_email TEXT,
  recipient_name TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','depleted','void')),
  expires_at TIMESTAMPTZ,
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gift_cards TO authenticated;
GRANT ALL ON public.gift_cards TO service_role;
ALTER TABLE public.gift_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read gift cards" ON public.gift_cards
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));
CREATE POLICY "org members write gift cards" ON public.gift_cards
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE INDEX gift_cards_org_code_idx ON public.gift_cards(organization_id, code);

-- Gift card redemption ledger
CREATE TABLE public.gift_card_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  gift_card_id UUID NOT NULL REFERENCES public.gift_cards(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gift_card_redemptions TO authenticated;
GRANT ALL ON public.gift_card_redemptions TO service_role;
ALTER TABLE public.gift_card_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read gc redemptions" ON public.gift_card_redemptions
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));
CREATE POLICY "org members write gc redemptions" ON public.gift_card_redemptions
  FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE INDEX gift_card_redemptions_card_idx ON public.gift_card_redemptions(gift_card_id);

-- updated_at triggers reuse existing helper if present; create if missing
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER promo_codes_updated_at BEFORE UPDATE ON public.promo_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER gift_cards_updated_at BEFORE UPDATE ON public.gift_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Atomic gift card redemption RPC
CREATE OR REPLACE FUNCTION public.redeem_gift_card(
  _org_id UUID,
  _code TEXT,
  _amount_cents INTEGER,
  _client_id UUID DEFAULT NULL,
  _invoice_id UUID DEFAULT NULL,
  _note TEXT DEFAULT NULL
) RETURNS TABLE (redeemed_cents INTEGER, remaining_cents INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_card public.gift_cards%ROWTYPE;
  v_apply INTEGER;
BEGIN
  IF _amount_cents <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;

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

  RETURN QUERY SELECT v_apply, (v_card.remaining_balance_cents - v_apply);
END; $$;

REVOKE ALL ON FUNCTION public.redeem_gift_card(UUID, TEXT, INTEGER, UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_gift_card(UUID, TEXT, INTEGER, UUID, UUID, TEXT) TO authenticated;
