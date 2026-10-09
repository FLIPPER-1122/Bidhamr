-- MitID-verificering via Idura Verify (tidligere Criipto). Fase 6 i ROADMAP.md.
--
-- Regler: ROADMAP-BESLUTNINGER.md, "MitID (Filip, 9. okt. 2026)":
--   - Man kan oprette konto og kigge uden MitID. MitID kræves FØR første bud
--     (også maksimum/automatisk bud) og FØR første auktion (opret, sæt op
--     igen/genopsæt, tilbud til næste byder). Håndhæves HER i databasen, så
--     det også gælder appen. Fejlkode BHV01 ('mitid_mangler: …').
--   - Én MitID = én konto: kun en HMAC-hash (serverens hemmelige nøgle,
--     MITID_HASH_NOEGLE) af MitIDs Person-ID (claim "uuid") gemmes - aldrig
--     CPR. Unik pr. aktiv verificering.
--   - 18 år (fødselsdato fra MitID).
--   - Navnet fra MitID er juridisk navn og bruges kun internt (handler,
--     fakturaer, DAC7). Kun brugeren selv og staff (og service_role) kan læse
--     det. Offentligt: users.mitid_verificeret_kl (mærket "MitID-verificeret").
--   - Eksisterende brugere verificerer sig næste gang, de byder/sælger.
--   - Erhvervskonti (users.konto_type = 'erhverv') er undtaget.
--
-- Indhold:
--   1. users.mitid_verificeret_kl (offentlig, kun service_role/definer kan sætte den)
--   2. mitid_verificeringer  - verificeringer (historik; slettes aldrig)
--      mitid_forsoeg         - afviste forsøg (dobbeltkonto, lukket konto,
--                              under 18) + genbrug efter kontosletning, til staff
--      mitid_flow            - kortlivede login-flows (state/nonce/PKCE), kun service_role
--   3. mitid_kraev() + triggere på bids, bud_maksimum, auctions og andenchance_tilbud
--   4. mitid_registrer()  (callback, kun service_role)
--      mitid_nulstil()    (staff via service_role, admin+, inhabilitet, moderation_log)
--   5. Kontosletning: hash bevares; navn/fødselsdato kun, hvis der er handler
--   6. mine_data() får MitID-oplysningerne med (GDPR)
--
-- CHEFENS VALG (til Filips godkendelse):
--   - Maksimumbud sat FØR denne migration fortsætter (automatiske bud,
--     bids.automatisk) - byderen bød før reglen. Nye/ændrede maksimum kræver MitID.
--   - Svar på "tilbud til næste byder" (andenchance_svar) kræver ikke MitID:
--     byderen har allerede budt. Kun sælgerens tilbud kræver det.
--   - Fødselsdatoen gemmes (internt, som navnet), fordi DAC7 kræver
--     fødselsdato på private sælgere.
--   - Ved kontosletning bevares hashen (så en lukket svindler ikke kan få en
--     ny konto, og så staff kan se, at en ny konto er samme person som en
--     slettet). Navn og fødselsdato bevares kun, hvis brugeren har handler
--     (handelsdata), ellers slettes de.
--   - Nulstilling kræver admin eller chef (den frigiver MitID'en til en
--     anden konto). Lukkede konti kan ikke nulstilles.
--
-- Idempotent: kan køres igen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælper: flet værdier ind i en eksisterende CHECK (som 20261010030000).
-- ---------------------------------------------------------------------------
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['mitid_nulstillet', 'mitid_forsoeg_behandlet']);

-- ---------------------------------------------------------------------------
-- 1. users.mitid_verificeret_kl
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists mitid_verificeret_kl timestamptz;

-- Offentlig (mærket "MitID-verificeret" på profil og auktion) - som konto_type.
grant select (mitid_verificeret_kl) on public.users to anon, authenticated;

-- Kun service_role/postgres (og security definer-funktionerne nedenfor, der
-- kører som postgres) kan sætte den. En ny række fra appen starter altid uden.
create or replace function public.users_beskyt_mitid()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.mitid_verificeret_kl := null;
  elsif new.mitid_verificeret_kl is distinct from old.mitid_verificeret_kl then
    raise exception 'Du må ikke ændre denne oplysning.' using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.users_beskyt_mitid() from public, anon, authenticated;

