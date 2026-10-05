-- Beslutninger 5. oktober 2026 (ROADMAP-BESLUTNINGER.md):
--
--   1. "Mindste startpris (Filip, 5. oktober 2026): 1 kr."
--      Afvises med en dansk fejl ("Startprisen skal være mindst 1 kr."):
--        - auctions_beskyt_ny (oprettelse via PostgREST/appen): 22023
--        - auctions_beskyt_kolonner (direkte PATCH, kun naar startprisen
--          AENDRES): 22023 - en gammel auktion med startpris 0 kan stadig
--          faa rettet andre felter
--        - rediger_auktion (RPC): kode 'startpris_for_lav'
--        - genopsaet_auktion (RPC, service_role): kode 'startpris_for_lav'
--      INGEN CHECK-constraint: en CHECK (ogsaa NOT VALID) tjekkes ved hver
--      UPDATE af raekken, saa gamle auktioner med startpris 0 ville fejle,
--      naar de fx afsluttes af cron. Eksisterende raekker roeres ikke.
--
--   2. "Alle afgoerelser kan ankes (Filip, 5. oktober 2026) - ogsaa en sag,
--      der er lukket uden at penge blev flyttet. Den part, der fik afvist sin
--      sag, kan anke."
--      Sager oprettes altid af koeberen (sag_opret), saa en lukket sag
--      ('lukket', penge_handling 'ingen', afgjort af en medarbejder) kan nu
--      ankes af KOEBEREN i samme vindue som andre afgoerelser (24 timer - 4
--      dage efter afgoerelsen). Saelgeren faar 'vandt'. Sager lukket af
--      systemet ("Afsluttet ved refusion", penge_handling null) kan stadig
--      ikke ankes.
--      Pengene: en lukning frigiver IKKE pengene straks - den saetter
--      penge_flyttes_efter_kl = afgoerelsen + 4 dage, og frysningen
--      (sag_holder_pengene / trades.sag_aaben) bestaar, til sag_afvikl
--      fjerner den efter fristen (uaendret). Mens en anke venter, springer
--      sag_afvikl sagen over ('venter_anke'), og sag_holder_pengene er sand
--      (uaendret). Derfor kraeves ingen aendring af frysningen.
--      Ankens afgoerelse (sag_anke_afgoer, admin/chef, ikke den der lukkede
--      sagen) - den enkleste konsistente loesning, samme moenster som de
--      oevrige anker ("modsat udfald, endeligt, ingen ny ankefrist"):
--        stadfaest - sagen forbliver lukket. Frysningen fjernes nu
--                    (penge_flyttes_efter_kl = nu, sag_afvikl), og handlen
--                    fortsaetter normalt. handling = 'lukket'.
--        omgoer    - koeberen faar medhold, praecis som naar koeberen faar
--                    medhold paa en anke af et medhold til saelger:
--                    svindel/bortkommet (eller retur allerede afleveret)
--                    refunderes nu; skadet/ikke som beskrevet -> varen
--                    sendes retur (koeberen betaler selv returfragten) og
--                    refunderes, saa snart returpakken er registreret.
--      Vi genaabner IKKE sagen til fornyet behandling: anke-behandleren er
--      allerede en anden admin/chef end den, der lukkede sagen, og
--      afgoerelsen paa anken er endelig - som ved alle andre anker.
--      sag_anker.ankede_status tillader nu 'lukket'.
--
--   3. "Ventetid foer afgoerelse til saelger ved retur (Filip, 5. oktober
--      2026): naar koeberen har faaet besked om at sende varen retur, skal
--      der gaa mindst 7 dage, foer staff kan afgoere til saelger eller lukke
--      sagen, fordi returen ikke er kommet."
--      sag_afgoer i 'afventer_retur' med udfald 'saelger' eller 'lukket'
--      afvises med kode 'retur_ventetid' (+ 'retur_frist_kl'), indtil
--        greatest(penge_flyttes_efter_kl, sag_anker.behandlet_kl) + 7 dage.
--      penge_flyttes_efter_kl er det tidspunkt, hvor koeberen faar beskeden
--      "Send varen retur nu": uden anke er det ankefristens udloeb
--      (afgjort_kl + 4 dage; cron notificerReturKanSendes), og efter en anke
--      saetter sag_anke_afgoer den til ankens afgoerelse (stadfaest/omgoer
--      -> notificerAnkeAfgjort). behandlet_kl er med for en sikkerheds skyld.
--      Kravet om p_retur_ikke_sendt bevares (tjekkes efter ventetiden).
--      Gaelder ogsaa en anket sag (admin/chef-vejen).
--      Samme beregning i TypeScript: src/lib/sager.ts (sagReturFristKl).
--
-- Genskrevet (praecise kopier af seneste definition + aendringerne ovenfor):
--   auctions_beskyt_ny       (seneste: 20261004061000)
--   auctions_beskyt_kolonner (seneste: 20261004061000)
--   rediger_auktion          (seneste: 20261004061000)
--   genopsaet_auktion        (seneste: 20261004060000)
--   sag_anke_vurder          (seneste: 20261004050000)
--   sag_anke_afgoer          (seneste: 20261004051000)
--   sag_afgoer               (seneste: 20261004052000)
-- moderation_log_handling_check roeres ikke (ingen nye handlinger).
-- Koeres EFTER 20261004061000_auktionsregler_rettelser.sql.
-- Idempotent: create or replace / drop constraint if exists. Aendrer ingen
-- eksisterende data.

