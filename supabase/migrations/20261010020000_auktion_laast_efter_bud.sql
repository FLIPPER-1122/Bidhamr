-- Auktionen er helt låst efter første bud (Filip, 7. okt. 2026).
--
-- Regel: ROADMAP-BESLUTNINGER.md, "Låst efter første bud". Når auktionen har
-- fået sit første bud, kan sælgeren ikke ændre noget som helst, ikke tilføje
-- noget og ikke slette eller annullere den - heller ikke direkte fra appen.
-- Kun BidHamr (staff, via security definer-funktioner) og systemet kan.
--
-- Hvad der allerede var låst før denne migration:
--  - Direkte UPDATE af auctions (auctions_beskyt_kolonner) afviste alle
--    ændringer efter bud - men med en generisk tekst.
--  - rediger_auktion svarede 'har_bud'.
--  - annuller_egen_auktion annullerede ikke (returnerede blot false).
--  - Billeder i storage (auktion-billeder) kunne ikke slettes, når der er bud
--    (auktion_billede_maa_slettes). Der er ingen UPDATE-policy, så et
--    eksisterende billede kan heller ikke overskrives.
--  - DELETE af auctions: ingen policy, så authenticated kan aldrig slette.
--
-- Hvad denne migration ændrer:
--  1. Fælles fejltekst med stabilt præfiks, som appen kan genkende:
--       'auktion_laast: Auktionen har fået bud og kan ikke ændres.'
--     errcode 'BHL01', hint 'Kontakt BidHamr, hvis der er et problem med varen.'
--  2. auctions_beskyt_kolonner: bud-låsen tjekkes FØRST (efter system-
--     undtagelsen), så enhver sælger-UPDATE efter bud - også af status,
--     skjult m.m. - giver auktion_laast. Afsluttet auktion uden bud får sin
--     egen tekst. Resten er uændret.
--  3. annuller_egen_auktion: låser rækken (for update) og kaster
--     auktion_laast, når der er bud. Ellers som før (true/false).
--  4. saet_spoergsmaal_aktiv ("Modtag spørgsmål") er også en ændring af
--     auktionen og svarer nu {kode: 'har_bud'} efter bud. Sælgeren kan
--     stadig BESVARE spørgsmål.
--  5. Ny BEFORE DELETE-trigger (auctions_laast_slet) som ekstra værn, hvis
--     der en dag kommer en DELETE-policy.
--
-- Systemet påvirkes ikke: auctions_beskyt_kolonner og auctions_laast_slet
-- springer over for service_role og for security definer-funktioner ejet af
-- postgres (handle_new_bid, bids_oeg_antal, autobud, afslut_udloebne_auktioner,
-- pause_udloeb_koer, dsa_indgreb, dsa_klage_afgoer, konto_slet, oprydning_koer
-- m.fl.), fordi current_user da er 'postgres'.
--
-- Race: et bud tager rækkelåsen (bids_laas_auktion, for update) og sætter
-- nuværende_bud i samme transaktion. En samtidig sælger-UPDATE venter på
-- rækkelåsen og ser derefter den nye række (old."nuværende_bud" er sat), og
-- annuller_egen_auktion/saet_spoergsmaal_aktiv tjekker under deres egen
-- for update-lås.
--
-- Idempotent. Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Direkte UPDATE fra sælgeren (appen opdaterer tabellen direkte).
--    Bevidst IKKE security definer: undtagelsen for systemet bygger på
--    current_user.
-- ---------------------------------------------------------------------------
create or replace function public.auctions_beskyt_kolonner()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  -- Låst efter første bud (Filip, 7. okt. 2026): intet kan ændres - uanset
  -- kolonne. Tjekkes først, så appen altid får samme fejl. Rækken er låst af
  -- denne UPDATE, og et samtidigt bud (bids_laas_auktion) har enten sat
  -- nuværende_bud på den række, vi ser her, eller venter på os.
  if old."nuværende_bud" is not null
     or public.auktion_har_bud(old.id) then
    raise exception 'auktion_laast: Auktionen har fået bud og kan ikke ændres.'
      using errcode = 'BHL01',
            hint = 'Kontakt BidHamr, hvis der er et problem med varen.';
  end if;

  -- Felter brugeren aldrig maa aendre.
  if new.id               is distinct from old.id
  or new.bruger_id        is distinct from old.bruger_id
  or new.status           is distinct from old.status
  or new.vinder_id        is distinct from old.vinder_id
  or new.slutter_kl       is distinct from old.slutter_kl
  or new.varighed_dage    is distinct from old.varighed_dage
  or new."nuværende_bud"  is distinct from old."nuværende_bud"
  or new.skjult           is distinct from old.skjult
  or new.pauset_kl        is distinct from old.pauset_kl
  or new.pause_resterende is distinct from old.pause_resterende
  or new.oprettet         is distinct from old.oprettet then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;

  -- En skjult auktion (BidHamr undersøger den) kan sælgeren ikke ændre -
  -- heller ikke via en direkte UPDATE fra appen (Filip, 6. okt. 2026).
  if coalesce(old.skjult, false) then
    raise exception 'Auktionen er skjult af BidHamr og kan ikke ændres lige nu.'
      using errcode = '42501';
  end if;

  if public.jeg_er_suspenderet() then
    raise exception 'Din konto er suspenderet.' using errcode = 'BHS02';
  end if;

  -- Indholdsfelter og startpris: kun paa en igangvaerende auktion.
  if old.status <> 'aktiv'
     or old.slutter_kl <= now() then
    raise exception 'Auktionen er slut og kan ikke ændres.'
      using errcode = '42501';
  end if;

  if new.startpris is distinct from old.startpris
     and (new.startpris is null or new.startpris < 0 or new.startpris > 9999999999
          or new.startpris <> trunc(new.startpris)) then
    raise exception 'Startprisen skal være et helt antal kroner.'
      using errcode = '22023';
  end if;

  -- Mindste startpris 1 kr - kun naar startprisen aendres, saa en gammel
  -- auktion med startpris 0 stadig kan faa rettet andre felter.
  if new.startpris is distinct from old.startpris and new.startpris < 1 then
    raise exception 'Startprisen skal være mindst 1 kr.'
      using errcode = '22023';
  end if;

  if new.billeder is distinct from old.billeder
     and not public.auktion_billeder_gyldige(auth.uid(), new.billeder) then
    raise exception 'Tilføj mellem 1 og 10 billeder, uploadet til BidHamr.'
      using errcode = 'BHA01';
  end if;

  if new.kategori is distinct from old.kategori
     and not public.er_gyldig_auktionskategori(new.kategori) then
    raise exception 'Vælg en kategori.' using errcode = 'BHA02';
  end if;

  new.redigeret_kl := date_trunc('milliseconds', clock_timestamp());
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Annullering
-- ---------------------------------------------------------------------------
create or replace function public.annuller_egen_auktion(p_auktion uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_antal int;
  v_a record;
begin
  if v_uid is null then raise exception 'Du skal være logget ind.' using errcode = '42501'; end if;

  -- Låser rækken: et samtidigt bud (bids_laas_auktion) venter, eller er
  -- nået først og ses herunder.
  select id, bruger_id, "nuværende_bud" as nb into v_a
    from public.auctions where id = p_auktion for update;
  if not found or v_a.bruger_id is distinct from v_uid then
    return false;
  end if;

  if v_a.nb is not null
     or exists (select 1 from public.bids b where b.auktion_id = v_a.id) then
    raise exception 'auktion_laast: Auktionen har fået bud og kan ikke ændres.'
      using errcode = 'BHL01',
            hint = 'Kontakt BidHamr, hvis der er et problem med varen.';
  end if;

  update public.auctions a set status = 'annulleret'
   where a.id = p_auktion and a.bruger_id = v_uid and a.status = 'aktiv' and a."nuværende_bud" is null
     and not coalesce(a.skjult, false)
     and a.pauset_kl is null
     and not exists (select 1 from public.bids b where b.auktion_id = a.id);
  get diagnostics v_antal = row_count;
  return v_antal > 0;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. "Modtag spørgsmål" er også en ændring af auktionen.
-- ---------------------------------------------------------------------------
create or replace function public.saet_spoergsmaal_aktiv(p_auktion uuid, p_aktiv boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  a     record;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  select id, bruger_id, status, slutter_kl, skjult, "nuværende_bud" as nb into a
    from public.auctions where id = p_auktion for update;
  if not found or a.bruger_id is distinct from v_uid or a.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if public.jeg_er_suspenderet() then
    return jsonb_build_object('kode', 'suspenderet');
  end if;
  if a.status <> 'aktiv' or a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  -- Låst efter første bud (Filip, 7. okt. 2026).
  if a.nb is not null
     or exists (select 1 from public.bids b where b.auktion_id = a.id) then
    return jsonb_build_object('kode', 'har_bud');
  end if;

  update public.auctions
     set spoergsmaal_aktiv = coalesce(p_aktiv, true)
   where id = a.id and spoergsmaal_aktiv is distinct from coalesce(p_aktiv, true);

  return jsonb_build_object('kode', 'ok', 'aktiv', coalesce(p_aktiv, true));
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Sletning (ekstra værn - authenticated har ingen DELETE-policy).
-- ---------------------------------------------------------------------------
create or replace function public.auctions_laast_slet()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return old;
  end if;
  if old."nuværende_bud" is not null
     or public.auktion_har_bud(old.id) then
    raise exception 'auktion_laast: Auktionen har fået bud og kan ikke ændres.'
      using errcode = 'BHL01',
            hint = 'Kontakt BidHamr, hvis der er et problem med varen.';
  end if;
  return old;
end;
$function$;

drop trigger if exists auctions_laast_slet on public.auctions;
create trigger auctions_laast_slet
  before delete on public.auctions
  for each row execute function public.auctions_laast_slet();
