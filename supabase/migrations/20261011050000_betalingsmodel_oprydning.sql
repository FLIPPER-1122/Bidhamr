-- Ny betalingsmodel, trin 5: oprydning og go-live (docs/BETALINGSMODEL-PLAN.md
-- afsnit 6.5). ROADMAP-BESLUTNINGER.md "Kun den nye model" (Filip, 8. okt.
-- 2026): BidHamr kører 100 % med den nye model (destination - pengene på
-- sælgerens Stripe Connect-konto). Den gamle model ("separate charges and
-- transfers") fjernes.
--
-- Forudsætninger (ellers afbrydes migrationen, og intet ændres):
--   - trin 1-4 er kørt (20261011010000 ... 20261011041000).
--   - Ingen separat-betaling er i gang (afventer/behandles, eller betalt og
--     hverken overført, refunderet, annulleret eller tabt ved indsigelse).
--     Produktionen har ingen betalinger. Testdatabasen er ryddet før.
--   - Alle aktive sælgerkonti er spejlet (trin 1's vagt:
--     betalingsmodel_backfill_mangler) - kør scripts/betalingsmodel-backfill.mts
--     --udfoer først (docs/GO-LIVE-STRIPE.md).
--
--  1. stripe_tilstand.betalingsmodel = 'destination' (og kan ikke sættes
--     tilbage: CHECK + vagt). Serveren bruger den kun som "databasen er
--     migreret"-vagt (src/lib/betaling/model.ts): står den ikke til
--     destination, nægter serveren at oprette betalinger (drift-fejl).
--  2. betalinger.pengemodel: standard 'destination', og nye rækker kan KUN
--     være destination (trigger). pengemodel kan ikke længere skiftes.
--     Gamle separat-rækker bliver stående uændret (handelsdata slettes aldrig;
--     stripe_transfer_id m.fl. bevares).
--  3. Funktioner uden separat-gren (genoprettet helt, md5-drift-tjek af den
--     normaliserede krop - samme normalisering som trin 2-4):
--     har_udbetalingskonto, saelger_kan_modtage_betaling,
--     betaling_klargoer_destination, betalinger_pengemodel_laas,
--     stripe_tilstand_betalingsmodel_vagt, udbetalingskonto_nulstil,
--     admin_forside_tal ("overførsel fejlet" -> "udbetaling fejlet"),
--     admin_penge_holdes og admin_penge_tal (kun destination).
--  4. Den gamle transfer fjernes: betaling_claim_overfoersel,
--     betaling_overfoersel_fejlet, betaling_overfoersel_loest_auto og
--     betaling_overfoersel_nulstil droppes (kun service role; ingen anden
--     funktion kalder dem - tjekkes først).
--  5. Overvågning (Niels F06): drift_tilfaelde (én alarm pr. tilfælde),
--     betaling_overvaagning (kørsel højst én gang pr. interval) og
--     betalinger.indsigelse_tabt_kl (hvornår indsigelsen blev tabt).
--
-- Idempotent. Nye og ændrede funktioner: security definer (undtagen
-- triggerfunktioner), search_path = '', ingen rettigheder til public, anon
-- eller authenticated.

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Forudsætninger
-- ===========================================================================
do $do$
declare
  n integer;
begin
  if to_regprocedure('public.betaling_indsigelse_tabt_afklar(uuid,text)') is null then
    raise exception 'trin5: trin 4 (20261011041000_betalingsmodel_trin4_rettelser.sql) er ikke kørt - kør trin 1-4 først';
  end if;

  select count(*) into n
    from public.betalinger b
    left join public.trades t on t.id = b.trade_id
   where b.pengemodel = 'separat'
     and (b.status in ('afventer', 'behandles')
          or (b.status = 'betalt' and b.refusion_anmodet_kl is not null and b.refunderet_kl is null)
          or (b.status = 'betalt'
              and b.stripe_transfer_id is null
              and b.refusion_anmodet_kl is null
              and coalesce(t.status, '') <> 'annulleret'
              and coalesce(b.indsigelse_status, '') <> 'lost'));
  if n > 0 then
    raise exception 'separat_betalinger_i_gang: % betaling(er) i den gamle model er ikke afsluttet (afventer, betalt uden overførsel eller refusion i gang). Afslut dem først - se docs/GO-LIVE-STRIPE.md', n;
  end if;

  -- Kasserede betalinger med afvigende beløb skal være refunderet: en
  -- afvigelse fra den gamle model refunderes ikke automatisk efter trin 5.
  select count(*) into n from public.betaling_afvigelser where refunderet_kl is null;
  if n > 0 then
    raise exception 'afvigelser_ikke_refunderet: % betaling(er) med afvigende beløb er ikke refunderet - refundér dem først (cron eller Stripe)', n;
  end if;

  if not exists (select 1 from public.stripe_tilstand where id) then
    raise exception 'trin5: rækken i stripe_tilstand mangler - kør 20261010070000_niels_betaling.sql og 20261011010000 først';
  end if;
end $do$;

-- Drift-tjek: kroppene skal være repoets seneste version (trin 1-4 / ældre)
-- eller denne migrations version (allerede kørt).
do $do$
declare
  r record;
  h text;
begin
  for r in
    select * from (values
      ('public.har_udbetalingskonto(uuid)',
       'cc8ae3322c25511f34ffdc4a24d5398f', '4a143fabd49ed877f4d95cf9209cafb2'),
      ('public.saelger_kan_modtage_betaling(uuid)',
       '5bed4a61cba8d4e2f637c963fc035bb2', '7a83ab35a150f690f34a0b6b628bacc2'),
      ('public.betaling_klargoer_destination(uuid,text,text)',
       '355a8ef8030a8ddf16a9d61530945709', 'a19f108395e46f28f6dc517040f5e183'),
      ('public.betalinger_pengemodel_laas()',
       '30ea05d7cf58751dabd9120cb70b3c90', '1c8f12522fd73b38fb93819fe3f0c965'),
      ('public.stripe_tilstand_betalingsmodel_vagt()',
       'a6dfc4e829fb6c8a53a48af7561fb2db', '27feccdf579b0a0b1f522b367155e4a7'),
      ('public.udbetalingskonto_nulstil(uuid,uuid,text)',
       '3abe02b0c15b0fe52d16b2aa97157215', '5b24f46324cd68c312e1574885fe816a'),
      ('public.admin_forside_tal()',
       '6a34a665112079afa7b0d2c96bb1d86d', '96cbe81845df16be6ca3e9faa3aabb92'),
      ('public.admin_penge_holdes(integer)',
       '952173b9a04ede95438fd49da5b3ec20', '61b21b8c00f3b8740a287ed61b8c02bd'),
      ('public.admin_penge_tal(timestamp with time zone,timestamp with time zone)',
       '168599dca4d37c1844e5bceb124d7cbb', '01f2628b517dfab3d30242ef138d1bd5')
    ) as v(fn, gammel, ny)
  loop
    select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
      into h
      from pg_proc p where p.oid = r.fn::regprocedure;
    if h = r.ny then
      raise notice '%: allerede rettet', r.fn;
    elsif h is distinct from r.gammel then
      raise exception '%: kroppen afviger fra repoets seneste version (md5 %) - kontrollér funktionen, før migrationen køres', r.fn, h;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 1. Betalingsmodellen: kun destination
-- ===========================================================================
-- Trin 1's vagt (backfill gennemført) bevares; nyt: kan ikke sættes tilbage
-- til 'separat'.
create or replace function public.stripe_tilstand_betalingsmodel_vagt()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  n integer;
begin
  if new.betalingsmodel is distinct from old.betalingsmodel
     and new.betalingsmodel is distinct from 'destination' then
    raise exception 'betalingsmodel_kun_destination: den gamle model (separat) er fjernet - betalingsmodellen kan kun være destination';
  end if;
  if new.betalingsmodel = 'destination'
     and new.betalingsmodel is distinct from old.betalingsmodel then
    select count(*) into n
      from public.betalingsprofiler
     where stripe_account_id is not null
       and connect_detaljer_indsendt
       and connect_frakoblet_kl is null
       and connect_udbetalingsplan is null;
    if n > 0 then
      raise exception 'betalingsmodel_backfill_mangler: % sælgerkonto(er) er ikke spejlet - kør scripts/betalingsmodel-backfill.mts --udfoer først', n;
    end if;
  end if;
  return new;
end;
$fn$;

revoke all on function public.stripe_tilstand_betalingsmodel_vagt() from public, anon, authenticated;

update public.stripe_tilstand
   set betalingsmodel = 'destination'
 where id and betalingsmodel is distinct from 'destination';

alter table public.stripe_tilstand alter column betalingsmodel set default 'destination';

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'stripe_tilstand_kun_destination'
                   and conrelid = 'public.stripe_tilstand'::regclass) then
    alter table public.stripe_tilstand
      add constraint stripe_tilstand_kun_destination check (betalingsmodel = 'destination');
  end if;
