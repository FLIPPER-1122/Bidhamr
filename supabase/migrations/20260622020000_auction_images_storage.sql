-- Storage bucket til auktionsbilleder. Filer gemmes som "<bruger_id>/<filnavn>",
-- så RLS-policies kan styre adgang ud fra mappenavnet (bruger_id).

insert into storage.buckets (id, name, public)
values ('auktion-billeder', 'auktion-billeder', true)
on conflict (id) do nothing;

create policy "auktion_billeder_select_all"
  on storage.objects for select
  using (bucket_id = 'auktion-billeder');

create policy "auktion_billeder_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'auktion-billeder'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "auktion_billeder_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'auktion-billeder'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
