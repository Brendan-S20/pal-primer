
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS churn_score int,
  ADD COLUMN IF NOT EXISTS churn_reason text,
  ADD COLUMN IF NOT EXISTS churn_scored_at timestamptz;
CREATE INDEX IF NOT EXISTS clients_churn_score_idx ON public.clients (organization_id, churn_score DESC NULLS LAST);