end $do$;

comment on column public.stripe_tilstand.betalingsmodel is
  'Altid destination (20261011050000): pengene står på sælgerens Connect-konto med manuel udbetaling. Den gamle model (separat) er fjernet. Serveren nægter at oprette betalinger, hvis feltet ikke er destination (databasen ikke migreret) - src/lib/betaling/model.ts.';

-- ===========================================================================
-- 2. betalinger.pengemodel: kun destination for nye rækker
-- ===========================================================================
alter table public.betalinger alter column pengemodel set default 'destination';

create or replace function public.betalinger_kun_destination()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.pengemodel is distinct from 'destination' then
    raise exception 'betalinger_kun_destination: nye betalinger skal være destination (den gamle model er fjernet)';
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_kun_destination() from public, anon, authenticated;

drop trigger if exists betalinger_kun_destination on public.betalinger;
create trigger betalinger_kun_destination
  before insert on public.betalinger
  for each row execute function public.betalinger_kun_destination();

-- pengemodel kan ikke længere ændres (skiftet separat -> destination fra
-- trin 2 findes ikke mere).
create or replace function public.betalinger_pengemodel_laas()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.pengemodel is distinct from old.pengemodel then
    raise exception 'betalinger_pengemodel_laast: pengemodel kan ikke ændres';
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_pengemodel_laas() from public, anon, authenticated;

comment on column public.betalinger.pengemodel is
  'destination (alle nye betalinger fra 20261011050000): betaling på sælgerens vegne (on_behalf_of + transfer_data), pengene står på sælgerens Connect-konto, manuel payout (saelger_udbetaling_id). separat: kun historiske rækker fra den gamle model (BidHamrs saldo + transfer, stripe_transfer_id) - arkiveret, røres ikke. Kan ikke ændres.';

-- ===========================================================================
-- 3. Funktioner uden separat-gren
-- ===========================================================================
-- Kan sælgerens konto tage imod betaling nu? (spejlet fra Stripe -
-- serveren tjekker desuden kontoen frisk, før en PaymentIntent laves).
create or replace function public.saelger_kan_modtage_betaling(p_saelger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.betalingsprofiler bp
     where bp.user_id = p_saelger
       and bp.stripe_account_id is not null
       and bp.connect_frakoblet_kl is null
       and coalesce(bp.connect_spaerret_aarsag, '') not like 'rejected.%'
       and bp.connect_charges_enabled
       and bp.connect_kort_aktiv
       and bp.connect_plan_ok);
