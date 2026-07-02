
-- Cohort retention: for each signup-month cohort, how many clients remained "active" (had a completed visit) N months later.
CREATE OR REPLACE FUNCTION public.client_cohort_retention(_org_id uuid, _months_back int DEFAULT 12)
RETURNS TABLE(cohort_month date, months_since int, cohort_size int, retained int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH cohorts AS (
    SELECT id AS client_id, date_trunc('month', created_at)::date AS cohort_month
    FROM public.clients
    WHERE organization_id = _org_id
      AND created_at >= (now() - make_interval(months => _months_back))
  ),
  activity AS (
    SELECT c.client_id, c.cohort_month,
      GREATEST(0, (EXTRACT(YEAR FROM AGE(date_trunc('month', v.completed_at), c.cohort_month)) * 12
        + EXTRACT(MONTH FROM AGE(date_trunc('month', v.completed_at), c.cohort_month)))::int) AS months_since
    FROM cohorts c
    LEFT JOIN public.visits v
      ON v.client_id = c.client_id
     AND v.status = 'completed'
     AND v.completed_at IS NOT NULL
  ),
  sizes AS (
    SELECT cohort_month, COUNT(*)::int AS cohort_size FROM cohorts GROUP BY cohort_month
  )
  SELECT s.cohort_month, m.months_since,
         s.cohort_size,
         COUNT(DISTINCT a.client_id) FILTER (WHERE a.months_since = m.months_since)::int AS retained
  FROM sizes s
  CROSS JOIN generate_series(0, _months_back) AS m(months_since)
  LEFT JOIN activity a ON a.cohort_month = s.cohort_month
  GROUP BY s.cohort_month, s.cohort_size, m.months_since
  ORDER BY s.cohort_month DESC, m.months_since ASC;
$$;

-- Client LTV: paid revenue, tenure, and monthly average per client (top N).
CREATE OR REPLACE FUNCTION public.client_ltv(_org_id uuid, _limit int DEFAULT 25)
RETURNS TABLE(client_id uuid, display_name text, tenure_days int, revenue_cents bigint, monthly_avg_cents bigint, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.display_name,
    GREATEST(1, EXTRACT(DAY FROM (now() - c.created_at))::int) AS tenure_days,
    COALESCE(SUM(i.total_cents) FILTER (WHERE i.status = 'paid'), 0)::bigint AS revenue_cents,
    CASE
      WHEN GREATEST(1, EXTRACT(DAY FROM (now() - c.created_at))::int) = 0 THEN 0
      ELSE (COALESCE(SUM(i.total_cents) FILTER (WHERE i.status = 'paid'), 0)::bigint * 30
            / GREATEST(1, EXTRACT(DAY FROM (now() - c.created_at))::int))
    END::bigint AS monthly_avg_cents,
    c.active
  FROM public.clients c
  LEFT JOIN public.invoices i ON i.client_id = c.id
  WHERE c.organization_id = _org_id
  GROUP BY c.id
  ORDER BY revenue_cents DESC
  LIMIT _limit;
$$;

-- Zone profitability: revenue attributed to visits within a zone (via subscription.price_cents on completed visits) in a date window.
CREATE OR REPLACE FUNCTION public.zone_profitability(_org_id uuid, _from date, _to date)
RETURNS TABLE(zone_id uuid, zone_name text, visit_count int, completed_count int, revenue_cents bigint, avg_revenue_per_visit_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT z.id, z.name,
    COUNT(v.id)::int AS visit_count,
    COUNT(v.id) FILTER (WHERE v.status = 'completed')::int AS completed_count,
    COALESCE(SUM(s.price_cents) FILTER (WHERE v.status = 'completed'), 0)::bigint AS revenue_cents,
    CASE WHEN COUNT(v.id) FILTER (WHERE v.status = 'completed') = 0 THEN 0
         ELSE (COALESCE(SUM(s.price_cents) FILTER (WHERE v.status = 'completed'), 0)::bigint
               / COUNT(v.id) FILTER (WHERE v.status = 'completed'))
    END::bigint AS avg_revenue_per_visit_cents
  FROM public.zones z
  LEFT JOIN public.visits v
    ON v.zone_id = z.id
   AND v.scheduled_on BETWEEN _from AND _to
  LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
  WHERE z.organization_id = _org_id
  GROUP BY z.id, z.name
  ORDER BY revenue_cents DESC;
$$;

-- Churn drivers: aggregate scored churn reasons.
CREATE OR REPLACE FUNCTION public.churn_drivers(_org_id uuid)
RETURNS TABLE(reason text, client_count int, avg_score numeric, revenue_at_risk_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH scored AS (
    SELECT c.id, COALESCE(NULLIF(TRIM(c.churn_reason), ''), 'Unclassified') AS reason,
           c.churn_score,
           COALESCE((SELECT SUM(i.total_cents) FROM public.invoices i
                     WHERE i.client_id = c.id AND i.status = 'paid'
                       AND i.paid_at >= now() - interval '180 days'), 0) AS recent_rev
    FROM public.clients c
    WHERE c.organization_id = _org_id AND c.churn_score IS NOT NULL
  )
  SELECT reason,
         COUNT(*)::int AS client_count,
         ROUND(AVG(churn_score)::numeric, 2) AS avg_score,
         SUM(recent_rev)::bigint AS revenue_at_risk_cents
  FROM scored
  GROUP BY reason
  ORDER BY revenue_at_risk_cents DESC;
$$;

GRANT EXECUTE ON FUNCTION public.client_cohort_retention(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.client_ltv(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.zone_profitability(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.churn_drivers(uuid) TO authenticated;
