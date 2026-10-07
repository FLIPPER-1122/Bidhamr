-- Autobud / maksimalbud (som Tradera). Regler: ROADMAP-BESLUTNINGER.md,
-- afsnittet "Autobud" (foreslået af Claude 7. okt. 2026 – afventer Filip).
--
-- Kræver, at 20261009040000_skjult_auktion_pause.sql er kørt (pauset_kl).
--
-- Overblik:
--  1. bud_maksimum: ét hemmeligt maksimum pr. byder pr. auktion. RLS slået
--     til uden policies - ingen bruger kan læse eller skrive tabellen direkte.
--     Kun via RPC'erne nedenfor (security definer, auth.uid()).
--     bud_maksimum_log: hver ændring gemmes (bindende tilsagn - slettes aldrig).
--  2. bids.automatisk: true på bud, som BidHamr har afgivet for en byder.
--     Kan kun sættes af autobud-motoren (bids_automatisk_kun_system nulstiller
--     den for alle andre - også service_role).
--  3. Motoren (autobud_afgoer) kører i AFTER INSERT-triggeren zz_bids_autobud
--     efter hvert ALMINDELIGT bud (web, app, saet_maksimum) under
--     auktionslåsen (a0_bids_laas_auktion), så alt afgøres i samme
--     transaktion: ingen løkker, ingen kapløb. Automatiske bud udløser ikke
--     motoren igen (én runde er nok - se nedenfor).
--  4. Afgørelse: alle med et gyldigt maksimum >= næste mindstebud (plus den,
--     der lige har budt, med loftet greatest(buddet, eget maksimum)) rangeres
--     efter loft (højest først) og tidspunkt, maksimum blev sat (først
--     fører ved lige store). Vinderen (W) byder det laveste, der slår nr. 2
--     (R): least(W.loft, naeste_bud_minimum(R.loft)) - ved lige store loft
--     præcis loftet. R's loft afgives først som automatisk bud (så hans
--     bindende bud står i historikken og kan bruges ved "tilbyd til
--     næsthøjeste byder"). Efter runden er alle andres loft < næste
--     mindstebud, så intet mere skal ske, før nogen byder igen.
--     Automatiske bud må ligge under budtrappen (de skal blot være højere
--     end det nuværende bud), så den højeste kan vinde til "dog højst sit
--     eget maksimum".
--  5. Autobud følger de eksisterende regler i handle_new_bid (pause, skjult,
--     slut, suspenderet/slettet, spærret, anti-sniping 2 min). Byderen
--     filtreres FØR motoren byder for ham, så et forbudt autobud aldrig
--     vælter det bud, der udløste det. Autobud tæller ikke med i brugerens
--     rate limit (bids_rate_limit).
--  6. RPC'er (authenticated): saet_maksimum, mit_maksimum, mine_maksimumbud.

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Tabeller
-- ---------------------------------------------------------------------------
create table if not exists public.bud_maksimum (
  auktion_id uuid not null references public.auctions(id) on delete cascade,
  bruger_id uuid not null references public.users(id) on delete cascade,
  maks_beloeb numeric not null
    check (maks_beloeb >= 1 and maks_beloeb = trunc(maks_beloeb) and maks_beloeb <= 9999999999),
  -- Ønsket om BidHamr Beskyttelse, når maksimum blev sat. Bruges kun, hvis
  -- byderen ikke har et bud på auktionen i forvejen (så gælder hans
  -- seneste bud - samme regel som afslut_udloebne_auktioner).
  beskyttelse boolean not null default false,
  -- Tidspunktet, det NUVÆRENDE beløb blev sat. Afgør lige store maksimum
  -- (først fører).
  sat_kl timestamptz not null default now(),
  oprettet_kl timestamptz not null default now(),
  opdateret_kl timestamptz not null default now(),
  -- Rate limit pr. byder pr. auktion (10 ændringer pr. minut).
  aendringer_vindue_kl timestamptz not null default now(),
  aendringer_antal integer not null default 0,
  primary key (auktion_id, bruger_id)
);