$fn$;

revoke all on function public.saelger_kan_modtage_betaling(uuid) from public, anon, authenticated;
grant execute on function public.saelger_kan_modtage_betaling(uuid) to service_role;

-- Opret auktion m.m. (Filip 8. okt. 2026): kontoen oprettet med kortbetaling
-- anmodet og oplysningerne sendt ind; auktionen må køre, mens Stripe godkender
-- (betalingen venter). Frosset = nej.
create or replace function public.har_udbetalingskonto(p_bruger uuid)
returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.betalingsprofiler bp
     where bp.user_id = p_bruger
       and bp.stripe_account_id is not null
       and bp.connect_detaljer_indsendt
       and bp.connect_frakoblet_kl is null
       and bp.saelger_frosset_kl is null
       and coalesce(bp.connect_spaerret_aarsag, '') not like 'rejected.%'
       and bp.connect_betalingsmetoder ? 'card_payments'
  );
$fn$;

revoke all on function public.har_udbetalingskonto(uuid) from public, anon, authenticated;
grant execute on function public.har_udbetalingskonto(uuid) to service_role;

-- Låser sælgerens konto og BidHamrs gebyr på betalingen, før en destination-
-- PaymentIntent oprettes. p_gammel_pi bruges ikke længere (skiftet fra den
-- gamle model er fjernet) - signaturen bevares for kompatibilitet.
-- Svar: 'klar', 'har_pi', 'venter', 'ikke_afventer', 'konto_aendret',
-- 'ikke_destination' (en historisk separat-række - laves aldrig).
create or replace function public.betaling_klargoer_destination(
  p_betaling uuid, p_konto text, p_gammel_pi text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b     record;
  konto text;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found or b.status <> 'afventer' or b.stripe_charge_id is not null then
    return 'ikke_afventer';
  end if;
  if b.pengemodel is distinct from 'destination' then
    return 'ikke_destination';
  end if;
  if b.venter_paa_saelgerkonto_kl is not null then
    return 'venter';
  end if;
  select bp.stripe_account_id into konto
    from public.betalingsprofiler bp where bp.user_id = b.seller_id;
  if konto is null or konto is distinct from p_konto then
    return 'konto_aendret';
  end if;
  if b.stripe_payment_intent_id is not null then
    return 'har_pi';
  end if;
  update public.betalinger
     set saelger_stripe_konto = p_konto,
         application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere + beskyttelse_oere,
         opdateret = now()
   where id = b.id;
  return 'klar';
end;
$fn$;

revoke all on function public.betaling_klargoer_destination(uuid, text, text) from public, anon, authenticated;
grant execute on function public.betaling_klargoer_destination(uuid, text, text) to service_role;

-- Admin/chef nulstiller en lukket (frakoblet) udbetalingskonto, så sælgeren
-- kan oprette en ny hos Stripe. Som før (20261003061000) - nyt:
--   - destination-spejlet (charges_enabled, kort, betalingsmetoder, plan,
--     "venter på bank") nulstilles også.
--   - Betalte destination-handler, der ikke er udbetalt, står på den GAMLE
--     Stripe-konto (låst på betalingen) og kan ikke udbetales til den nye:
--     de markeres til staff (ingen automatisk overførsel som i den gamle
--     model). 'ventende' = antal markerede.
create or replace function public.udbetalingskonto_nulstil(p_medarbejder uuid, p_bruger uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_note     text := btrim(coalesce(p_begrundelse, ''));
  p          record;
  v_antal    integer;
  v_ventende integer;
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users
        where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note = '' then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;
  if p_bruger is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_bruger = p_medarbejder then return jsonb_build_object('kode', 'inhabil'); end if;

  select * into p from public.betalingsprofiler where user_id = p_bruger for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p.connect_frakoblet_kl is null then
    return jsonb_build_object('kode', 'ikke_frakoblet');
  end if;
  if coalesce(p.connect_spaerret_aarsag, '') like 'rejected.%' then
    return jsonb_build_object('kode', 'afvist_af_stripe');
  end if;

  update public.betalingsprofiler
     set connect_tidligere_konti =
           case when p.stripe_account_id is null
                  or p.stripe_account_id = any(connect_tidligere_konti)
                then connect_tidligere_konti
                else connect_tidligere_konti || p.stripe_account_id end,
         stripe_account_id              = null,
         connect_detaljer_indsendt      = false,
         connect_overfoersler_aktiv     = false,
         connect_udbetalinger_aktiv     = false,
         connect_mangler_nu             = '{}',
         connect_mangler_forfaldne      = '{}',
         connect_spaerret_aarsag        = null,
         connect_mangler_siden          = null,
         connect_klar_kl                = null,
         connect_frakoblet_kl           = null,
         connect_kraever_opmaerksomhed  = false,
         connect_opmaerksomhed_aarsag   = null,
         connect_opmaerksomhed_kl       = null,
         connect_charges_enabled        = false,
         connect_kort_aktiv             = false,
         connect_betalingsmetoder       = '{}'::jsonb,
         connect_udbetalingsplan        = null,
         connect_plan_ok                = false,
         connect_udbetaling_fejlet_kl   = null,
         connect_udbetaling_fejlet_bank = null,
         connect_udbetaling_fejlkode    = null,
         connect_nulstillet_antal       = connect_nulstillet_antal + 1,
         opdateret                      = now()
   where user_id = p_bruger
  returning connect_nulstillet_antal into v_antal;

  update public.betalinger
     set kraever_opmaerksomhed = true,
         sidste_fejl = 'Sælgerens udbetalingskonto er nulstillet af BidHamr. Pengene står på '
                       || 'sælgerens gamle Stripe-konto og kan ikke udbetales automatisk - kontrollér kontoen i Stripe.',
         opdateret = now()
   where seller_id = p_bruger
     and pengemodel = 'destination'
     and status = 'betalt'
     and saelger_udbetaling_id is null
     and refusion_anmodet_kl is null
     and saelger_stripe_konto is not distinct from p.stripe_account_id;
  get diagnostics v_ventende = row_count;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'udbetalingskonto_nulstillet', 'bruger', p_bruger, p_bruger,
          left(v_note || coalesce(' (tidligere Stripe-konto: ' || p.stripe_account_id || ')', ''), 2200));

  return jsonb_build_object('kode', 'ok', 'nulstillet_antal', v_antal, 'ventende', v_ventende);
end;
$fn$;

revoke all on function public.udbetalingskonto_nulstil(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.udbetalingskonto_nulstil(uuid, uuid, text) to service_role;

-- admin_forside_tal: som i 20261006011000_fragt_rettelser.sql, men
-- 'overfoersel_fejlet' (gammel transfer) er erstattet af 'udbetaling_fejlet':
-- frigivne destination-handler, staff skal se på, hvor udbetalingen til
-- sælgerens bank ikke er gennemført (ikke startet, uafklaret, fejlet,
-- annulleret eller afvist).
create or replace function public.admin_forside_tal()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  c_system   constant uuid := '00000000-0000-4000-8000-0000000b1d00';
  c_tz       constant text := 'Europe/Copenhagen';
  v_lokal    timestamp := now() at time zone c_tz;
  v_dag      timestamptz := date_trunc('day', v_lokal) at time zone c_tz;
  v_uge      timestamptz := date_trunc('week', v_lokal) at time zone c_tz;
  v_maaned   timestamptz := date_trunc('month', v_lokal) at time zone c_tz;
  v_start30  date := (date_trunc('day', v_lokal) - interval '29 days')::date;
  v_handling jsonb;
  v_brugere  jsonb;
  v_tilvaekst jsonb;
  v_aktivitet jsonb;
begin
  -- ---------------------------------------------------------- Kræver handling
  select jsonb_build_object(
    -- Samme taelling som antal_aabne_sager() (uden anker - de har eget kort).
    'aabne_sager',
      (select count(*) from public.sager where status = 'aaben'),
    -- Afventer retur, hvor koeberens 7 dages frist er udloebet, og returen
    -- ikke er registreret: staff skal tage stilling. Samme beregning som
    -- sag_afgoer / sag_genaabn (20261005021000).
    'retur_udloebet',
      (select count(*)
         from public.sager s
         left join public.sag_anker a on a.sag_id = s.id
        where s.status = 'afventer_retur'
          and s.retur_afleveret_kl is null
          and (a.id is null or a.status <> 'afventer')
          and greatest(coalesce(s.penge_flyttes_efter_kl, s.afgjort_kl + interval '4 days'),
                       coalesce(a.behandlet_kl, '-infinity'::timestamptz))
              + interval '7 days' <= now()),
    'anker',
      (select count(*) from public.sag_anker where status = 'afventer'),
    'rapporter',
      (select count(*) from public.reports where status = 'pending'),
    -- Handler der haenger: samme regler som Haenger-fanen paa /admin/handler
    -- (admin_haengende_handler).
    'ikke_sendt',
      (select count(*) from public.admin_haengende_handler() where grund = 'ikke_sendt'),
    'ikke_modtaget',
      (select count(*) from public.admin_haengende_handler() where grund = 'ikke_modtaget'),
    'afhentning',
      (select count(*) from public.admin_haengende_handler() where grund = 'afhentning'),
    'ubetalte',
      (select count(*) from public.ubetalte_vindere where status = 'afventer'),
    -- Alle betalinger, staff skal se paa (samme som menuens badge).
    'betalinger',
      (select count(*) from public.betalinger where kraever_opmaerksomhed),
    -- Delmaengder af 'betalinger' til visning.
    'udbetaling_fejlet',
      (select count(*) from public.betalinger b
        where b.kraever_opmaerksomhed
          and b.pengemodel = 'destination'
          and b.status = 'betalt'
          and b.frigivet_kl is not null
          and b.refusion_anmodet_kl is null
          and (b.saelger_udbetaling_id is null
               or exists (select 1 from public.saelger_udbetalinger su
                           where su.id = b.saelger_udbetaling_id
                             and su.status in ('claimet', 'usikker', 'failed', 'canceled', 'afvist')))),
    'refusion_fejlet',
      (select count(*) from public.betalinger
        where kraever_opmaerksomhed
          and refusion_forsoeg > 0
          and refunderet_kl is null),
    'afvigelser',
      (select count(*) from public.betaling_afvigelser where refunderet_kl is null),
    'udbetalingskonti',
      (select count(*) from public.betalingsprofiler where connect_kraever_opmaerksomhed),
    'kontolukninger',
      (select count(*) from public.konto_lukning_forslag where status = 'afventer'),
    -- Forsendelser, staff skal se paa (samme som fanen Fragt paa /admin/handler).
    'fragt',
      (select count(*) from public.forsendelser where kraever_opmaerksomhed)
  ) into v_handling;

  -- ---------------------------------------------------------- Brugere
  select jsonb_build_object(
    'i_alt',   count(*),
    'i_dag',   count(*) filter (where oprettet >= v_dag),
    'uge',     count(*) filter (where oprettet >= v_uge),
    'maaned',  count(*) filter (where oprettet >= v_maaned)
  ) into v_brugere
  from public.users
  where id <> c_system;

  -- Tilvaekst: een raekke pr. dag (lokal dato), nye + kumulativt i alt ved
  -- dagens udgang.
  with dage as (
    select d::date as dag
      from generate_series(v_start30, date_trunc('day', v_lokal)::date, interval '1 day') d
  ), nye as (
    select (oprettet at time zone c_tz)::date as dag, count(*) as antal
      from public.users
     where id <> c_system
       and oprettet >= (v_start30::timestamp at time zone c_tz)
     group by 1
  ), foer as (
    select count(*) as antal
      from public.users
     where id <> c_system
       and oprettet < (v_start30::timestamp at time zone c_tz)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'dag', to_char(x.dag, 'YYYY-MM-DD'),
           'nye', x.nye,
           'kumulativt', x.kumulativt) order by x.dag), '[]'::jsonb)
    into v_tilvaekst
    from (
      select dg.dag,
             coalesce(n.antal, 0) as nye,
             (select antal from foer)
               + sum(coalesce(n.antal, 0)) over (order by dg.dag) as kumulativt
        from dage dg
        left join nye n on n.dag = dg.dag
    ) x;

  -- ---------------------------------------------------------- Aktivitet
  select jsonb_build_object(
    'auktioner', (
      select jsonb_build_object(
        'i_dag',  count(*) filter (where oprettet >= v_dag),
        'uge',    count(*) filter (where oprettet >= v_uge),
        'maaned', count(*) filter (where oprettet >= v_maaned))
        from public.auctions
       where oprettet >= least(v_uge, v_maaned)),
    -- Solgte varer = handler, hvor betalingen er gennemfoert i perioden
    -- (ogsaa hvis den senere er refunderet - salget skete).
    'solgte', (
      select jsonb_build_object(
        'i_dag',  count(*) filter (where betalt_kl >= v_dag),
        'uge',    count(*) filter (where betalt_kl >= v_uge),
        'maaned', count(*) filter (where betalt_kl >= v_maaned))
        from public.betalinger
       where betalt_kl >= least(v_uge, v_maaned))
  ) into v_aktivitet;

  return jsonb_build_object(
    'handling',  v_handling,
    'brugere',   v_brugere,
    'tilvaekst', v_tilvaekst,
    'aktivitet', v_aktivitet,
    'beregnet_kl', now());
