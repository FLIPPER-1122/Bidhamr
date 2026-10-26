-- Udbetaling hver 14. dag: en afbrudt kørsel fortsættes af næste cron
-- (reviewerens fund B1 efter 20261031020000_prismodel_rettelser.sql, 26. okt.
-- 2026).
--
-- Problemet: samme kørsel (ét kald af udbetalSaelger, id i
-- saelger_udbetalinger.koersel) må lave flere payouts efter hinanden, til
-- sælgerens kø er tom (20261031020000, B1). Blev kørslen afbrudt efter første
-- payout (Stripe-fejl, konto_ikke_klar, venter_saldo, eller cron'en ramte
-- maxDuration), fik en ny kørsel 'interval' - og resten af køen ventede 14
-- dage. Cron'ens sælgerliste (saelgere_klar_til_udbetaling) og trin 1b i
-- udbetalSaelger udelukkede sælgeren også.
--
-- Rettelsen: en ny kørsel FORTSÆTTER sælgerens seneste kørsel, når den
-- stadig må fortsætte. Kørsels-id'et slås op i databasen
-- (saelger_fortsaettelig_koersel) - ikke valgt af kalderen - og claimet
-- tjekker betingelserne igen under sælgerlåsen:
--   - public.saelger_fortsaettelig_koersel(p_saelger) -> uuid | null: id'et
--     på sælgerens SENESTE kørsel med en payout (oprettet/paid), når præcis
--     de samme betingelser som i saelger_udbetaling_claim(..., p_koersel)
--     er opfyldt: kørslens første payout er under 1 time gammel, kørslen har
--     under 20 payouts, og ingen ANDEN kørsel (eller payout uden kørsel) har
--     en payout inden for de seneste 14 dage. Ellers null.
--   - public.saelgere_klar_til_udbetaling_fortsat(p_graense): sælgere med en
--     fortsættelig kørsel OG frigivne, ublokerede handler (samme betingelser
--     som saelgere_klar_til_udbetaling, uden intervallet). Cron'en
--     (udbetalVentende) tager dem med ud over saelgere_klar_til_udbetaling.
--
-- saelger_udbetaling_claim ÆNDRES IKKE (md5 tjekkes nedenfor): alle værn er
-- uændrede - nødstop, sælgerlås, frysning, 'i_gang', blokering pr. betaling
-- under rækkelås (betaling_udbetaling_blokeret: chefens godkendelse fra
-- 10.000 kr., erhvervets fortrydelsesfrist, sag, indsigelse m.m.) og
-- intervallet med kørsels-betingelserne. Saldo-afstemning, F03 og
-- idempotency-nøglerne ligger i udbetaling.ts og er uændrede. Et forkert
-- kørsels-id kan aldrig give mere end før: claimet lader kun en kørsel
-- fortsætte, når den er den eneste med payouts inden for 14 dage (altså den
-- seneste), den startede for under 1 time siden og har under 20 payouts.
-- Grænserne er derfor stadig: højst 20 payouts x 50 handler pr. kørsel, alle
-- inden for 1 time fra kørslens første payout. Bliver kørslen afbrudt i over
-- 1 time, venter resten til næste 14-dages-interval (som før).
--
-- Funktionerne fra 20261031010000 og 20261031020000 røres ikke, så begge kan
-- køres igen efter denne (deres md5-tjek passer stadig).
--
-- Idempotent (kan køres igen: kun create or replace af nye funktioner). Ingen
-- egen begin;/commit; (se 20261031020000, S5). KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Forudsætning: 20261031020000 er kørt, og claimet er præcis den version,
-- hvis betingelser saelger_fortsaettelig_koersel spejler.
do $do$
begin
  if to_regprocedure('public.saelger_naeste_udbetaling_kl(uuid)') is null
     or to_regprocedure('public.betaling_udbetaling_blokeret(uuid)') is null
     or to_regprocedure('public.saelgere_klar_til_udbetaling(integer)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'saelger_udbetalinger'
                       and column_name = 'koersel') then
    raise exception 'Forudsætning mangler: kør 20261031020000_prismodel_rettelser.sql først';
  end if;
  if pg_temp.krop_md5('public.saelger_udbetaling_claim(uuid,text,uuid[],uuid)') is distinct from '3ab66db65625a200d0cdd97b7d8d3544' then
    raise exception 'saelger_udbetaling_claim(uuid,text,uuid[],uuid): md5 % er ikke versionen fra 20261031020000 - kontrollér, at betingelserne i saelger_fortsaettelig_koersel stadig passer',
      pg_temp.krop_md5('public.saelger_udbetaling_claim(uuid,text,uuid[],uuid)');
  end if;
  if pg_temp.krop_md5('public.saelger_naeste_udbetaling_kl(uuid)') is distinct from '64b69eb837c12279e8e2c60d3423bd58' then
    raise exception 'saelger_naeste_udbetaling_kl(uuid): md5 % er ikke versionen fra 20261031020000',
      pg_temp.krop_md5('public.saelger_naeste_udbetaling_kl(uuid)');
  end if;
