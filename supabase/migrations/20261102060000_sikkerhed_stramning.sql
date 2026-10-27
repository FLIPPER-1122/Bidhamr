-- Sikkerhedsstramning efter den fulde gennemgang (27. okt. 2026).
--
-- Kører efter 20261102050000 (rører ikke firmapakker eller erhverv-betaling).
--
-- Indhold:
--   H2. Fulde navne kunne læses af alle (users_select_all + select (navn) til
--       anon/authenticated). Ny offentlig kolonne users.visningsnavn, som en
--       trigger holder ved lige: samme regel som src/lib/kortNavn.ts
--       ("Kasper K."), firmakonti (konto_type = 'erhverv') med det fulde navn,
--       slettede konti "Slettet bruger". select (navn) fjernes fra anon og
--       authenticated; brugeren læser sit eget fulde navn med mit_navn().
--       mine_blokeringer() og mine_fulgte_saelgere() giver nu visningsnavn.
--       Bevidst uændret (fulde navn til parten i en handel): handel_afhentnings-
--       adresse (køberen skal finde sælgerens dør ved afhentning) og
--       firma_faktura_salg (firmaet fakturerer køberen). Staff (hent_medarbejdere)
--       og service role er uændret.
--   M1. Brede, gamle tabel-grants fjernes. Kun det, hjemmesiden (src) og appen
--       (bidhamr-app/src) skriver direkte med brugerens klient, bevares:
--         users:   update (navn, fornavn, efternavn, telefon, adresse, avatar_url)
--         auctions: insert på kolonnerne fra Opret auktion (ingen update -
--                  redigering går via rediger_auktion, security definer)
--         bids:    insert (afgivBud.ts)
--         messages: insert (chatten)
--         favorites: insert/delete
--       Alt andet skrives via security definer-RPC'er (push_token_registrer,
--       foelg_saelger, fjern_blokering ...). Desuden fjernes truncate,
--       references, trigger og maintain fra anon/authenticated på ALLE tabeller
--       i public.
--   M2. Loft på nye auktioner for private: højst 30 pr. time (BHA06) og højst
--       200 aktive ad gangen (BHA07). Firmaer (kvote) er undtaget. Service role
--       (genopsaet_auktion og saet_annulleret_op_igen fra serveren) tæller
--       200-loftet på auktionens bruger_id; timeloftet gælder kun brugerens
--       egne oprettelser. SQL uden JWT (migrationer, seed) er undtaget.
--   A-3. Til sidst: tabel-select på users/auctions for anon/authenticated
--       laves om til de kendte kolonne-grants (hvis den findes), og
--       migrationen stopper, hvis navn, idempotens_noegle eller
--       forbudt_bekraeftet stadig kan læses.
--   L1. Skemaet net (pg_net) lukkes for anon/authenticated.
--   L2. firma_velkomst_billetter.brugt_kl: sættes, når knappen på /bekraeft er
--       trykket, og login er lykkedes (src/app/auth/callback/route.ts).
--   L3. Shipmondo-webhooken: en hændelse med samme forsendelse, kode (Shipment
--       Monitor-status) og tidspunkt gemmes kun én gang - også hvis nøglen er
--       lavet med det gamle format (med current_state).
--   L4. Sekvenser i public: ingen usage/update/select for anon/authenticated.
--   L5. avatarer_delete_own: kun authenticated og storage_to_trin_ok() som de
--       andre avatar-policies.
--   L6. auctions.idempotens_noegle og forbudt_bekraeftet kan ikke længere
--       læses af anon/authenticated (dubletter findes med min_auktion_for_noegle).
--
-- Idempotent (kan køres igen). Tabeller/kolonner, der ikke findes, springes
-- over. Kør først på testdatabasen. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- H2. users.visningsnavn
-- ===========================================================================

-- Samme regel som kortNavn i src/lib/kortNavn.ts (og appens src/lib/navn.ts).
-- Ren funktion uden dataadgang - må kaldes af alle (triggeren kører som den,
-- der opdaterer rækken).
create or replace function public.visningsnavn_beregn(p_navn text, p_konto_type text, p_slettet_kl timestamptz)
returns text
language sql
immutable
set search_path = public
as $fn$
  select case
    when p_slettet_kl is not null then 'Slettet bruger'
    when p_konto_type = 'erhverv' then
      coalesce(nullif(regexp_replace(btrim(coalesce(p_navn, '')), '[[:space:]]+', ' ', 'g'), ''), 'Anonym')
    else public.kort_visningsnavn(p_navn)
  end;