-- ============================================================ 1. Startpris: oprettelse

-- Som 20261004061000 + mindste startpris 1 kr.
create or replace function public.auctions_beskyt_ny()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    if new.redigeret_kl is null then
      new.redigeret_kl := date_trunc('milliseconds', now());
    end if;
    return new;
  end if;

  new.status          := 'aktiv';
  new.vinder_id       := null;
  new."nuværende_bud" := null;
  new.skjult          := false;
  new.oprettet        := now();
  new.redigeret_kl    := date_trunc('milliseconds', now());

  if new.varighed_dage is null then
    new.varighed_dage := public.varighed_fra_slutter_kl(new.slutter_kl);
  end if;

  if not public.er_gyldig_varighed(new.varighed_dage) then
    raise exception 'Vælg en varighed på 3, 5, 7 eller 10 dage.'
      using errcode = '22023';
  end if;

  new.slutter_kl := now() + make_interval(days => new.varighed_dage);

  if new.startpris is null or new.startpris < 0 or new.startpris > 9999999999
     or new.startpris <> trunc(new.startpris) then
    raise exception 'Startprisen skal være et helt antal kroner.'
      using errcode = '22023';
  end if;

  -- NYT: mindste startpris 1 kr (Filip, 5. oktober 2026).
  if new.startpris < 1 then
    raise exception 'Startprisen skal være mindst 1 kr.'
      using errcode = '22023';
  end if;

  -- Billederne skal ligge i den indloggede brugers egen mappe.
  if not public.auktion_billeder_gyldige(auth.uid(), new.billeder) then
    raise exception 'Tilføj mellem 1 og 10 billeder, uploadet til BidHamr.'
      using errcode = 'BHA01';
  end if;

  if not public.er_gyldig_auktionskategori(new.kategori) then
    raise exception 'Vælg en kategori.' using errcode = 'BHA02';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.auctions_beskyt_ny() from public, anon, authenticated;

-- ============================================================ 1. Startpris: direkte UPDATE (appen)

