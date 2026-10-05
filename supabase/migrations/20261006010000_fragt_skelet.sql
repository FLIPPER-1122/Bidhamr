-- Fragt-skelet (ROADMAP fase 2: "Byg koden, saa fragtfirmaet kan skiftes (GLS
-- nu, evt. Shipmondo senere) uden at omskrive handelsflowet").
--
-- Koden taler med fragtfirmaet gennem en adapter (src/lib/fragt/). Databasen
-- kender kun normaliserede forsendelser og haendelser - aldrig GLS- eller
-- Shipmondo-specifikke felter. Indtil der er adgang til GLS, bruges et
-- fiktivt testfragtfirma ('test'), hvis sporing styres af fragt_test_sporing.
--
-- Ingen pengeflytning: intet her roerer betalinger, frigivelse, refusion eller
-- 48-timers uret. Fragtprisen (pris_oere) er fragtfirmaets pris til BidHamr -
-- IKKE det, koeberen betaler (det er fortsat fast 35 kr, se betalingskoden).
--
-- Indhold:
--   1. forsendelser: en pakke hos et fragtfirma (udgaaende fra saelger, eller
--      retur fra koeber i en sag). Hoejst en aktiv af hver type pr. handel.
--   2. forsendelse_haendelser: normaliserede sporingshaendelser. Idempotent
--      via (forsendelse_id, noegle). raa er begraenset til 4 KB.
--   3. fragt_test_sporing: testfragtfirmaets "sporingssystem" (kun service_role).
--   4. Ingen sletning: handelsdata (bogfoeringsloven/DAC7). Haendelser kan
--      heller ikke aendres (bevis i sager).
--   5. RLS: koeber og saelger paa handlen (og staff) kan laese forsendelser og
--      haendelser. Kun service_role skriver.
--   6. Privat bucket 'fragt-labels' (PDF). Laesning: saelgeren (udgaaende),
--      koeberen (retur) og staff. Kun service_role uploader.
--   7. Funktioner (alle kun service_role - serveren har allerede tjekket
--      brugeren med auth, og funktionerne tjekker det igen under laas):
--        forsendelse_claim, forsendelse_gem_oprettet, forsendelse_marker_fejlet,
--        forsendelse_annuller, forsendelse_registrer_haendelse,
--        forsendelse_marker_besked.
--
-- Idempotent: kan koeres flere gange.

-- ============================================================ 1. forsendelser

create table if not exists public.forsendelser (
  id                      uuid primary key default gen_random_uuid(),
  trade_id                uuid not null references public.trades(id) on delete restrict,
  type                    text not null default 'udgaaende',
  fragtfirma              text not null,
  -- opretter: claimet, fragtfirmaet kaldes. fejlet: oprettelsen fejlede.
  -- oprettet .. returneret: seneste sporingsstatus. annulleret: labelen er
  -- annulleret hos fragtfirmaet, foer pakken blev afleveret.
  status                  text not null default 'opretter',
  pakkestoerrelse         text not null,
  -- Fragtfirmaets pris til BidHamr (omkostning) - ikke koeberens fragt.
  pris_oere               integer,
  forsendelses_id         text,
  sporingsnummer          text,
  -- Sti i bucket 'fragt-labels': <handel-id>/<forsendelse-id>.pdf
  label_sti               text,
  -- Kode til QR/indlevering uden printer (hvis fragtfirmaet giver en).
  qr_kode                 text,
  oprettet_af             uuid references public.users(id) on delete set null,
  oprettet_kl             timestamptz not null default now(),
  opdateret_kl            timestamptz not null default now(),
  afleveret_kl            timestamptz,
  klar_til_afhentning_kl  timestamptz,
  leveret_kl              timestamptz,
  returneret_kl           timestamptz,
  annulleret_kl           timestamptz,
  sidste_haendelse_kl     timestamptz,
  -- Sporings-cron: hvornaar sporingen sidst blev hentet.
  sidst_polled_kl         timestamptz,
  -- Beskeder til koeber/saelger er sendt (idempotens + genforsoeg i cron).
  afleveret_besked_kl     timestamptz,
  leveret_besked_kl       timestamptz,
  -- Staff skal kigge paa forsendelsen (returneret, fejl, leveret uden
  -- "sendt" osv.). Tekst til staff - aldrig vist til brugerne.
  kraever_opmaerksomhed   boolean not null default false,
  opmaerksomhed_tekst     text,
  fejl                    text,
  constraint forsendelser_type_check check (type in ('udgaaende', 'retur')),
  constraint forsendelser_fragtfirma_check check (fragtfirma in ('test', 'gls', 'shipmondo')),
  constraint forsendelser_status_check check (status in (
    'opretter', 'oprettet', 'afleveret', 'i_transit', 'klar_til_afhentning',
    'leveret', 'returneret', 'annulleret', 'fejlet')),
  constraint forsendelser_stoerrelse_check check (pakkestoerrelse in ('lille', 'mellem', 'stor')),
  constraint forsendelser_pris_check check (pris_oere is null or pris_oere between 0 and 10000000),
  constraint forsendelser_tekst_check check (
        char_length(coalesce(forsendelses_id, '')) <= 200
    and char_length(coalesce(sporingsnummer, '')) <= 100
    and char_length(coalesce(label_sti, '')) <= 200
    and char_length(coalesce(qr_kode, '')) <= 500
    and char_length(coalesce(opmaerksomhed_tekst, '')) <= 1000
    and char_length(coalesce(fejl, '')) <= 500)
);

