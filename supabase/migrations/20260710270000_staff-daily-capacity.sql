-- Per-technician daily capacity for route balancing (#27). When null, the
-- balancer falls back to the org-wide workday length.
-- Applied to live via Supabase MCP 2026-07-10.
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS daily_capacity_minutes integer;