-- Som 20261004061000 + mindste startpris 1 kr, naar startprisen aendres.
create or replace function public.auctions_beskyt_kolonner()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  -- Felter brugeren aldrig maa aendre.
  if new.id              is distinct from old.id
  or new.bruger_id       is distinct from old.bruger_id
  or new.status          is distinct from old.status
  or new.vinder_id       is distinct from old.vinder_id
  or new.slutter_kl      is distinct from old.slutter_kl
  or new.varighed_dage   is distinct from old.varighed_dage
  or new."nuværende_bud" is distinct from old."nuværende_bud"
  or new.skjult          is distinct from old.skjult
  or new.oprettet        is distinct from old.oprettet then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;

  if public.jeg_er_suspenderet() then
    raise exception 'Din konto er suspenderet.' using errcode = 'BHS02';
  end if;

  -- Indholdsfelter og startpris: kun paa en igangvaerende auktion uden bud.
  if old.status <> 'aktiv'
     or old.slutter_kl <= now()
     or old."nuværende_bud" is not null
     or public.auktion_har_bud(old.id) then
    raise exception 'Auktionen kan ikke redigeres, efter der er budt.'
      using errcode = '42501';
  end if;

  if new.startpris is distinct from old.startpris
     and (new.startpris is null or new.startpris < 0 or new.startpris > 9999999999
          or new.startpris <> trunc(new.startpris)) then
    raise exception 'Startprisen skal være et helt antal kroner.'
      using errcode = '22023';
  end if;

  -- NYT: mindste startpris 1 kr - kun naar startprisen aendres, saa en gammel
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
$fn$;

revoke execute on function public.auctions_beskyt_kolonner() from public, anon, authenticated;

-- ============================================================ 1. Startpris: rediger_auktion (RPC)

-- Som 20261004061000 + kode 'startpris_for_lav' (startpris under 1 kr).
-- Signatur uaendret.
create or replace function public.rediger_auktion(
  p_auktion           uuid,
  p_titel             text,
  p_beskrivelse       text,
  p_billeder          text[],
  p_kategori          text,
  p_startpris         numeric,
  p_forsendelse_mulig boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  a       record;
  u       record;
  v_titel   text := btrim(coalesce(p_titel, ''));
  v_beskr   text := nullif(btrim(coalesce(p_beskrivelse, '')), '');
  v_kat     text := btrim(coalesce(p_kategori, ''));
  v_ver     timestamptz := date_trunc('milliseconds', clock_timestamp());
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  -- Laaser raekken: et samtidigt bud (handle_new_bid, "for update") venter,
  -- til redigeringen er faerdig, eller er naaet foerst og ses herunder.
  select * into a from public.auctions where id = p_auktion for update;
  if not found or a.bruger_id is distinct from v_uid or a.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = v_uid;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if a.status <> 'aktiv' then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'slut');
  end if;
  if a."nuværende_bud" is not null
     or exists (select 1 from public.bids b where b.auktion_id = a.id) then
    return jsonb_build_object('kode', 'har_bud');
  end if;

  if char_length(v_titel) < 1 or char_length(v_titel) > 120 then
    return jsonb_build_object('kode', 'ugyldig_titel');
  end if;
  if v_beskr is not null and char_length(v_beskr) > 500 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if not public.er_gyldig_auktionskategori(v_kat) then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  -- NYT: mindste startpris 1 kr.
  if p_startpris < 1 then
    return jsonb_build_object('kode', 'startpris_for_lav');
  end if;

  if not public.auktion_billeder_gyldige(v_uid, p_billeder) then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;

  update public.auctions
     set titel             = v_titel,
         beskrivelse       = v_beskr,
         billeder          = p_billeder,
         kategori          = v_kat,
         startpris         = p_startpris,
         forsendelse_mulig = coalesce(p_forsendelse_mulig, false),
         redigeret_kl      = v_ver
   where id = a.id;

  return jsonb_build_object('kode', 'ok', 'redigeret_kl', v_ver);
end;
$fn$;

revoke execute on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean)
  from public, anon;
grant execute on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean)
  to authenticated;

-- ============================================================ 1. Startpris: genopsaet_auktion

