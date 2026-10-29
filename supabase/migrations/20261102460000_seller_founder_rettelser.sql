-- =============================================================================
-- Seller founder - rettelser (Filip, 29. okt. 2026 - ROADMAP-BESLUTNINGER
-- "Founderens gratis handler"). Bygger på 20261102420000_seller_founder.sql.
--
--   1. Rabatten efter auktionens sluttid: betalinger_b_prismodel bruger
--      founder_rabat_pct(sælger, least(now(), auktionens slutter_kl)), når
--      betalingen kommer fra auktionens lukning (afslut_udloebne_auktioner).
--      Så passer gebyret med det, auktion_founder_rabat viste før buddet -
--      også når cron'en er forsinket, eller aftalen skifter fase lige efter
--      sluttiden. Et stop gælder fra stoptidspunktet: er aftalen stoppet før
--      sluttiden, er rabatten 0; stoppes den efter sluttiden, gælder den
--      rabat, der var på sluttiden.
--      Tilbud til næste byder (andenchance_svar) bruger fortsat now(). De
--      kendes på, at auktionens vinder_id endnu ikke er køberen, og at der
--      ligger et tilbud til køberen på auktionen (status afventer/accepteret)
--      - andenchance_svar opretter betalingen, før den sætter vinder_id og
--      markerer tilbuddet accepteret. Er bare én af delene sand, bruges now().
--      md5-tjek før og efter.
--   2. Anslået Stripe-tab: seller_founder_json giver gratis_handler (betalte
--      handler med 100 % rabat - også refunderede, for Stripe beholder sit
--      gebyr ved refusion) og gratis_total_oere (det, køberne betalte for
--      dem). Satsen (ca. 1,5 % + 1,80 kr.) ligger i TypeScript
--      (src/lib/betaling/stripeGebyrSkoen.ts) - det er et skøn.
--   3. Alarm ved mistanke om falske handler: seller_founder_alarm_tjek()
--      finder par (founder, køber) med mindst 3 betalte handler med founder-
--      rabat inden for 30 dage og gemmer én alarm pr. par pr. periode (30
--      dage) i seller_founder_alarmer. Overvågningen i betalings-cron'en
--      kalder den og giver en drift-alarm pr. ny række. Alarmerne står på
--      founderens admin-side og på listen.
--   4. Småting fra review:
--      a. betalinger_founder_rabat_check afviser kun rabat på de kendte
--         modeller uden rabat (gammel, ny, erhverv, erhverv2) i stedet for at
--         kræve 'ny2' - en ny privat prismodel stopper ikke founder-
--         betalingerne (betalingen kunne ellers ikke oprettes, og
--         afslut_udloebne_auktioner sluger fejlen som en warning). Kommentar
--         på aktuel_prismodel.
--      b. seller_founder_json: 'handler' og 'rabat_oere' tæller ikke
--         refunderede handler med (ny: 'refunderede').
--      c. Genoptages en aftale, bevares den første oprettelse (oprettet_kl/
--         oprettet_af); genoptagelsen står i genoptaget_kl/genoptaget_af.
--         Rækker, der allerede er genoptaget, får den første oprettelse
--         tilbage fra moderation_log.
--      d. Brugere med en staff-rolle (alt andet end 'bruger') kan ikke gøres
--         til founder (kode 'staff', også i triggeren) og får ingen rabat.
--
-- Idempotent (kan køres igen). Én transaktion: ingen egen begin;/commit;.
-- Ingen handelsdata ændres. KØRES IKKE i produktion uden Filips "ja".
-- =============================================================================

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.seller_founder') is null
     or to_regprocedure('public.founder_rabat_pct(uuid,timestamptz)') is null
     or to_regprocedure('public.seller_founder_json(public.seller_founder)') is null
     or to_regclass('public.andenchance_tilbud') is null then
    raise exception 'Forudsætning mangler: kør 20261102420000_seller_founder.sql først';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælper (kun i denne session) - samme md5 som 20261102420000
-- ===========================================================================
create or replace function pg_temp.sfr_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Drift-tjek: triggeren skal være 20261102420000's version eller allerede
-- denne. Ellers afbrydes migrationen, før noget ændres.
do $do$
declare
  h text := pg_temp.sfr_md5('public.betalinger_b_prismodel()');
