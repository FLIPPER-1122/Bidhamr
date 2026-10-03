-- Rettelser efter review af 20261004060000_auktionsregler.sql.
--
--   M1  Billed-URL'er blev kun tjekket loest (position(...) > 0 og '^https?://'),
--       og kun i rediger_auktion. Ny faelles hjaelper
--       public.auktion_billeder_gyldige(bruger, billeder): 1-10 billeder
--       (MAKS_BILLEDER i src/lib/auktionRegler.ts), hvert praecist
--         https://<lkifkrexeldimmghnsie (prod) eller pjiigmzqwlfepxnjdvug (test)>.supabase.co/storage/v1/object/public/
--         auktion-billeder/<brugerens id>/<[A-Za-z0-9._-]+>
--       og uden '..'. Bruges i rediger_auktion, ved oprettelse
--       (auctions_beskyt_ny) og ved direkte PATCH, naar billeder aendres
--       (auctions_beskyt_kolonner). Alle eksisterende billed-URL'er i
--       produktion matcher. Hjemmesidens upload laver nu filnavne
--       <uuid>.<endelse> (src/lib/auktionRegler.ts, auktionBilledeSti).
--   L1  Kun hele kroner: CHECK-constraints paa bids."beløb" og
--       auctions.startpris (ingen eksisterende raekker bryder dem - tjekket i
--       produktion og test 3. oktober 2026), og en venlig fejl i
--       check_minimum_bid.
--   L2  Kategori valideres i databasen mod samme liste som
--       src/lib/kategorier.ts (public.auktion_kategorier). Ved oprettelse, i
--       rediger_auktion og ved direkte PATCH, naar kategorien aendres.
--   L3  auctions_beskyt_kolonner: en suspenderet saelger kan ikke aendre sin
--       auktion via direkte PATCH (samme regel som i rediger_auktion).
--
-- Funktionerne er ellers uaendrede fra 20261004060000.
-- Idempotent: create or replace, constraints kun hvis de ikke findes,
-- validate er en no-op paa en allerede valideret constraint. Aendrer ingen data.

-- ============================================================ 1. Hjaelpere

-- Gyldige billeder til en auktion ejet af p_bruger. Security invoker og ren
-- (laeser ingen tabeller). Kaldes fra triggere, der koerer som den indloggede
-- bruger, og derfor skal authenticated kunne udfoere den.
create or replace function public.auktion_billeder_gyldige(p_bruger uuid, p_billeder text[])
returns boolean
language sql
immutable
security invoker
set search_path = public
as $fn$
  select coalesce(
    p_bruger is not null
    and p_billeder is not null
    and array_ndims(p_billeder) = 1
    and cardinality(p_billeder) between 1 and 10   -- MAKS_BILLEDER
    and not exists (
      select 1
        from unnest(p_billeder) as e(url)
       where e.url is null
          or char_length(e.url) > 1000
          or position('..' in e.url) > 0
          or e.url !~ ('^https://(lkifkrexeldimmghnsie|pjiigmzqwlfepxnjdvug)\.supabase\.co/storage/v1/object/public/auktion-billeder/'
                       || p_bruger::text || '/[A-Za-z0-9._-]+$')
    ),
    false);
$fn$;

revoke execute on function public.auktion_billeder_gyldige(uuid, text[]) from public, anon;
grant execute on function public.auktion_billeder_gyldige(uuid, text[]) to authenticated, service_role;

-- Kategorier. HOLD SYNKRON med src/lib/kategorier.ts.
create or replace function public.auktion_kategorier()
returns text[]
language sql
immutable
security invoker
set search_path = public
as $fn$
  select array[
    'Elektronik',
    'Møbler',
    'Tøj & sko',
    'Biler',
    'Legetøj',
    'Sport',
    'Havemøbler',
    'Andet'
  ]::text[];
$fn$;

create or replace function public.er_gyldig_auktionskategori(p_kategori text)
returns boolean
language sql
immutable
security invoker
set search_path = public
as $fn$
  select coalesce(p_kategori = any (public.auktion_kategorier()), false);
$fn$;

revoke execute on function public.auktion_kategorier() from public, anon;
revoke execute on function public.er_gyldig_auktionskategori(text) from public, anon;
grant execute on function public.auktion_kategorier() to authenticated, service_role;
grant execute on function public.er_gyldig_auktionskategori(text) to authenticated, service_role;

-- Er den indloggede bruger suspenderet? Security definer, fordi
-- auctions_beskyt_kolonner koerer som brugeren, og users-kolonnerne ikke
-- noedvendigvis er laeselige. Svarer kun for auth.uid() selv.
create or replace function public.jeg_er_suspenderet()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    select u.suspenderet
           and (u.suspenderet_til is null or u.suspenderet_til > now())
      from public.users u
     where u.id = auth.uid()), false);
$fn$;

revoke execute on function public.jeg_er_suspenderet() from public, anon;
grant execute on function public.jeg_er_suspenderet() to authenticated, service_role;

-- ============================================================ 2. Hele kroner

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bids_beloeb_hele_kroner') then
    alter table public.bids add constraint bids_beloeb_hele_kroner
      check ("beløb" = trunc("beløb")) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auctions_startpris_hele_kroner') then
    alter table public.auctions add constraint auctions_startpris_hele_kroner
      check (startpris = trunc(startpris)) not valid;
  end if;
end $$;

alter table public.bids validate constraint bids_beloeb_hele_kroner;
alter table public.auctions validate constraint auctions_startpris_hele_kroner;

-- Som 20261004060000 + hele kroner. Teksten "Buddet skal være i hele kroner."
-- er whitelistet i src/app/actions/bud.ts.
create or replace function public.check_minimum_bid()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  minimum numeric;
begin
  if new."beløb" is null or new."beløb" <> trunc(new."beløb") then
    raise exception 'Buddet skal være i hele kroner.' using errcode = '22023';
  end if;

  select public.naeste_bud_minimum(a."nuværende_bud", a.startpris) into minimum
    from public.auctions a where a.id = new.auktion_id;

  if minimum is not null and new."beløb" < minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(minimum);
  end if;
  return new;
end;
$function$;

revoke execute on function public.check_minimum_bid() from public, anon, authenticated;

-- ============================================================ 3. Oprettelse

-- Som 20261004060000 + billeder (BHA01) og kategori (BHA02).
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

-- ============================================================ 4. Direkte UPDATE (appen)

-- Som 20261004060000 + suspenderet saelger (BHS02), billeder (BHA01) og
-- kategori (BHA02). Billeder/kategori tjekkes kun, naar de aendres.
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

-- ============================================================ 5. rediger_auktion (RPC)

-- Som 20261004060000, men billeder og kategori valideres med de faelles
-- hjaelpere. Signatur og returkoder er uaendrede.
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
