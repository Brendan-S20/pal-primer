-- Waste-log receipt photos (punch list #16): private bucket, org-scoped.
-- Path shape: {organization_id}/{timestamp}.{ext}
insert into storage.buckets (id, name, public)
values ('waste-receipts', 'waste-receipts', false)
on conflict (id) do nothing;

create policy "org members upload waste receipts" on storage.objects
  for insert with check (
    bucket_id = 'waste-receipts'
    and is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

create policy "org members read waste receipts" on storage.objects
  for select using (
    bucket_id = 'waste-receipts'
    and is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

create policy "managers delete waste receipts" on storage.objects
  for delete using (
    bucket_id = 'waste-receipts'
    and can_write_org(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );
