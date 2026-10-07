-- Ophævelse af afgørelser på en auktion: inhabilitet og "klage først" i
-- databasen (rettelse til 20261009070000_ophaev_fjernelse.sql).
--
-- KØRES I PRODUKTION EFTER 20261009070000 (og på testdatabasen).
-- Idempotent: kan køres flere gange.
--
-- 1. Ny funktion dsa_ophaev_auktion_afgoerelser(p_staff, p_auktion,
--    p_rapport, p_rapport_status) - kun service_role. Bruges af hjemmesidens
--    "Vis igen"/"Ophæv fjernelse"/"Ophæv skjulning" og genåbning af en
--    rapport. I én transaktion:
--      - kræver admin (som resten af auktions-moderationen),
--      - låser auktionen og dens gældende afgørelser (for update),
--      - afviser med 'inhabil', hvis medarbejderen er sælgeren eller har
--        handlet med sælgeren (dsa_er_inhabil),
--      - afviser med 'klage_afventer', hvis en klage afventer over en gældende
--        afgørelse på auktionen, over den anmeldelse, afgørelsen bygger på,
--        eller over en anmeldelse af auktionen (så klagen afgøres først, og
--        sælger/anmelder får ét svar),
--      - genåbner evt. rapporten (betinget af dens status, så et dobbeltklik
--        eller den automatiske arkivering ikke giver dobbelt effekt),
--      - annulleret auktion: ophæver de gældende afgørelser (auktionen
--        forbliver annulleret og skjult) og returnerer, hvilke typer der blev
--        ophævet; ellers gøres den skjulte auktion synlig igen (triggerne
--        auctions_pause_skjult og auctions_dsa_ophaevet klarer pause og
--        afgørelser).
--
-- 2. auctions_pause_skjult: når skjult ændres direkte på en annulleret
--    auktion (fx fra appen eller SQL), ophæves en afgørelse med en afventende
--    klage ikke. Auktionen forbliver skjult og annulleret som hidtil.

set lock_timeout = '5s';

-- 1 ---------------------------------------------------------------------------

create or replace function public.dsa_ophaev_auktion_afgoerelser(
  p_staff uuid,
  p_auktion uuid,
  p_rapport uuid default null,
  p_rapport_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  a            record;
  v_ophaevet   text[] := '{}';
  v_fjernelse  uuid;
  v_vist       boolean := false;
  v_rapport_ok boolean;
begin
  if p_staff is null or not public.staff_chat_har_rolle(p_staff, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  select au.id, au.bruger_id, au.skjult, au.status
    into a
    from public.auctions au
   where au.id = p_auktion
   for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Inhabil: egen auktion eller en sælger, man har handlet med.
  if a.bruger_id = p_staff or public.dsa_er_inhabil(p_staff, a.bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- De gældende afgørelser låses, så en samtidig klage-afgørelse eller et
  -- dobbeltklik venter på denne transaktion.
  perform 1
    from public.dsa_afgoerelser af
   where af.indhold_type = 'auktion' and af.indhold_id = p_auktion
     and af.ophaevet_kl is null
   for update;

  -- Klage først.
  if exists (
    select 1
      from public.dsa_klager k
     where k.status = 'afventer'
       and (
         k.afgoerelse_id in (
           select af.id from public.dsa_afgoerelser af
            where af.indhold_type = 'auktion' and af.indhold_id = p_auktion
              and af.ophaevet_kl is null)
         or k.anmeldelse_id in (
           select af.anmeldelse_id from public.dsa_afgoerelser af
            where af.indhold_type = 'auktion' and af.indhold_id = p_auktion
              and af.ophaevet_kl is null and af.anmeldelse_id is not null)
         or k.anmeldelse_id in (
           select an.id from public.dsa_anmeldelser an
            where an.indhold_type = 'auktion' and an.indhold_id = p_auktion)
       )
  ) then
    return jsonb_build_object('kode', 'klage_afventer');
  end if;

  -- Rapporten genåbnes i samme transaktion, før opslaget ændres.
  if p_rapport is not null then
    update public.reports
       set status = 'pending', handled_by = null, handled_note = null, handled_at = null
     where id = p_rapport and auction_id = p_auktion and status = p_rapport_status;
    v_rapport_ok := found;
    if not v_rapport_ok then
      if exists (select 1 from public.reports r where r.id = p_rapport) then
        return jsonb_build_object('kode', 'rapport_aendret');
      end if;
      return jsonb_build_object('kode', 'rapport_arkiveret');
    end if;
  end if;

  if not coalesce(a.skjult, false) then
    return jsonb_build_object('kode', 'ok', 'ophaevet', to_jsonb(v_ophaevet), 'vist', false);
  end if;

  if a.status = 'annulleret' then
    -- Auktionen åbnes aldrig igen og forbliver skjult (Filip, 6. okt. 2026).
    with o as (
      update public.dsa_afgoerelser af
         set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where af.indhold_type = 'auktion' and af.indhold_id = p_auktion
         and af.handling in ('auktion_fjernet', 'auktion_annulleret', 'auktion_skjult')
         and af.ophaevet_kl is null
      returning af.id, af.handling, af.oprettet_kl
    )
    select coalesce(array_agg(distinct o.handling), '{}'),
           (select o2.id from o o2
             where o2.handling in ('auktion_fjernet', 'auktion_annulleret')
             order by o2.oprettet_kl desc limit 1)
      into v_ophaevet, v_fjernelse
      from o;
  else
    update public.auctions set skjult = false where id = p_auktion and skjult;
    v_vist := found;
  end if;

  return jsonb_build_object(
    'kode', 'ok',
    'ophaevet', to_jsonb(v_ophaevet),
    'fjernelse_id', v_fjernelse,
    'vist', v_vist
  );
end;
$fn$;

revoke all on function public.dsa_ophaev_auktion_afgoerelser(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.dsa_ophaev_auktion_afgoerelser(uuid, uuid, uuid, text) to service_role;

-- 2 ---------------------------------------------------------------------------
-- Komplet udgave fra 20261009070000 + "klage først" i ophævelsen.

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
    -- En fjernet (annulleret) auktion bliver aldrig offentligt synlig igen -
    -- heller ikke ved "Vis igen", medhold eller en genåbnet rapport (Filip,
    -- 6. okt. 2026). Den forbliver skjult (kun sælger, deltagere og staff kan
    -- se den), og afgørelserne ophæves i stedet, så sælgeren kan sætte varen
    -- op igen med ét klik. Også en "Auktion skjult"-afgørelse ophæves - fx
    -- når sælgeren selv annullerede, og staff derefter skjulte auktionen.
    -- Klage først: en afgørelse med en afventende klage ophæves ikke her -
    -- klagen afgøres først (dsa_klage_afgoer ophæver selv med grunden
    -- 'klage', før den kommer hertil).
    if coalesce(old.skjult, false) and not coalesce(new.skjult, false) then
      new.skjult := true;
      update public.dsa_afgoerelser af
         set ophaevet_kl = now(), ophaevet_grund = 'staff'
       where af.indhold_type = 'auktion' and af.indhold_id = new.id
         and af.handling in ('auktion_fjernet', 'auktion_annulleret', 'auktion_skjult')
         and af.ophaevet_kl is null
         and not exists (
           select 1 from public.dsa_klager k
            where k.status = 'afventer'
              and (k.afgoerelse_id = af.id
                   or (af.anmeldelse_id is not null and k.anmeldelse_id = af.anmeldelse_id)));
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

-- Triggeren genskabes, så den også findes, hvis den mangler.
drop trigger if exists auctions_pause_skjult on public.auctions;
create trigger auctions_pause_skjult
  before update on public.auctions
  for each row execute function public.auctions_pause_skjult();
