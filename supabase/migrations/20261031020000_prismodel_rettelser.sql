-- Rettelser til den nye prismodel (20261031010000_ny_prismodel.sql) efter
-- reviewerens gennemgang 26. okt. 2026. Beslutning (Filip, 26. okt. 2026):
-- også firmaer får udbetalt højst hver 14. dag (ROADMAP-BESLUTNINGER afsnit 3)
-- - intervallet har aldrig haft en undtagelse for erhverv, og det får det
-- heller ikke her.
--
--   B1. Efterslæb ved mange handler: en payout samler højst 50 handler
--       (MAKS_PR_UDBETALING i src/lib/betaling/udbetaling.ts). Med "højst én
--       payout pr. 14 dage" kunne en sælger med over 50 frigivne handler på
--       14 dage få et voksende efterslæb. Nu må samme KØRSEL (ét kald af
--       udbetalSaelger) lave flere payouts efter hinanden, til køen er tom:
--         - saelger_udbetalinger.koersel (uuid): kørslen, der lavede claimet.
--         - saelger_udbetaling_claim(p_saelger, p_konto, p_betalinger,
--           p_koersel default null): intervallet springes KUN over, når
--           p_koersel er givet, kørslen allerede har en payout (oprettet/
--           paid), kørslens første payout er under 1 time gammel, kørslen
--           har under 20 payouts, og ingen ANDEN kørsel (eller payout uden
--           kørsel) har en payout inden for de seneste 14 dage. En anden
--           kørsel (cron, webhook, samtidige kald) afvises stadig med
--           'interval'.
--         - saelger_naeste_udbetaling_kl: 14 dage regnes fra kørslens FØRSTE
--           payout (ikke den sidste i rækken).
--       Alle andre værn er uændrede og står i samme rækkefølge: tomt kald,
--       nødstop, sælgerlåsen (pg_advisory_xact_lock), frysning, 'i_gang'
--       (en uafklaret claimet/usikker udbetaling - den unikke indeks
--       saelger_udbetalinger_en_uafklaret gælder stadig), blokeringerne pr.
--       betaling under rækkelås (betaling_udbetaling_blokeret - herunder
--       chefens godkendelse fra 10.000 kr., erhvervets fortrydelsesfrist og
--       nødstop), sælger/konto/pengemodel/beløb. Saldo-afstemningen sker i
--       udbetaling.ts før HVER claim (også de efterfølgende i en kørsel).
--   B2. Cron'en (udbetalVentende) hentede højst 1000 betalingsrækker uden
--       sortering - med 14 dages ventetid vokser puljen, og sælgere kunne
--       blive overset. Ny service_role-RPC public.saelgere_klar_til_udbetaling
--       (p_graense): distinkte sælgere med frigivne, ikke-udbetalte,
--       ublokerede destination-betalinger, hvis interval er udløbet
--       (saelger_naeste_udbetaling_kl is null or <= now()), sorteret efter
--       ældste frigivelse.
--   S3. Beløbsloftet (25.000 kr.): notice for aktive auktioner med startpris
--       over loftet, eller hvor næste mindstebud overstiger loftet (dem kan
--       ingen byde på længere) - staff skal se på dem. Ændrer intet.
--   S5. Transaktion: repoets migrationer skriver ikke selv begin;/commit;
--       (se de seneste filer). Testdatabasen: `npx supabase db query -f`
--       sender filen som én forespørgsel = én implicit transaktion (fejler
--       noget, rulles alt tilbage; derfor virker `set local` nedenfor).
--       Produktionen: filen kopieres ind i en prod-koersel/-fil, der selv
--       har begin;/commit; (docs/GO-LIVE-STRIPE.md). Et begin;/commit; HER
--       ville afslutte prod-kørslens ydre transaktion midt i filen - derfor
--       er der bevidst ingen.
--
-- Idempotent (kan køres igen): md5-drift-tjek som i 20261031010000 - afviger
-- en funktion fra både den gamle og den nye version, afbrydes migrationen.
-- KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regprocedure('public.saelger_naeste_udbetaling_kl(uuid)') is null
     or to_regprocedure('public.koebergebyr_oere(bigint,boolean)') is null
     or to_regprocedure('public.betaling_udbetaling_blokeret(uuid)') is null
     or to_regprocedure('public.naeste_bud_minimum(numeric,numeric)') is null
     or to_regclass('public.saelger_udbetalinger') is null then
    raise exception 'Forudsætning mangler: kør 20261031010000_ny_prismodel.sql først';
  end if;
