-- Stage 4 (address search): structured storage additions.
-- unit: apartment/suite kept separate from the street line (spec).
-- address_source: 'matched' = picked from the address provider ("Address
-- Matched, Not USPS Verified"), 'manual' = typed/confirmed by hand.
ALTER TABLE public.properties
  ADD COLUMN unit text,
  ADD COLUMN address_source text CHECK (address_source IN ('matched', 'manual'));