end;
$fn$;

comment on function public.admin_forside_tal() is
  'Tal til admin-forsiden (antal, ingen beloeb eller personoplysninger). '
  'Kun service_role - serveren kalder den efter assertRole(''medarbejder'').';

revoke all on function public.admin_forside_tal() from public, anon, authenticated;
grant execute on function public.admin_forside_tal() to service_role;

-- Penge, der holdes (chef): betalt og ikke udbetalt til sælgerens bank.
-- Kun destination - pengene står på sælgerens Stripe-konto, indtil
-- udbetalingen er gennemført (paid). Historiske separat-rækker tælles ikke.
create or replace function public.admin_penge_holdes(p_graense integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with h as (
    select bt.id as betaling_id, bt.trade_id, bt.auction_id, bt.total_oere,
           bt.udbetaling_oere, bt.betalt_kl, bt.kraever_opmaerksomhed,
           t.status as handel_status, s.penge_fejl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then 'indsigelse'
             when bt.refusion_anmodet_kl is not null then 'refusion_i_gang'
             when su.id is not null then 'udbetaling_paa_vej'
             when bt.frigivet_kl is not null
                  and bp.connect_udbetaling_fejlet_kl is not null then 'venter_paa_bank'
             when bt.frigivet_kl is not null then 'afventer_udbetaling'
             when an.id is not null then 'afventer_anke'
             when s.status = 'aaben' then 'afventer_sag'
             when s.status = 'afventer_retur' then 'afventer_retur'
             when s.penge_handling is not null then 'ankefrist'
             when coalesce(t.sag_aaben, false) then 'frosset'
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'afhentning'
             when t.status = 'betaling_modtaget' then 'afventer_afsendelse'
             when t.status = 'pakke_sendt' then 'auto_frigivelse'
             when t.status = 'modtaget' and t.received_at is not null then 'auto_frigivelse'
             else 'kraever_tjek'
           end as grund,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
                  or bt.refusion_anmodet_kl is not null
               then null
             when bt.frigivet_kl is not null and su.id is null
                  and bp.connect_udbetaling_fejlet_kl is null
               then greatest(coalesce(bt.midler_tilgaengelige_kl, now()),
                             coalesce(bt.udbetal_tidligst, '-infinity'::timestamptz))
             when su.id is not null
                  or bt.frigivet_kl is not null
                  or an.id is not null
                  or s.status = 'aaben'
               then null
             when s.status = 'afventer_retur' or s.penge_handling is not null
               then s.penge_flyttes_efter_kl
             when coalesce(t.sag_aaben, false) or coalesce(t.afhentning, false) then null
             when t.status = 'betaling_modtaget' then bt.betalt_kl + interval '5 days'
             when t.status = 'pakke_sendt'
               then coalesce(t.sendt_kl, bt.betalt_kl) + interval '14 days'
             when t.status = 'modtaget' then t.received_at + interval '48 hours'
           end as forventet_kl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then null
             when bt.refusion_anmodet_kl is not null then 'refunder'
             when su.id is not null or bt.frigivet_kl is not null
               then 'frigiv'
             when an.id is not null or s.status = 'aaben' then null
             when s.status = 'afventer_retur' then 'refunder'
             when s.penge_handling is not null then s.penge_handling
             when coalesce(t.sag_aaben, false) then null
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'frigiv'
             when t.status = 'betaling_modtaget' then 'refunder'
             when t.status in ('pakke_sendt', 'modtaget') then 'frigiv'
           end as handling
      from public.betalinger bt
      join public.trades t on t.id = bt.trade_id
      left join public.saelger_udbetalinger su on su.id = bt.saelger_udbetaling_id
      left join public.betalingsprofiler bp on bp.user_id = bt.seller_id
      left join lateral (
        select s1.status, s1.penge_handling, s1.penge_flyttes_efter_kl, s1.penge_fejl
          from public.sager s1
         where s1.trade_id = bt.trade_id
           and (s1.status in ('aaben', 'afventer_retur')
                or (s1.penge_handling is not null and s1.afviklet_kl is null))
         order by s1.oprettet_kl desc
         limit 1
      ) s on true
      left join lateral (
        select a1.id from public.sag_anker a1
         where a1.trade_id = bt.trade_id and a1.status = 'afventer'
         limit 1
      ) an on true
     where bt.pengemodel = 'destination'
       and bt.status = 'betalt'
       and bt.refunderet_kl is null
       and (su.id is null or su.status <> 'paid')
       and coalesce(bt.indsigelse_status, '') <> 'lost'
  ),
  afv as (
    select a.id, a.trade_id, a.modtaget_oere, a.oprettet, a.sidste_fejl
      from public.betaling_afvigelser a
     where a.refunderet_kl is null
  )
  select jsonb_build_object(
    'antal', (select count(*) from h),
    'beloeb', (select coalesce(sum(total_oere), 0) from h),
    'til_saelgere', (select coalesce(sum(udbetaling_oere), 0) from h),
    'efter_grund', coalesce((
      select jsonb_agg(jsonb_build_object('grund', grund, 'antal', antal, 'beloeb', beloeb)
                       order by beloeb desc)
        from (select grund, count(*) as antal, sum(total_oere) as beloeb
                from h group by grund) x), '[]'::jsonb),
    'forkerte_beloeb', jsonb_build_object(
        'antal',  (select count(*) from afv),
        'beloeb', (select coalesce(sum(modtaget_oere), 0) from afv)),
    'liste', coalesce((
      select jsonb_agg(jsonb_build_object(
               'betaling_id', l.betaling_id,
               'trade_id', l.trade_id,
               'auction_id', l.auction_id,
               'titel', au.titel,
               'total_oere', l.total_oere,
               'udbetaling_oere', l.udbetaling_oere,
               'betalt_kl', l.betalt_kl,
               'handel_status', l.handel_status,
               'grund', l.grund,
               'forventet_kl', l.forventet_kl,
               'handling', l.handling,
               'penge_fejl', l.penge_fejl,
               'kraever_opmaerksomhed', l.kraever_opmaerksomhed)
             order by l.forventet_kl asc nulls last, l.betalt_kl asc)
        from (select * from h
               order by forventet_kl asc nulls last, betalt_kl asc
               limit greatest(1, least(coalesce(p_graense, 200), 1000))) l
        left join public.auctions au on au.id = l.auction_id), '[]'::jsonb)
  );
$function$;

revoke all on function public.admin_penge_holdes(integer) from public, anon, authenticated;
grant execute on function public.admin_penge_holdes(integer) to service_role;

-- Pengetal (chef): kun destination. "Givet til sælger" = udbetalingen til
-- sælgerens bank er sendt (saelger_udbetalinger oprettet/paid);
-- overfoert_kl er tidspunktet for udbetalingen. Historiske separat-rækker
-- tælles ikke.
create or replace function public.admin_penge_tal(p_fra timestamptz, p_til timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with g as (
    select coalesce(p_fra, '-infinity'::timestamptz) as fra,
           coalesce(p_til, 'infinity'::timestamptz)  as til
  ),
  b as (
    select bt.*,
           coalesce(bt.refusion_oere, bt.total_oere) as ref_beloeb,
           (bt.refusion_oere is not null and bt.refusion_oere < bt.total_oere) as er_delvis,
           exists (select 1 from public.saelger_udbetalinger su
                    where su.id = bt.saelger_udbetaling_id
                      and su.status in ('oprettet', 'paid')) as givet_til_saelger
      from public.betalinger bt
     where bt.pengemodel = 'destination'
  ),
  betalt as (
    select b.* from b, g
     where b.betalt_kl is not null and b.betalt_kl >= g.fra and b.betalt_kl < g.til
  ),
  aktive as (
    select * from betalt
     where status = 'betalt'
       and refusion_anmodet_kl is null
       and coalesce(indsigelse_status, '') <> 'lost'
  ),
  delvis as (
    select d.*, f.besk, f.kgeb, f.fragt, f.beholdt - f.besk - f.kgeb - f.fragt as oevrigt
      from betalt d
      cross join lateral (
        select x.beholdt, x.besk, x.kgeb,
               least(d.fragt_oere, x.beholdt - x.besk - x.kgeb) as fragt
          from (
            select y.beholdt, y.besk,
                   least(d.koebergebyr_oere, y.beholdt - y.besk) as kgeb
              from (
                select d.total_oere - d.refusion_oere as beholdt,
                       least(d.beskyttelse_oere, d.total_oere - d.refusion_oere) as besk
              ) y
          ) x
      ) f
     where d.status = 'refunderet'
       and d.er_delvis
       and not d.givet_til_saelger
       and d.overfoersel_paabegyndt_kl is null
  ),
  refunderet as (
    select b.* from b, g
     where b.status = 'refunderet'
       and b.refunderet_kl >= g.fra and b.refunderet_kl < g.til
  ),
  ref_i_gang as (
    select b.* from b, g
     where b.status = 'betalt'
       and b.refusion_anmodet_kl is not null
       and b.refusion_anmodet_kl >= g.fra and b.refusion_anmodet_kl < g.til
  ),
  overfoert as (
    select b.* from b, g
     where b.givet_til_saelger
       and b.overfoert_kl >= g.fra and b.overfoert_kl < g.til
  ),
  indsigelser as (
    select b.*,
           (b.givet_til_saelger or b.overfoersel_paabegyndt_kl is not null) as efter_udbetaling
      from b, g
     where b.indsigelse_kl is not null
       and b.indsigelse_kl >= g.fra and b.indsigelse_kl < g.til
  ),
  afv_modtaget as (
    select a.* from public.betaling_afvigelser a, g
     where a.oprettet >= g.fra and a.oprettet < g.til
  ),
  afv_refunderet as (
    select a.* from public.betaling_afvigelser a, g
     where a.refunderet_kl is not null
       and a.refunderet_kl >= g.fra and a.refunderet_kl < g.til
  )
  select jsonb_build_object(
    'betalinger_modtaget', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(total_oere), 0)) from betalt),
    'forkerte_beloeb_modtaget', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(modtaget_oere), 0)) from afv_modtaget),
    'omsaetning', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(bud_oere), 0)) from aktive),
    'indtjening', (
      select jsonb_build_object(
        'koebergebyr',  a.kgeb + d.kgeb,
        'saelgergebyr', a.sgeb,
        'beskyttelse',  a.besk + d.besk,
        'oevrigt',      d.oevrigt,
        'i_alt',        a.kgeb + d.kgeb + a.sgeb + a.besk + d.besk + d.oevrigt,
        'heraf_ikke_frigivet', a.ikke_frigivet,
        'antal_beskyttelse', a.antal_besk)
        from (select coalesce(sum(koebergebyr_oere), 0)  as kgeb,
                     coalesce(sum(saelgergebyr_oere), 0) as sgeb,
                     coalesce(sum(beskyttelse_oere), 0)  as besk,
                     count(*) filter (where beskyttelse)  as antal_besk,
                     coalesce(sum(koebergebyr_oere + saelgergebyr_oere + beskyttelse_oere)
                              filter (where not givet_til_saelger), 0) as ikke_frigivet
                from aktive) a,
             (select coalesce(sum(kgeb), 0) as kgeb,
                     coalesce(sum(besk), 0) as besk,
                     coalesce(sum(oevrigt), 0) as oevrigt
                from delvis) d),
    'fragt', (select jsonb_build_object(
        'beloeb', (select coalesce(sum(fragt_oere), 0) from aktive)
                  + (select coalesce(sum(fragt), 0) from delvis),
        'antal',  (select count(*) from aktive where fragt_oere > 0))),
    'udbetalinger', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(udbetaling_oere), 0)) from overfoert),
    'refusioner', jsonb_build_object(
        'fulde', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0))
            from refunderet where not er_delvis),
        'delvise', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0))
            from refunderet where er_delvis),
        'i_gang', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0)) from ref_i_gang),
        'forkerte_beloeb', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(modtaget_oere), 0)) from afv_refunderet),
        'efter_udbetaling', (select jsonb_build_object(
            'antal', count(*),
            'refunderet', coalesce(sum(ref_beloeb), 0),
            'udbetalt', coalesce(sum(udbetaling_oere), 0))
            from refunderet
           where givet_til_saelger or overfoersel_paabegyndt_kl is not null)),
    'indsigelser', (select jsonb_build_object(
        'antal',  count(*),
        'beloeb', coalesce(sum(total_oere), 0),
        'aabne',  count(*) filter (where public.betaling_indsigelse_blokerer(indsigelse_kl, indsigelse_status)
                                    and coalesce(indsigelse_status, '') <> 'lost'),
        'vundet', count(*) filter (where indsigelse_status = 'won'),
        'lukket', count(*) filter (where indsigelse_status in ('warning_closed', 'prevented')),
        'tabt_foer_udbetaling', jsonb_build_object(
            'antal',  count(*) filter (where indsigelse_status = 'lost' and not efter_udbetaling),
            'beloeb', coalesce(sum(total_oere) filter (
                        where indsigelse_status = 'lost' and not efter_udbetaling), 0)),
        'tabt_efter_udbetaling', jsonb_build_object(
            'antal',  count(*) filter (where indsigelse_status = 'lost' and efter_udbetaling),
            'beloeb', coalesce(sum(total_oere) filter (
                        where indsigelse_status = 'lost' and efter_udbetaling), 0),
            'tab',    coalesce(sum(udbetaling_oere + fragt_oere) filter (
                        where indsigelse_status = 'lost' and efter_udbetaling), 0)))
        from indsigelser)
  );
