-- Rettelser til "skjult auktion sættes på pause" efter review + nye
-- beslutninger fra Filip (6. oktober 2026). KUN til testdatabasen, som fik en
-- tidligere udgave af 20261009040000_skjult_auktion_pause.sql. Produktion
-- kører den rettede 20261009040000 og behøver ikke denne fil (den er dog
-- harmløs at køre der). Slutresultatet er det samme.
--
--  V1  Triggeren auctions_pause_skjult kører ved enhver opdatering:
--      genoptager, når pauset_kl er sat, status er 'aktiv' og skjult er
--      false - uanset hvilken kolonne der ændrede sig. Annulleres en pauset
--      auktion, lukkes pausen (aldrig genåbning). handle_new_bid afviser bud
--      på en pauset auktion.
--  (a) En auktion, som BidHamr har fjernet/stoppet (annulleret), genåbnes
--      ALDRIG: dsa_klage_afgoer ophæver afgørelsen ved medhold, men status
--      forbliver 'annulleret'. Ny trigger auctions_annulleret_endelig.
--      Nyt: kan_saette_op_igen / saet_annulleret_op_igen (ét klik).
--  V5  auctions_beskyt_kolonner: sælgeren kan ikke ændre en skjult auktion.
--  (b) Maks pause: pg_cron 'pause-udloeb' - påmindelse efter 3 dage,
--      automatisk annullering (DSA-afgørelse) efter 14 dage.
--      auktion_pauser får annulleret_kl, automatisk, afgoerelse_id,
--      paamindet_kl.
--  Mindre: auktion_pauser.auction_id on delete restrict (ikke cascade);
--      dsa_anmeldelse_afgoer håndhæver inhabilitet over for alle parter.
--
-- Idempotent.

set lock_timeout = '5s';

-- =====================================================================
-- 1. auktion_pauser: nye kolonner, FK uden cascade, nyt unikt indeks
-- =====================================================================
alter table public.auktion_pauser add column if not exists annulleret_kl timestamptz;
alter table public.auktion_pauser add column if not exists automatisk boolean not null default false;
alter table public.auktion_pauser add column if not exists afgoerelse_id uuid
  references public.dsa_afgoerelser(id) on delete restrict;
alter table public.auktion_pauser add column if not exists paamindet_kl timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'auktion_pauser_auction_id_fkey' and confdeltype <> 'r') then
    alter table public.auktion_pauser drop constraint auktion_pauser_auction_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auktion_pauser_auction_id_fkey') then
    alter table public.auktion_pauser
      add constraint auktion_pauser_auction_id_fkey
      foreign key (auction_id) references public.auctions(id) on delete restrict;
  end if;
end $$;

-- Højst én åben pause pr. auktion (åben = hverken genoptaget eller annulleret).
drop index if exists public.auktion_pauser_aaben_idx;
create unique index auktion_pauser_aaben_idx
  on public.auktion_pauser (auction_id) where genoptaget_kl is null and annulleret_kl is null;
create index if not exists auktion_pauser_annulleret_idx
  on public.auktion_pauser (annulleret_kl) where annulleret_kl is not null;

-- =====================================================================
-- 2. Trigger: pause ved skjul, genoptag ved vis igen, luk ved annullering
-- =====================================================================
-- Kører ved ENHVER opdatering af auctions (ikke kun skjult/status), så en
-- pauset auktion altid genoptages, når den igen er aktiv og synlig - uanset
-- hvilken kolonne der blev ændret.
create or replace function public.auctions_pause_skjult()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rest interval;
begin
  -- Annulleret: pausen lukkes. En annulleret auktion genåbnes aldrig
  -- (Filip, 6. okt. 2026), så den resterende tid gemmes ikke.
  if new.status = 'annulleret' then
    if old.pauset_kl is not null or new.pauset_kl is not null then
      new.pauset_kl := null;
      new.pause_resterende := null;
      update public.auktion_pauser
         set annulleret_kl = now()
       where auction_id = new.id and genoptaget_kl is null and annulleret_kl is null;
    end if;
    return new;
  end if;

  -- Skjules: en igangværende auktion sættes på pause.
  if coalesce(new.skjult, false) and not coalesce(old.skjult, false)
     and old.status = 'aktiv' and new.status = 'aktiv' and old.pauset_kl is null then
    v_rest := greatest(old.slutter_kl - now(), interval '0');
    new.pauset_kl := now();
    new.pause_resterende := v_rest;
    insert into public.auktion_pauser (auction_id, pauset_kl, resterende)
    values (new.id, new.pauset_kl, v_rest)
    on conflict (auction_id) where genoptaget_kl is null and annulleret_kl is null do nothing;
    return new;
  end if;

  -- Genoptages: pauset, aktiv og synlig - uanset hvilken kolonne der ændrede sig.
  if old.pauset_kl is not null and new.status = 'aktiv' and not coalesce(new.skjult, false) then
    new.slutter_kl := now() + greatest(coalesce(old.pause_resterende, interval '0'), interval '24 hours');
    new.pauset_kl := null;
    new.pause_resterende := null;
    update public.auktion_pauser
       set genoptaget_kl = now(), ny_slutter_kl = new.slutter_kl
     where auction_id = new.id and genoptaget_kl is null and annulleret_kl is null;
  end if;

  return new;
