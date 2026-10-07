-- Autobud: rettelser efter review og test (7. okt. 2026).
--
-- KUN TIL TESTDATABASEN (og andre databaser, hvor 20261010010000_autobud.sql
-- allerede er kørt i sin første udgave). 20261010010000_autobud.sql er rettet
-- tilsvarende, så produktionen får slutresultatet direkte. Denne fil er
-- idempotent og giver samme slutresultat, uanset hvilken udgave af
-- 20261010010000 der er kørt.
--
-- Regler: ROADMAP-BESLUTNINGER.md, afsnittet "Autobud".
--  1. Taberens maksimum afgives ALDRIG som et synligt bud (Filip, 7. okt.
--     2026). Kun vinderen byder: least(vinderens loft,
--     naeste_bud_minimum(nr. 2's loft)), ved lige store præcis loftet.
--     Alle maksimum, der er STØRRE end buddet, er med (ingen springes over).
--     Lige store: et maksimum, der er sat før et manuelt bud på præcis samme
--     beløb, fører - det manuelle bud afvises ("samme_bud"), så der aldrig
--     står to bud med samme beløb.
--  2. Fører køberen, kan BidHamr Beskyttelse ikke ændres via saet_maksimum
--     (beskyttelse_laast). Kun ændringer af beløbet tæller i rate limit.
--  3. Fejl i motoren ruller hele buddet tilbage (ingen exception when others).
--     Motoren kører også, når den førende ændrer sit maksimum.
--  4. Det første bud ved "Byd automatisk" markeres automatisk = true.
--  5. bud_maksimum_log logger også beskyttelse og kan ikke truncates;
--     bud_maksimum-FK'er er on delete restrict.
--  6. bids_rate_limit og check_minimum_bid: search_path = ''.
--  7. mit_maksimum.naaet kun, når maksimum faktisk er nået/overgået.
--  8. mine_data() har egne maksimumbud med (mine_maksimumbud).

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Tabeller
-- ---------------------------------------------------------------------------
alter table public.bud_maksimum
  drop constraint if exists bud_maksimum_auktion_id_fkey,
  add constraint bud_maksimum_auktion_id_fkey
    foreign key (auktion_id) references public.auctions(id) on delete restrict;
alter table public.bud_maksimum
  drop constraint if exists bud_maksimum_bruger_id_fkey,
  add constraint bud_maksimum_bruger_id_fkey
    foreign key (bruger_id) references public.users(id) on delete restrict;

alter table public.bud_maksimum_log add column if not exists beskyttelse boolean;
alter table public.bud_maksimum_log add column if not exists forrige_beskyttelse boolean;

drop trigger if exists bud_maksimum_log_ingen_truncate on public.bud_maksimum_log;
create trigger bud_maksimum_log_ingen_truncate
  before truncate on public.bud_maksimum_log
  for each statement execute function public.bud_maksimum_log_uaendret();

-- ---------------------------------------------------------------------------
-- 2. bids.automatisk: '1' = motorens bud, 'start' = det første bud fra
--    saet_maksimum ("Byd automatisk").
-- ---------------------------------------------------------------------------
create or replace function public.bids_automatisk_kun_system()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(new.automatisk, false) then
    if current_user in ('anon', 'authenticated', 'service_role')
       or coalesce(current_setting('bidhamr.autobud', true), '') not in ('1', 'start') then
      new.automatisk := false;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Bud-triggere
-- ---------------------------------------------------------------------------
create or replace function public.bids_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  -- Autobud: automatiske bud tæller ikke mod brugerens egen grænse
  -- (saet_maksimum har sin egen: 10 ændringer pr. minut pr. auktion).
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
set search_path = ''
as $$
declare
  minimum numeric;
  v_nuv numeric;
begin
  if new."beløb" is null or new."beløb" <> trunc(new."beløb") then
    raise exception 'Buddet skal være i hele kroner.' using errcode = '22023';
  end if;

  -- Mindst 1 kr - også på gamle auktioner med startpris 0.
  if new."beløb" < 1 then
    raise exception 'minimum_bid: Dit bud skal være mindst 1 kr.';
  end if;

  -- Autobud: et bud fra motoren skal blot være højere end det nuværende bud
  -- (vinderen byder "dog højst sit eget maksimum"). Startbuddet fra
  -- saet_maksimum følger budtrappen som alle andre bud.
  if new.automatisk and coalesce(current_setting('bidhamr.autobud', true), '') = '1' then
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

  if new.automatisk and coalesce(current_setting('bidhamr.autobud', true), '') = '1' then
    -- Autobud (motoren): højere end det nuværende bud er nok.
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

-- Afgiver ét automatisk bud (kun vinderen af en runde). BidHamr Beskyttelse:
-- byderens seneste bud på auktionen (samme regel som
-- afslut_udloebne_auktioner), ellers ønsket fra maksimum.
create or replace function public.autobud_afgiv(p_auktion uuid, p_bruger uuid, p_beloeb numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_besk boolean;
  v_forrige text := coalesce(current_setting('bidhamr.autobud', true), '');
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
  perform set_config('bidhamr.autobud', v_forrige, true);
end;
$$;

-- Afgør maksimumbud. Kører under auktionslåsen.
--  p_nyt_bud = true: lige efter et nyt (manuelt eller start-)bud på
--    p_beloeb. Et andet maksimum på præcis p_beloeb er sat før buddet og
--    fører derfor - buddet afvises (samme_bud).
--  p_nyt_bud = false: den førende har ændret sit maksimum. Kun maksimum, der
--    er større end det nuværende bud, kan ændre noget.
-- Kun vinderen byder. Taberens maksimum afgives aldrig som et bud og ses
-- aldrig af andre.
drop function if exists public.autobud_afgoer(uuid, uuid, numeric);
create or replace function public.autobud_afgoer(
  p_auktion uuid, p_byder uuid, p_beloeb numeric, p_nyt_bud boolean
)
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
  c1 record;
  c2 record;
  w_id uuid; w_loft numeric;
  r_loft numeric;
  v_pris numeric;
begin
  select au.id, au.bruger_id, au.startpris, au.status, au.skjult, au.pauset_kl, au.slutter_kl,
         au."nuværende_bud" as nuv
    into a
    from public.auctions au where au.id = p_auktion for update;
  if a.id is null or a.status <> 'aktiv' or coalesce(a.skjult, false)
     or a.pauset_kl is not null or a.slutter_kl <= now() then
    return;
  end if;
  -- Kun hvis buddet stadig er det førende.
  if a.nuv is distinct from p_beloeb then
    return;
  end if;

  -- Byderens eget loft: hans maksimum, hvis det ikke er overgået af hans eget
  -- bud - ellers buddet (sat nu, altså senest).
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

  -- De to stærkeste andre maksimum, der kan slå buddet (alle, der er større
  -- end buddet - og ved et nyt bud også dem på præcis samme beløb).
  select m.bruger_id, m.maks_beloeb, m.sat_kl into c1
    from public.bud_maksimum m
   where m.auktion_id = p_auktion
     and m.bruger_id <> p_byder
     and (m.maks_beloeb > p_beloeb or (p_nyt_bud and m.maks_beloeb = p_beloeb))
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
     and (m.maks_beloeb > p_beloeb or (p_nyt_bud and m.maks_beloeb = p_beloeb))
     and public.autobud_maa_byde(a.bruger_id, m.bruger_id)
   order by m.maks_beloeb desc, m.sat_kl asc
   limit 1;

  -- Rangering: højeste loft først; ved lige store den, der satte det først.
  if c1.maks_beloeb > v_l_loft
     or (c1.maks_beloeb = v_l_loft and c1.sat_kl < v_l_tid) then
    w_id := c1.bruger_id; w_loft := c1.maks_beloeb;
    if c2.bruger_id is not null
       and (c2.maks_beloeb > v_l_loft
            or (c2.maks_beloeb = v_l_loft and c2.sat_kl < v_l_tid)) then
      r_loft := c2.maks_beloeb;
    else
      r_loft := v_l_loft;
    end if;
  else
    w_id := p_byder; w_loft := v_l_loft;
    r_loft := c1.maks_beloeb;
  end if;

  -- Vinderen byder det laveste, der slår nr. 2 - dog højst sit eget loft.
  -- Ved lige store loft præcis loftet (den første fører).
  if w_loft = r_loft then
    v_pris := w_loft;
  else
    v_pris := least(w_loft, public.naeste_bud_minimum(r_loft, a.startpris));
  end if;

  if v_pris > p_beloeb then
    perform public.autobud_afgiv(p_auktion, w_id, v_pris);
  elsif p_nyt_bud and w_id <> p_byder then
    -- Kun muligt, når et andet maksimum er præcis lig buddet (og sat før).
    raise exception 'samme_bud: En anden byder har allerede budt det samme – byd mere.';
  end if;
end;
$$;

-- Fejl i motoren ruller hele buddet tilbage (ingen exception when others):
-- et bud, der ikke kunne afgøres korrekt, må ikke stå.
create or replace function public.bids_autobud()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Motorens egne bud udløser ikke motoren igen (én runde er nok).
  if new.automatisk and coalesce(current_setting('bidhamr.autobud', true), '') = '1' then
    return null;
  end if;
  perform public.autobud_afgoer(new.auktion_id, new.bruger_id, new."beløb", true);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RPC'er
-- ---------------------------------------------------------------------------
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
  v_nu_besk boolean;
  v_beloeb_aendret boolean;
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

  -- Rate limit: højst 10 ændringer af beløbet pr. minut pr. auktion.
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

  -- Kun afhentning: ingen BidHamr Beskyttelse (som bids_beskyttelse_kun_afhentning).
  v_besk := coalesce(p_beskyttelse, false) and coalesce(a.forsendelse_mulig, false);

  if v_foerende = v_uid then
    -- Fører: maksimum kan sænkes, men ikke under det nuværende bud.
    if p_maks < a.nuv then
      raise exception 'maks_under_bud: Du fører med % kr. Dit maksimum kan ikke være lavere end dit nuværende bud.',
        trim_scale(a.nuv);
    end if;
    -- BidHamr Beskyttelse følger det førende bud og kan ikke ændres her
    -- (p_beskyttelse = null betyder "uændret"). Afvisningen tæller ikke i
    -- rate limit.
    select b.beskyttelse into v_nu_besk
      from public.bids b
     where b.auktion_id = p_auktion and b.bruger_id = v_uid
     order by b.oprettet desc, b."beløb" desc
     limit 1;
    v_nu_besk := coalesce(v_nu_besk, false);
    if p_beskyttelse is not null and v_besk <> v_nu_besk then
      raise exception 'beskyttelse_laast: Du fører allerede. BidHamr Beskyttelse følger dit bud og kan ikke ændres, mens du fører.';
    end if;
    v_besk := v_nu_besk;
  else
    v_min := public.naeste_bud_minimum(a.nuv, a.startpris);
    if p_maks < v_min then
      raise exception 'maks_for_lavt: Dit maksimum skal være mindst % kr.', trim_scale(v_min);
    end if;
  end if;

  v_beloeb_aendret := v_m.auktion_id is null or v_m.maks_beloeb <> p_maks;

  if v_m.auktion_id is null then
    insert into public.bud_maksimum (auktion_id, bruger_id, maks_beloeb, beskyttelse,
                                     sat_kl, aendringer_vindue_kl, aendringer_antal)
    values (p_auktion, v_uid, p_maks, v_besk, clock_timestamp(), now(), 1);
    insert into public.bud_maksimum_log (auktion_id, bruger_id, maks_beloeb, forrige_beloeb,
                                         beskyttelse, forrige_beskyttelse)
    values (p_auktion, v_uid, p_maks, null, v_besk, null);
  elsif v_beloeb_aendret or v_m.beskyttelse <> v_besk then
    update public.bud_maksimum
       set maks_beloeb = p_maks,
           beskyttelse = v_besk,
           sat_kl = case when v_beloeb_aendret then clock_timestamp() else sat_kl end,
           opdateret_kl = now(),
           aendringer_antal = case
             when not v_beloeb_aendret then aendringer_antal
             when aendringer_vindue_kl > now() - interval '1 minute' then aendringer_antal + 1
             else 1 end,
           aendringer_vindue_kl = case
             when not v_beloeb_aendret then aendringer_vindue_kl
             when aendringer_vindue_kl > now() - interval '1 minute' then aendringer_vindue_kl
             else now() end
     where auktion_id = p_auktion and bruger_id = v_uid;
    insert into public.bud_maksimum_log (auktion_id, bruger_id, maks_beloeb, forrige_beloeb,
                                         beskyttelse, forrige_beskyttelse)
    values (p_auktion, v_uid, p_maks, v_m.maks_beloeb, v_besk, v_m.beskyttelse);
  end if;

  if v_foerende is distinct from v_uid then
    -- Startbud på næste mindstebud (følger budtrappen, tæller som
    -- automatisk); zz_bids_autobud afgør resten i samme transaktion.
    perform set_config('bidhamr.autobud', 'start', true);
    insert into public.bids (auktion_id, bruger_id, "beløb", beskyttelse, auktion_redigeret_kl, automatisk)
    values (p_auktion, v_uid, v_min, v_besk, p_auktion_redigeret_kl, true);
    perform set_config('bidhamr.autobud', '', true);
    v_bud_afgivet := true;
  elsif v_beloeb_aendret then
    -- Den førende har ændret sit maksimum: står der et andet maksimum over
    -- det nuværende bud (fx fra en byder, der var spærret ved sidste runde),
    -- afgøres det nu.
    perform public.autobud_afgoer(p_auktion, v_uid, a.nuv, false);
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
    -- Kun når maksimum faktisk er nået: en anden fører, og det højeste bud
    -- er mindst maksimum (ved lige store førte den, der satte sit først).
    'naaet', v_foerende is distinct from v_uid and v_nuv is not null and v_nuv >= v_maks
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
               'forrige', l.forrige_beloeb,
               'bidhamr_beskyttelse', l.beskyttelse,
               'forrige_bidhamr_beskyttelse', l.forrige_beskyttelse,
               'tidspunkt', l.kl)
             order by l.kl)
        from public.bud_maksimum_log l
       where l.bruger_id = auth.uid()), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