create index if not exists bud_maksimum_bruger_idx on public.bud_maksimum (bruger_id);

alter table public.bud_maksimum enable row level security;
revoke all on public.bud_maksimum from anon, authenticated;

create table if not exists public.bud_maksimum_log (
  id bigint generated always as identity primary key,
  auktion_id uuid not null,
  bruger_id uuid not null,
  maks_beloeb numeric not null,
  forrige_beloeb numeric,
  kl timestamptz not null default now()
);

create index if not exists bud_maksimum_log_auktion_idx on public.bud_maksimum_log (auktion_id, bruger_id);

alter table public.bud_maksimum_log enable row level security;
revoke all on public.bud_maksimum_log from anon, authenticated;

-- Loggen slettes aldrig.
create or replace function public.bud_maksimum_log_uaendret()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'bud_maksimum_log kan ikke ændres eller slettes.';
end;
$$;

drop trigger if exists bud_maksimum_log_uaendret on public.bud_maksimum_log;
create trigger bud_maksimum_log_uaendret
  before update or delete on public.bud_maksimum_log
  for each row execute function public.bud_maksimum_log_uaendret();

-- ---------------------------------------------------------------------------
-- 2. bids.automatisk
-- ---------------------------------------------------------------------------
alter table public.bids add column if not exists automatisk boolean not null default false;

-- Kun motoren må markere et bud som automatisk: den sætter
-- bidhamr.autobud = '1' (lokalt i transaktionen) og kører som ejeren
-- (security definer). Alle andre - også appen og service_role - får false.
-- IKKE security definer: current_user skal være den rigtige rolle.
create or replace function public.bids_automatisk_kun_system()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(new.automatisk, false) then
    if current_user in ('anon', 'authenticated', 'service_role')
       or coalesce(current_setting('bidhamr.autobud', true), '') <> '1' then
      new.automatisk := false;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists a1_bids_automatisk_kun_system on public.bids;
create trigger a1_bids_automatisk_kun_system
  before insert on public.bids
  for each row execute function public.bids_automatisk_kun_system();

-- ---------------------------------------------------------------------------
-- 3. Eksisterende bud-triggere: autobud tæller ikke i rate limit og må ligge
--    under budtrappen (men skal stadig være højere end det nuværende bud).
-- ---------------------------------------------------------------------------
create or replace function public.bids_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare n integer;
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  -- NYT (autobud): automatiske bud tæller ikke mod brugerens egen grænse.
  if new.automatisk then return new; end if;
  select count(*) into n from public.bids
   where bruger_id = new.bruger_id and oprettet > now() - interval '1 minute'
     and not automatisk;
  if n >= 20 then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.check_minimum_bid()
returns trigger
language plpgsql
set search_path = 'public'
as $$
declare
  minimum numeric;
  v_nuv numeric;
begin
  if new."beløb" is null or new."beløb" <> trunc(new."beløb") then
    raise exception 'Buddet skal være i hele kroner.' using errcode = '22023';
  end if;

  -- NYT: mindst 1 kr - ogsaa paa gamle auktioner med startpris 0.
  if new."beløb" < 1 then
    raise exception 'minimum_bid: Dit bud skal være mindst 1 kr.';
  end if;

  -- NYT (autobud): et automatisk bud skal blot være højere end det
  -- nuværende bud (den højeste vinder til "dog højst sit eget maksimum").
  if new.automatisk then
    select a."nuværende_bud" into v_nuv from public.auctions a where a.id = new.auktion_id;
    if v_nuv is null or new."beløb" <= v_nuv then
      raise exception 'minimum_bid: automatisk bud skal være højere end nuværende bud';
    end if;
    return new;
  end if;

  select public.naeste_bud_minimum(a."nuværende_bud", a.startpris) into minimum
    from public.auctions a where a.id = new.auktion_id;

  if minimum is not null and new."beløb" < minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(minimum);
  end if;
  return new;
end;
$$;