begin
  if h is distinct from '71c3db40bf76679a88c6a4902b896d6b'
     and h is distinct from '095aa253737258905ae53646ce759616' then
    raise exception 'betalinger_b_prismodel: md5 % er hverken 20261102420000 eller denne migration - kontrollér funktionen, før migrationen køres', h;
  end if;
end $do$;

-- ===========================================================================
-- 1. Rabatten efter auktionens sluttid
-- ===========================================================================
create or replace function public.betalinger_b_prismodel()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_erhverv boolean;
  v_saelger uuid;
  v_auktion uuid;
  v_slut    timestamptz;
  v_vinder  uuid;
  v_tid     timestamptz;
begin
  if tg_op = 'INSERT' then
    v_auktion := coalesce(new.auction_id,
                          (select t.auction_id from public.trades t where t.id = new.trade_id));
    select coalesce(a.erhverv, false), a.bruger_id, a.slutter_kl, a.vinder_id
      into v_erhverv, v_saelger, v_slut, v_vinder
      from public.auctions a
     where a.id = v_auktion;
    v_erhverv := coalesce(v_erhverv, false);
    v_saelger := coalesce(v_saelger, new.seller_id);
    -- 20261102460000: founder-rabatten regnes ud fra auktionens sluttid, når
    -- betalingen kommer fra auktionens lukning (køberen er auktionens vinder).
    -- Tilbud til næste byder (andenchance_svar sætter vinder_id og tilbuddets
    -- status EFTER betalingen): nu.
    v_tid := case
               when v_slut is not null
                    and v_vinder = new.buyer_id
                    and not exists (select 1 from public.andenchance_tilbud x
                                     where x.auction_id = v_auktion
                                       and x.byder_id = new.buyer_id
                                       and x.status in ('afventer', 'accepteret'))
                 then least(now(), v_slut)
               else now()
             end;
    -- 20261101010000: erhvervshandler uden sælgergebyr ('erhverv2').
    -- 20261102140000: private handler med glidende overgang ('ny2').
    new.prismodel         := public.aktuel_prismodel(v_erhverv);
    -- 20261102420000: seller founder-rabat (låst). Firmaer aldrig.
    new.founder_rabat_pct := case when v_erhverv then 0
                                  else public.founder_rabat_pct(v_saelger, v_tid) end;
    new.fragt_oere        := coalesce(new.fragt_oere, 0);
    new.koebergebyr_oere  := public.founder_gebyr_oere(
                               public.prismodel_koebergebyr_oere(new.prismodel, new.bud_oere), new.founder_rabat_pct);
    new.saelgergebyr_oere := public.founder_gebyr_oere(
                               public.prismodel_saelgergebyr_oere(new.prismodel, new.bud_oere), new.founder_rabat_pct);
    new.udbetaling_oere   := new.bud_oere - new.saelgergebyr_oere;
    new.beskyttelse_oere  := 0;
    new.beskyttelse       := not v_erhverv and new.fragt_oere > 0;
    new.total_oere        := new.bud_oere + new.koebergebyr_oere + new.fragt_oere;
    return new;
  end if;

  -- UPDATE: prismodellen og founder-rabatten kan ikke ændres. I den nye
  -- model følger beskyttelse leveringsformen (fragt > 0 = forsendelse).
  -- Beløbene røres ikke her (CHECK-formlerne afviser forkerte beløb).
  new.prismodel := old.prismodel;
  new.founder_rabat_pct := old.founder_rabat_pct;
  if old.prismodel <> 'gammel' then
    new.beskyttelse := old.prismodel in ('ny', 'ny2') and coalesce(new.fragt_oere, 0) > 0;
  end if;
  return new;
end;
$function$;

do $do$
begin
  if pg_temp.sfr_md5('public.betalinger_b_prismodel()') is distinct from '095aa253737258905ae53646ce759616' then
    raise exception 'betalinger_b_prismodel: efter rettelsen er md5 %', pg_temp.sfr_md5('public.betalinger_b_prismodel()');
  end if;
end $do$;