-- mine_data(): egne maksimumbud med i udtrækket ("mine_maksimumbud").
-- mine_data er lang og har små forskelle mellem databaserne (kommentarer),
-- så den nuværende definition rettes på stedet: "return v;" bliver til
-- "return v || {mine_maksimumbud}". Idempotent.
do $do$
declare
  v_def text := pg_get_functiondef('public.mine_data()'::regprocedure);
begin
  if position('mine_maksimumbud' in v_def) > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, 'return v;', ''))) / length('return v;') <> 1 then
    raise exception 'mine_data: forventede præcis én "return v;"';
  end if;
  execute replace(v_def, 'return v;',
    'return v || jsonb_build_object(''mine_maksimumbud'', public.mine_maksimumbud());');
end;
$do$;

-- ---------------------------------------------------------------------------
-- 6. Rettigheder
-- ---------------------------------------------------------------------------
revoke all on function public.bids_automatisk_kun_system() from public, anon, authenticated;
revoke all on function public.autobud_afgiv(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.autobud_afgoer(uuid, uuid, numeric, boolean) from public, anon, authenticated;
revoke all on function public.bids_autobud() from public, anon, authenticated;

revoke all on function public.saet_maksimum(uuid, numeric, boolean, timestamptz) from public, anon;
grant execute on function public.saet_maksimum(uuid, numeric, boolean, timestamptz) to authenticated;
revoke all on function public.mit_maksimum(uuid) from public, anon;
grant execute on function public.mit_maksimum(uuid) to authenticated;
revoke all on function public.mine_maksimumbud() from public, anon;
grant execute on function public.mine_maksimumbud() to authenticated;