create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auktion record;
  v_bruger record;
  v_minimum numeric;
begin
  -- FOR SHARE: konto_slet laaser brugeren FOR UPDATE. Enten venter buddet,
  -- til sletningen er faerdig (og afvises herunder), eller sletningen venter
  -- paa buddet (og ser det i konto_sletning_blokeringer).
  select suspenderet, suspenderet_til, konto_slettet_kl into v_bruger
    from public.users where id = new.bruger_id
     for share;

  if v_bruger is null then
    raise exception 'Brugeren findes ikke';
  end if;

  if v_bruger.konto_slettet_kl is not null then
    raise exception 'Kontoen er slettet.' using errcode = '42501';
  end if;

  if v_bruger.suspenderet
     and (v_bruger.suspenderet_til is null or v_bruger.suspenderet_til > now()) then
    raise exception 'Din konto er suspenderet, og du kan ikke byde.'
      using errcode = '42501';
  end if;

  select * into v_auktion from public.auctions where id = new.auktion_id for update;

  if v_auktion is null then
    raise exception 'Auktionen findes ikke';
  end if;

  if v_auktion.skjult then
    raise exception 'Auktionen er ikke tilgængelig';
  end if;

  -- 6. okt. 2026: en pauset auktion tager ikke imod bud (heller ikke autobud).
  if v_auktion.pauset_kl is not null then
    raise exception 'Auktionen er sat på pause';
  end if;

  if v_auktion.status <> 'aktiv' then
    raise exception 'Auktionen er ikke aktiv længere';
  end if;

  if v_auktion.slutter_kl <= now() then
    raise exception 'Auktionen er allerede slut';
  end if;

  -- Saelgeren har blokeret/spaerret byderen.
  if public.er_blokeret(v_auktion.bruger_id, new.bruger_id) then
    raise exception 'Sælgeren har spærret dig fra at byde på sine auktioner.'
      using errcode = '42501';
  end if;

  if new.auktion_redigeret_kl is not null
     and date_trunc('milliseconds', new.auktion_redigeret_kl)
         is distinct from v_auktion.redigeret_kl then
    raise exception 'Sælgeren har lige ændret auktionen. Se den igen, før du byder.';
  end if;

  -- Mindst 1 kr - ogsaa paa gamle auktioner med startpris 0.
  if new."beløb" is null or new."beløb" < 1 then
    raise exception 'minimum_bid: Dit bud skal være mindst 1 kr.';
  end if;

  if new.automatisk then
    -- NYT (autobud): højere end det nuværende bud er nok.
    if v_auktion."nuværende_bud" is null or new."beløb" <= v_auktion."nuværende_bud" then
      raise exception 'minimum_bid: automatisk bud skal være højere end nuværende bud';
    end if;
  else
    v_minimum := public.naeste_bud_minimum(v_auktion."nuværende_bud", v_auktion.startpris);
    if new."beløb" < v_minimum then
      raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(v_minimum);
    end if;
  end if;

  -- Anti-sniping: gælder også automatiske bud.
  update public.auctions
  set
    "nuværende_bud" = new."beløb",
    slutter_kl = case
      when slutter_kl - now() < interval '2 minutes'
        then now() + interval '2 minutes'
      else slutter_kl
    end
  where id = new.auktion_id;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Motoren
-- ---------------------------------------------------------------------------