end $do$;

-- ===========================================================================
-- 1. Sælgerens fortsættelige kørsel
-- ===========================================================================
-- Samme betingelser som intervallet i saelger_udbetaling_claim (20261031020000):
--   v_start >= now() - 1 time, v_antal < 20, ingen payout fra en anden kørsel
--   (eller uden kørsel) inden for 14 dage.
-- Kun et opslag: intet låses eller ændres. Claimet tjekker det igen under
-- sælgerlåsen.
create or replace function public.saelger_fortsaettelig_koersel(p_saelger uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  with seneste as (
    select u.koersel
      from public.saelger_udbetalinger u
     where u.seller_id = p_saelger
       and u.status in ('oprettet', 'paid')
       and u.koersel is not null
     order by u.oprettet desc, u.id desc
     limit 1
  ), k as (
    select s.koersel, min(u.oprettet) as start, count(*) as antal
      from seneste s
      join public.saelger_udbetalinger u
        on u.seller_id = p_saelger
       and u.koersel = s.koersel
       and u.status in ('oprettet', 'paid')
     group by s.koersel
  )
  select k.koersel
    from k
   where p_saelger is not null
     and k.start >= now() - interval '1 hour'
     and k.antal < 20
     and not exists (select 1 from public.saelger_udbetalinger u
                      where u.seller_id = p_saelger
                        and u.status in ('oprettet', 'paid')
                        and u.koersel is distinct from k.koersel
                        and u.oprettet > now() - interval '14 days');
$fn$;
revoke all on function public.saelger_fortsaettelig_koersel(uuid) from public, anon, authenticated;
grant execute on function public.saelger_fortsaettelig_koersel(uuid) to service_role;
comment on function public.saelger_fortsaettelig_koersel(uuid) is
  'Id på sælgerens seneste udbetalingskørsel, hvis den må fortsætte (første payout under 1 time gammel, under 20 payouts, ingen anden payout inden for 14 dage - samme betingelser som saelger_udbetaling_claim). null = ingen. 20261031030000.';

-- ===========================================================================
-- 2. Cron: sælgere med en fortsættelig kørsel og handler klar
-- ===========================================================================
-- Samme betingelser på handlerne som saelgere_klar_til_udbetaling
-- (20261031020000, B2) - blokerede handler tæller ikke - men i stedet for
-- "intervallet er udløbet": sælgeren har en fortsættelig kørsel. Kun sælgere
-- med en payout inden for den seneste time kan have det (få rækker).
create or replace function public.saelgere_klar_til_udbetaling_fortsat(p_graense integer default 500)
returns table (seller_id uuid, aeldste_frigivet_kl timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  select x.seller_id, x.aeldste
    from (
      select b.seller_id, min(b.frigivet_kl) as aeldste
        from public.betalinger b
       where b.seller_id in (select u.seller_id
                               from public.saelger_udbetalinger u
                              where u.status in ('oprettet', 'paid')
                                and u.koersel is not null
                                and u.oprettet >= now() - interval '1 hour')
         and b.pengemodel = 'destination'
         and b.status = 'betalt'
         and b.frigivet_kl is not null
         and b.saelger_udbetaling_id is null
         and b.refusion_anmodet_kl is null
         and not b.kraever_opmaerksomhed
         and b.midler_tilgaengelige_kl <= now()
         and (b.udbetal_tidligst is null or b.udbetal_tidligst <= now())
         and public.betaling_udbetaling_blokeret(b.id) is null
       group by b.seller_id
    ) x
   where public.saelger_fortsaettelig_koersel(x.seller_id) is not null
   order by x.aeldste, x.seller_id
   limit greatest(coalesce(p_graense, 500), 1);
$fn$;
revoke all on function public.saelgere_klar_til_udbetaling_fortsat(integer) from public, anon, authenticated;
grant execute on function public.saelgere_klar_til_udbetaling_fortsat(integer) to service_role;

-- ===========================================================================
-- Oprydning
-- ===========================================================================
drop function pg_temp.krop_md5(text);