drop trigger if exists users_beskyt_mitid on public.users;
create trigger users_beskyt_mitid
  before insert or update of mitid_verificeret_kl on public.users
  for each row execute function public.users_beskyt_mitid();

-- ---------------------------------------------------------------------------
-- 2a. mitid_verificeringer
-- ---------------------------------------------------------------------------
create table if not exists public.mitid_verificeringer (
  id              uuid primary key default gen_random_uuid(),
  bruger_id       uuid not null references public.users(id),
  -- HMAC-SHA256 (hex) af MitIDs Person-ID med serverens hemmelige nøgle.
  id_hash         text not null check (id_hash ~ '^[0-9a-f]{64}$'),
  -- Juridisk navn fra MitID (kun internt). Kan blive null ved kontosletning.
  juridisk_navn   text check (juridisk_navn is null or char_length(juridisk_navn) between 1 and 300),
  foedselsdato    date,
  status          text not null default 'aktiv' check (status in ('aktiv', 'nulstillet', 'slettet')),
  verificeret_kl  timestamptz not null default now(),
  nulstillet_kl   timestamptz,
  nulstillet_af   uuid references public.users(id),
  nulstil_aarsag  text check (nulstil_aarsag is null or char_length(nulstil_aarsag) <= 1000),
  slettet_kl      timestamptz
);

-- Én MitID = én aktiv konto, og højst én aktiv verificering pr. konto.
create unique index if not exists mitid_verificeringer_hash_aktiv
  on public.mitid_verificeringer (id_hash) where status = 'aktiv';
create unique index if not exists mitid_verificeringer_bruger_aktiv
  on public.mitid_verificeringer (bruger_id) where status = 'aktiv';
create index if not exists mitid_verificeringer_hash on public.mitid_verificeringer (id_hash);
create index if not exists mitid_verificeringer_bruger on public.mitid_verificeringer (bruger_id);

alter table public.mitid_verificeringer enable row level security;

revoke all on public.mitid_verificeringer from public, anon, authenticated;
-- Brugeren selv (og staff) kan læse - aldrig hashen.
grant select (id, bruger_id, juridisk_navn, foedselsdato, status, verificeret_kl)
  on public.mitid_verificeringer to authenticated;

drop policy if exists mitid_verificeringer_laes on public.mitid_verificeringer;
create policy mitid_verificeringer_laes on public.mitid_verificeringer
  for select to authenticated
  using (bruger_id = (select auth.uid()) or (select public.er_staff()));

-- Slettes aldrig (handelsdata/DAC7 og svindelværn).
create or replace function public.mitid_ingen_sletning()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'MitID-verificeringer kan ikke slettes.' using errcode = '42501';
end $$;

revoke all on function public.mitid_ingen_sletning() from public, anon, authenticated;

drop trigger if exists mitid_verificeringer_ingen_sletning on public.mitid_verificeringer;
create trigger mitid_verificeringer_ingen_sletning
  before delete on public.mitid_verificeringer
  for each row execute function public.mitid_ingen_sletning();
drop trigger if exists mitid_verificeringer_ingen_truncate on public.mitid_verificeringer;
create trigger mitid_verificeringer_ingen_truncate
  before truncate on public.mitid_verificeringer
  for each statement execute function public.mitid_ingen_sletning();

-- ---------------------------------------------------------------------------
-- 2b. mitid_forsoeg: afviste forsøg og genbrug efter sletning (kun staff via
--     service_role). Ingen persondata fra MitID - kun hvilke konti og hvorfor.
-- ---------------------------------------------------------------------------
create table if not exists public.mitid_forsoeg (
  id               uuid primary key default gen_random_uuid(),
  bruger_id        uuid not null references public.users(id),
  aarsag           text not null check (aarsag in ('dobbeltkonto', 'lukket_konto', 'under_18', 'tidligere_slettet')),
  -- Den anden konto, som MitID'en allerede hører til (dobbeltkonto, lukket
  -- konto, tidligere slettet).
  anden_bruger_id  uuid references public.users(id),
  oprettet_kl      timestamptz not null default now(),
  behandlet_kl     timestamptz,
  behandlet_af     uuid references public.users(id)
);