$function$;

revoke all on function public.admin_penge_tal(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_penge_tal(timestamptz, timestamptz) to service_role;

-- ===========================================================================
-- 4. Den gamle transfer fjernes
-- ===========================================================================
-- Kun service role har kunnet kalde dem (serveren - overfoerTilSaelger m.fl.,
-- fjernet i trin 5). Ingen anden funktion må kalde dem.
do $do$
declare
  n integer;
begin
  select count(*) into n
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname not in ('betaling_claim_overfoersel', 'betaling_overfoersel_fejlet',
                           'betaling_overfoersel_loest_auto', 'betaling_overfoersel_nulstil')
     and p.prosrc ~ '(betaling_claim_overfoersel|betaling_overfoersel_fejlet|betaling_overfoersel_loest_auto|betaling_overfoersel_nulstil)';
  if n > 0 then
    raise exception 'trin5: % funktion(er) kalder stadig den gamle transfer - kontrollér før de droppes', n;
  end if;
end $do$;

drop function if exists public.betaling_claim_overfoersel(uuid);
drop function if exists public.betaling_overfoersel_fejlet(uuid, text);
drop function if exists public.betaling_overfoersel_loest_auto(uuid);
drop function if exists public.betaling_overfoersel_nulstil(uuid);

comment on column public.betalinger.stripe_transfer_id is
  'Kun den gamle model (separat, historisk): transfer fra BidHamrs saldo til sælgerens Connect-konto. Bruges ikke af nye betalinger (destination: stripe_destination_transfer_id og saelger_udbetaling_id). Bevares - handelsdata slettes aldrig.';

-- ===========================================================================
-- 5. Overvågning (Niels F06)
-- ===========================================================================
-- Ét tilfælde (fx "udbetaling X hænger", "saldo på konto Y passer ikke") giver
-- højst én drift-alarm, til det er løst. Løses det og opstår igen, alarmeres
-- der igen. Kun service role. Ingen persondata i nøglen (id'er).
create table if not exists public.drift_tilfaelde (
  noegle       text primary key check (char_length(noegle) between 1 and 200),
  aabnet_kl    timestamptz not null default now(),
  loest_kl     timestamptz,
  antal_aabnet integer not null default 1 check (antal_aabnet >= 1)
);

comment on table public.drift_tilfaelde is
  'Tilfælde, der har givet drift-alarm (én alarm pr. tilfælde, Niels F06). Kun service role.';

alter table public.drift_tilfaelde enable row level security;
revoke all on table public.drift_tilfaelde from public, anon, authenticated;
grant select, insert, update on table public.drift_tilfaelde to service_role;

-- true = tilfældet er nyt (eller genopstået efter at være løst): giv alarm.
create or replace function public.drift_tilfaelde_aabn(p_noegle text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v boolean;
begin
  if p_noegle is null or char_length(p_noegle) not between 1 and 200 then
    raise exception 'drift_tilfaelde_aabn: ugyldig nøgle';
  end if;
  insert into public.drift_tilfaelde as d (noegle)
  values (p_noegle)
  on conflict (noegle) do update
     set aabnet_kl = now(), loest_kl = null, antal_aabnet = d.antal_aabnet + 1
   where d.loest_kl is not null
  returning true into v;
  return coalesce(v, false);
end;
$fn$;

revoke all on function public.drift_tilfaelde_aabn(text) from public, anon, authenticated;
grant execute on function public.drift_tilfaelde_aabn(text) to service_role;

-- Tilfældet er løst (næste gang giver ny alarm). true = det var åbent.
create or replace function public.drift_tilfaelde_luk(p_noegle text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
begin
  update public.drift_tilfaelde
     set loest_kl = now()
   where noegle = p_noegle and loest_kl is null;
  get diagnostics n = row_count;
  return n > 0;
end;
$fn$;

revoke all on function public.drift_tilfaelde_luk(text) from public, anon, authenticated;
grant execute on function public.drift_tilfaelde_luk(text) to service_role;

-- Betalingsovervågningen (src/lib/betaling/overvaagning.ts) kører fra
-- betalings-cron'en (hvert 5. minut), men højst én gang pr. interval
-- (Stripe-opslag). Claimes atomisk.
create table if not exists public.betaling_overvaagning (
  id               boolean primary key default true check (id),
  sidst_startet_kl timestamptz
);

alter table public.betaling_overvaagning enable row level security;
revoke all on table public.betaling_overvaagning from public, anon, authenticated;
grant select, insert, update on table public.betaling_overvaagning to service_role;

insert into public.betaling_overvaagning (id) values (true) on conflict (id) do nothing;

create or replace function public.betaling_overvaagning_claim(p_minutter integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
begin
  update public.betaling_overvaagning
     set sidst_startet_kl = now()
   where id
     and (sidst_startet_kl is null
          or sidst_startet_kl <= now() - make_interval(mins => greatest(coalesce(p_minutter, 60), 1)));
  get diagnostics n = row_count;
  return n > 0;
end;
$fn$;

revoke all on function public.betaling_overvaagning_claim(integer) from public, anon, authenticated;
grant execute on function public.betaling_overvaagning_claim(integer) to service_role;

-- Hvornår en indsigelse blev tabt (alarm, når en tabt indsigelse har ventet
-- på afklaring i over 7 dage). Sættes af databasen.
alter table public.betalinger
  add column if not exists indsigelse_tabt_kl timestamptz;

comment on column public.betalinger.indsigelse_tabt_kl is
  'Hvornår indsigelsen (chargeback) første gang stod som tabt (lost). Sættes af triggeren betalinger_indsigelse_tabt_kl.';

create or replace function public.betalinger_indsigelse_tabt_kl()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.indsigelse_status = 'lost' and new.indsigelse_tabt_kl is null then
    new.indsigelse_tabt_kl := now();
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_indsigelse_tabt_kl() from public, anon, authenticated;

drop trigger if exists betalinger_indsigelse_tabt_kl on public.betalinger;
create trigger betalinger_indsigelse_tabt_kl
  before insert or update of indsigelse_status on public.betalinger
  for each row execute function public.betalinger_indsigelse_tabt_kl();

-- Eksisterende tabte indsigelser: bedste kendte tidspunkt.
update public.betalinger
   set indsigelse_tabt_kl = coalesce(indsigelse_tabt_afklaret_kl, indsigelse_lukket_kl, opdateret)
 where indsigelse_status = 'lost'
   and indsigelse_tabt_kl is null;

create index if not exists betalinger_tabt_uafklaret_idx
  on public.betalinger (indsigelse_tabt_kl)
  where indsigelse_status = 'lost' and indsigelse_tabt_afklaret is null;