-- Som 20261004060000 + kode 'startpris_for_lav'. Signatur uaendret
-- (service_role; serveren udleder p_seller af sessionen).
create or replace function public.genopsaet_auktion(
  p_auction uuid, p_seller uuid, p_startpris numeric, p_slutter_kl timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  a     record;
  u     record;
  ny_id uuid;
  dage  integer;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = p_seller;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if not public.har_udbetalingskonto(p_seller) then
    return jsonb_build_object('kode', 'mangler_udbetalingskonto');
  end if;

  if a.status <> 'afsluttet' then return jsonb_build_object('kode', 'ikke_afsluttet'); end if;
  if a.skjult then return jsonb_build_object('kode', 'skjult'); end if;

  if not exists (select 1 from public.ubetalte_vindere v where v.auction_id = a.id) then
    return jsonb_build_object('kode', 'ikke_ubetalt');
  end if;
  if exists (select 1 from public.trades t
              where t.auction_id = a.id and t.status <> 'annulleret') then
    return jsonb_build_object('kode', 'solgt');
  end if;
  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = a.id) then
    return jsonb_build_object('kode', 'allerede_genopsat');
  end if;

  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  -- NYT: mindste startpris 1 kr.
  if p_startpris < 1 then
    return jsonb_build_object('kode', 'startpris_for_lav');
  end if;

  dage := public.varighed_fra_slutter_kl(p_slutter_kl);
  if not public.er_gyldig_varighed(dage) then
    return jsonb_build_object('kode', 'ugyldig_slutdato');
  end if;

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, varighed_dage, redigeret_kl,
    kategori, postnummer, lat, lng, maerke, stand, skjult)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, p_startpris, a.lokation,
    a.forsendelse_mulig, 'aktiv', now() + make_interval(days => dage), dage,
    date_trunc('milliseconds', now()),
    a.kategori, a.postnummer, a.lat, a.lng, a.maerke, a.stand, false)
  returning id into ny_id;

  insert into public.genopsaetninger (gammel_auction_id, ny_auction_id, seller_id)
  values (a.id, ny_id, a.bruger_id);

  update public.andenchance_tilbud
     set status = 'annulleret', besvaret_kl = now()
   where auction_id = a.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'auction_id', ny_id);
end;
$fn$;

revoke all on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  to service_role;

-- ============================================================ 2. Anke af en lukket sag

-- Snapshot af den ankede afgoerelse kan nu ogsaa vaere 'lukket'.
alter table public.sag_anker
  drop constraint if exists sag_anker_ankede_status_check;
alter table public.sag_anker
  add constraint sag_anker_ankede_status_check check (
    ankede_status in ('afgjort_koeber', 'afventer_retur', 'afgjort_saelger', 'lukket'));