end $do$;

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Drift-tjek: funktionen skal være den gamle (fra repoet) eller den nye
-- (genkørsel). Ellers afbrydes migrationen, før noget ændres.
create or replace function pg_temp.kraev_md5(p_fn text, p_gammel text, p_ny text)
returns text language plpgsql as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is null then return 'findes_ikke'; end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  return 'gammel';
end
$f$;

do $do$
begin
  -- saelger_naeste_udbetaling_kl fra 20261031010000.
  perform pg_temp.kraev_md5('public.saelger_naeste_udbetaling_kl(uuid)',
                            '0dc6631dae67325c66bc7cbeed7efc9b', '64b69eb837c12279e8e2c60d3423bd58');
  -- saelger_udbetaling_claim fra 20261031010000 (3 parametre). Den nye har 4.
  if pg_temp.kraev_md5('public.saelger_udbetaling_claim(uuid,text,uuid[])',
                       'b96aeedef9a8bacadb24870610d0c864', '-') not in ('findes_ikke', 'gammel') then
    raise exception 'saelger_udbetaling_claim(uuid,text,uuid[]): uventet tilstand';
  end if;
  if pg_temp.kraev_md5('public.saelger_udbetaling_claim(uuid,text,uuid[],uuid)', '-', '3ab66db65625a200d0cdd97b7d8d3544') = 'gammel' then
    raise exception 'saelger_udbetaling_claim(uuid,text,uuid[],uuid): uventet tilstand';
  end if;
end $do$;

-- ===========================================================================
-- B1. Flere payouts i samme kørsel
-- ===========================================================================
alter table public.saelger_udbetalinger add column if not exists koersel uuid;
comment on column public.saelger_udbetalinger.koersel is
  'Kørslen (ét kald af udbetalSaelger), der lavede claimet (20261031020000). Samme kørsel må lave flere payouts efter hinanden (højst 20, inden for 1 time), til sælgerens kø er tom; 14-dages-intervallet regnes fra kørslens første payout. null = før 20261031020000 eller uden kørsel.';

