-- Rapporter kan nu have fire udfald i stedet for to:
--   pending          - afventer behandling (default)
--   under_behandling - opslaget er midlertidigt skjult mens sagen undersøges
--   handled          - afsluttet uden handling, opslaget forbliver aktivt
--   fjernet          - opslaget er fjernet permanent fra platformen
-- handled_by/handled_at giver sporbarhed på hvem der traf beslutningen.

alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports add constraint reports_status_check
  check (status in ('pending', 'under_behandling', 'handled', 'fjernet'));

alter table public.reports
  add column if not exists handled_by uuid references public.users(id) on delete set null,
  add column if not exists handled_at timestamptz;