create index if not exists mitid_forsoeg_bruger on public.mitid_forsoeg (bruger_id, oprettet_kl desc);
create index if not exists mitid_forsoeg_aabne on public.mitid_forsoeg (oprettet_kl desc) where behandlet_kl is null;

alter table public.mitid_forsoeg enable row level security;
revoke all on public.mitid_forsoeg from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2c. mitid_flow: ét login-forløb (state, nonce, PKCE-verifier). Kun
--     service_role. state og appens engangs-token gemmes kun som SHA-256.
-- ---------------------------------------------------------------------------
create table if not exists public.mitid_flow (
  id               uuid primary key default gen_random_uuid(),
  bruger_id        uuid not null references public.users(id),
  state_hash       text unique check (state_hash is null or state_hash ~ '^[0-9a-f]{64}$'),
  nonce            text,
  code_verifier    text,
  -- Intern sti, der vendes tilbage til (hjemmesiden). Null for appen.
  retur            text check (retur is null or (char_length(retur) <= 500 and retur like '/%' and retur not like '//%')),
  app              boolean not null default false,
  -- Appens engangs-token (SHA-256), indløses af /api/mitid/start?t=…
  starttoken_hash  text unique check (starttoken_hash is null or starttoken_hash ~ '^[0-9a-f]{64}$'),
  oprettet_kl      timestamptz not null default now(),
  udloeber_kl      timestamptz not null,
  startet_kl       timestamptz,
  brugt_kl         timestamptz
);

create index if not exists mitid_flow_udloeber on public.mitid_flow (udloeber_kl);

alter table public.mitid_flow enable row level security;
revoke all on public.mitid_flow from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Håndhævelse
-- ---------------------------------------------------------------------------
create or replace function public.mitid_er_verificeret(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users u
     where u.id = p_bruger
       and (u.konto_type = 'erhverv' or u.mitid_verificeret_kl is not null));
$$;

revoke all on function public.mitid_er_verificeret(uuid) from public, anon, authenticated;