comment on table public.forsendelser is
  'Pakker hos et fragtfirma (adapter i src/lib/fragt). Udgaaende fra saelger '
  'eller retur fra koeber i en sag. Slettes aldrig (handelsdata).';

create unique index if not exists forsendelser_aktiv_uniq
  on public.forsendelser (trade_id, type)
  where status not in ('annulleret', 'fejlet');
create unique index if not exists forsendelser_firma_id_uniq
  on public.forsendelser (fragtfirma, forsendelses_id)
  where forsendelses_id is not null;
create index if not exists forsendelser_sporing_idx
  on public.forsendelser (fragtfirma, sporingsnummer)
  where sporingsnummer is not null;
create index if not exists forsendelser_trade_idx
  on public.forsendelser (trade_id, oprettet_kl desc);
-- Sporings-cron: aktive forsendelser, mindst nyligt hentede foerst.
create index if not exists forsendelser_aktive_idx
  on public.forsendelser (sidst_polled_kl nulls first)
  where status in ('oprettet', 'afleveret', 'i_transit', 'klar_til_afhentning');
create index if not exists forsendelser_opmaerksomhed_idx
  on public.forsendelser (opdateret_kl desc)
  where kraever_opmaerksomhed;

alter table public.forsendelser enable row level security;

drop policy if exists forsendelser_select_parter on public.forsendelser;
create policy forsendelser_select_parter on public.forsendelser
  for select to authenticated using (
    public.er_staff()
    or exists (select 1 from public.trades t
                where t.id = forsendelser.trade_id
                  and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );

-- Kun de kolonner, parterne har brug for. pris_oere (BidHamrs omkostning),
-- forsendelses_id, oprettet_af og staff-felterne er skjult.
revoke all on public.forsendelser from public, anon, authenticated;
grant select (id, trade_id, type, fragtfirma, status, pakkestoerrelse,
              sporingsnummer, label_sti, qr_kode, oprettet_kl, afleveret_kl,
              klar_til_afhentning_kl, leveret_kl, returneret_kl, annulleret_kl,
              sidste_haendelse_kl)
  on public.forsendelser to authenticated;
grant all on public.forsendelser to service_role;

-- ============================================================ 2. haendelser

create table if not exists public.forsendelse_haendelser (
  id              uuid primary key default gen_random_uuid(),
  forsendelse_id  uuid not null references public.forsendelser(id) on delete restrict,
  type            text not null,
  tidspunkt       timestamptz not null,
  -- Idempotensnoegle fra adapteren (fragtfirmaets haendelses-id, eller
  -- type + tidspunkt). Samme haendelse via webhook og sporing giver samme noegle.
  noegle          text not null,
  beskrivelse     text,
  kilde           text not null,
  raa             jsonb,
  modtaget_kl     timestamptz not null default now(),
  constraint forsendelse_haendelser_type_check check (type in (
    'oprettet', 'afleveret', 'i_transit', 'klar_til_afhentning', 'leveret',
    'returneret', 'fejl')),
  constraint forsendelse_haendelser_kilde_check check (kilde in ('webhook', 'sporing', 'test')),
  constraint forsendelse_haendelser_tekst_check check (
        char_length(noegle) between 1 and 200
    and char_length(coalesce(beskrivelse, '')) <= 300),
  constraint forsendelse_haendelser_raa_check check (
    raa is null or (jsonb_typeof(raa) = 'object' and pg_column_size(raa) <= 4096)),
  constraint forsendelse_haendelser_uniq unique (forsendelse_id, noegle)
);

comment on table public.forsendelse_haendelser is
  'Normaliserede sporingshaendelser fra fragtfirmaet (webhook eller sporing). '
  'Kan hverken aendres eller slettes (bevis i sager).';

create index if not exists forsendelse_haendelser_tid_idx
  on public.forsendelse_haendelser (forsendelse_id, tidspunkt);

alter table public.forsendelse_haendelser enable row level security;

drop policy if exists forsendelse_haendelser_select_parter on public.forsendelse_haendelser;
create policy forsendelse_haendelser_select_parter on public.forsendelse_haendelser
  for select to authenticated using (
    public.er_staff()
    or exists (select 1 from public.forsendelser f
                 join public.trades t on t.id = f.trade_id
                where f.id = forsendelse_haendelser.forsendelse_id
                  and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );

-- raa (fragtfirmaets payload) er kun til staff/service_role.
revoke all on public.forsendelse_haendelser from public, anon, authenticated;
grant select (id, forsendelse_id, type, tidspunkt, beskrivelse)
  on public.forsendelse_haendelser to authenticated;
grant all on public.forsendelse_haendelser to service_role;

-- ============================================================ 3. testfragtfirma

-- Testfragtfirmaets sporing: /dev/fragt indsaetter raekker her for at "rykke"
-- pakken frem. hentSporing() for 'test' laeser tabellen. Ingen handelsdata.
create table if not exists public.fragt_test_sporing (
  id              uuid primary key default gen_random_uuid(),
  sporingsnummer  text not null,
  type            text not null,
  tidspunkt       timestamptz not null default now(),
  beskrivelse     text,
  constraint fragt_test_sporing_type_check check (type in (
    'oprettet', 'afleveret', 'i_transit', 'klar_til_afhentning', 'leveret',
    'returneret', 'fejl')),
  constraint fragt_test_sporing_tekst_check check (
        sporingsnummer ~ '^TEST[0-9A-Z]{1,30}$'
    and char_length(coalesce(beskrivelse, '')) <= 300)
);

create index if not exists fragt_test_sporing_idx
  on public.fragt_test_sporing (sporingsnummer, tidspunkt);

alter table public.fragt_test_sporing enable row level security;
revoke all on public.fragt_test_sporing from public, anon, authenticated;
grant all on public.fragt_test_sporing to service_role;

-- ============================================================ 4. ingen sletning

create or replace function public.forsendelser_ingen_sletning()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Forsendelser er handelsdata og kan ikke slettes.' using errcode = '42501';
end;
$fn$;
revoke execute on function public.forsendelser_ingen_sletning() from public, anon, authenticated;

drop trigger if exists forsendelser_ingen_sletning on public.forsendelser;
create trigger forsendelser_ingen_sletning
  before delete on public.forsendelser
  for each row execute function public.forsendelser_ingen_sletning();

create or replace function public.forsendelse_haendelser_ingen_aendring()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Sporingshændelser kan ikke ændres eller slettes.' using errcode = '42501';
end;
$fn$;
revoke execute on function public.forsendelse_haendelser_ingen_aendring() from public, anon, authenticated;

drop trigger if exists forsendelse_haendelser_ingen_aendring on public.forsendelse_haendelser;
create trigger forsendelse_haendelser_ingen_aendring
  before update or delete on public.forsendelse_haendelser
  for each row execute function public.forsendelse_haendelser_ingen_aendring();

-- Kerne-felter paa en forsendelse kan ikke skiftes, naar de foerst er sat
-- (handel, type, fragtfirma, og sporingsnummer/forsendelses-id/label).
create or replace function public.forsendelser_beskyt()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if new.trade_id <> old.trade_id or new.type <> old.type
     or new.fragtfirma <> old.fragtfirma or new.oprettet_kl <> old.oprettet_kl
     or (old.sporingsnummer is not null and new.sporingsnummer is distinct from old.sporingsnummer)
     or (old.forsendelses_id is not null and new.forsendelses_id is distinct from old.forsendelses_id)
     or (old.label_sti is not null and new.label_sti is distinct from old.label_sti) then
    raise exception 'Forsendelsens faste felter kan ikke ændres.' using errcode = '42501';
  end if;
  new.opdateret_kl := now();
  return new;
end;
$fn$;
revoke execute on function public.forsendelser_beskyt() from public, anon, authenticated;

drop trigger if exists forsendelser_beskyt on public.forsendelser;
create trigger forsendelser_beskyt
  before update on public.forsendelser
  for each row execute function public.forsendelser_beskyt();

-- ============================================================ 6. storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fragt-labels', 'fragt-labels', false, 5242880, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Maa den kaldende bruger laese labelen? Staff, saelgeren for en udgaaende
-- forsendelse og koeberen for en retur. Kun stier, der staar paa en forsendelse.
create or replace function public.fragt_label_maa_laese(p_sti text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null and (
       public.er_staff()
    or exists (
         select 1 from public.forsendelser f
           join public.trades t on t.id = f.trade_id
          where f.label_sti = p_sti
            and ((f.type = 'udgaaende' and t.seller_id = auth.uid())
              or (f.type = 'retur' and t.buyer_id = auth.uid())))
  );
$fn$;
revoke all on function public.fragt_label_maa_laese(text) from public, anon;
grant execute on function public.fragt_label_maa_laese(text) to authenticated;

drop policy if exists "fragt_labels_laes" on storage.objects;
create policy "fragt_labels_laes"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'fragt-labels'
    and public.fragt_label_maa_laese(name)
  );
-- Ingen insert/update/delete-policies: kun service_role uploader labels.

-- ============================================================ 7. funktioner

-- Rang for sporingsstatus: status flyttes kun fremad, saa haendelser i forkert
-- raekkefoelge (webhook + sporing) ikke ruller status tilbage.
create or replace function public.forsendelse_status_rang(p_status text)
returns integer
language sql
immutable
set search_path = public
as $fn$
  select case p_status
    when 'oprettet' then 1
    when 'afleveret' then 2
    when 'i_transit' then 3
    when 'klar_til_afhentning' then 4
    when 'leveret' then 5
    when 'returneret' then 6
    else 0 end;
$fn$;
revoke all on function public.forsendelse_status_rang(text) from public, anon, authenticated;
grant execute on function public.forsendelse_status_rang(text) to service_role;

-- Claimer en ny forsendelse (status 'opretter'), FOER fragtfirmaet kaldes, saa
-- et dobbeltklik ikke bestiller to labels. p_bruger er brugeren, serveren har
-- verificeret med auth; den tjekkes igen her under laas paa handlen.
--   udgaaende: p_bruger skal vaere saelger, handlen en forsendelseshandel i
--              status 'betaling_modtaget'.
--   retur:     p_bruger skal vaere koeber, og handlen skal have en sag i
--              'afventer_retur' med retur_kraeves.
-- Svar: {kode: 'ok', id} | {kode: 'findes', id} | {kode: 'i_gang'} |
--       {kode: 'ikke_fundet' | 'afhentning' | 'forkert_status' | 'ingen_retur' | 'ugyldig'}
-- En claim, der har staaet i 'opretter' i over 10 minutter (afbrudt kald),
-- markeres 'fejlet', og en ny claimes.
create or replace function public.forsendelse_claim(
  p_trade           uuid,
  p_bruger          uuid,
  p_type            text,
  p_fragtfirma      text,
  p_pakkestoerrelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t  record;
  f  record;
  v_id uuid;
begin
  if p_trade is null or p_bruger is null
     or p_type not in ('udgaaende', 'retur')
     or p_fragtfirma not in ('test', 'gls', 'shipmondo')
     or p_pakkestoerrelse not in ('lille', 'mellem', 'stor') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  select id, seller_id, buyer_id, status, afhentning into t
    from public.trades where id = p_trade for update;
  if t.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  if p_type = 'udgaaende' then
    if t.seller_id <> p_bruger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
    if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;
  else
    if t.buyer_id <> p_bruger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  end if;

  -- Findes der allerede en aktiv forsendelse af typen?
  select id, status, oprettet_kl into f
    from public.forsendelser
   where trade_id = p_trade and type = p_type
     and status not in ('annulleret', 'fejlet')
   for update;
  if f.id is not null then
    if f.status <> 'opretter' then
      return jsonb_build_object('kode', 'findes', 'id', f.id);
    end if;
    if f.oprettet_kl > now() - interval '10 minutes' then
      return jsonb_build_object('kode', 'i_gang');
    end if;
    update public.forsendelser
       set status = 'fejlet', fejl = 'Oprettelsen blev afbrudt (over 10 minutter).'
     where id = f.id and status = 'opretter';
  end if;

  if p_type = 'udgaaende' then
    if t.status <> 'betaling_modtaget' then
      return jsonb_build_object('kode', 'forkert_status');
    end if;
  else
    if not exists (select 1 from public.sager s
                    where s.trade_id = p_trade
                      and s.status = 'afventer_retur'
                      and s.retur_kraeves) then
      return jsonb_build_object('kode', 'ingen_retur');
    end if;
  end if;

  insert into public.forsendelser (trade_id, type, fragtfirma, status, pakkestoerrelse, oprettet_af)
  values (p_trade, p_type, p_fragtfirma, 'opretter', p_pakkestoerrelse, p_bruger)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end;
$fn$;
revoke all on function public.forsendelse_claim(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.forsendelse_claim(uuid, uuid, text, text, text) to service_role;

-- Gemmer fragtfirmaets svar paa en claimet forsendelse. Idempotent: kun fra
-- 'opretter'. Returnerer true, hvis denne kaldt vandt.
create or replace function public.forsendelse_gem_oprettet(
  p_id              uuid,
  p_forsendelses_id text,
  p_sporingsnummer  text,
  p_label_sti       text,
  p_qr_kode         text,
  p_pris_oere       integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.forsendelser
     set status = 'oprettet',
         forsendelses_id = p_forsendelses_id,
         sporingsnummer = p_sporingsnummer,
         label_sti = p_label_sti,
         qr_kode = p_qr_kode,
         pris_oere = p_pris_oere,
         fejl = null
   where id = p_id and status = 'opretter';
  return found;
end;
$fn$;
revoke all on function public.forsendelse_gem_oprettet(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.forsendelse_gem_oprettet(uuid, text, text, text, text, integer) to service_role;

-- Oprettelsen fejlede hos fragtfirmaet: frigiv claimet, saa der kan proeves igen.
create or replace function public.forsendelse_marker_fejlet(p_id uuid, p_fejl text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.forsendelser
     set status = 'fejlet', fejl = left(coalesce(p_fejl, 'Ukendt fejl'), 500)
   where id = p_id and status = 'opretter';
  return found;
end;
$fn$;
revoke all on function public.forsendelse_marker_fejlet(uuid, text) from public, anon, authenticated;
grant execute on function public.forsendelse_marker_fejlet(uuid, text) to service_role;

-- Annullerer en udgaaende label, foer pakken er afleveret. Kaldes EFTER, at
-- fragtfirmaet har annulleret. p_bruger skal vaere saelgeren (verificeret af
-- serveren og igen her). Idempotent: kun fra 'oprettet'.
-- Svar: 'ok' | 'ikke_fundet' | 'kan_ikke'.
create or replace function public.forsendelse_annuller(p_id uuid, p_bruger uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (select 1 from public.forsendelser f
                   join public.trades t on t.id = f.trade_id
                  where f.id = p_id
                    and ((f.type = 'udgaaende' and t.seller_id = p_bruger)
                      or (f.type = 'retur' and t.buyer_id = p_bruger))) then
    return 'ikke_fundet';
  end if;
  update public.forsendelser
     set status = 'annulleret', annulleret_kl = now()
   where id = p_id and status = 'oprettet';
  if not found then return 'kan_ikke'; end if;
  return 'ok';
end;
$fn$;
revoke all on function public.forsendelse_annuller(uuid, uuid) from public, anon, authenticated;
grant execute on function public.forsendelse_annuller(uuid, uuid) to service_role;

-- Gemmer en normaliseret sporingshaendelse idempotent og opdaterer
-- forsendelsens status (kun fremad). Roerer IKKE handlen eller pengene -
-- det goer serveren bagefter ud fra svaret (src/lib/fragt/server.ts).
-- Saetter kraever_opmaerksomhed ved: returneret, fejl, haendelser paa en
-- annulleret/fejlet label, og returpakker der er afleveret (staff registrerer
-- det i sagen - refusionen startes ikke automatisk).
-- Svar: {ny, forsendelse_id, trade_id, forsendelse_type, status, trade_status}
create or replace function public.forsendelse_registrer_haendelse(
  p_forsendelse uuid,
  p_type        text,
  p_tidspunkt   timestamptz,
  p_noegle      text,
  p_beskrivelse text,
  p_raa         jsonb,
  p_kilde       text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f       record;
  v_ny    boolean := false;
  v_tid   timestamptz := least(coalesce(p_tidspunkt, now()), now() + interval '5 minutes');
  v_raa   jsonb := p_raa;
  v_note  text := null;
  v_trade text;
begin
  if p_type not in ('oprettet', 'afleveret', 'i_transit', 'klar_til_afhentning',
                    'leveret', 'returneret', 'fejl') then
    raise exception 'ukendt haendelsestype %', p_type;
  end if;

  select * into f from public.forsendelser where id = p_forsendelse for update;
  if f.id is null then raise exception 'forsendelse findes ikke'; end if;

  -- For stor raa payload gemmes ikke (haendelsen gemmes stadig).
  if v_raa is not null and (jsonb_typeof(v_raa) <> 'object' or pg_column_size(v_raa) > 4096) then
    v_raa := jsonb_build_object('afkortet', true);
  end if;

  insert into public.forsendelse_haendelser
    (forsendelse_id, type, tidspunkt, noegle, beskrivelse, kilde, raa)
  values (f.id, p_type, v_tid, left(p_noegle, 200), left(p_beskrivelse, 300), p_kilde, v_raa)
  on conflict (forsendelse_id, noegle) do nothing;
  v_ny := found;

  if v_ny then
    if f.status in ('annulleret', 'fejlet', 'opretter') then
      -- Haendelse paa en label, der ikke er (eller ikke laengere er) aktiv.
      if p_type <> 'oprettet' then
        v_note := 'Sporingshændelse (' || p_type || ') på en forsendelse med status '
                  || f.status || '. Tjek, om sælgeren har brugt en annulleret label.';
      end if;
      update public.forsendelser
         set sidste_haendelse_kl = greatest(coalesce(sidste_haendelse_kl, v_tid), v_tid),
             kraever_opmaerksomhed = kraever_opmaerksomhed or v_note is not null,
             opmaerksomhed_tekst = case when v_note is null then opmaerksomhed_tekst
               else left(coalesce(opmaerksomhed_tekst || ' · ', '') || v_note, 1000) end
       where id = f.id;
    else
      if p_type = 'returneret' then
        v_note := case when f.type = 'udgaaende'
          then 'Pakken er sendt retur til sælgeren (fx ikke hentet). Vurdér handlen (ikke-afhentet pakke, model 3).'
          else 'Returpakken er sendt tilbage til køberen. Vurdér sagen.' end;
      elsif p_type = 'fejl' then
        v_note := 'Fragtfirmaet meldte en fejl: ' || coalesce(left(p_beskrivelse, 200), 'ingen beskrivelse');
      elsif f.type = 'retur' and p_type = 'afleveret' then
        v_note := 'Returpakken er afleveret. Registrér det i sagen.';
      end if;

      update public.forsendelser
         set status = case
               when p_type <> 'fejl'
                and public.forsendelse_status_rang(p_type) > public.forsendelse_status_rang(status)
               then p_type else status end,
             afleveret_kl = case when p_type in ('afleveret', 'i_transit', 'klar_til_afhentning', 'leveret')
               then coalesce(afleveret_kl, v_tid) else afleveret_kl end,
             klar_til_afhentning_kl = case when p_type = 'klar_til_afhentning'
               then coalesce(klar_til_afhentning_kl, v_tid) else klar_til_afhentning_kl end,
             leveret_kl = case when p_type = 'leveret'
               then coalesce(leveret_kl, v_tid) else leveret_kl end,
             returneret_kl = case when p_type = 'returneret'
               then coalesce(returneret_kl, v_tid) else returneret_kl end,
             sidste_haendelse_kl = greatest(coalesce(sidste_haendelse_kl, v_tid), v_tid),
             kraever_opmaerksomhed = kraever_opmaerksomhed or v_note is not null,
             opmaerksomhed_tekst = case when v_note is null then opmaerksomhed_tekst
               else left(coalesce(opmaerksomhed_tekst || ' · ', '') || v_note, 1000) end
       where id = f.id;
    end if;
  end if;

  select tr.status into v_trade from public.trades tr
    join public.forsendelser fo on fo.trade_id = tr.id
   where fo.id = p_forsendelse;

  return (select jsonb_build_object(
    'ny', v_ny,
    'forsendelse_id', fo.id,
    'trade_id', fo.trade_id,
    'forsendelse_type', fo.type,
    'status', fo.status,
    'trade_status', v_trade)
    from public.forsendelser fo where fo.id = p_forsendelse);
end;
$fn$;
revoke all on function public.forsendelse_registrer_haendelse(uuid, text, timestamptz, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.forsendelse_registrer_haendelse(uuid, text, timestamptz, text, text, jsonb, text) to service_role;

-- Markerer, at en besked er sendt (afleveret_besked_kl / leveret_besked_kl),
-- og tilfoejer evt. en staff-note. Idempotent.
create or replace function public.forsendelse_marker_besked(
  p_id   uuid,
  p_felt text,
  p_note text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_felt = 'afleveret' then
    update public.forsendelser
       set afleveret_besked_kl = now(),
           kraever_opmaerksomhed = kraever_opmaerksomhed or p_note is not null,
           opmaerksomhed_tekst = case when p_note is null then opmaerksomhed_tekst
             else left(coalesce(opmaerksomhed_tekst || ' · ', '') || p_note, 1000) end
     where id = p_id and afleveret_besked_kl is null;
  elsif p_felt = 'leveret' then
    update public.forsendelser
       set leveret_besked_kl = now(),
           kraever_opmaerksomhed = kraever_opmaerksomhed or p_note is not null,
           opmaerksomhed_tekst = case when p_note is null then opmaerksomhed_tekst
             else left(coalesce(opmaerksomhed_tekst || ' · ', '') || p_note, 1000) end
     where id = p_id and leveret_besked_kl is null;
  else
    raise exception 'ukendt felt %', p_felt;
  end if;
  return found;
end;
$fn$;
revoke all on function public.forsendelse_marker_besked(uuid, text, text) from public, anon, authenticated;
grant execute on function public.forsendelse_marker_besked(uuid, text, text) to service_role;
