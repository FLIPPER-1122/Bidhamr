-- auctions_delete_own er fjernet (20260930030000). Ejeren kan i stedet
-- annullere sin egen auktion, saa laenge den er aktiv og uden bud.
-- Raekken bevares (handelsdata slettes aldrig).
--
-- Idempotent: ejer, status og "ingen bud" kontrolleres i samme update.
-- handle_new_bid tager "for update" paa auktionen, saa et samtidigt bud
-- enten venter paa denne update (og ser status='annulleret') eller naar
-- foerst, hvorefter denne update finder buddet og ikke rammer raekken.
create or replace function public.annuller_egen_auktion(p_auktion uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_antal int;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  update public.auctions a
     set status = 'annulleret'
   where a.id = p_auktion
     and a.bruger_id = v_uid
     and a.status = 'aktiv'
     and a."nuværende_bud" is null
     and not exists (select 1 from public.bids b where b.auktion_id = a.id);

  get diagnostics v_antal = row_count;
  return v_antal > 0;
end;
$fn$;

revoke execute on function public.annuller_egen_auktion(uuid) from public, anon;
grant execute on function public.annuller_egen_auktion(uuid) to authenticated;