$fn$;

revoke all on function public.visningsnavn_beregn(text, text, timestamptz) from public;
grant execute on function public.visningsnavn_beregn(text, text, timestamptz) to anon, authenticated, service_role;

alter table public.users add column if not exists visningsnavn text;

comment on column public.users.visningsnavn is
  'Offentligt navn ("Kasper K.", firmaer fuldt firmanavn, slettede "Slettet bruger"). Vedligeholdes af triggeren users_zz_visningsnavn - kan ikke skrives af brugere. users.navn kan kun læses af brugeren selv (mit_navn) og service role. 20261102060000.';

create or replace function public.users_saet_visningsnavn()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  -- Altid beregnet - også hvis nogen forsøger at skrive kolonnen selv.
  new.visningsnavn := public.visningsnavn_beregn(new.navn, new.konto_type, new.konto_slettet_kl);
  return new;
end;
$fn$;

revoke all on function public.users_saet_visningsnavn() from public, anon, authenticated;

-- "zz": efter de andre BEFORE-triggere, så navnet er det endelige (fx
-- "Slettet bruger" ved sletning).
drop trigger if exists users_zz_visningsnavn on public.users;
create trigger users_zz_visningsnavn
  before insert or update on public.users
  for each row execute function public.users_saet_visningsnavn();

-- Udfyld eksisterende rækker (kun dem, der afviger - kan køres igen). De
-- andre users-triggere slås fra imens: de vogter brugerændringer og kan afvise
-- ældre rækker, selvom kun visningsnavn ændres (fx users_beskyt_lukket_konto
-- på en lukket konto uden permanent suspension). Kun de triggere, der var slået
-- til, slås til igen. Fejler noget, rulles det hele tilbage.
do $do$
declare
  v_til text[];
  v_navn text;
begin
  select coalesce(array_agg(t.tgname::text), '{}') into v_til
    from pg_trigger t
   where t.tgrelid = 'public.users'::regclass and not t.tgisinternal and t.tgenabled <> 'D';
  alter table public.users disable trigger user;
  update public.users u
     set visningsnavn = public.visningsnavn_beregn(u.navn, u.konto_type, u.konto_slettet_kl)
   where u.visningsnavn is distinct from public.visningsnavn_beregn(u.navn, u.konto_type, u.konto_slettet_kl);
  foreach v_navn in array v_til loop
    execute format('alter table public.users enable trigger %I', v_navn);
  end loop;
end;
$do$;

-- Kolonne-grants: visningsnavn ind, navn ud (fornavn/efternavn har aldrig
-- været læsbare, men lukkes for en sikkerheds skyld).
grant select (visningsnavn) on public.users to anon, authenticated;
revoke select (navn, fornavn, efternavn) on public.users from anon, authenticated;

-- Eget fulde navn (Min konto, profil, forudfyldt leverings-/afsendernavn).
create or replace function public.mit_navn()
returns table (navn text, fornavn text, efternavn text)
language sql
stable
security definer
set search_path = public
as $fn$
  select u.navn, u.fornavn, u.efternavn
    from public.users u
   where u.id = auth.uid();
$fn$;

revoke all on function public.mit_navn() from public, anon;
grant execute on function public.mit_navn() to authenticated;