create or replace function public.mitid_kraev(p_bruger uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return;
  end if;
  if exists (select 1 from public.users u
              where u.id = p_bruger
                and u.konto_type is distinct from 'erhverv'
                and u.mitid_verificeret_kl is null) then
    raise exception 'mitid_mangler: Bekræft dig med MitID, før du byder eller sætter varer til salg. Det gør du kun én gang.'
      using errcode = 'BHV01';
  end if;
end $$;

revoke all on function public.mitid_kraev(uuid) from public, anon, authenticated;

-- Bud: kun brugerens egne bud. Automatiske bud (bids.automatisk, sat af
-- autobud-motoren under auktionslåsen - a1_bids_automatisk_kun_system nulstiller
-- feltet for alle andre) springes over: maksimum er tjekket, da det blev sat.
create or replace function public.bids_mitid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(new.automatisk, false) then
    perform public.mitid_kraev(new.bruger_id);
  end if;
  return new;
end $$;

revoke all on function public.bids_mitid() from public, anon, authenticated;

-- "a3": efter låsen (a0), automatisk-feltet (a1) og firmakonto-tjekket (a2).
drop trigger if exists a3_bids_mitid on public.bids;
create trigger a3_bids_mitid
  before insert on public.bids
  for each row execute function public.bids_mitid();

-- Maksimum (automatisk bud): nyt maksimum eller ændret beløb.
create or replace function public.bud_maksimum_mitid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.maks_beloeb is distinct from old.maks_beloeb then
    perform public.mitid_kraev(new.bruger_id);
  end if;
  return new;
end $$;

revoke all on function public.bud_maksimum_mitid() from public, anon, authenticated;

drop trigger if exists a0_bud_maksimum_mitid on public.bud_maksimum;
create trigger a0_bud_maksimum_mitid
  before insert or update of maks_beloeb on public.bud_maksimum
  for each row execute function public.bud_maksimum_mitid();

-- Auktioner: ALLE nye auktioner (opret fra hjemmeside/app, genopsaet_auktion,
-- saet_annulleret_op_igen). Firmakonti er undtaget i mitid_kraev.
create or replace function public.auctions_mitid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.mitid_kraev(new.bruger_id);
  return new;
end $$;

revoke all on function public.auctions_mitid() from public, anon, authenticated;

-- "auctions_a0": før de andre tjek (udbetalingskonto, indhold …), så sælgeren
-- først bliver bedt om MitID.
drop trigger if exists auctions_a0_mitid on public.auctions;
create trigger auctions_a0_mitid
  before insert on public.auctions
  for each row execute function public.auctions_mitid();

-- Tilbud til næste byder (andenchance_opret): sælgeren sælger.
create or replace function public.andenchance_mitid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.mitid_kraev(new.seller_id);
  return new;
end $$;

revoke all on function public.andenchance_mitid() from public, anon, authenticated;

drop trigger if exists a0_andenchance_mitid on public.andenchance_tilbud;
create trigger a0_andenchance_mitid
  before insert on public.andenchance_tilbud
  for each row execute function public.andenchance_mitid();

-- ---------------------------------------------------------------------------
-- 4a. mitid_registrer: kaldes af /api/mitid/callback (service_role), når
--     id_token er verificeret. Afgør alle regler i én transaktion.
--     Returnerer {kode}: ok | allerede | dobbeltkonto | lukket_konto |
--     under_18 | erhverv | ugyldig_bruger | ugyldig
-- ---------------------------------------------------------------------------
create or replace function public.mitid_registrer(
  p_bruger uuid,
  p_hash text,
  p_navn text,
  p_foedselsdato date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  u          record;
  v_navn     text := nullif(btrim(coalesce(p_navn, '')), '');
  v_idag     date := (now() at time zone 'Europe/Copenhagen')::date;
  v_anden    uuid;
  v_eksist   record;
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_foedselsdato is null
     or p_foedselsdato > v_idag or p_foedselsdato < date '1900-01-01' then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if v_navn is not null and char_length(v_navn) > 300 then
    v_navn := left(v_navn, 300);
  end if;

  select id, konto_type, konto_lukket_kl, konto_slettet_kl, mitid_verificeret_kl
    into u from public.users where id = p_bruger for update;
  if not found or u.konto_slettet_kl is not null then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'lukket_konto');
  end if;
  if u.konto_type = 'erhverv' then
    return jsonb_build_object('kode', 'erhverv');
  end if;

  -- Samme MitID på flere konti på én gang: lås pr. hash.
  perform pg_advisory_xact_lock(hashtextextended('mitid:' || p_hash, 0));

  -- Allerede verificeret på denne konto?
  select id, id_hash into v_eksist from public.mitid_verificeringer
   where bruger_id = p_bruger and status = 'aktiv';
  if found then
    if v_eksist.id_hash = p_hash then
      if u.mitid_verificeret_kl is null then
        update public.users set mitid_verificeret_kl = now() where id = p_bruger;
      end if;
      return jsonb_build_object('kode', 'allerede');
    end if;
    -- En anden MitID end den, kontoen er verificeret med.
    return jsonb_build_object('kode', 'anden_mitid');
  end if;

  -- 18 år.
  if (p_foedselsdato + interval '18 years')::date > v_idag then
    insert into public.mitid_forsoeg (bruger_id, aarsag) values (p_bruger, 'under_18');
    return jsonb_build_object('kode', 'under_18');
  end if;

  -- MitID'en hører til en permanent lukket konto (uanset status).
  select v.bruger_id into v_anden
    from public.mitid_verificeringer v
    join public.users x on x.id = v.bruger_id
   where v.id_hash = p_hash and v.bruger_id <> p_bruger and x.konto_lukket_kl is not null
   order by v.verificeret_kl desc
   limit 1;
  if v_anden is not null then
    insert into public.mitid_forsoeg (bruger_id, aarsag, anden_bruger_id)
    values (p_bruger, 'lukket_konto', v_anden);
    return jsonb_build_object('kode', 'lukket_konto_mitid');
  end if;

  -- Én MitID = én konto.
  select v.bruger_id into v_anden
    from public.mitid_verificeringer v
   where v.id_hash = p_hash and v.status = 'aktiv' and v.bruger_id <> p_bruger
   limit 1;
  if v_anden is not null then
    insert into public.mitid_forsoeg (bruger_id, aarsag, anden_bruger_id)
    values (p_bruger, 'dobbeltkonto', v_anden);
    return jsonb_build_object('kode', 'dobbeltkonto');
  end if;

  -- Tilladt, men staff får besked: samme person har haft en konto, der er slettet.
  select v.bruger_id into v_anden
    from public.mitid_verificeringer v
   where v.id_hash = p_hash and v.status = 'slettet' and v.bruger_id <> p_bruger
   order by v.verificeret_kl desc
   limit 1;
  if v_anden is not null then
    insert into public.mitid_forsoeg (bruger_id, aarsag, anden_bruger_id)
    values (p_bruger, 'tidligere_slettet', v_anden);
  end if;

  insert into public.mitid_verificeringer (bruger_id, id_hash, juridisk_navn, foedselsdato)
  values (p_bruger, p_hash, v_navn, p_foedselsdato);

  update public.users set mitid_verificeret_kl = now() where id = p_bruger;

  return jsonb_build_object('kode', 'ok');
exception
  when unique_violation then
    -- To samtidige forløb: det unikke index afgør det.
    return jsonb_build_object('kode', 'dobbeltkonto');
end $$;

revoke all on function public.mitid_registrer(uuid, text, text, date) from public, anon, authenticated;
grant execute on function public.mitid_registrer(uuid, text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 4b. mitid_nulstil: staff nulstiller en brugers verificering (fx forkert
--     person). Brugeren skal verificere sig igen, og MitID'en frigives.
--     Kun admin/chef, ikke sig selv, ikke en, man har handlet med, ikke en
--     lukket konto. Staff-konti kun af chef. Logges i moderation_log.
-- ---------------------------------------------------------------------------
create or replace function public.mitid_nulstil(p_staff uuid, p_bruger uuid, p_aarsag text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_aarsag text := nullif(btrim(coalesce(p_aarsag, '')), '');
  u        record;
  v_antal  integer;
begin
  if not public.staff_chat_har_rolle(p_staff, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_aarsag is null or char_length(v_aarsag) < 5 then
    return jsonb_build_object('kode', 'aarsag_mangler');
  end if;
  if char_length(v_aarsag) > 1000 then
    return jsonb_build_object('kode', 'aarsag_for_lang');
  end if;
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_staff then
    return jsonb_build_object('kode', 'sig_selv');
  end if;

  select id, rolle, konto_lukket_kl, konto_slettet_kl into u
    from public.users where id = p_bruger for update;
  if not found or u.konto_slettet_kl is not null then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'lukket');
  end if;
  if u.rolle in ('medarbejder', 'admin', 'chef', 'saelger')
     and not public.staff_chat_har_rolle(p_staff, 'chef') then
    return jsonb_build_object('kode', 'staff');
  end if;
  if public.dsa_er_inhabil(p_staff, p_bruger) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.mitid_verificeringer
     set status = 'nulstillet', nulstillet_kl = now(), nulstillet_af = p_staff, nulstil_aarsag = v_aarsag
   where bruger_id = p_bruger and status = 'aktiv';
  get diagnostics v_antal = row_count;

  if v_antal = 0 then
    return jsonb_build_object('kode', 'ikke_verificeret');
  end if;

  update public.users set mitid_verificeret_kl = null where id = p_bruger;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'mitid_nulstillet', 'bruger', p_bruger, p_bruger, left(v_aarsag, 4000));

  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.mitid_nulstil(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mitid_nulstil(uuid, uuid, text) to service_role;

-- Staff markerer et forsøg som set/behandlet (listen på Mistænkelig aktivitet).
create or replace function public.mitid_forsoeg_behandl(p_staff uuid, p_forsoeg uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bruger uuid;
begin
  if not public.staff_chat_har_rolle(p_staff, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  update public.mitid_forsoeg
     set behandlet_kl = now(), behandlet_af = p_staff
   where id = p_forsoeg and behandlet_kl is null
  returning bruger_id into v_bruger;
  if v_bruger is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'mitid_forsoeg_behandlet', 'bruger', v_bruger, v_bruger, 'MitID-forsøg gennemgået');
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.mitid_forsoeg_behandl(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mitid_forsoeg_behandl(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Kontosletning (konto_slet sætter users.konto_slettet_kl).
--    Hashen bevares (status 'slettet'): en lukket konto kan aldrig få en ny
--    konto verificeret, og staff ser, når en slettet bruger kommer igen.
--    Navn og fødselsdato bevares kun som handelsdata, hvis brugeren har
--    handler (køber eller sælger) - ellers slettes de.
-- ---------------------------------------------------------------------------
create or replace function public.users_mitid_ved_sletning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handler boolean;
begin
  if old.konto_slettet_kl is null and new.konto_slettet_kl is not null then
    v_handler := exists (select 1 from public.trades t where t.buyer_id = new.id or t.seller_id = new.id);
    update public.mitid_verificeringer
       set status = case when status = 'aktiv' then 'slettet' else status end,
           slettet_kl = coalesce(slettet_kl, now()),
           juridisk_navn = case when v_handler then juridisk_navn else null end,
           foedselsdato  = case when v_handler then foedselsdato else null end
     where bruger_id = new.id;
    new.mitid_verificeret_kl := null;
  end if;
  return new;
end $$;

revoke all on function public.users_mitid_ved_sletning() from public, anon, authenticated;

drop trigger if exists users_mitid_ved_sletning on public.users;
create trigger users_mitid_ved_sletning
  before update of konto_slettet_kl on public.users
  for each row execute function public.users_mitid_ved_sletning();

-- ---------------------------------------------------------------------------
-- 6. mine_data(): MitID-oplysningerne med i "Download dine data".
--    Den eksisterende funktion omdøbes én gang til mine_data_grund og kaldes
--    herfra (rate limit og indhold uændret). NB: ændres mine_data senere, så
--    ret mine_data_grund - eller behold "mitid" i en ny mine_data.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'mine_data_grund') then
    alter function public.mine_data() rename to mine_data_grund;
  end if;
end $$;

revoke all on function public.mine_data_grund() from public, anon, authenticated;

create or replace function public.mine_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v     jsonb;
begin
  v := public.mine_data_grund();
  return v || jsonb_build_object('mitid', jsonb_build_object(
    'verificeret_kl', (select u.mitid_verificeret_kl from public.users u where u.id = v_uid),
    'verificeringer', coalesce((
      select jsonb_agg(jsonb_build_object(
               'status', m.status,
               'juridisk_navn', m.juridisk_navn,
               'foedselsdato', m.foedselsdato,
               'verificeret_kl', m.verificeret_kl,
               'nulstillet_kl', m.nulstillet_kl) order by m.verificeret_kl)
        from public.mitid_verificeringer m where m.bruger_id = v_uid), '[]'::jsonb),
    'note', 'Vi gemmer ikke dit CPR-nummer. Dit MitID-id gemmes kun sløret (hash), så samme MitID ikke kan bruges til flere konti.'));
end $$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Admin: liste over åbne MitID-forsøg (Mistænkelig aktivitet). service_role.
-- ---------------------------------------------------------------------------
create or replace function public.admin_mitid_forsoeg()
returns table (
  id uuid,
  aarsag text,
  oprettet_kl timestamptz,
  bruger_id uuid,
  bruger_navn text,
  bruger_email text,
  anden_bruger_id uuid,
  anden_navn text,
  anden_email text,
  anden_lukket boolean,
  anden_slettet boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.aarsag, f.oprettet_kl,
         f.bruger_id, u.navn, u.email,
         f.anden_bruger_id, a.navn, a.email,
         a.konto_lukket_kl is not null, a.konto_slettet_kl is not null
    from public.mitid_forsoeg f
    join public.users u on u.id = f.bruger_id
    left join public.users a on a.id = f.anden_bruger_id
   where f.behandlet_kl is null
     and f.aarsag in ('dobbeltkonto', 'lukket_konto', 'tidligere_slettet')
   order by f.oprettet_kl desc
   limit 200;
$$;

revoke all on function public.admin_mitid_forsoeg() from public, anon, authenticated;
grant execute on function public.admin_mitid_forsoeg() to service_role;

-- Oprydning af gamle login-forløb (ikke handelsdata) - kaldes fra /api/mitid/start.
create or replace function public.mitid_flow_oprydning()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.mitid_flow where udloeber_kl < now() - interval '1 day';
$$;

revoke all on function public.mitid_flow_oprydning() from public, anon, authenticated;
grant execute on function public.mitid_flow_oprydning() to service_role;