end;
$fn$;

revoke all on function public.auctions_pause_skjult() from public, anon, authenticated;

-- Navnet sorterer efter auctions_beskyt_kolonner, så beskyttelsen ser
-- brugerens egne ændringer, før triggeren selv sætter felterne.
drop trigger if exists auctions_pause_skjult on public.auctions;
create trigger auctions_pause_skjult
  before update on public.auctions
  for each row execute function public.auctions_pause_skjult();

-- En annulleret auktion kan aldrig få en anden status igen (Filip, 6. okt.
-- 2026): buddene gælder ikke, og sælgeren sætter varen op igen som en ny
-- auktion. Kun til oprydning af testdata:
--   set local bidhamr.tillad_genaabning = 'ja';
create or replace function public.auctions_annulleret_endelig()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if old.status = 'annulleret' and new.status is distinct from 'annulleret'
     and coalesce(current_setting('bidhamr.tillad_genaabning', true), '') <> 'ja' then
    raise exception 'En annulleret auktion kan ikke åbnes igen. Sæt varen op igen som en ny auktion.'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke all on function public.auctions_annulleret_endelig() from public, anon, authenticated;

drop trigger if exists auctions_annulleret_endelig on public.auctions;
create trigger auctions_annulleret_endelig
  before update of status on public.auctions
  for each row when (old.status = 'annulleret' and new.status is distinct from old.status)
  execute function public.auctions_annulleret_endelig();

-- =====================================================================
-- 3. auctions_beskyt_kolonner: en skjult auktion kan sælgeren ikke ændre
-- =====================================================================
create or replace function public.auctions_beskyt_kolonner()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
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
$fn$;