-- Blokerede brugere og fulgte sælgere: kun det korte navn.
create or replace function public.mine_blokeringer()
returns table (id uuid, bruger_id uuid, navn text, avatar_url text, auktion_id uuid, auktion_titel text, oprettet_kl timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select b.id,
         case when b.kilde_auktion_id is null then b.blokeret_id end,
         case when b.kilde_auktion_id is null then u.visningsnavn end,
         case when b.kilde_auktion_id is null then u.avatar_url end,
         b.kilde_auktion_id,
         a.titel,
         b.oprettet_kl
    from public.brugerblokeringer b
    join public.users u on u.id = b.blokeret_id
    left join public.auctions a on a.id = b.kilde_auktion_id
   where b.blokerer_id = auth.uid()
   order by b.oprettet_kl desc;
$fn$;

create or replace function public.mine_fulgte_saelgere()
returns table (saelger_id uuid, navn text, avatar_url text, aktive_auktioner integer, fulgt_siden timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  select u.id, u.visningsnavn, u.avatar_url,
         (select count(*)::integer from public.auctions a
           where a.bruger_id = u.id and a.status = 'aktiv'
             and not coalesce(a.skjult, false) and a.slutter_kl > now()),
         f.created_at
    from public.seller_follows f
    join public.users u on u.id = f.seller_id
   where f.follower_id = auth.uid()
     and u.konto_lukket_kl is null
   order by f.created_at desc;
$fn$;

revoke all on function public.mine_blokeringer() from public, anon;
grant execute on function public.mine_blokeringer() to authenticated;
revoke all on function public.mine_fulgte_saelgere() from public, anon;
grant execute on function public.mine_fulgte_saelgere() to authenticated;

-- ===========================================================================
-- M1. Tabel-grants
-- ===========================================================================

do $do$
declare
  v_tabel text;
  v_kolonner text;
  -- Kolonner, Opret auktion skriver (src/components/OpretAuktionForm.tsx og
  -- appens src/app/opret-auktion.tsx). Kun dem, der findes, får en grant.
  v_auktion_kolonner text[] := array[
    'bruger_id', 'titel', 'beskrivelse', 'billeder', 'startpris', 'kategori', 'stand',
    'producent', 'sikkerhedsoplysninger', 'postnummer', 'lokation', 'lat', 'lng',
    'forsendelse_mulig', 'pakkestoerrelse', 'vaegt_gram', 'afhentning_mulig',
    'spoergsmaal_aktiv', 'forbudt_bekraeftet', 'kunst_bekraeftet', 'varighed_dage',
    'slutter_kl', 'idempotens_noegle'];
  v_bruger_kolonner text[] := array['navn', 'fornavn', 'efternavn', 'telefon', 'adresse', 'avatar_url'];
  v_maintain boolean := current_setting('server_version_num')::integer >= 170000;
begin
  -- users: anon skriver intet; authenticated kun profilfelterne.
  revoke insert, update, delete on public.users from anon;
  revoke insert, update, delete on public.users from authenticated;
  select string_agg(quote_ident(c), ', ') into v_kolonner
    from unnest(v_bruger_kolonner) c
   where exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'users' and column_name = c);
  execute format('grant update (%s) on public.users to authenticated', v_kolonner);

  -- auctions: anon skriver intet; authenticated kun insert på Opret
  -- auktions kolonner. Ingen update (rediger_auktion er security definer).
  revoke insert, update, delete on public.auctions from anon;
  revoke insert, update, delete on public.auctions from authenticated;
  select string_agg(quote_ident(c), ', ') into v_kolonner
    from unnest(v_auktion_kolonner) c
   where exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'auctions' and column_name = c);
  execute format('grant insert (%s) on public.auctions to authenticated', v_kolonner);

  -- bids: kun indloggede byder (afgivBud.ts).
  revoke insert, update, delete on public.bids from anon;
  revoke update, delete on public.bids from authenticated;

  -- messages: anon læser og skriver intet.
  revoke select, insert, update, delete on public.messages from anon;
  revoke update, delete on public.messages from authenticated;

  -- Egne lister: intet for anon. authenticated: favorites insert/delete
  -- (FavoritterProvider/useFavoritter); push_tokens via push_token_registrer/
  -- push_token_fjern; saved_auctions og auction_templates bruges ikke.
  foreach v_tabel in array array['favorites', 'saved_auctions', 'push_tokens', 'auction_templates'] loop
    if to_regclass('public.' || v_tabel) is not null then
      execute format('revoke all on public.%I from anon', v_tabel);
    end if;
  end loop;
  if to_regclass('public.favorites') is not null then
    revoke update on public.favorites from authenticated;
  end if;
  foreach v_tabel in array array['saved_auctions', 'push_tokens', 'auction_templates'] loop
    if to_regclass('public.' || v_tabel) is not null then
      execute format('revoke insert, update, delete on public.%I from authenticated', v_tabel);
    end if;
  end loop;

  -- Kun service role skriver i moderation_log.
  if to_regclass('public.moderation_log') is not null then
    revoke insert, update, delete on public.moderation_log from anon, authenticated;
  end if;

  -- employee_complaints: chefen behandler dem via service role.
  if to_regclass('public.employee_complaints') is not null then
    revoke update, delete on public.employee_complaints from anon, authenticated;
  end if;

  -- Følg og blokér går via RPC'er (foelg_saelger, stop_foelg_saelger,
  -- bloker_bruger, fjern_blokering ... - alle security definer).
  if to_regclass('public.seller_follows') is not null then
    revoke insert, update, delete on public.seller_follows from anon, authenticated;
  end if;
  if to_regclass('public.brugerblokeringer') is not null then
    revoke insert, update, delete on public.brugerblokeringer from anon, authenticated;
  end if;

  -- Alle tabeller, views og sekvenser i public: ingen truncate, references,
  -- trigger eller maintain for anon/authenticated.
  for v_tabel in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', v_tabel);
    if v_maintain then
      execute format('revoke maintain on public.%I from anon, authenticated', v_tabel);
    end if;
  end loop;

  -- L4. Sekvenser: ingen klient indsætter i tabeller med en sekvens
  -- (penge_afstemning_koersler, penge_saldo_snapshot m.fl. er service role).
  for v_tabel in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('revoke all on sequence public.%I from anon, authenticated', v_tabel);
  end loop;