-- Som 20261004050000, men en sag lukket af en medarbejder ('lukket',
-- penge_handling 'ingen') har nu en taber: koeberen, der oprettede sagen.
-- Returnerer {"kode", "part"?, "fra_kl"?, "til_kl"?}:
--   kan_anke        - knappen er aaben (fra_kl <= nu < til_kl)
--   for_tidligt     - aabner fra_kl (24 timer efter afgoerelsen)
--   for_sent        - ankefristen er udloebet, eller pengene er flyttet /
--                     frysningen er fjernet
--   findes          - sagen er allerede anket (anke_status medsendes)
--   vandt           - brugeren fik medhold (eller sagen blev lukket, og
--                     brugeren er saelgeren) og kan ikke anke
--   ingen_anke      - sagen er ikke afgjort, eller er lukket af systemet
--   retur_afleveret - (saelger) returpakken er allerede registreret
--   ikke_fundet     - sagen findes ikke, eller brugeren er ikke part
create or replace function public.sag_anke_vurder(p_sag uuid, p_bruger uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  s       record;
  t       record;
  a       record;
  v_part  text;
  v_taber text;
  v_fra   timestamptz;
  v_til   timestamptz;
begin
  if p_sag is null or p_bruger is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  select * into s from public.sager where id = p_sag;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select buyer_id, seller_id into t from public.trades where id = s.trade_id;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  if p_bruger = t.buyer_id then v_part := 'koeber';
  elsif p_bruger = t.seller_id then v_part := 'saelger';
  else return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select status into a from public.sag_anker where sag_id = s.id;
  if found then
    return jsonb_build_object('kode', 'findes', 'part', v_part, 'anke_status', a.status);
  end if;

  v_taber := case
    when s.penge_handling = 'refunder' and s.status in ('afgjort_koeber', 'afventer_retur') then 'saelger'
    when s.penge_handling = 'frigiv' and s.status = 'afgjort_saelger' then 'koeber'
    -- NYT: lukket uden at flytte penge - koeberens sag er afvist.
    when s.penge_handling = 'ingen' and s.status = 'lukket' then 'koeber'
    else null end;
  if v_taber is null or s.afgjort_kl is null or s.afgjort_af is null
     or s.afgjort_af = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ingen_anke', 'part', v_part);
  end if;
  if v_taber <> v_part then
    return jsonb_build_object('kode', 'vandt', 'part', v_part);
  end if;

  v_fra := s.afgjort_kl + interval '24 hours';
  v_til := s.afgjort_kl + interval '4 days';

  if s.afviklet_kl is not null or now() >= v_til then
    return jsonb_build_object('kode', 'for_sent', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
  end if;
  if v_taber = 'saelger' and s.retur_afleveret_kl is not null then
    return jsonb_build_object('kode', 'retur_afleveret', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
  end if;
  if now() < v_fra then
    return jsonb_build_object('kode', 'for_tidligt', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
  end if;
  return jsonb_build_object('kode', 'kan_anke', 'part', v_part, 'fra_kl', v_fra, 'til_kl', v_til);
end;
$fn$;

revoke all on function public.sag_anke_vurder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sag_anke_vurder(uuid, uuid) to service_role;

-- Som 20261004051000, men en anke af en LUKKET sag (koeberen ankede):
--   stadfaest - sagen forbliver lukket; frysningen fjernes nu (sag_afvikl),
--               og handlen fortsaetter normalt. handling = 'lukket'.
--   omgoer    - koeberen faar medhold (samme gren som naar koeberen anker et
--               medhold til saelger).
-- Ellers uaendret. Returnerer {"kode": "ok", "udfald", "handling", ...} hvor
-- handling nu ogsaa kan vaere:
--   'lukket'               - stadfaestet lukning; frysningen er fjernet
--                            (afvikling.kode = 'ok'), intet til Stripe
create or replace function public.sag_anke_afgoer(
  p_medarbejder      uuid,
  p_anke             uuid,
  p_udfald           text,
  p_begrundelse      text,
  p_intern_note      text,
  p_retur_ikke_sendt boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_note     text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_sag      uuid;
  v_trade    uuid;
  a          record;
  s          record;
  t          record;
  b          record;
  v_res      jsonb;
  v_handling text;
  v_hvem     text;
  v_log      text;
  v_retur    boolean := false;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('stadfaest', 'omgoer') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select sag_id, trade_id into v_sag, v_trade from public.sag_anker where id = p_anke;
  if v_sag is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag, anke.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = v_sag for update;
  select * into a from public.sag_anker where id = p_anke for update;

  if a.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;
  -- Ingen maa behandle en anke, hvor han selv er part.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  -- En anden end den, der afgjorde sagen.
  if p_medarbejder = a.ankede_afgjort_af or p_medarbejder = s.afgjort_af then
    return jsonb_build_object('kode', 'samme_medarbejder');
  end if;

  v_hvem := case a.part when 'koeber' then 'køberens' else 'sælgerens' end;

  if p_udfald = 'stadfaest' then
    update public.sag_anker
       set status = 'stadfaestet', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_stadfaestet', 'sag', s.id, a.indgivet_af,
            left('Anken (' || v_hvem || ') er afvist - afgørelsen står og er endelig. '
                 -- NYT: en lukket sag forbliver lukket; der flyttes ingen penge.
                 || case when s.status = 'lukket'
                         then 'Sagen forbliver lukket, og frysningen fjernes nu'
                         else 'Pengene flyttes nu' end
                 || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if s.afviklet_kl is not null or s.penge_handling is null then
      v_handling := 'allerede_afviklet';
    else
      update public.sager set penge_flyttes_efter_kl = now() where id = s.id;
      if s.status = 'afventer_retur' then
        v_handling := 'afvent_retur';
      else
        v_res := public.sag_afvikl(s.id);
        -- NYT: 'ingen' (lukket) -> 'lukket'.
        v_handling := case v_res->>'kode'
                        when 'ok' then case s.penge_handling when 'ingen' then 'lukket'
                                                             else s.penge_handling end
                        else 'blokeret' end;
      end if;
    end if;

  else
    -- Omgoer: kun hvis pengene ikke er flyttet.
    if s.afviklet_kl is not null
       or b.id is null
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null
       or b.status <> 'betalt' then
      return jsonb_build_object('kode', 'penge_flyttet');
    end if;

    if a.part = 'saelger' then
      -- Saelgeren faar medhold. Har han allerede faaet varen retur, ville han
      -- faa baade varen og pengene.
      if s.retur_afleveret_kl is not null then
        return jsonb_build_object('kode', 'retur_afleveret');
      end if;
      -- Venter sagen paa retur, kan koeberen have sendt varen (pakken er
      -- bare ikke registreret endnu). Behandleren skal bekraefte, at den
      -- ikke er sendt.
      if s.status = 'afventer_retur' and not coalesce(p_retur_ikke_sendt, false) then
        return jsonb_build_object('kode', 'bekraeft_retur_ikke_sendt');
      end if;
      update public.sager
         set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund,
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = 'frigiv', penge_flyttes_efter_kl = now(),
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_log := 'Anken (sælgerens) er godkendt - afgørelsen er ændret til medhold til sælger og er endelig. Pengene frigives til sælger nu'
               || case when s.status = 'afventer_retur'
                       then ' | Bekræftet af behandleren: køberen har ikke sendt varen retur' else '' end;
    else
      -- Koeberen faar medhold (ogsaa naar sagen var lukket). Samme
      -- forhaandstjek som sag_afgoer.
      if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
        return jsonb_build_object('kode', 'indsigelse');
      end if;
      if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
        update public.sager
           set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = (s.retur_afleveret_kl is not null),
               returfragt_betaler = case when s.retur_afleveret_kl is not null then 'koeber' end,
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Refusion (alt undtagen BidHamr Beskyttelse) nu';
      else
        v_retur := true;
        update public.sager
           set status = 'afventer_retur', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = true, returfragt_betaler = 'koeber',
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Varen sendes retur (køberen betaler selv returfragten); refusion, så snart returpakken er registreret';
      end if;
      if s.status = 'lukket' then
        v_log := v_log || ' | Den ankede afgørelse var en lukning af sagen';
      end if;
    end if;

    update public.sag_anker
       set status = 'omgjort', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_omgjort', 'sag', s.id, a.indgivet_af,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if v_retur then
      v_handling := 'afvent_retur';
    else
      v_res := public.sag_afvikl(s.id);
      v_handling := case v_res->>'kode'
                      when 'ok' then case a.part when 'saelger' then 'frigiv' else 'refunder' end
                      else 'blokeret' end;
    end if;
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'udfald', p_udfald, 'handling', v_handling, 'afvikling', v_res,
    'anke_id', a.id, 'part', a.part, 'sag_id', s.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_anke_afgoer(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.sag_anke_afgoer(uuid, uuid, text, text, text, boolean) to service_role;

-- ============================================================ 3. Ventetid foer afgoerelse ved retur

-- Som 20261004052000, men i 'afventer_retur' kan sagen foerst afgoeres til
-- saelger eller lukkes 7 dage efter, at koeberen fik besked om at sende
-- varen retur (kode 'retur_ventetid' + 'retur_frist_kl'). Ellers uaendret.
create or replace function public.sag_afgoer(
  p_medarbejder      uuid,
  p_sag              uuid,
  p_udfald           text,
  p_begrundelse      text,
  p_intern_note      text,
  p_retur_ikke_sendt boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_note     text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_frist    timestamptz := now() + interval '4 days';
  v_trade    uuid;
  s          record;
  t          record;
  b          record;
  v_handling text;
  v_advarsel text;
  v_log      text;
  -- Sagen har en afgjort anke (afgoerelsen paa anken er endelig).
  ak         record;
  v_anket    boolean := false;
  v_res      jsonb;
  -- Tekst til moderation_log, naar medarbejderen har bekraeftet, at
  -- koeberen ikke har sendt varen retur.
  v_retur_tjek text := '';
  -- NYT: hvornaar koeberen fik besked om at sende varen retur, og hvornaar
  -- de 7 dages ventetid er udloebet.
  v_anke_behandlet timestamptz;
  v_retur_frist    timestamptz;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('koeber', 'saelger', 'lukket') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  -- Ingen maa afgoere en sag, hvor han selv er part.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- En anke venter: den skal afgoeres foerst.
  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'anke_afventer');
  end if;

  -- Anken er afgjort, og afgoerelsen er endelig. Kun hvis sagen venter
  -- paa en retur, der ikke kommer (fx koeberen sender aldrig varen), maa en
  -- admin/chef afgoere den igen (til saelger eller lukke den - se
  -- statustjekket nedenfor) - og kun en anden end dem, der afgjorde sagen og
  -- anken. Der er ingen ny ankefrist: pengene flyttes straks.
  select * into ak from public.sag_anker where sag_id = s.id;
  if found then
    v_anke_behandlet := ak.behandlet_kl;
    if s.status <> 'afventer_retur' then
      return jsonb_build_object('kode', 'anket');
    end if;
    if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
      return jsonb_build_object('kode', 'anke_endelig');
    end if;
    if p_medarbejder = ak.ankede_afgjort_af
       or p_medarbejder = ak.behandlet_af
       or p_medarbejder = s.afgjort_af then
      return jsonb_build_object('kode', 'samme_medarbejder');
    end if;
    v_anket := true;
    v_frist := now();
  end if;

  if s.status = 'aaben' then
    null;
  elsif s.status = 'afventer_retur' and p_udfald in ('saelger', 'lukket') then
    -- Fx koeberen sender aldrig varen retur.
    -- NYT: foerst 7 dage efter, at koeberen fik besked om at sende varen
    -- retur. Beskeden gives, naar ankefristen er udloebet
    -- (penge_flyttes_efter_kl = afgjort_kl + 4 dage), eller naar anken er
    -- afgjort (sag_anke_afgoer saetter penge_flyttes_efter_kl = nu).
    v_retur_frist := greatest(coalesce(s.penge_flyttes_efter_kl, s.afgjort_kl + interval '4 days'),
                              coalesce(v_anke_behandlet, '-infinity'::timestamptz))
                     + interval '7 days';
    if v_retur_frist is null or now() < v_retur_frist then
      return jsonb_build_object('kode', 'retur_ventetid', 'retur_frist_kl', v_retur_frist);
    end if;
    -- Medarbejderen skal bekraefte, at koeberen ikke har sendt varen
    -- retur (heller ikke undervejs) - ellers kunne saelgeren faa baade varen
    -- og pengene (eller handlen fortsaette, mens varen er paa vej tilbage).
    if not coalesce(p_retur_ikke_sendt, false) then
      return jsonb_build_object('kode', 'bekraeft_retur_ikke_sendt');
    end if;
    v_retur_tjek := ' | Bekræftet af medarbejderen: køberen har ikke sendt varen retur (heller ikke undervejs)';
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  if p_udfald = 'koeber' then
    -- Tjek allerede nu, at en refusion vil vaere mulig (ingen indsigelse,
    -- intet overfoert). sag_afvikl tjekker igen, naar fristen er udloebet.
    if b.id is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;
    if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
      return jsonb_build_object('kode', 'indsigelse');
    end if;
    if b.status <> 'betalt'
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null then
      return jsonb_build_object('kode', 'ikke_mulig');
    end if;

    if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
      -- Svindel/bortkommet refunderes uden retur. (Er returpakken allerede
      -- registreret - sagen er genaabnet efter retur - venter vi ikke igen.)
      update public.sager
         set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             retur_kraeves = (s.retur_afleveret_kl is not null),
             returfragt_betaler = case when s.retur_afleveret_kl is not null
                                       then 'koeber' end,
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'planlagt_refusion';
      v_log := 'Medhold til køber - refusion (alt undtagen BidHamr Beskyttelse) efter ankefristen på 4 dage';
    else
      -- Skadet / ikke som beskrevet: retur foer refusion.
      update public.sager
         set status = 'afventer_retur', retur_kraeves = true,
             returfragt_betaler = 'koeber',
             afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'afvent_retur';
      v_log := 'Medhold til køber - varen sendes retur (køberen betaler selv returfragten), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';
    end if;
    -- trades.sag_aaben forbliver true: pengene er frosset til sag_afvikl.

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_koeber', 'sag', s.id, t.buyer_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  elsif p_udfald = 'saelger' then
    update public.sager
       set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'frigiv', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    -- Vil frigivelsen vaere blokeret? (samme regler som sag_afvikl)
    v_advarsel := case
      when b.id is null then 'ingen_betaling'
      when public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then 'indsigelse'
      when b.status = 'refunderet' or b.refusion_anmodet_kl is not null then 'refusion'
      when b.status <> 'betalt' then 'ikke_betalt'
      else null end;

    v_handling := 'planlagt_frigivelse';
    v_log := case when v_anket
                  then 'Medhold til sælger efter anke - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - pengene frigives nu'
                  else 'Medhold til sælger - pengene frigives efter ankefristen på 4 dage' end
             || coalesce(' (OBS: frigivelsen er blokeret lige nu: ' || v_advarsel || ')', '')
             || v_retur_tjek;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_saelger', 'sag', s.id, t.seller_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  else
    update public.sager
       set status = 'lukket', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'ingen', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    v_handling := 'lukket';
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', s.id, t.buyer_id,
            left(case when v_anket
                      then 'Sag lukket efter anke uden at flytte penge - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - frysningen fjernes nu'
                      else 'Sag lukket uden at flytte penge - frysningen fjernes efter ankefristen på 4 dage (køberen kan anke)' end
                 || v_retur_tjek
                 || ' | Til parterne: '
                 || v_grund || coalesce(' | Intern note: ' || v_note, ''), 4000));
  end if;

  -- Anket sag - ingen ny ankefrist, saa afgoerelsen gennemfoeres straks.
  -- Serveren kalder Stripe (udfoerSagAfvikling), naar afvikling.kode = 'ok';
  -- ellers proever cron igen (sag_afvikl_forfaldne).
  if v_anket then
    v_res := public.sag_afvikl(s.id);
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'penge_flyttes_efter_kl', v_frist,
    'endelig', v_anket, 'afvikling', v_res,
    'advarsel', v_advarsel, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$fn$;

revoke all on function public.sag_afgoer(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.sag_afgoer(uuid, uuid, text, text, text, boolean) to service_role;
