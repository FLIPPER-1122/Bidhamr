-- Brugerens adresse til fakturaer (Filip, 27. okt. 2026 - ROADMAP-BESLUTNINGER.md,
-- "Oplysninger til fakturaen indsamles ved oprettelse").
--
-- Private udfylder adresse (vej og nr.), postnummer og by, når de opretter en
-- konto (hjemmesiden og appen). Eksisterende brugere uden adresse bliver bedt
-- om den, før de byder første gang eller betaler første gang. Adressen kan
-- rettes under Min konto -> Min adresse. Den bruges på firmaets faktura til
-- køberen (firma_fakturaer, 20261102330000), hvor den låses i fakturaens
-- øjebliksbillede, når fakturaen laves.
--
-- Indhold:
--   1. public.bruger_adresser: én række pr. bruger (adresse, postnummer,
--      bynavn). Byen sættes altid af databasen ud fra postnummeret
--      (public.postnummer_koordinater - samme liste som src/data/postnumre.ts).
--      RLS: kun brugeren selv kan læse sin række. Ingen kan skrive direkte -
--      kun via funktionerne herunder. Service role (serveren, admin) har
--      adgang som altid.
--   2. bruger_adresse_gem(p_bruger, p_adresse, p_postnummer): intern (kun
--      service role). Bruges ved oprettelse af kontoen (efter koden fra
--      mailen, src/lib/kontoOprettelse.ts).
--      gem_min_adresse(p_adresse, p_postnummer): brugeren selv (auth.uid()).
--      Begge svarer jsonb { kode: 'ok' | 'adresse' | 'postnummer' | 'konto' |
--      'ikke_logget_ind', adresse, postnummer, by }.
--   3. Krav før bud: triggere på bids og bud_maksimum (som MitID, BHV01).
--      Private uden adresse afvises med fejlkode BHY01 ('adresse_mangler: ...').
--      Automatiske bud (bids.automatisk) springes over - maksimum blev tjekket,
--      da det blev sat. Firmakonti og systembrugeren er undtaget.
--      Kravet før første betaling ligger på serveren (startBetalingFor), fordi
--      kun serveren kan starte en betaling.
--   4. Kontosletning: adressen slettes, medmindre brugeren har handler
--      (bogføring). Sendte fakturaer har deres eget øjebliksbillede af
--      adressen og ændres aldrig.
--   5. "Download dine data" (mine_data): nøglen 'adresse'. Flettes ind i den
--      nuværende definition (tekst-erstatning, kræver præcis ét match - samme
--      mønster som 20261102270000/20261102290000).
--
-- Rører ikke users.adresse (adressen til afhentning, fri tekst - Min profil).
--
-- Idempotent (kan køres igen). Kun testdatabasen, indtil Filip siger ja.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.postnummer_koordinater') is null then
    raise exception 'Forudsætning mangler: public.postnummer_koordinater (20261007011000)';
  end if;
  if to_regprocedure('public.mine_data()') is null then
    raise exception 'Forudsætning mangler: public.mine_data()';
  end if;
  if to_regclass('public.bud_maksimum') is null then
    raise exception 'Forudsætning mangler: public.bud_maksimum (20261010010000_autobud.sql)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Tabellen
-- ===========================================================================
create table if not exists public.bruger_adresser (
  bruger_id     uuid primary key references public.users(id),
  -- Vej og husnummer (fx "Testvej 12, 2. th.").
  adresse       text not null check (char_length(adresse) between 3 and 200),
  postnummer    text not null check (postnummer ~ '^[0-9]{4}$'),
  -- Altid bynavnet for postnummeret (sat af bruger_adresse_gem).
  bynavn        text not null check (char_length(bynavn) between 1 and 100),
  oprettet_kl   timestamptz not null default now(),
  opdateret_kl  timestamptz not null default now()
);