end;
$do$;

-- ===========================================================================
-- L6. auctions: interne kolonner kan ikke læses
-- ===========================================================================

do $do$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'auctions' and column_name = 'idempotens_noegle') then
    revoke select (idempotens_noegle) on public.auctions from anon, authenticated;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'auctions' and column_name = 'forbudt_bekraeftet') then
    revoke select (forbudt_bekraeftet) on public.auctions from anon, authenticated;
  end if;
end;
$do$;

-- ===========================================================================
-- M2. Loft på nye auktioner for private
-- ===========================================================================

create or replace function public.auctions_oprettelse_loft()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid := auth.uid();
  v_server boolean := coalesce(auth.role(), '') = 'service_role';
  v_type   text;
  v_antal  integer;
begin
  -- Service role: genopsaet_auktion og saet_annulleret_op_igen kaldes fra
  -- serveren (createAdminClient) på sælgerens vegne og indsætter med
  -- sælgeren som bruger_id. Loftet på 200 aktive gælder også her (ellers
  -- kunne det omgås ved at sætte ubetalte/annullerede varer op igen) - men
  -- ikke timeloftet (hver gammel auktion kan kun sættes op én gang).
  -- SQL uden JWT (migrationer, seed) er undtaget. anon kan ikke indsætte.
  if v_server then
    v_bruger := new.bruger_id;
  end if;
  if v_bruger is null then
    return new;
  end if;

  -- Firmaer har deres egen kvote (firma_ugekvote).
  select u.konto_type into v_type from public.users u where u.id = v_bruger;
  if v_type = 'erhverv' then
    return new;
  end if;

  -- Én oprettelse ad gangen pr. bruger, så samtidige kald ikke snyder loftet.
  perform pg_advisory_xact_lock(hashtextextended('auktion_opret:' || v_bruger::text, 0));

  if not v_server then
    select count(*) into v_antal
      from public.auctions a
     where a.bruger_id = v_bruger
       and a.oprettet > now() - interval '1 hour';
    if v_antal >= 30 then
      raise exception 'auktion_loft_time: Du har oprettet mange auktioner på kort tid. Vent lidt, og prøv igen.'
        using errcode = 'BHA06',
              hint = 'Højst 30 nye auktioner i timen.';
    end if;
  end if;

  select count(*) into v_antal
    from public.auctions a
   where a.bruger_id = v_bruger
     and a.status = 'aktiv';
  if v_antal >= 200 then
    raise exception 'auktion_loft_aktive: Du har 200 aktive auktioner, som er det højeste antal. Vent, til nogle af dem er slut, og prøv igen.'
      using errcode = 'BHA07',
            hint = 'Højst 200 aktive auktioner ad gangen.';
  end if;

  return new;