-- Triggeren selv er uændret (samme kolonner som 20261102420000).
drop trigger if exists betalinger_b_prismodel on public.betalinger;
create trigger betalinger_b_prismodel
  before insert or update of prismodel, fragt_oere, beskyttelse, founder_rabat_pct on public.betalinger
  for each row execute function public.betalinger_b_prismodel();

-- ===========================================================================
-- 4a. En ny privat prismodel må ikke stoppe founder-betalingerne
-- ===========================================================================
do $do$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.betalinger'::regclass and conname = 'betalinger_founder_rabat_check';
  if v_def is null or strpos(v_def, 'erhverv2') = 0 then
    alter table public.betalinger drop constraint if exists betalinger_founder_rabat_check;
    -- Alle eksisterende rækker passer ('ny2' er ikke på listen), så den
    -- valideres med det samme.
    alter table public.betalinger add constraint betalinger_founder_rabat_check
      check (founder_rabat_pct in (0, 50, 100)
             and (founder_rabat_pct = 0 or prismodel not in ('gammel', 'ny', 'erhverv', 'erhverv2')));
  end if;
end $do$;

comment on function public.aktuel_prismodel(boolean) is
  'Prismodellen for en ny betaling (20261102140000): erhverv2 for erhvervsauktioner, ellers ny2. NY MODEL? Seller founder (20261102420000/20261102460000): betalinger_b_prismodel giver founder-rabat på alle private modeller, og betalinger_founder_rabat_check afviser kun de gamle (gammel, ny, erhverv, erhverv2). En ny privat model skal kunne regnes af prismodel_koebergebyr_oere/prismodel_saelgergebyr_oere og founder_gebyr_oere, og TypeScript-spejlet (src/lib/betaling/beregn.ts koebergebyrForPrismodel) skal give rabat på den - ellers afviser serveren PaymentIntent for founderens handler. En ny ERHVERVS-model skal på listen i betalinger_founder_rabat_check.';

-- ===========================================================================
-- 4c. Genoptagelse bevarer den første oprettelse
-- ===========================================================================
alter table public.seller_founder add column if not exists genoptaget_kl timestamptz;
alter table public.seller_founder add column if not exists genoptaget_af uuid references public.users(id);

-- Rækker, der allerede er genoptaget med 20261102420000 (oprettet_kl blev
-- overskrevet): den første oprettelse hentes fra moderation_log.
-- Idempotent: anden gang er den første log-linje = oprettet_kl.
update public.seller_founder sf
   set genoptaget_kl = sf.oprettet_kl,
       genoptaget_af = sf.oprettet_af,
       oprettet_kl   = m.foerst,
       oprettet_af   = m.af
  from (select distinct on (l.bruger_id) l.bruger_id, l.oprettet_kl as foerst, l.medarbejder_id as af
          from public.moderation_log l
         where l.handling = 'seller_founder_oprettet'
         order by l.bruger_id, l.oprettet_kl) m
 where m.bruger_id = sf.bruger_id
   and m.foerst < sf.oprettet_kl - interval '1 second';

comment on column public.seller_founder.oprettet_kl is
  'Første gang brugeren blev founder (bevares, når aftalen genoptages - 20261102460000).';
comment on column public.seller_founder.genoptaget_kl is
  'Seneste gang en stoppet aftale blev genoptaget (null = aldrig). 20261102460000.';

-- ===========================================================================
-- 4d. Staff kan ikke være founder
-- ===========================================================================
-- Firmakonti og staff kan aldrig være (aktiv) founder. Et stop er altid tilladt.
create or replace function public.seller_founder_kun_privat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.stoppet_kl is null then
    if exists (select 1 from public.users u where u.id = new.bruger_id and coalesce(u.konto_type, 'privat') <> 'privat')
       or exists (select 1 from public.firmaer f where f.bruger_id = new.bruger_id) then
      raise exception 'Firmakonti kan ikke være seller founder' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.users u where u.id = new.bruger_id and coalesce(u.rolle, 'bruger') <> 'bruger') then
      raise exception 'Staff kan ikke være seller founder' using errcode = 'check_violation';
    end if;
  end if;
  new.opdateret_kl := now();
  return new;
end
$fn$;
revoke execute on function public.seller_founder_kun_privat() from public, anon, authenticated;

