-- P0.3: technicians could read waste_disposal_manifests but every "Log dump"
-- insert failed RLS, because the single write policy uses can_write_org()
-- whose allow-list is owner/office_manager/dispatcher only. Logging a dump is
-- a core technician task, so give org members (which includes techs) their own
-- INSERT policy. Update/delete stay manager-level via the existing policy.

CREATE POLICY "org members log manifests"
  ON public.waste_disposal_manifests
  FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));