end;
$fn$;

revoke all on function public.auctions_oprettelse_loft() from public, anon, authenticated;

drop trigger if exists auctions_a0_loft on public.auctions;
create trigger auctions_a0_loft
  before insert on public.auctions
  for each row execute function public.auctions_oprettelse_loft();

-- ===========================================================================
-- L1. pg_net
-- ===========================================================================
-- Skemaet ejes af supabase_admin. Kan postgres ikke tilbagekalde (grants givet
-- af en anden rolle), sker intet - se docs/SIKKERHED-AUTH.md.

do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'net') then
    begin
      execute 'revoke execute on all functions in schema net from anon, authenticated';
      execute 'revoke usage on schema net from anon, authenticated';
    exception when insufficient_privilege then
      raise notice 'net: kunne ikke tilbagekalde (%).', sqlerrm;
    end;
  end if;
end;
$do$;

-- ===========================================================================
-- L5. Storage: sletning af eget profilbillede
-- ===========================================================================

drop policy if exists avatarer_delete_own on storage.objects;
create policy avatarer_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatarer'
    and (select auth.uid())::text = (storage.foldername(name))[1]
    and public.storage_to_trin_ok()
  );

-- ===========================================================================
-- L2. Velkomstbilletten markeres som brugt efter login
-- ===========================================================================

do $do$
begin
  if to_regclass('public.firma_velkomst_billetter') is not null then
    alter table public.firma_velkomst_billetter add column if not exists brugt_kl timestamptz;
    comment on column public.firma_velkomst_billetter.brugt_kl is
      'Sat, når firmaet har trykket på knappen på /bekraeft, og login er lykkedes (src/app/auth/callback/route.ts). Herefter er billetten ugyldig. 20261102060000.';
  end if;
end;
$do$;

-- ===========================================================================
-- L3. Shipmondo: samme hændelse (forsendelse, kode, tidspunkt) kun én gang
-- ===========================================================================
-- forsendelse_registrer_haendelse indsætter med "on conflict (forsendelse_id,
-- noegle) do nothing" og ser på FOUND. Springer denne trigger rækken over
-- (return null), er FOUND falsk, og intet sker - også selvom nøglen er i det
-- gamle format (med current_state). 'fejl' er kun markeringer og har egne
-- nøgler.

create or replace function public.forsendelse_haendelser_dublet()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.kilde = 'webhook'
     and new.type <> 'fejl'
     and new.noegle like 'shipmondo:%'
     and exists (
       select 1 from public.forsendelse_haendelser h
        where h.forsendelse_id = new.forsendelse_id
          and h.kilde = 'webhook'
          and h.type = new.type
          and h.tidspunkt = new.tidspunkt
          and h.noegle like 'shipmondo:%'
          and coalesce(h.raa ->> 'status', '') = coalesce(new.raa ->> 'status', '')) then
    return null;
  end if;
  return new;
end;
$fn$;

revoke all on function public.forsendelse_haendelser_dublet() from public, anon, authenticated;

do $do$
begin
  if to_regclass('public.forsendelse_haendelser') is not null then
    drop trigger if exists forsendelse_haendelser_dublet on public.forsendelse_haendelser;
    create trigger forsendelse_haendelser_dublet
      before insert on public.forsendelse_haendelser
      for each row execute function public.forsendelse_haendelser_dublet();
  end if;
end;
$do$;

-- ===========================================================================
-- A-3. Kolonne-revokes skal virke - ellers stopper migrationen
-- ===========================================================================
-- En kolonne-revoke gør intet, hvis rollen har select på hele tabellen. Det
-- har anon/authenticated ikke haft siden 20260930100000 (users) og
-- 20261010061000 (auctions), men findes en tabel-select alligevel (drift),
-- laves den om til de kolonne-grants, som policies og kode bygger på:
--   users:    kun den kendte offentlige liste (aldrig "alt undtagen" - users
--             har e-mail, telefon, adresse m.m.). Samme liste, som test har
--             efter denne migration (27. okt. 2026).
--   auctions: alle kolonner undtagen de lukkede (samme regel som
--             20261010061000 + L6 ovenfor).
-- Kommer adgangen fra PUBLIC (eller en anden rolle, anon/authenticated
-- arver fra), gør revoken her intet, og tjekket nedenfor stopper migrationen,
-- så det kan undersøges.

