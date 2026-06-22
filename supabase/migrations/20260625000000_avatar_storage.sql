-- Storage bucket til profilbilleder. Filer gemmes som "<bruger_id>/<filnavn>",
-- samme mønster som auktion-billeder.

insert into storage.buckets (id, name, public)
values ('avatarer', 'avatarer', true)
on conflict (id) do nothing;

create policy "avatarer_select_all"
  on storage.objects for select
  using (bucket_id = 'avatarer');

create policy "avatarer_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'avatarer'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "avatarer_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'avatarer'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
