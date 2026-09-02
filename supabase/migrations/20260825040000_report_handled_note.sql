-- Note om hvad der blev tjekket og konklusionen. handled_by/handled_at blev
-- tilføjet i 20260825030000 og findes allerede.
alter table public.reports add column if not exists handled_note text;

-- Ensret statusnavnene til dansk: 'handled' -> 'behandlet', så de matcher
-- 'under_behandling' og 'fjernet'.
alter table public.reports drop constraint if exists reports_status_check;
update public.reports set status = 'behandlet' where status = 'handled';
alter table public.reports add constraint reports_status_check
  check (status in ('pending', 'under_behandling', 'behandlet', 'fjernet'));