-- Rabatten: som 20261102420000, men 0 for staff (fx en founder, der senere
-- får en staff-rolle).
create or replace function public.founder_rabat_pct(p_bruger uuid, p_tid timestamptz)
returns smallint
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((
    select case
             when d.dag < sf.start_dato then 0
             when d.dag < (sf.start_dato + interval '6 months')::date then 100
             else 50
           end
      from public.seller_founder sf
      join public.users u on u.id = sf.bruger_id
     cross join lateral (select (coalesce(p_tid, now()) at time zone 'Europe/Copenhagen')::date as dag) d
     where sf.bruger_id = p_bruger
       and (sf.stoppet_kl is null or sf.stoppet_kl > coalesce(p_tid, now()))
       and coalesce(u.konto_type, 'privat') = 'privat'
       and coalesce(u.rolle, 'bruger') = 'bruger'
       and not exists (select 1 from public.firmaer f where f.bruger_id = p_bruger)
  ), 0)::smallint;
$fn$;
comment on function public.founder_rabat_pct(uuid, timestamptz) is
  'Seller founder-rabat i procent på et tidspunkt (20261102420000/20261102460000): 100 fra og med start_dato til start_dato + 6 måneder (dansk dato), derefter 50; 0 uden aktiv aftale på tidspunktet, for firmaer og for staff. Spejl: src/lib/betaling/beregn.ts founderRabatPct.';
revoke execute on function public.founder_rabat_pct(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.founder_rabat_pct(uuid, timestamptz) to service_role;

-- Gør en privat bruger til founder (eller genoptag en stoppet aftale med en
-- ny startdato). Koder: ok, allerede, ingen_adgang, inhabil, ikke_fundet,
-- firma, staff, ugyldig_dato, ugyldig.
create or replace function public.seller_founder_opret(p_chef uuid, p_bruger uuid, p_start date, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  u      record;
  sf     record;
  n      integer;
begin
  if not public.seller_founder_er_chef(p_chef) then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_bruger is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  if p_bruger = p_chef then return jsonb_build_object('kode', 'inhabil'); end if;
  if p_start is null or p_start < date '2026-01-01' or p_start > public.seller_founder_i_dag() + 366 then
    return jsonb_build_object('kode', 'ugyldig_dato');
  end if;
  if v_note is not null and char_length(v_note) > 1000 then return jsonb_build_object('kode', 'ugyldig'); end if;

  select x.id, x.konto_type, x.konto_slettet_kl, x.rolle into u from public.users x where x.id = p_bruger;
  if not found or u.konto_slettet_kl is not null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if coalesce(u.konto_type, 'privat') <> 'privat'
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'firma');
  end if;
  if coalesce(u.rolle, 'bruger') <> 'bruger' then return jsonb_build_object('kode', 'staff'); end if;

  select * into sf from public.seller_founder s where s.bruger_id = p_bruger for update;
  if found and sf.stoppet_kl is null then return jsonb_build_object('kode', 'allerede'); end if;
  if found then
    -- Genoptag: den første oprettelse (oprettet_kl/oprettet_af) bevares.
    update public.seller_founder
       set start_dato = p_start, stoppet_kl = null, stoppet_af = null,
           genoptaget_kl = now(), genoptaget_af = p_chef,
           note = coalesce(v_note, note)
     where id = sf.id;
  else
    insert into public.seller_founder (bruger_id, start_dato, oprettet_af, note)
    values (p_bruger, p_start, p_chef, v_note)
    on conflict (bruger_id) do nothing;
    get diagnostics n = row_count;
    if n = 0 then return jsonb_build_object('kode', 'allerede'); end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'seller_founder_oprettet', 'bruger', p_bruger, p_bruger,
          left('Seller founder fra ' || to_char(p_start, 'DD-MM-YYYY')
               || case when sf.id is not null then ' (aftalen genoptaget)' else '' end
               || coalesce(' - ' || v_note, ''), 2000));
  return jsonb_build_object('kode', 'ok');
