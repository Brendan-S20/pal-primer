ALTER TABLE public.platform_announcements DROP CONSTRAINT IF EXISTS platform_announcements_severity_check;
UPDATE public.platform_announcements SET severity = 'warning' WHERE severity = 'warn';
ALTER TABLE public.platform_announcements ADD CONSTRAINT platform_announcements_severity_check CHECK (severity IN ('info','success','warning','critical'));