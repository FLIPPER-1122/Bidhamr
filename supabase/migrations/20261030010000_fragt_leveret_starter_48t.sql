-- Auto-frigivelse 48 timer efter afhentning, hvis ingen sag (ROADMAP fase 2;
-- ROADMAP-BESLUTNINGER afsnit 1 "Frigivelse af penge": "Uret starter, når
-- sporingen viser, at køberen har hentet pakken", og "Sager": "48-timers uret
-- starter, når køberen trykker modtaget (indtil sporing er bygget - derefter
-- ved afhentning)").
--
-- Når fragtfirmaets sporing melder pakken leveret/afhentet (forsendelser.
-- leveret_kl), starter 48-timers uret af sig selv - køberen skal ikke trykke
-- noget. Handlen går til 'modtaget' præcis som ved købers "Jeg har modtaget
-- pakken", så resten af maskineriet er uændret: køberen kan oprette en sag i
-- 48 timer, godkende varen (med bedømmelse), eller lade fristen løbe ud, og
-- så frigiver handel_auto_frigiv pengene (grund 48_timer - ingen bedømmelse).
--
--   1. trades.modtaget_kilde: 'fragt' = uret blev startet af fragtfirmaets
--      leveringsmelding (null = køberen trykkede selv, eller ældre handler).
--      trades.fragt_ur_besked_kl: køber og sælger har fået besked om uret
--      (så cron kan sende beskeden igen, hvis serveren døde imellem).
--      Brugerne har ingen skriveadgang til trades - kun funktionerne her.
--   2. handel_fragt_leveret_start(p_trade): starter uret. Uret regnes fra
--      REGISTRERINGEN hos BidHamr (now()), ikke fra fragtfirmaets
--      hændelsestidspunkt: DAO's sporing kan være op til 24 timer forsinket,
--      og køberen skal altid have fulde 48 timer efter beskeden.
--      Kun når ALT er i orden (låst og tjekket igen under lås, samme
--      låserækkefølge som sag_opret og handel_auto_frigiv: betaling, handel):
--        - handlen er 'pakke_sendt' (ikke afhentning hos sælger),
--        - betalingen er betalt og hverken frigivet, overført, udbetalt
--          eller under refusion, og ingen blokerende indsigelse,
--        - ingen sag (heller ikke en lukket) og ingen sag-markering
--          (sag_aaben), ingen ventende anke,
--        - en aktiv udgående forsendelse er meldt leveret, og meldingen må
--          frigive penge (leveret_frigiver - Shipmondos "leveret" kun med
--          SHIPMONDO_LEVERET_FRIGIVER=true),
--        - pakken er ikke meldt returneret, og "ikke afhentet" er ikke
--          registreret.
--      Uden p_trade: op til 200 handler (cron-reserven, fx når sælgeren
--      markerer pakken sendt EFTER leveringsmeldingen). Idempotent: en
--      handel, der allerede er 'modtaget', røres ikke. Returnerer de handler,
--      hvor uret blev startet nu.
--   3. handel_fragt_ur_besked_sendt(p_trade): beskeden er sendt (én gang).
--   4. sag_opret: når uret er startet af fragtfirmaet, kan køberen inden for
--      de 48 timer også vælge "Pakken er ikke kommet frem" (bortkommet) -
--      uden billeder af pakke/label/indhold (han har ikke pakken), og med
--      tjek af sporingen for staff. Ellers ville en køber, hvis pakke er
--      meldt leveret forkert, miste retten til at melde den bortkommet (som
--      han havde fra dag 7 i 'pakke_sendt').
--
-- Ingen penge flyttes her. Frigivelsen sker stadig kun i handel_auto_frigiv
-- (uændret: frysning, sager, anker, indsigelse, refusion, returneret og ikke
-- afhentet blokerer), og udbetalingen til banken har sine egne værn
-- (nødstop, frosset sælger, chefens godkendelse fra 10.000 kr.).
--
-- sag_opret ligger i produktion og rettes på stedet med md5-drift-tjek
-- (mønstret fra 20261021010000): "gammel" = testdatabasen før denne
-- migration (hentet 21. okt. 2026), "ny" = efter. Andet afbryder migrationen.
--
-- Idempotent (kan køres igen). Én transaktion. KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.forsendelser') is null or to_regclass('public.handel_ikke_afhentet') is null
     or to_regprocedure('public.sag_holder_pengene(uuid)') is null
     or to_regprocedure('public.betaling_indsigelse_blokerer(timestamptz,text)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'forsendelser'
                       and column_name = 'leveret_frigiver') then
    raise exception 'Forudsætning mangler: kør 20261016030000, 20261019010000 og 20261024010000 først';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session)
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- ===========================================================================
-- 1. Kolonner
-- ===========================================================================
alter table public.trades
  add column if not exists modtaget_kilde      text,
  add column if not exists fragt_ur_besked_kl  timestamptz;

do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.trades'::regclass and conname = 'trades_modtaget_kilde_check') then
    alter table public.trades
      add constraint trades_modtaget_kilde_check check (modtaget_kilde is null or modtaget_kilde = 'fragt');
  end if;
end $do$;