end
$fn$;
revoke execute on function public.seller_founder_opret(uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.seller_founder_opret(uuid, uuid, date, text) to service_role;

-- Ret startdatoen på en aktiv aftale. Koder: ok, uaendret, ingen_adgang,
-- inhabil, ikke_founder, firma, staff, ugyldig_dato. (firma/staff: før gav
-- triggeren en exception.)
create or replace function public.seller_founder_ret_start(p_chef uuid, p_bruger uuid, p_start date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  sf record;
begin
  if not public.seller_founder_er_chef(p_chef) then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_bruger is null or p_bruger = p_chef then return jsonb_build_object('kode', 'inhabil'); end if;
  if p_start is null or p_start < date '2026-01-01' or p_start > public.seller_founder_i_dag() + 366 then
    return jsonb_build_object('kode', 'ugyldig_dato');
  end if;
  select * into sf from public.seller_founder s where s.bruger_id = p_bruger for update;
  if not found or sf.stoppet_kl is not null then return jsonb_build_object('kode', 'ikke_founder'); end if;
  if exists (select 1 from public.users u where u.id = p_bruger and coalesce(u.konto_type, 'privat') <> 'privat')
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'firma');
  end if;
  if exists (select 1 from public.users u where u.id = p_bruger and coalesce(u.rolle, 'bruger') <> 'bruger') then
    return jsonb_build_object('kode', 'staff');
  end if;
  if sf.start_dato = p_start then return jsonb_build_object('kode', 'uaendret'); end if;
  update public.seller_founder set start_dato = p_start where id = sf.id;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'seller_founder_startdato', 'bruger', p_bruger, p_bruger,
          'Startdato ændret fra ' || to_char(sf.start_dato, 'DD-MM-YYYY') || ' til ' || to_char(p_start, 'DD-MM-YYYY'));
  return jsonb_build_object('kode', 'ok');
end
$fn$;
revoke execute on function public.seller_founder_ret_start(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.seller_founder_ret_start(uuid, uuid, date) to service_role;

-- ===========================================================================
-- 3. Alarm ved mistanke om falske handler
-- ===========================================================================
create table if not exists public.seller_founder_alarmer (
  id                uuid primary key default gen_random_uuid(),
  founder_id        uuid not null references public.users(id),
  koeber_id         uuid not null references public.users(id),
  -- Antal betalte handler med founder-rabat i de 30 dage før alarmen.
  handler           integer not null,
  foerste_betalt_kl timestamptz not null,
  seneste_betalt_kl timestamptz not null,
  oprettet_kl       timestamptz not null default now(),
  constraint seller_founder_alarmer_handler check (handler >= 3)
);
comment on table public.seller_founder_alarmer is
  'Mistanke om falske handler (Filip, 29. okt. 2026): samme køber har mindst 3 betalte handler med founder-rabat hos samme founder inden for 30 dage. Én række pr. par pr. periode (30 dage fra alarmen). Skrives kun af seller_founder_alarm_tjek(). Kun service role. 20261102460000.';
create index if not exists seller_founder_alarmer_par
  on public.seller_founder_alarmer (founder_id, koeber_id, oprettet_kl desc);

alter table public.seller_founder_alarmer enable row level security;
revoke all on table public.seller_founder_alarmer from public, anon, authenticated, service_role;
grant select on table public.seller_founder_alarmer to service_role;

-- Opslaget (seller_id, buyer_id, betalt_kl) for betalinger med rabat.
create index if not exists betalinger_founder_par
  on public.betalinger (seller_id, buyer_id, betalt_kl)
  where founder_rabat_pct > 0 and betalt_kl is not null;

-- Finder nye par og gemmer dem. Returnerer de nye alarmer som json-array
-- [{ founder_id, koeber_id, handler }] - kalderen giver én drift-alarm pr.
-- element. Advisory-låsen gør to samtidige kørsler sikre (ingen dobbelt-
-- alarm).
create or replace function public.seller_founder_alarm_tjek()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r      record;
  v_nye  jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('seller_founder_alarm_tjek'));
  for r in
    select b.seller_id, b.buyer_id, count(*)::integer as n, min(b.betalt_kl) as f, max(b.betalt_kl) as s
      from public.betalinger b
     where b.founder_rabat_pct > 0
       and b.betalt_kl is not null
       and b.betalt_kl >= now() - interval '30 days'
       and b.buyer_id is not null
       and b.seller_id is not null
     group by b.seller_id, b.buyer_id
    having count(*) >= 3
     order by b.seller_id, b.buyer_id
  loop
    -- Én alarm pr. par pr. periode: ingen ny, før 30 dage efter den forrige.
    -- (Så tælles kun handler, der er betalt efter den forrige alarm.)
    if exists (select 1 from public.seller_founder_alarmer x
                where x.founder_id = r.seller_id and x.koeber_id = r.buyer_id
                  and x.oprettet_kl > now() - interval '30 days') then
      continue;
    end if;
    insert into public.seller_founder_alarmer (founder_id, koeber_id, handler, foerste_betalt_kl, seneste_betalt_kl)
    values (r.seller_id, r.buyer_id, r.n, r.f, r.s);
    v_nye := v_nye || jsonb_build_object('founder_id', r.seller_id, 'koeber_id', r.buyer_id, 'handler', r.n);
  end loop;
  return v_nye;