do $do$
declare
  v_rolle text;
  v_kolonner text;
  v_users_offentlige text[] := array['id', 'avatar_url', 'rating', 'oprettet', 'konto_type',
                                     'mitid_verificeret_kl', 'visningsnavn'];
  v_auctions_lukkede text[] := array['vinder_id', 'kunst_bekraeftet', 'kunst_markeret_kl', 'kunst_kontrol',
                                     'kunst_tekst_md5', 'kunst_tjekket_kl', 'idempotens_noegle',
                                     'forbudt_bekraeftet'];
begin
  foreach v_rolle in array array['anon', 'authenticated'] loop
    -- relacl direkte (information_schema viser kun grants, som den kørende
    -- rolle selv er part i).
    if exists (select 1 from pg_class c, aclexplode(c.relacl) x
                where c.oid = 'public.users'::regclass
                  and x.grantee = v_rolle::regrole and x.privilege_type = 'SELECT') then
      select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_kolonner
        from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = 'users'
         and c.column_name = any (v_users_offentlige);
      execute format('revoke select on public.users from %I', v_rolle);
      execute format('grant select (%s) on public.users to %I', v_kolonner, v_rolle);
      raise notice 'users: tabel-select for % lavet om til kolonne-grants (%).', v_rolle, v_kolonner;
    end if;

    if exists (select 1 from pg_class c, aclexplode(c.relacl) x
                where c.oid = 'public.auctions'::regclass
                  and x.grantee = v_rolle::regrole and x.privilege_type = 'SELECT') then
      select string_agg(quote_ident(attname), ', ' order by attnum) into v_kolonner
        from pg_attribute
       where attrelid = 'public.auctions'::regclass and attnum > 0 and not attisdropped
         and attname <> all (v_auctions_lukkede);
      execute format('revoke select on public.auctions from %I', v_rolle);
      execute format('grant select (%s) on public.auctions to %I', v_kolonner, v_rolle);
      raise notice 'auctions: tabel-select for % lavet om til kolonne-grants.', v_rolle;
    end if;
  end loop;
end;
$do$;

do $do$
declare
  v_rolle text;
  v_kolonne text;
  v_fejl text[] := '{}';
begin
  foreach v_rolle in array array['anon', 'authenticated'] loop
    -- Fulde navne må ikke kunne læses.
    foreach v_kolonne in array array['navn', 'fornavn', 'efternavn'] loop
      if exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'users' and column_name = v_kolonne)
         and has_column_privilege(v_rolle, 'public.users', v_kolonne, 'select') then
        v_fejl := v_fejl || format('%s kan læse users.%s', v_rolle, v_kolonne);
      end if;
    end loop;
    -- Interne auktionskolonner (L6).
    foreach v_kolonne in array array['idempotens_noegle', 'forbudt_bekraeftet'] loop
      if exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'auctions' and column_name = v_kolonne)
         and has_column_privilege(v_rolle, 'public.auctions', v_kolonne, 'select') then
        v_fejl := v_fejl || format('%s kan læse auctions.%s', v_rolle, v_kolonne);
      end if;
    end loop;
    -- Det offentlige navn skal kunne læses (ellers viser siderne intet navn).
    if not has_column_privilege(v_rolle, 'public.users', 'visningsnavn', 'select') then
      v_fejl := v_fejl || format('%s kan IKKE læse users.visningsnavn', v_rolle);
    end if;
  end loop;

  if cardinality(v_fejl) > 0 then
    raise exception 'Sikkerhedsstramningen virkede ikke: %. Tjek grants (også til PUBLIC) - migrationen rulles tilbage.',
      array_to_string(v_fejl, '; ');
  end if;
end;
$do$;

-- PostgREST skal kende de nye kolonne-grants og funktioner med det samme.
notify pgrst, 'reload schema';