comment on table public.bruger_adresser is
  'Brugerens adresse til fakturaer (vej og nr., postnummer, by). Kun brugeren selv kan læse den (RLS); skrives kun via gem_min_adresse()/bruger_adresse_gem(). Firmaet får den kun via sin faktura på en betalt handel (firma_fakturaer - øjebliksbillede). Slettes ved kontosletning, medmindre brugeren har handler. 20261102340000.';

alter table public.bruger_adresser enable row level security;
revoke all on public.bruger_adresser from public, anon, authenticated;
grant select on public.bruger_adresser to authenticated;
grant all on public.bruger_adresser to service_role;

drop policy if exists bruger_adresser_egen on public.bruger_adresser;
create policy bruger_adresser_egen on public.bruger_adresser
  for select to authenticated
  using (bruger_id = (select auth.uid()));

-- ===========================================================================
-- 2. Gem (validering ét sted)
-- ===========================================================================
-- Intern: kun service role (oprettelse af konto) og funktionerne herunder.
create or replace function public.bruger_adresse_gem(p_bruger uuid, p_adresse text, p_postnummer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_adr  text := btrim(regexp_replace(coalesce(p_adresse, ''), '\s+', ' ', 'g'));
  v_post text := btrim(coalesce(p_postnummer, ''));
  v_by   text;
begin
  if p_bruger is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  -- Vej og nr.: 3-200 tegn, mindst ét bogstav og ét ciffer, ingen
  -- styretegn.
  if char_length(v_adr) < 3 or char_length(v_adr) > 200
     or v_adr !~ '[[:alpha:]]' or v_adr !~ '[0-9]'
     or v_adr ~ '[[:cntrl:]]' then
    return jsonb_build_object('kode', 'adresse');
  end if;
  if v_post !~ '^[0-9]{4}$' then
    return jsonb_build_object('kode', 'postnummer');
  end if;
  select p.bynavn into v_by from public.postnummer_koordinater p where p.postnummer = v_post;
  if v_by is null then
    return jsonb_build_object('kode', 'postnummer');
  end if;
  -- Slettede og lukkede konti kan ikke få en ny adresse.
  if not exists (select 1 from public.users u
                  where u.id = p_bruger
                    and u.konto_slettet_kl is null
                    and u.konto_lukket_kl is null) then
    return jsonb_build_object('kode', 'konto');
  end if;

  insert into public.bruger_adresser as a (bruger_id, adresse, postnummer, bynavn)
  values (p_bruger, v_adr, v_post, v_by)
  on conflict (bruger_id) do update
     set adresse = excluded.adresse,
         postnummer = excluded.postnummer,
         bynavn = excluded.bynavn,
         opdateret_kl = now()
   -- Uændret adresse: ingen skrivning (dobbeltklik giver ingen ny tid).
   where (a.adresse, a.postnummer, a.bynavn)
         is distinct from (excluded.adresse, excluded.postnummer, excluded.bynavn);

  return jsonb_build_object('kode', 'ok', 'adresse', v_adr, 'postnummer', v_post, 'by', v_by);
end;
$fn$;

revoke all on function public.bruger_adresse_gem(uuid, text, text) from public, anon, authenticated;
grant execute on function public.bruger_adresse_gem(uuid, text, text) to service_role;

-- Brugeren selv (Min adresse, formularen før bud/betaling, appen).
create or replace function public.gem_min_adresse(p_adresse text, p_postnummer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  return public.bruger_adresse_gem(auth.uid(), p_adresse, p_postnummer);
end;
$fn$;

revoke all on function public.gem_min_adresse(text, text) from public, anon;
grant execute on function public.gem_min_adresse(text, text) to authenticated;

-- ===========================================================================
-- 3. Krav før bud (BHY01)
-- ===========================================================================
create or replace function public.adresse_kraev(p_bruger uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return;
  end if;
  if exists (select 1 from public.users u
              where u.id = p_bruger
                and u.konto_type is distinct from 'erhverv')
     and not exists (select 1 from public.bruger_adresser a where a.bruger_id = p_bruger) then
    raise exception 'adresse_mangler: Udfyld din adresse, før du byder. Den skal stå på din kvittering eller faktura.'
      using errcode = 'BHY01';
  end if;
end;
$fn$;

revoke all on function public.adresse_kraev(uuid) from public, anon, authenticated;

create or replace function public.bids_adresse()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not coalesce(new.automatisk, false) then
    perform public.adresse_kraev(new.bruger_id);
  end if;
  return new;
end;
$fn$;

revoke all on function public.bids_adresse() from public, anon, authenticated;

-- "a4": efter låsen (a0), automatisk-feltet (a1), firmakonto (a2) og
-- MitID/vilkår (a3).
drop trigger if exists a4_bids_adresse on public.bids;
create trigger a4_bids_adresse
  before insert on public.bids
  for each row execute function public.bids_adresse();

create or replace function public.bud_maksimum_adresse()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' or new.maks_beloeb is distinct from old.maks_beloeb then
    perform public.adresse_kraev(new.bruger_id);
  end if;
  return new;
end;
$fn$;

revoke all on function public.bud_maksimum_adresse() from public, anon, authenticated;

drop trigger if exists a1_bud_maksimum_adresse on public.bud_maksimum;
create trigger a1_bud_maksimum_adresse
  before insert or update on public.bud_maksimum
  for each row execute function public.bud_maksimum_adresse();

-- ===========================================================================
-- 4. Kontosletning
-- ===========================================================================
-- Uden handler slettes adressen. Med handler (køb eller salg) bevares den
-- til bogføringen; fakturaer har deres eget øjebliksbillede og ændres ikke.
create or replace function public.users_adresse_ved_sletning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (select 1 from public.trades t where t.buyer_id = new.id or t.seller_id = new.id) then
    delete from public.bruger_adresser a where a.bruger_id = new.id;
  end if;
  return null;
end;
$fn$;

revoke all on function public.users_adresse_ved_sletning() from public, anon, authenticated;

drop trigger if exists users_adresse_ved_sletning on public.users;
create trigger users_adresse_ved_sletning
  after update of konto_slettet_kl on public.users
  for each row
  when (old.konto_slettet_kl is null and new.konto_slettet_kl is not null)
  execute function public.users_adresse_ved_sletning();

-- ===========================================================================
-- 5. "Download dine data"
-- ===========================================================================
create or replace function public.mine_data_adresse(p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
           'adresse', a.adresse,
           'postnummer', a.postnummer,
           'by', a.bynavn,
           'oprettet_kl', a.oprettet_kl,
           'opdateret_kl', a.opdateret_kl)
    from public.bruger_adresser a
   where p_uid is not null and a.bruger_id = p_uid;
$fn$;

revoke all on function public.mine_data_adresse(uuid) from public, anon, authenticated, service_role;

-- Flettes ind lige efter "v := public.mine_data_grund()" i den NUVÆRENDE
-- mine_data. Allerede med: intet sker.
create or replace function pg_temp.adresse_flet_mine_data()
returns void language plpgsql as $$
declare
  v_def text := replace(pg_get_functiondef('public.mine_data()'::regprocedure), E'\r\n', E'\n');
  v_gl  text := E'  v := public.mine_data_grund()';
  v_n   integer;
begin
  if position('public.mine_data_adresse(' in v_def) > 0 then
    return;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
  if v_n <> 1 then
    raise exception 'mine_data: "%" fundet % gange (skal være 1) - flet adressen ind manuelt', v_gl, v_n;
  end if;
  execute replace(v_def, v_gl,
    v_gl || E'\n       || jsonb_build_object(''adresse'', public.mine_data_adresse(v_uid))');
end $$;

select pg_temp.adresse_flet_mine_data();

do $$
begin
  if position('public.mine_data_adresse(v_uid)' in pg_get_functiondef('public.mine_data()'::regprocedure)) = 0 then
    raise exception 'mine_data mangler adressen efter fletningen';
  end if;
end $$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated, service_role;