end
$fn$;
comment on function public.seller_founder_alarm_tjek() is
  'Mistanke om falske handler hos seller founders: gemmer og returnerer nye par (mindst 3 betalte handler med rabat inden for 30 dage; én pr. par pr. 30 dage). Kaldes af betalingsovervågningen (src/lib/betaling/founderAlarm.ts). 20261102460000.';
revoke execute on function public.seller_founder_alarm_tjek() from public, anon, authenticated;
grant execute on function public.seller_founder_alarm_tjek() to service_role;

-- ===========================================================================
-- 2 + 4b + 4c + 3. Admin-visningen
-- ===========================================================================
-- handler / rabat_oere: betalte handler med rabat, UDEN refunderede.
-- refunderede: betalte handler med rabat, der er refunderet (helt eller
-- delvist). gratis_handler / gratis_total_oere: betalte handler med 100 %
-- rabat, INKL. refunderede (Stripe beholder sit gebyr ved refusion) - til
-- det anslåede Stripe-tab. alarmer: de seneste 10 mistanker; alarm_aktiv:
-- en mistanke inden for 30 dage.
create or replace function public.seller_founder_json(p_sf public.seller_founder)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'bruger_id', p_sf.bruger_id,
    'navn', u.navn,
    'email', u.email,
    'start_dato', p_sf.start_dato,
    'stoppet_kl', p_sf.stoppet_kl,
    'note', p_sf.note,
    'oprettet_kl', p_sf.oprettet_kl,
    'oprettet_af_navn', o.navn,
    'genoptaget_kl', p_sf.genoptaget_kl,
    'genoptaget_af_navn', g.navn,
    'er_firma', coalesce(u.konto_type, 'privat') <> 'privat'
                or exists (select 1 from public.firmaer f where f.bruger_id = p_sf.bruger_id),
    'er_staff', coalesce(u.rolle, 'bruger') <> 'bruger',
    'rabat_nu', public.founder_rabat_pct(p_sf.bruger_id, now()),
    -- Sidste dag med 0 kr. og første dag med 50 %.
    'fri_til', ((p_sf.start_dato + interval '6 months')::date - 1),
    'halv_fra', (p_sf.start_dato + interval '6 months')::date,
    'handler', st.handler,
    'rabat_oere', st.rabat_oere,
    'refunderede', st.refunderede,
    'gratis_handler', st.gratis_handler,
    'gratis_total_oere', st.gratis_total_oere,
    'alarm_aktiv', exists (select 1 from public.seller_founder_alarmer x
                            where x.founder_id = p_sf.bruger_id and x.oprettet_kl > now() - interval '30 days'),
    'alarmer', (select coalesce(jsonb_agg(jsonb_build_object(
                         'koeber_id', a.koeber_id, 'koeber_navn', a.koeber_navn, 'handler', a.handler,
                         'foerste_betalt_kl', a.foerste_betalt_kl, 'seneste_betalt_kl', a.seneste_betalt_kl,
                         'oprettet_kl', a.oprettet_kl) order by a.oprettet_kl desc), '[]'::jsonb)
                  from (select x.*, k.navn as koeber_navn
                          from public.seller_founder_alarmer x
                          left join public.users k on k.id = x.koeber_id
                         where x.founder_id = p_sf.bruger_id
                         order by x.oprettet_kl desc
                         limit 10) a))
    from public.users u
    left join public.users o on o.id = p_sf.oprettet_af
    left join public.users g on g.id = p_sf.genoptaget_af
   cross join lateral (
     select count(*) filter (where not z.refunderet)::integer as handler,
            coalesce(sum(z.rabat) filter (where not z.refunderet), 0)::bigint as rabat_oere,
            count(*) filter (where z.refunderet)::integer as refunderede,
            count(*) filter (where z.pct = 100)::integer as gratis_handler,
            coalesce(sum(z.total_oere) filter (where z.pct = 100), 0)::bigint as gratis_total_oere
       from (select b.founder_rabat_pct as pct, b.total_oere,
                    (b.status = 'refunderet' or b.refunderet_kl is not null) as refunderet,
                    public.prismodel_koebergebyr_oere(b.prismodel, b.bud_oere)
                      + public.prismodel_saelgergebyr_oere(b.prismodel, b.bud_oere)
                      - b.koebergebyr_oere - b.saelgergebyr_oere as rabat
               from public.betalinger b
              where b.seller_id = p_sf.bruger_id and b.founder_rabat_pct > 0 and b.betalt_kl is not null) z
   ) st
   where u.id = p_sf.bruger_id;