-- Må motoren byde for denne bruger på auktionen? Samme regler som
-- handle_new_bid - tjekkes FØR der bydes, så et forbudt autobud aldrig
-- vælter det bud, der udløste det.
create or replace function public.autobud_maa_byde(p_saelger uuid, p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bruger <> p_saelger
     and exists (
       select 1 from public.users u
        where u.id = p_bruger
          and u.konto_slettet_kl is null
          and not (coalesce(u.suspenderet, false)
                   and (u.suspenderet_til is null or u.suspenderet_til > now())))
     and not public.er_blokeret(p_saelger, p_bruger);
$$;

-- Afgiver ét automatisk bud. BidHamr Beskyttelse: byderens seneste bud på
-- auktionen (samme regel som afslut_udloebne_auktioner), ellers ønsket fra
-- maksimum.
create or replace function public.autobud_afgiv(p_auktion uuid, p_bruger uuid, p_beloeb numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_besk boolean;
begin
  select b.beskyttelse into v_besk
    from public.bids b
   where b.auktion_id = p_auktion and b.bruger_id = p_bruger
   order by b.oprettet desc, b."beløb" desc
   limit 1;
  if v_besk is null then
    select m.beskyttelse into v_besk
      from public.bud_maksimum m
     where m.auktion_id = p_auktion and m.bruger_id = p_bruger;
  end if;

  perform set_config('bidhamr.autobud', '1', true);
  insert into public.bids (auktion_id, bruger_id, "beløb", beskyttelse, automatisk)
  values (p_auktion, p_bruger, p_beloeb, coalesce(v_besk, false), true);
  perform set_config('bidhamr.autobud', '', true);
end;
$$;

-- Afgør maksimumbud efter et almindeligt bud. Kører under auktionslåsen.
create or replace function public.autobud_afgoer(p_auktion uuid, p_byder uuid, p_beloeb numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
  v_l_maks numeric;
  v_l_sat timestamptz;
  v_l_loft numeric;
  v_l_tid timestamptz;
  v_min numeric;
  c1 record;
  c2 record;
  w_id uuid; w_loft numeric;
  r_id uuid; r_loft numeric;
  v_nu numeric;
  v_beloeb numeric;
begin
  select au.id, au.bruger_id, au.startpris, au.status, au.skjult, au.pauset_kl, au.slutter_kl,
         au."nuværende_bud" as nuv
    into a
    from public.auctions au where au.id = p_auktion for update;
  if a.id is null or a.status <> 'aktiv' or coalesce(a.skjult, false)
     or a.pauset_kl is not null or a.slutter_kl <= now() then
    return;
  end if;
  -- Kun hvis buddet stadig er det førende (det er det altid lige efter
  -- handle_new_bid, men vær sikker).
  if a.nuv is distinct from p_beloeb then
    return;
  end if;

  select m.maks_beloeb, m.sat_kl into v_l_maks, v_l_sat
    from public.bud_maksimum m
   where m.auktion_id = p_auktion and m.bruger_id = p_byder;

  if v_l_maks is not null and v_l_maks >= p_beloeb then
    v_l_loft := v_l_maks;
    v_l_tid := v_l_sat;
  else
    v_l_loft := p_beloeb;
    v_l_tid := clock_timestamp();
  end if;

  v_min := public.naeste_bud_minimum(p_beloeb, a.startpris);

  -- De to stærkeste andre maksimum, der kan slå buddet.
  select m.bruger_id, m.maks_beloeb, m.sat_kl into c1
    from public.bud_maksimum m
   where m.auktion_id = p_auktion
     and m.bruger_id <> p_byder
     and m.maks_beloeb >= v_min
     and public.autobud_maa_byde(a.bruger_id, m.bruger_id)
   order by m.maks_beloeb desc, m.sat_kl asc
   limit 1;

  if c1.bruger_id is null then
    return;
  end if;

  select m.bruger_id, m.maks_beloeb, m.sat_kl into c2
    from public.bud_maksimum m
   where m.auktion_id = p_auktion
     and m.bruger_id <> p_byder
     and m.bruger_id <> c1.bruger_id
     and m.maks_beloeb >= v_min
     and public.autobud_maa_byde(a.bruger_id, m.bruger_id)
   order by m.maks_beloeb desc, m.sat_kl asc
   limit 1;

  if c1.maks_beloeb > v_l_loft
     or (c1.maks_beloeb = v_l_loft and c1.sat_kl < v_l_tid) then
    -- En anden fører. Nr. 2 er den stærkeste af byderen og c2.
    w_id := c1.bruger_id; w_loft := c1.maks_beloeb;
    if c2.bruger_id is not null
       and (c2.maks_beloeb > v_l_loft
            or (c2.maks_beloeb = v_l_loft and c2.sat_kl < v_l_tid)) then
      r_id := c2.bruger_id; r_loft := c2.maks_beloeb;
    else
      r_id := p_byder; r_loft := v_l_loft;
    end if;
  else
    -- Byderen fører stadig (hans eget maksimum er højest).
    w_id := p_byder; w_loft := v_l_loft;
    r_id := c1.bruger_id; r_loft := c1.maks_beloeb;
  end if;

  v_nu := p_beloeb;

  -- Nr. 2 byder sit loft (hans maksimum er nået), hvis det er under vinderens.
  if r_loft > v_nu and r_loft < w_loft then
    perform public.autobud_afgiv(p_auktion, r_id, r_loft);
    v_nu := r_loft;
  end if;

  -- Vinderen byder det laveste, der slår nr. 2 - dog højst sit eget loft.
  if w_loft = r_loft then
    v_beloeb := w_loft;
  else
    v_beloeb := least(w_loft, public.naeste_bud_minimum(r_loft, a.startpris));
  end if;

  if v_beloeb > v_nu then
    perform public.autobud_afgiv(p_auktion, w_id, v_beloeb);
  end if;
end;
$$;

create or replace function public.bids_autobud()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.automatisk then
    return null;
  end if;
  begin
    perform public.autobud_afgoer(new.auktion_id, new.bruger_id, new."beløb");
  exception when others then
    -- Et fejlet autobud må aldrig vælte det almindelige bud. Næste bud
    -- afgør maksimum igen.
    raise warning 'autobud fejlede for auktion %: %', new.auktion_id, sqlerrm;
  end;
  return null;
end;
$$;

-- Navnet sikrer, at den kører efter on_bid_created (handle_new_bid).
drop trigger if exists zz_bids_autobud on public.bids;
create trigger zz_bids_autobud
  after insert on public.bids
  for each row execute function public.bids_autobud();

-- ---------------------------------------------------------------------------
-- 5. RPC'er
-- ---------------------------------------------------------------------------

-- Sæt, hæv eller sænk sit maksimum. Fører man ikke, afgives et bud på
-- næste mindstebud, og motoren afgør resten i samme transaktion.
-- Returnerer {foerer, nuvaerende_bud, maks_beloeb, slutter_kl, bud_afgivet}.
create or replace function public.saet_maksimum(
  p_auktion uuid,
  p_maks numeric,
  p_beskyttelse boolean default false,
  p_auktion_redigeret_kl timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  a record;
  v_bruger record;
  v_foerende uuid;
  v_min numeric;
  v_m record;
  v_bud_afgivet boolean := false;
  v_besk boolean;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if p_auktion is null then
    raise exception 'Auktionen findes ikke';
  end if;
  if p_maks is null or p_maks <> trunc(p_maks) then
    raise exception 'Buddet skal være i hele kroner.' using errcode = '22023';
  end if;
  if p_maks < 1 or p_maks > 9999999999 then
    raise exception 'maks_ugyldigt: Dit maksimum er ugyldigt.';
  end if;

  select au.id, au.bruger_id, au.startpris, au.status, au.skjult, au.pauset_kl, au.slutter_kl,
         au."nuværende_bud" as nuv, au.forsendelse_mulig
    into a
    from public.auctions au where au.id = p_auktion for update;

  if a.id is null then
    raise exception 'Auktionen findes ikke';
  end if;
  if a.bruger_id = v_uid then
    raise exception 'own_auction: Du kan ikke byde på din egen auktion.';
  end if;
  if coalesce(a.skjult, false) then
    raise exception 'Auktionen er ikke tilgængelig';
  end if;
  if a.pauset_kl is not null then
    raise exception 'Auktionen er sat på pause';
  end if;
  if a.status <> 'aktiv' then
    raise exception 'Auktionen er ikke aktiv længere';
  end if;
  if a.slutter_kl <= now() then
    raise exception 'Auktionen er allerede slut';
  end if;

  select suspenderet, suspenderet_til, konto_slettet_kl into v_bruger
    from public.users where id = v_uid for share;
  if v_bruger is null or v_bruger.konto_slettet_kl is not null then
    raise exception 'Kontoen er slettet.' using errcode = '42501';
  end if;
  if v_bruger.suspenderet
     and (v_bruger.suspenderet_til is null or v_bruger.suspenderet_til > now()) then
    raise exception 'Din konto er suspenderet, og du kan ikke byde.' using errcode = '42501';
  end if;
  if public.er_blokeret(a.bruger_id, v_uid) then
    raise exception 'Sælgeren har spærret dig fra at byde på sine auktioner.' using errcode = '42501';
  end if;

  -- Rate limit: højst 10 ændringer pr. minut pr. auktion.
  select * into v_m from public.bud_maksimum
   where auktion_id = p_auktion and bruger_id = v_uid for update;
  if v_m.auktion_id is not null
     and v_m.aendringer_vindue_kl > now() - interval '1 minute'
     and v_m.aendringer_antal >= 10 then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.' using errcode = 'P0001';
  end if;

  select b.bruger_id into v_foerende
    from public.bids b
   where b.auktion_id = p_auktion
   order by b."beløb" desc, b.oprettet asc
   limit 1;

  if v_foerende = v_uid then
    -- Fører: maksimum kan sænkes, men ikke under det nuværende bud.
    if p_maks < a.nuv then
      raise exception 'maks_under_bud: Du fører med % kr. Dit maksimum kan ikke være lavere end dit nuværende bud.',
        trim_scale(a.nuv);
    end if;
  else
    v_min := public.naeste_bud_minimum(a.nuv, a.startpris);
    if p_maks < v_min then
      raise exception 'maks_for_lavt: Dit maksimum skal være mindst % kr.', trim_scale(v_min);
    end if;
  end if;

  -- Kun afhentning: ingen BidHamr Beskyttelse (som bids_beskyttelse_kun_afhentning).
  v_besk := coalesce(p_beskyttelse, false) and coalesce(a.forsendelse_mulig, false);

  if v_m.auktion_id is null then
    insert into public.bud_maksimum (auktion_id, bruger_id, maks_beloeb, beskyttelse,
                                     sat_kl, aendringer_vindue_kl, aendringer_antal)
    values (p_auktion, v_uid, p_maks, v_besk, clock_timestamp(), now(), 1);
    insert into public.bud_maksimum_log (auktion_id, bruger_id, maks_beloeb, forrige_beloeb)
    values (p_auktion, v_uid, p_maks, null);
  elsif v_m.maks_beloeb <> p_maks or v_m.beskyttelse <> v_besk then
    update public.bud_maksimum
       set maks_beloeb = p_maks,
           beskyttelse = v_besk,
           sat_kl = case when maks_beloeb <> p_maks then clock_timestamp() else sat_kl end,
           opdateret_kl = now(),
           aendringer_antal = case when aendringer_vindue_kl > now() - interval '1 minute'
                                   then aendringer_antal + 1 else 1 end,
           aendringer_vindue_kl = case when aendringer_vindue_kl > now() - interval '1 minute'
                                       then aendringer_vindue_kl else now() end
     where auktion_id = p_auktion and bruger_id = v_uid;
    if v_m.maks_beloeb <> p_maks then
      insert into public.bud_maksimum_log (auktion_id, bruger_id, maks_beloeb, forrige_beloeb)
      values (p_auktion, v_uid, p_maks, v_m.maks_beloeb);
    end if;
  end if;

  if v_foerende is distinct from v_uid then
    -- Almindeligt bud på næste mindstebud; zz_bids_autobud afgør resten.
    insert into public.bids (auktion_id, bruger_id, "beløb", beskyttelse, auktion_redigeret_kl)
    values (p_auktion, v_uid, v_min, v_besk, p_auktion_redigeret_kl);
    v_bud_afgivet := true;
  end if;

  select au."nuværende_bud" as nuv, au.slutter_kl into a
    from public.auctions au where au.id = p_auktion;
  select b.bruger_id into v_foerende
    from public.bids b
   where b.auktion_id = p_auktion
   order by b."beløb" desc, b.oprettet asc
   limit 1;

  return jsonb_build_object(
    'foerer', coalesce(v_foerende = v_uid, false),
    'nuvaerende_bud', a.nuv,
    'maks_beloeb', p_maks,
    'slutter_kl', a.slutter_kl,
    'bud_afgivet', v_bud_afgivet
  );
end;
$$;

-- Mit maksimum på en auktion (kun ens eget). null, hvis intet maksimum.
-- {maks_beloeb, foerer, nuvaerende_bud, naaet}
create or replace function public.mit_maksimum(p_auktion uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_maks numeric;
  v_nuv numeric;
  v_foerende uuid;
begin
  if v_uid is null then
    return null;
  end if;
  select m.maks_beloeb into v_maks
    from public.bud_maksimum m
   where m.auktion_id = p_auktion and m.bruger_id = v_uid;
  if v_maks is null then
    return null;
  end if;
  -- Har byderen siden budt manuelt over sit maksimum, gælder det ikke
  -- længere (hans bud er højere) - vis det ikke som "dit maksimum".
  if exists (select 1 from public.bids b
              where b.auktion_id = p_auktion and b.bruger_id = v_uid
                and b."beløb" > v_maks) then
    return null;
  end if;
  select au."nuværende_bud" into v_nuv from public.auctions au where au.id = p_auktion;
  select b.bruger_id into v_foerende
    from public.bids b
   where b.auktion_id = p_auktion
   order by b."beløb" desc, b.oprettet asc
   limit 1;
  return jsonb_build_object(
    'maks_beloeb', v_maks,
    'foerer', coalesce(v_foerende = v_uid, false),
    'nuvaerende_bud', v_nuv,
    -- Overbudt, og maksimum er brugt op.
    'naaet', v_foerende is distinct from v_uid
  );
end;
$$;

-- Til "Download dine data": egne maksimum og ændringer.
create or replace function public.mine_maksimumbud()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'maksimum', coalesce((
      select jsonb_agg(jsonb_build_object(
               'auktion_id', m.auktion_id, 'auktion', a.titel,
               'maksimum', m.maks_beloeb, 'bidhamr_beskyttelse', m.beskyttelse,
               'oprettet', m.oprettet_kl, 'opdateret', m.opdateret_kl)
             order by m.oprettet_kl)
        from public.bud_maksimum m
        left join public.auctions a on a.id = m.auktion_id
       where m.bruger_id = auth.uid()), '[]'::jsonb),
    'aendringer', coalesce((
      select jsonb_agg(jsonb_build_object(
               'auktion_id', l.auktion_id, 'maksimum', l.maks_beloeb,
               'forrige', l.forrige_beloeb, 'tidspunkt', l.kl)
             order by l.kl)
        from public.bud_maksimum_log l
       where l.bruger_id = auth.uid()), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- 6. Rettigheder
-- ---------------------------------------------------------------------------
revoke all on function public.bud_maksimum_log_uaendret() from public, anon, authenticated;
revoke all on function public.bids_automatisk_kun_system() from public, anon, authenticated;
revoke all on function public.autobud_maa_byde(uuid, uuid) from public, anon, authenticated;
revoke all on function public.autobud_afgiv(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.autobud_afgoer(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.bids_autobud() from public, anon, authenticated;

revoke all on function public.saet_maksimum(uuid, numeric, boolean, timestamptz) from public, anon;
grant execute on function public.saet_maksimum(uuid, numeric, boolean, timestamptz) to authenticated;
revoke all on function public.mit_maksimum(uuid) from public, anon;
grant execute on function public.mit_maksimum(uuid) to authenticated;
revoke all on function public.mine_maksimumbud() from public, anon;
grant execute on function public.mine_maksimumbud() to authenticated;
