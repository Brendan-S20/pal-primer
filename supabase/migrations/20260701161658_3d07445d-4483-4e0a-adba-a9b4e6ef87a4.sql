
CREATE TABLE public.visit_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL,
  storage_path text NOT NULL,
  kind text NOT NULL DEFAULT 'completion',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_photos_visit_idx ON public.visit_photos(visit_id);
CREATE INDEX visit_photos_org_idx ON public.visit_photos(organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.visit_photos TO authenticated;
GRANT ALL ON public.visit_photos TO service_role;

ALTER TABLE public.visit_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read visit photos"
  ON public.visit_photos FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "assigned tech inserts visit photos"
  ON public.visit_photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_org_member(auth.uid(), organization_id)
    AND uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.visits v
      JOIN public.staff s ON s.id = v.assigned_staff_id
      WHERE v.id = visit_id
        AND v.organization_id = visit_photos.organization_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "managers delete visit photos"
  ON public.visit_photos FOR DELETE TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id));

CREATE OR REPLACE FUNCTION public.is_visit_tech(_user_id uuid, _visit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.visits v
    JOIN public.staff s ON s.id = v.assigned_staff_id
    WHERE v.id = _visit_id AND s.user_id = _user_id
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_visit_tech(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_visit(_visit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  UPDATE public.visits
     SET status='in_progress',
         started_at = COALESCE(started_at, now()),
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END; $$;
GRANT EXECUTE ON FUNCTION public.start_visit(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_visit(_visit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE _has_photo boolean;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.visit_photos
     WHERE visit_id = _visit_id AND kind = 'completion'
  ) INTO _has_photo;
  IF NOT _has_photo THEN
    RAISE EXCEPTION 'A completion photo is required before completing this visit';
  END IF;
  UPDATE public.visits
     SET status='completed',
         completed_at = now(),
         started_at = COALESCE(started_at, now()),
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END; $$;
GRANT EXECUTE ON FUNCTION public.complete_visit(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.skip_visit(_visit_id uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to skip a visit';
  END IF;
  UPDATE public.visits
     SET status='skipped',
         skip_reason = _reason,
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END; $$;
GRANT EXECUTE ON FUNCTION public.skip_visit(uuid, text) TO authenticated;

CREATE POLICY "org members read visit photo files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'visit-photos'
    AND public.is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "assigned tech uploads visit photo files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'visit-photos'
    AND public.is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
    AND public.is_visit_tech(auth.uid(), ((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY "managers delete visit photo files"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'visit-photos'
    AND public.can_write_org(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );
