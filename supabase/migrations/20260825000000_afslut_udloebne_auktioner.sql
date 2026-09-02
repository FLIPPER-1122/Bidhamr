-- Auktioner udløber på tid, men intet satte deres status til 'afsluttet'.
-- Derfor stod udløbne auktioner stadig som "Aktiv" i admin og i appen.
-- Dette job lukker dem og udpeger vinderen (højeste bud, ved lige bud det
-- tidligste). vinder_id bruges af BidPanel til at vise vinderen via realtime.

create or replace function public.afslut_udloebne_auktioner()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  antal integer;
begin
  update public.auctions a
     set status = 'afsluttet',
         vinder_id = (
           select b.bruger_id
             from public.bids b
            where b.auktion_id = a.id
            order by b.beløb desc, b.oprettet asc
            limit 1
         )
   where a.status = 'aktiv'
     and a.slutter_kl <= now();

  get diagnostics antal = row_count;
  return antal;
end;
$$;

comment on function public.afslut_udloebne_auktioner() is
  'Lukker auktioner hvis slutter_kl er passeret og sætter vinder_id. Kaldes hvert minut af pg_cron.';

-- Kun service-role/postgres må køre den; ingen grants til anon/authenticated.
revoke all on function public.afslut_udloebne_auktioner() from public, anon, authenticated;

-- Kør hvert minut. Anti-snipe forlænger med 2 minutter, så et minuts
-- opløsning er rigeligt til at lukke rettidigt.
select cron.unschedule('afslut-udloebne-auktioner')
 where exists (select 1 from cron.job where jobname = 'afslut-udloebne-auktioner');

select cron.schedule(
  'afslut-udloebne-auktioner',
  '* * * * *',
  $$select public.afslut_udloebne_auktioner();$$
);
