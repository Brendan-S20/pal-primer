-- DNA sample collection photo (QA round 3, deferred B8 item).
--
-- Chain-of-custody evidence for a logged sample: a photo of the collection
-- (bagged sample / kit at the site), stored in a private org-scoped bucket.
-- This is collection evidence only — no genetic data is stored, keeping the
-- I9 rule (provider references, statuses, reports, matches; no raw markers).
-- Path shape mirrors waste-receipts: {organization_id}/{timestamp}.{ext}

alter table public.dna_matches
  add column if not exists sample_photo_path text
    check (sample_photo_path is null or char_length(sample_photo_path) <= 300);

insert into storage.buckets (id, name, public)
values ('dna-samples', 'dna-samples', false)
on conflict (id) do nothing;

create policy "org members upload dna sample photos" on storage.objects
  for insert with check (
    bucket_id = 'dna-samples'
    and is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

create policy "org members read dna sample photos" on storage.objects
  for select using (
    bucket_id = 'dna-samples'
    and is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

create policy "managers delete dna sample photos" on storage.objects
  for delete using (
    bucket_id = 'dna-samples'
    and can_write_org(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );
