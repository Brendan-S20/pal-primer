-- Dashboard month-to-date reads filter by organization and a date window,
-- then page by timestamp and id. Existing indexes cover organization alone
-- (payments) or require status first (review_items).
CREATE INDEX IF NOT EXISTS payments_org_created_id_idx
  ON public.payments (organization_id, created_at, id);

CREATE INDEX IF NOT EXISTS review_items_org_detected_id_idx
  ON public.review_items (organization_id, detected_at, id);