comment on column public.trades.modtaget_kilde is
  '''fragt'' = 48-timers uret blev startet af fragtfirmaets leveringsmelding (received_at = registreringen hos BidHamr). null = køberen trykkede selv "modtaget" (eller ældre handel). Sættes kun af handel_fragt_leveret_start (20261030010000).';
comment on column public.trades.fragt_ur_besked_kl is
  'Køber og sælger har fået besked om, at fragtfirmaets leveringsmelding startede 48-timers uret (handel_fragt_ur_besked_sendt).';

-- Parterne (RLS: trades_select_own) og appen kan se, at fragtfirmaet startede
-- uret. fragt_ur_besked_kl er kun til serveren.
grant select (modtaget_kilde) on public.trades to authenticated;

-- Cron-reserven for beskeder, der mangler.
create index if not exists trades_fragt_ur_besked_mangler
  on public.trades (received_at)
  where modtaget_kilde = 'fragt' and fragt_ur_besked_kl is null;

-- ===========================================================================
-- 2. handel_fragt_leveret_start
-- ===========================================================================
create or replace function public.handel_fragt_leveret_start(p_trade uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $f$
declare
  k     record;
  b     record;
  t     record;
  v_kl  timestamptz;
  v_ud  jsonb := '[]'::jsonb;
begin
  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.trades tr
      join public.betalinger bt on bt.trade_id = tr.id
     where (p_trade is null or tr.id = p_trade)
       and tr.status = 'pakke_sendt'
       and not coalesce(tr.afhentning, false)
       and not coalesce(tr.sag_aaben, false)
       and bt.status = 'betalt'
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null and bt.saelger_udbetaling_id is null
       and exists (select 1 from public.forsendelser fo
                    where fo.trade_id = tr.id and fo.type = 'udgaaende'
                      and fo.status not in ('opretter', 'annulleres', 'annulleret', 'fejlet')
                      and fo.leveret_kl is not null and fo.leveret_frigiver)
     order by tr.id
     limit 200
  loop
    -- Hver handel i sin egen undertransaktion: én fejl stopper ikke resten.
    begin
      -- Låserækkefølge som sag_opret og handel_auto_frigiv: betaling, handel.
      -- Alt tjekkes igen under låsen (en samtidig sag, refusion eller
      -- frigivelse vinder).
      select * into b from public.betalinger where id = k.betaling_id for update;
      select * into t from public.trades where id = k.trade_id for update;

      if t.status <> 'pakke_sendt'
         or coalesce(t.afhentning, false)
         or coalesce(t.sag_aaben, false)
         or b.status <> 'betalt'
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
         or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
         or public.sag_holder_pengene(t.id)
         or exists (select 1 from public.sager s where s.trade_id = t.id)
         or exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id)
         or exists (select 1 from public.forsendelser fo
                     where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.returneret_kl is not null)
         or not exists (select 1 from public.forsendelser fo
                         where fo.trade_id = t.id and fo.type = 'udgaaende'
                           and fo.status not in ('opretter', 'annulleres', 'annulleret', 'fejlet')
                           and fo.leveret_kl is not null and fo.leveret_frigiver) then
        continue;
      end if;

      -- Uret regnes fra registreringen her - ikke fra fragtfirmaets
      -- (måske forsinkede) hændelsestidspunkt.
      v_kl := now();
      update public.trades
         set status = 'modtaget', received_at = v_kl, modtaget_kilde = 'fragt'
       where id = t.id and status = 'pakke_sendt';
      if not found then continue; end if;

      v_ud := v_ud || jsonb_build_array(jsonb_build_object(
        'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
        'auction_id', t.auction_id, 'received_at', v_kl));
    exception when others then
      raise warning 'handel_fragt_leveret_start: handel % fejlede: %', k.trade_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$f$;

revoke all on function public.handel_fragt_leveret_start(uuid) from public, anon, authenticated;
grant execute on function public.handel_fragt_leveret_start(uuid) to service_role;

-- ===========================================================================
-- 3. handel_fragt_ur_besked_sendt
-- ===========================================================================
create or replace function public.handel_fragt_ur_besked_sendt(p_trade uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $f$
begin
  update public.trades
     set fragt_ur_besked_kl = now()
   where id = p_trade and modtaget_kilde = 'fragt' and fragt_ur_besked_kl is null;
  return found;
end;
$f$;

revoke all on function public.handel_fragt_ur_besked_sendt(uuid) from public, anon, authenticated;
grant execute on function public.handel_fragt_ur_besked_sendt(uuid) to service_role;

-- ===========================================================================
-- 4. sag_opret: "Pakken er ikke kommet frem", når fragtfirmaet startede uret
-- ===========================================================================
do $do$
begin
  raise notice 'sag_opret: %', pg_temp.ps_ret(
    'public.sag_opret(uuid,text,text,jsonb)',
    '11f01e46dda440ef5c59bc25c3c0ff1c',
    'a1d9ea08a7f349d523c2e2a8775aa5f8',
    jsonb_build_array(
      jsonb_build_array(
$g$  if t.status = 'modtaget' then
    if p_type = 'bortkommet' then$g$,
$n$  if t.status = 'modtaget' then
    -- 20261030010000: bortkommet også, når fragtfirmaets leveringsmelding
    -- startede uret (køberen har ikke selv kvitteret) - inden for 48 timer.
    if p_type = 'bortkommet' and t.modtaget_kilde is distinct from 'fragt' then$n$, 1),
      jsonb_build_array(
$g$  if t.status = 'modtaget' and not ($g$,
$n$  if t.status = 'modtaget' and p_type <> 'bortkommet' and not ($n$, 1),
      jsonb_build_array(
$g$            t.status = 'pakke_sendt')$g$,
$n$            t.status = 'pakke_sendt' or p_type = 'bortkommet')$n$, 1)));
end $do$;
-- (create or replace bevarer rettighederne på sag_opret - uændrede.)