-- =====================================================================
-- 5. dsa_klage_afgoer: en fjernet/stoppet auktion genåbnes aldrig
-- =====================================================================
-- Beslutning (Filip, 6. okt. 2026): en auktion, som BidHamr har fjernet
-- eller stoppet (annulleret), genåbnes ALDRIG - heller ikke ved medhold.
-- Buddene gælder ikke. Medhold ophæver afgørelsen (ophaevet_grund
-- 'klage'), status forbliver 'annulleret', og sælgeren får et ærligt svar
-- og kan sætte varen op igen med ét klik (saet_annulleret_op_igen).
-- Medhold i en klage over "Auktion skjult" viser den igen; var den på
-- pause, genoptager triggeren auctions_pause_skjult den.
create or replace function public.dsa_klage_afgoer(p_medarbejder uuid, p_klage uuid, p_udfald text, p_svar text, p_intern_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_svar  text := btrim(coalesce(p_svar, ''));
  v_note  text := nullif(btrim(coalesce(p_intern_note, '')), '');
  k       record;
  af      record;
  an      record;
  v_rolle text := 'medarbejder';
  v_r     jsonb;
  v_genaabnet boolean := true;
  v_bruger uuid;
  v_til    uuid;
  v_saelger uuid;
begin
  if p_udfald is null or p_udfald not in ('medhold', 'fastholdt') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_svar = '' then return jsonb_build_object('kode', 'svar_mangler'); end if;
  if char_length(v_svar) > 2000 or (v_note is not null and char_length(v_note) > 2000) then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select * into k from public.dsa_klager x where x.id = p_klage for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if k.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;

  if k.afgoerelse_id is not null then
    select * into af from public.dsa_afgoerelser x where x.id = k.afgoerelse_id for update;
    v_rolle := public.dsa_min_rolle(af.handling);
    v_bruger := af.bruger_id;
  else
    select * into an from public.dsa_anmeldelser x where x.id = k.anmeldelse_id for update;
    v_bruger := an.anmeldt_bruger_id;
  end if;

  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, v_rolle) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  if k.afgoerelse_id is not null then
    if p_medarbejder is not distinct from af.medarbejder_id
       or p_medarbejder = k.klager_id
       or public.dsa_er_inhabil(p_medarbejder, af.bruger_id)
       or exists (select 1 from public.dsa_anmeldelser x
                   where x.id = af.anmeldelse_id and x.anmelder_id = p_medarbejder) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
    if af.handling in ('bedoemmelse_skjult', 'bedoemmelse_svar_skjult') then
      select r.til_bruger_id into v_til from public.ratings r where r.id = af.indhold_id;
      if public.bedoemmelse_er_inhabil(p_medarbejder, af.indhold_id)
         or public.dsa_er_inhabil(p_medarbejder, v_til) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    elsif af.handling = 'spoergsmaal_skjult' then
      select x.asker_id, au.bruger_id into v_til, v_saelger
        from public.auction_questions x join public.auctions au on au.id = x.auction_id
       where x.id = af.indhold_id;
      if public.dsa_er_inhabil(p_medarbejder, v_til) or public.dsa_er_inhabil(p_medarbejder, v_saelger) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    end if;
  else
    if p_medarbejder is not distinct from an.behandlet_af
       or p_medarbejder is not distinct from an.anmelder_id
       or public.dsa_er_inhabil(p_medarbejder, an.anmeldt_bruger_id) then
      return jsonb_build_object('kode', 'inhabil');
    end if;
  end if;

  if p_udfald = 'medhold' then
    if k.afgoerelse_id is not null then
      -- Fjernet/stoppet: afgørelsen ophæves, men auktionen åbnes ikke igen.
      if af.handling in ('auktion_fjernet', 'auktion_annulleret') then
        v_genaabnet := false;
        perform 1 from public.auctions x where x.id = af.indhold_id for update;
      end if;

      update public.dsa_afgoerelser
         set ophaevet_kl = coalesce(ophaevet_kl, now()), ophaevet_grund = coalesce(ophaevet_grund, 'klage')
       where id = af.id;

      if af.handling = 'auktion_skjult' then
        update public.auctions set skjult = false where id = af.indhold_id and skjult;
      elsif af.handling = 'auktion_fjernet' then
        -- Indholdet er i orden: det må ses igen (status forbliver 'annulleret').
        update public.auctions set skjult = false where id = af.indhold_id and skjult;
      elsif af.handling = 'spoergsmaal_skjult' then
        v_r := public.skjul_spoergsmaal(p_medarbejder, af.indhold_id, false, null);
        if v_r->>'kode' not in ('ok', 'uaendret') then
          raise exception 'skjul_spoergsmaal: %', v_r->>'kode';
        end if;
      elsif af.handling in ('bedoemmelse_skjult', 'bedoemmelse_svar_skjult') then
        v_r := public.skjul_bedoemmelse(p_medarbejder, af.indhold_id,
                 case when af.handling = 'bedoemmelse_skjult' then 'bedoemmelse' else 'svar' end,
                 false, null, left('Medhold i klage ' || k.sagsnummer, 500));
        if v_r->>'kode' not in ('ok', 'uaendret') then
          raise exception 'skjul_bedoemmelse: %', v_r->>'kode';
        end if;
      elsif af.handling = 'konto_suspenderet' then
        if not exists (select 1 from public.dsa_afgoerelser y
                        where y.bruger_id = af.bruger_id and y.id <> af.id
                          and y.handling in ('konto_suspenderet', 'konto_lukket')
                          and y.oprettet_kl > af.oprettet_kl and y.ophaevet_kl is null) then
          update public.users
             set suspenderet = false, suspenderet_aarsag = null, suspenderet_kl = null, suspenderet_til = null
           where id = af.bruger_id and suspenderet and konto_lukket_kl is null;
        end if;
        insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
        values (p_medarbejder, 'ophaev_suspension', 'bruger', af.bruger_id, af.bruger_id,
                left('Suspension ophævet efter medhold i klage ' || k.sagsnummer, 4000));
      elsif af.handling = 'konto_lukket' then
        update public.users
           set konto_lukket_kl = null, konto_lukket_af = null, suspenderet = false,
               suspenderet_aarsag = null, suspenderet_kl = null, suspenderet_til = null
         where id = af.bruger_id and konto_lukket_kl is not null and konto_slettet_kl is null;
        insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
        values (p_medarbejder, 'konto_genaabnet', 'bruger', af.bruger_id, af.bruger_id,
                left('Konto genåbnet efter medhold i klage ' || k.sagsnummer, 4000));
      end if;
    else
      update public.dsa_anmeldelser
         set status = 'ny', udfald = null, behandlet_af = null, behandlet_kl = null,
             genaabnet_kl = now(), frist_kl = now() + interval '7 days', svar_sendt_kl = null
       where id = an.id;
    end if;
  end if;

  update public.dsa_klager
     set status = 'afgjort', udfald = p_udfald, svar = v_svar, intern_note = v_note,
         afgjort_af = p_medarbejder, afgjort_kl = now()
   where id = k.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder,
          case when p_udfald = 'medhold' then 'dsa_klage_medhold' else 'dsa_klage_fastholdt' end,
          'dsa', k.id, v_bruger,
          left('Klage ' || k.sagsnummer || ': ' || case when p_udfald = 'medhold' then 'medhold' else 'afgørelsen fastholdt' end
               || case when p_udfald = 'medhold' and not v_genaabnet then ' (auktionen åbnes ikke igen - sælgeren kan sætte varen op igen)' else '' end
               || ' | ' || coalesce(v_note, v_svar), 4000));

  return jsonb_build_object('kode', 'ok', 'genaabnet', v_genaabnet,
                            'type', case when k.afgoerelse_id is not null then 'afgoerelse' else 'anmeldelse' end);