-- Tidligst næste payout: 14 dage efter den seneste KØRSELS første payout,
-- der er oprettet hos Stripe eller gennemført. Fejlede, annullerede og
-- afviste tæller ikke. null = ingen begrænsning.
create or replace function public.saelger_naeste_udbetaling_kl(p_saelger uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $fn$
  select max(coalesce(k.foerste, u.oprettet)) + interval '14 days'
    from public.saelger_udbetalinger u
    left join lateral (
      select min(u2.oprettet) as foerste
        from public.saelger_udbetalinger u2
       where u2.seller_id = u.seller_id
         and u2.koersel = u.koersel
         and u2.status in ('oprettet', 'paid')
    ) k on u.koersel is not null
   where u.seller_id = p_saelger
     and u.status in ('oprettet', 'paid');
$fn$;
revoke all on function public.saelger_naeste_udbetaling_kl(uuid) from public, anon, authenticated;
grant execute on function public.saelger_naeste_udbetaling_kl(uuid) to service_role;

-- Den gamle claim (3 parametre) erstattes af én med p_koersel (default null,
-- så et kald med tre navngivne parametre virker som før - uden kørsel, dvs.
-- intervallet gælder fuldt ud).
drop function if exists public.saelger_udbetaling_claim(uuid, text, uuid[]);

create or replace function public.saelger_udbetaling_claim(p_saelger uuid, p_konto text, p_betalinger uuid[],
                                                           p_koersel uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b        record;
  v_grund  text;
  v_ok     uuid[] := '{}';
  v_afvist jsonb := '[]'::jsonb;
  v_sum    bigint := 0;
  v_id     uuid;
  v_naeste timestamptz;
  v_start  timestamptz;
  v_antal  integer;
begin
  if p_saelger is null or p_konto is null or coalesce(array_length(p_betalinger, 1), 0) = 0 then
    return jsonb_build_object('kode', 'intet', 'afvist', v_afvist);
  end if;
  if public.udbetalinger_stoppet() then
    return jsonb_build_object('kode', 'stoppet', 'afvist', v_afvist);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('saelger_udbetaling:' || p_saelger::text));
  if exists (select 1 from public.betalingsprofiler bp
              where bp.user_id = p_saelger and bp.udbetaling_frosset_kl is not null) then
    return jsonb_build_object('kode', 'frosset', 'afvist', v_afvist);
  end if;
  if exists (select 1 from public.saelger_udbetalinger u
              where u.seller_id = p_saelger and u.status in ('claimet', 'usikker')) then
    return jsonb_build_object('kode', 'i_gang', 'afvist', v_afvist);
  end if;
  -- Udbetaling hver 14. dag (Filip, 26. okt. 2026 - også firmaer): højst én
  -- KØRSEL med payouts pr. sælger pr. 14 dage. Under låsen, så to samtidige
  -- kørsler ikke begge kommer igennem. Intet låses eller ændres.
  -- 20261031020000 (B1): samme kørsel må fortsætte med næste portion (højst
  -- 50 handler pr. payout), til køen er tom - kun hvis kørslen selv har
  -- startet intervallet for under 1 time siden, har under 20 payouts, og
  -- ingen anden payout ligger inden for de 14 dage.
  v_naeste := public.saelger_naeste_udbetaling_kl(p_saelger);
  if v_naeste > now() then
    if p_koersel is not null then
      select min(u.oprettet), count(*) into v_start, v_antal
        from public.saelger_udbetalinger u
       where u.seller_id = p_saelger and u.koersel = p_koersel and u.status in ('oprettet', 'paid');
    end if;
    if p_koersel is null
       or v_start is null
       or v_start < now() - interval '1 hour'
       or v_antal >= 20
       or exists (select 1 from public.saelger_udbetalinger u
                   where u.seller_id = p_saelger
                     and u.status in ('oprettet', 'paid')
                     and u.koersel is distinct from p_koersel
                     and u.oprettet > now() - interval '14 days') then
      return jsonb_build_object('kode', 'interval', 'afvist', v_afvist, 'naeste_kl', v_naeste);
    end if;
  end if;

  for b in
    select * from public.betalinger
     where id = any (p_betalinger)
     order by id
       for update
  loop
    perform 1 from public.trades t where t.id = b.trade_id for update;
    if b.seller_id <> p_saelger then
      v_grund := 'anden_saelger';
    elsif b.pengemodel <> 'destination' then
      v_grund := 'ikke_destination';
    elsif b.saelger_stripe_konto is distinct from p_konto then
      v_grund := 'anden_konto';
    elsif b.udbetaling_oere <= 0 then
      v_grund := 'intet_beloeb';
    else
      v_grund := public.betaling_udbetaling_blokeret(b.id);
    end if;
    if v_grund is null then
      v_ok := v_ok || b.id;
      v_sum := v_sum + b.udbetaling_oere;
    else
      v_afvist := v_afvist || jsonb_build_object('betaling_id', b.id, 'grund', v_grund);
    end if;
  end loop;

  if coalesce(array_length(v_ok, 1), 0) = 0 then
    return jsonb_build_object('kode', 'intet', 'afvist', v_afvist);
  end if;

  insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids, koersel)
  values (p_saelger, p_konto, v_sum, 'dkk', 'claimet', v_ok, p_koersel)
  returning id into v_id;

  update public.betalinger
     set saelger_udbetaling_id = v_id,
         overfoersel_paabegyndt_kl = coalesce(overfoersel_paabegyndt_kl, now()),
         opdateret = now()
   where id = any (v_ok);

  return jsonb_build_object('kode', 'ok', 'udbetaling_id', v_id, 'beloeb_oere', v_sum,
                            'betalinger', to_jsonb(v_ok), 'afvist', v_afvist);