$fn$;
revoke execute on function public.seller_founder_json(public.seller_founder) from public, anon, authenticated;
grant execute on function public.seller_founder_json(public.seller_founder) to service_role;

-- Boksen på brugersiden: som 20261102420000 + er_staff.
create or replace function public.seller_founder_admin(p_chef uuid, p_bruger uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when not public.seller_founder_er_chef(p_chef) then jsonb_build_object('kode', 'ingen_adgang')
    else jsonb_build_object(
      'kode', 'ok',
      'i_dag', public.seller_founder_i_dag(),
      'er_firma', exists (select 1 from public.users u where u.id = p_bruger and coalesce(u.konto_type, 'privat') <> 'privat')
                  or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger),
      'er_staff', exists (select 1 from public.users u where u.id = p_bruger and coalesce(u.rolle, 'bruger') <> 'bruger'),
      'founder', (select public.seller_founder_json(s) from public.seller_founder s where s.bruger_id = p_bruger))
  end;
$fn$;
revoke execute on function public.seller_founder_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.seller_founder_admin(uuid, uuid) to service_role;

-- ===========================================================================
-- 6. Appen og hjemmesiden: founderens egen rabat (til "Du får udbetalt" ved
--    opret/redigér auktion). Kun den indloggede brugers egen rabat - intet
--    bruger-id som parameter. p_tid = auktionens planlagte sluttid (null = nu).
-- ===========================================================================
create or replace function public.min_founder_rabat(p_tid timestamptz default now())
returns smallint
language sql
stable
security definer
set search_path = ''
as $fn$
  select case when auth.uid() is null then 0::smallint
              else public.founder_rabat_pct(auth.uid(), coalesce(p_tid, now())) end;
$fn$;
comment on function public.min_founder_rabat(timestamptz) is
  'Den indloggede brugers seller founder-rabat (0/50/100) på tidspunktet p_tid (auktionens planlagte sluttid; null = nu). Til visningen af sælgergebyret ved opret/redigér auktion - det endelige tal låses på betalingen ud fra sluttiden. 20261102460000.';
revoke execute on function public.min_founder_rabat(timestamptz) from public, anon;
grant execute on function public.min_founder_rabat(timestamptz) to authenticated;

-- ===========================================================================
-- 5. Kontrol
-- ===========================================================================
do $do$
begin
  if public.founder_rabat_pct(null, now()) <> 0 then
    raise exception 'Kontrol: founder_rabat_pct uden bruger skal være 0';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.betalinger'::regclass
                  and conname = 'betalinger_founder_rabat_check'
                  and strpos(pg_get_constraintdef(oid), 'erhverv2') > 0) then
    raise exception 'Kontrol: betalinger_founder_rabat_check er ikke rettet';
  end if;
end $do$;

drop function if exists pg_temp.sfr_md5(text);