end;
$fn$;

revoke all on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.dsa_klage_afgoer(uuid, uuid, text, text, text) to service_role;

-- =====================================================================
-- 9. handle_new_bid: bud på en pauset auktion afvises
-- =====================================================================
-- Som 20261007031000_konto_sikkerhed_rettelser.sql. NYT: afvis, når
-- pauset_kl er sat (også hvis den af en eller anden grund ikke er skjult).
create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
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

  -- NYT (6. okt. 2026): en pauset auktion tager ikke imod bud.
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

  v_minimum := public.naeste_bud_minimum(v_auktion."nuværende_bud", v_auktion.startpris);
  if new."beløb" < v_minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(v_minimum);
  end if;

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
$fn$;

-- =====================================================================
-- 10. dsa_anmeldelse_afgoer: inhabilitet over for alle parter
-- =====================================================================
-- Som 20261009010000_dsa.sql. NYT: samme inhabilitetsregel som UI'et
-- (src/app/admin/dsa/page.tsx) og dsa_indgreb: indholdets ejer, begge parter
-- i et spørgsmål (spørger og sælger) og begge parter i en bedømmelse
-- (bedoemmelse_er_inhabil + den anden part).
create or replace function public.dsa_anmeldelse_afgoer(
  p_medarbejder uuid,
  p_anmeldelse  uuid,
  p_udfald      text,
  p_svar        text,
  p_intern_note text,
  p_politi      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_svar text := btrim(coalesce(p_svar, ''));
  v_note text := nullif(btrim(coalesce(p_intern_note, '')), '');
  x      record;
  v_ejer uuid;
  v_a    uuid;
  v_b    uuid;
begin
  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('ingen_overtraedelse', 'ikke_fundet') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_svar = '' then return jsonb_build_object('kode', 'svar_mangler'); end if;
  if char_length(v_svar) > 2000 or (v_note is not null and char_length(v_note) > 2000) then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select * into x from public.dsa_anmeldelser a where a.id = p_anmeldelse for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if x.status <> 'ny' then return jsonb_build_object('kode', 'behandlet'); end if;
  if x.anmelder_id = p_medarbejder or public.dsa_er_inhabil(p_medarbejder, x.anmeldt_bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if x.indhold_id is not null and x.indhold_type <> 'andet' then
    select e.bruger_id into v_ejer from public.dsa_indhold_ejer(x.indhold_type, x.indhold_id) e limit 1;
    if public.dsa_er_inhabil(p_medarbejder, v_ejer) then
      return jsonb_build_object('kode', 'inhabil');
    end if;

    if x.indhold_type in ('spoergsmaal', 'spoergsmaal_svar') then
      select q.asker_id, au.bruger_id into v_a, v_b
        from public.auction_questions q join public.auctions au on au.id = q.auction_id
       where q.id = x.indhold_id;
      if public.dsa_er_inhabil(p_medarbejder, v_a) or public.dsa_er_inhabil(p_medarbejder, v_b) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    elsif x.indhold_type in ('bedoemmelse', 'bedoemmelse_svar') then
      -- indhold_id er bedømmelsens id (også for svaret).
      select r.fra_bruger_id, r.til_bruger_id into v_a, v_b
        from public.ratings r where r.id = x.indhold_id;
      if public.bedoemmelse_er_inhabil(p_medarbejder, x.indhold_id)
         or public.dsa_er_inhabil(p_medarbejder, v_a)
         or public.dsa_er_inhabil(p_medarbejder, v_b) then
        return jsonb_build_object('kode', 'inhabil');
      end if;
    end if;
  end if;

  update public.dsa_anmeldelser
     set status = 'afgjort', udfald = p_udfald, svar_til_anmelder = v_svar,
         intern_note = coalesce(v_note, intern_note), behandlet_af = p_medarbejder, behandlet_kl = now(),
         politi_underrettet = politi_underrettet or coalesce(p_politi, false)
   where id = x.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'dsa_anmeldelse_afgjort', 'dsa', x.id, x.anmeldt_bruger_id,
          left('Anmeldelse ' || x.sagsnummer || ' afsluttet uden indgreb ('
               || case p_udfald when 'ikke_fundet' then 'indholdet findes ikke' else 'ingen overtrædelse' end
               || '): ' || coalesce(v_note, v_svar), 4000));

  return jsonb_build_object('kode', 'ok', 'id', x.id);
end;
$fn$;
revoke all on function public.dsa_anmeldelse_afgoer(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.dsa_anmeldelse_afgoer(uuid, uuid, text, text, text, boolean) to service_role;

-- =====================================================================
-- 11. Sæt en annulleret auktion op igen med ét klik
-- =====================================================================
-- Må sælgeren sætte en annulleret auktion op igen som en ny auktion?
-- 'ok', når den er annulleret og ikke allerede sat op igen, ingen klage er i
-- gang, og enten
--   - den blev annulleret automatisk efter 14 dages pause, og BidHamr ikke
--     bagefter har fjernet den, eller
--   - BidHamr fjernede/stoppede den, og alle sådanne afgørelser er ophævet
--     (medhold i klage, genåbnet rapport eller "Vis igen").
-- Ellers en kode: ikke_fundet, ikke_annulleret, allerede_genopsat,
-- klage_afventer, fjernet (en gældende fjernelse), ikke_bidhamr (sælgeren
-- annullerede selv - opret en ny auktion).
create or replace function public.kan_saette_op_igen(p_auction uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_status text;
  v_auto   uuid[];
begin
  select a.status into v_status from public.auctions a where a.id = p_auction;
  if not found then return 'ikke_fundet'; end if;
  if v_status <> 'annulleret' then return 'ikke_annulleret'; end if;
  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = p_auction) then
    return 'allerede_genopsat';
  end if;
  if exists (select 1 from public.dsa_klager k
               join public.dsa_afgoerelser f on f.id = k.afgoerelse_id
              where f.indhold_type = 'auktion' and f.indhold_id = p_auction and k.status = 'afventer') then
    return 'klage_afventer';
  end if;

  select coalesce(array_agg(p.afgoerelse_id) filter (where p.afgoerelse_id is not null), '{}')
    into v_auto
    from public.auktion_pauser p
   where p.auction_id = p_auction and p.automatisk and p.annulleret_kl is not null;

  -- En gældende fjernelse/stop fra en medarbejder (ikke den automatiske).
  if exists (select 1 from public.dsa_afgoerelser f
              where f.indhold_type = 'auktion' and f.indhold_id = p_auction
                and f.handling in ('auktion_fjernet', 'auktion_annulleret')
                and f.ophaevet_kl is null
                and not (f.id = any (v_auto))) then
    return 'fjernet';
  end if;

  if exists (select 1 from public.auktion_pauser p
              where p.auction_id = p_auction and p.automatisk and p.annulleret_kl is not null) then
    return 'ok';
  end if;

  if exists (select 1 from public.dsa_afgoerelser f
              where f.indhold_type = 'auktion' and f.indhold_id = p_auction
                and f.handling in ('auktion_fjernet', 'auktion_annulleret')) then
    return 'ok';
  end if;

  return 'ikke_bidhamr';
end;
$fn$;

revoke all on function public.kan_saette_op_igen(uuid) from public, anon, authenticated;
grant execute on function public.kan_saette_op_igen(uuid) to service_role;

-- Opretter en ny auktion med samme indhold, startpris og varighed (som
-- genopsaet_auktion for ubetalte vindere). Kaldes kun af serveren efter
-- login-tjek (p_seller = den indloggede bruger). Returnerer {kode,
-- auction_id?}. Koder som kan_saette_op_igen + ikke_saelger, suspenderet,
-- konto_lukket, mangler_udbetalingskonto, forbudt_vare.
create or replace function public.saet_annulleret_op_igen(p_auction uuid, p_seller uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  a      record;
  u      record;
  v_kode text;
  v_tjek jsonb;
  dage   integer;
  pris   numeric;
  ny_id  uuid;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_seller is null or a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  select suspenderet, suspenderet_til, konto_lukket_kl, konto_slettet_kl into u
    from public.users where id = p_seller;
  if u.konto_lukket_kl is not null or u.konto_slettet_kl is not null then
    return jsonb_build_object('kode', 'konto_lukket');
  end if;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;
  if not public.har_udbetalingskonto(p_seller) then
    return jsonb_build_object('kode', 'mangler_udbetalingskonto');
  end if;

  v_kode := public.kan_saette_op_igen(p_auction);
  if v_kode <> 'ok' then return jsonb_build_object('kode', v_kode); end if;

  -- Indholdskontrollen (auctions_indhold_kontrol) springer serveren over -
  -- forbudte ord tjekkes derfor her.
  v_tjek := public.forbudt_tekst_tjek(coalesce(a.titel, '') || ' ' || coalesce(a.beskrivelse, ''));
  if v_tjek->>'resultat' = 'blokeret' then
    return jsonb_build_object('kode', 'forbudt_vare', 'ord', v_tjek->>'ord', 'kategori', v_tjek->>'kategori');
  end if;

  dage := case when public.er_gyldig_varighed(a.varighed_dage) then a.varighed_dage else 7 end;
  pris := greatest(trunc(coalesce(a.startpris, 1)), 1);

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, varighed_dage, redigeret_kl,
    kategori, postnummer, lat, lng, maerke, stand, skjult,
    spoergsmaal_aktiv, forbudt_bekraeftet)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, pris, a.lokation,
    a.forsendelse_mulig, 'aktiv', now() + make_interval(days => dage), dage,
    date_trunc('milliseconds', now()),
    a.kategori, a.postnummer, a.lat, a.lng, a.maerke, a.stand, false,
    a.spoergsmaal_aktiv, a.forbudt_bekraeftet)
  returning id into ny_id;

  insert into public.genopsaetninger (gammel_auction_id, ny_auction_id, seller_id)
  values (a.id, ny_id, a.bruger_id);

  return jsonb_build_object('kode', 'ok', 'auction_id', ny_id);
end;
$fn$;

revoke all on function public.saet_annulleret_op_igen(uuid, uuid) from public, anon, authenticated;
grant execute on function public.saet_annulleret_op_igen(uuid, uuid) to service_role;

-- =====================================================================
-- 12. Maks pause: påmindelse efter 3 dage, annullering efter 14 dage
-- =====================================================================
-- pg_cron 'pause-udloeb' hver time (Filip, 6. okt. 2026):
--  - Efter 3 dage på pause: staff får en påmindelse via drift-alarmen
--    (drift_fejl_log -> mail til DRIFT_ALARM_MAIL og /admin/drift). Én pr.
--    pause (auktion_pauser.paamindet_kl). /admin/auktioner markerer den.
--  - Efter 14 dage: auktionen annulleres automatisk med en DSA-afgørelse
--    (auktion_annulleret, automatisk_afgjort, samme regel som skjulningen).
--    Triggeren lukker pausen; auktion_pauser.automatisk/afgoerelse_id
--    sættes. Beskederne sendes af notifikations-cron'en
--    (src/lib/notifikationer/auktionPause.ts): byderne "dit bud gælder ikke
--    længere", sælgeren begrundelsen med "Sæt varen op igen".
create or replace function public.pause_udloeb_koer()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r       record;
  v_regel record;
  v_af    uuid;
  v_paam  integer := 0;
  v_ann   integer := 0;
begin
  -- Påmindelse efter 3 dage.
  for r in
    select p.id, p.auction_id, a.pauset_kl
      from public.auktion_pauser p
      join public.auctions a on a.id = p.auction_id
     where p.genoptaget_kl is null and p.annulleret_kl is null and p.paamindet_kl is null
       and a.status = 'aktiv' and a.pauset_kl is not null
       and a.pauset_kl <= now() - interval '3 days'
       and a.pauset_kl > now() - interval '14 days'
  loop
    update public.auktion_pauser set paamindet_kl = now() where id = r.id;
    perform public.drift_fejl_log(
      'cron', '/admin/auktioner',
      format('Auktion %s har været på pause i over 3 dage. Den annulleres automatisk %s, hvis den ikke vises igen eller fjernes inden da.',
             r.auction_id,
             to_char((r.pauset_kl + interval '14 days') at time zone 'Europe/Copenhagen', 'DD-MM-YYYY "kl." HH24:MI')));
    v_paam := v_paam + 1;
  end loop;

  -- Automatisk annullering efter 14 dage.
  for r in
    select a.id, a.bruger_id, a.titel, p.id as pid
      from public.auctions a
      join public.auktion_pauser p
        on p.auction_id = a.id and p.genoptaget_kl is null and p.annulleret_kl is null
     where a.status = 'aktiv' and a.pauset_kl is not null
       and a.pauset_kl <= now() - interval '14 days'
     order by a.pauset_kl
     limit 200
  loop
    begin
      v_af := null;
      select f.regel_kode, f.regel_tekst, f.grundlag into v_regel
        from public.dsa_afgoerelser f
       where f.indhold_type = 'auktion' and f.indhold_id = r.id and f.handling = 'auktion_skjult'
       order by f.oprettet_kl desc
       limit 1;
      if not found then
        select x.kode as regel_kode, left(x.navn || ' (' || x.henvisning || ')', 500) as regel_tekst, x.grundlag
          into v_regel
          from public.dsa_regler() x where x.kode = 'andet';
      end if;

      update public.auctions set status = 'annulleret'
       where id = r.id and status = 'aktiv' and pauset_kl is not null;
      if not found then continue; end if;

      insert into public.dsa_afgoerelser
        (bruger_id, indhold_type, indhold_id, auktion_id, indhold_tekst, handling, regel_kode, regel_tekst,
         grundlag, fakta, automatisk_afgjort, foer_status)
      values
        (r.bruger_id, 'auktion', r.id, r.id, left(r.titel, 300), 'auktion_annulleret', v_regel.regel_kode,
         v_regel.regel_tekst, v_regel.grundlag,
         'Auktionen var sat på pause i 14 dage, mens BidHamr undersøgte den, og blev ikke åbnet igen inden da. '
         || 'Efter vores regler annulleres den så automatisk. Buddene gælder ikke, og ingen skal betale noget. '
         || 'Du kan sætte varen op igen med ét klik fra siden med denne begrundelse.',
         true, 'aktiv')
      returning id into v_af;

      update public.auktion_pauser set automatisk = true, afgoerelse_id = v_af where id = r.pid;
      v_ann := v_ann + 1;
    exception when others then
      perform public.drift_fejl_log('cron', 'pause-udloeb',
        'Automatisk annullering af pauset auktion fejlede: ' || sqlerrm);
    end;
  end loop;

  return jsonb_build_object('paamindet', v_paam, 'annulleret', v_ann);
end;
$fn$;

revoke all on function public.pause_udloeb_koer() from public, anon, authenticated;
grant execute on function public.pause_udloeb_koer() to service_role;

-- cron.schedule med samme navn opdaterer jobbet (idempotent).
select cron.schedule('pause-udloeb', '11 * * * *', $$select public.pause_udloeb_koer();$$);

-- =====================================================================
-- 13. Oprydning: annullerede auktioner beholder ikke en pause
-- =====================================================================
-- Den tidligere udgave lod pause-felterne stå på en annulleret auktion (til
-- en senere genåbning). Triggeren lukker pausen (annulleret_kl).
update public.auctions
   set pauset_kl = null, pause_resterende = null
 where status = 'annulleret' and pauset_kl is not null;

update public.auktion_pauser p
   set annulleret_kl = now()
  from public.auctions a
 where a.id = p.auction_id and a.status = 'annulleret'
   and p.genoptaget_kl is null and p.annulleret_kl is null;