end;
$fn$;
revoke all on function public.saelger_udbetaling_claim(uuid, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_claim(uuid, text, uuid[], uuid) to service_role;

-- ===========================================================================
-- B2. Sælgere, der er klar til udbetaling (cron)
-- ===========================================================================
-- Samme betingelser som kandidaterne i udbetalSaelger + blokeringen
-- (betaling_udbetaling_blokeret er null - så blokerede handler, fx en sag
-- eller chefens godkendelse, ikke skubber andre sælgere ud af grænsen) +
-- intervallet. Ældste frigivelse først. Uafklarede claims hentes for sig
-- (udbetalVentende).
create or replace function public.saelgere_klar_til_udbetaling(p_graense integer default 500)
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
       where b.pengemodel = 'destination'
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
   where coalesce(public.saelger_naeste_udbetaling_kl(x.seller_id) <= now(), true)
   order by x.aeldste, x.seller_id
   limit greatest(coalesce(p_graense, 500), 1);
$fn$;
revoke all on function public.saelgere_klar_til_udbetaling(integer) from public, anon, authenticated;
grant execute on function public.saelgere_klar_til_udbetaling(integer) to service_role;

-- Efter oprettelsen: begge funktioner skal have den forventede krop.
do $do$
begin
  if pg_temp.krop_md5('public.saelger_naeste_udbetaling_kl(uuid)') is distinct from '64b69eb837c12279e8e2c60d3423bd58' then
    raise exception 'saelger_naeste_udbetaling_kl: uventet md5 % efter rettelsen',
      pg_temp.krop_md5('public.saelger_naeste_udbetaling_kl(uuid)');
  end if;
  if pg_temp.krop_md5('public.saelger_udbetaling_claim(uuid,text,uuid[],uuid)') is distinct from '3ab66db65625a200d0cdd97b7d8d3544' then
    raise exception 'saelger_udbetaling_claim: uventet md5 % efter rettelsen',
      pg_temp.krop_md5('public.saelger_udbetaling_claim(uuid,text,uuid[],uuid)');
  end if;
end $do$;

-- ===========================================================================
-- S3. Beløbsloft: aktive auktioner over loftet (kun en notice)
-- ===========================================================================
-- Startpris over 25.000 kr. (oprettet før loftet), eller næste mindstebud
-- over loftet (buddet står allerede tæt på/over 25.000): ingen kan byde, før
-- staff har set på dem. Ingen fandtes 26. okt. 2026 på testdatabasen.
do $do$
declare
  n_start integer;
  n_bud   integer;
  n_maks  integer;
begin
  select count(*) filter (where a.startpris > public.maks_beloeb_kr()),
         count(*) filter (where public.naeste_bud_minimum(a."nuværende_bud", a.startpris) > public.maks_beloeb_kr())
    into n_start, n_bud
    from public.auctions a
   where a.status = 'aktiv';
  select count(*) into n_maks
    from public.bud_maksimum m
    join public.auctions a on a.id = m.auktion_id
   where m.maks_beloeb > public.maks_beloeb_kr() and a.status = 'aktiv';
  if n_start > 0 or n_bud > 0 or n_maks > 0 then
    raise notice 'Beløbsloft 25.000 kr. - aktive auktioner, staff skal se på dem: % med startpris over loftet, % hvor næste mindstebud overstiger loftet (ingen kan byde), % maksimum over loftet',
      n_start, n_bud, n_maks;
  else
    raise notice 'Beløbsloft 25.000 kr.: ingen aktive auktioner over loftet';
  end if;
end $do$;

-- ===========================================================================
-- Oprydning
-- ===========================================================================
drop function pg_temp.kraev_md5(text, text, text);
drop function pg_temp.krop_md5(text);
