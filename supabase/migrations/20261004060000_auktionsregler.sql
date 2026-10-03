-- Auktionsregler (Filip, 4. oktober 2026 - ROADMAP-BESLUTNINGER.md,
-- "Midlertidige beslutninger"):
--
--   1. Budstigning som trappe efter det nuvaerende hoejeste bud:
--        under 100 kr: +5 kr · 100-999 kr: +10 kr · 1.000-4.999 kr: +50 kr
--        · fra 5.000 kr: +100 kr.
--      Erstatter 10 %-reglen i check_minimum_bid (20261001060000).
--      Foerste bud maa vaere lig startprisen (startpris = mindstepris; der
--      findes ingen skjult mindstepris/reservepris).
--      Reglen ligger i public.naeste_bud_minimum og haandhaeves to steder:
--        - check_minimum_bid (BEFORE INSERT): tidlig, venlig fejl.
--        - handle_new_bid (AFTER INSERT, efter "for update" paa auktionen):
--          den endelige kontrol. Tidligere tjekkede den kun "hoejere end
--          nuvaerende bud", saa to samtidige bud kunne snyde budstigningen.
--      public.mindste_naeste_bud(auktion) kan kaldes af browser og app.
--      Samme regel i TypeScript: src/lib/auktionRegler.ts (mindsteNaesteBud).
--
--   2. Varighed: 3, 5, 7 eller 10 dage. Ny kolonne auctions.varighed_dage.
--      Ved oprettelse (auctions_beskyt_ny) beregner databasen selv
--      slutter_kl = now() + varighed. Sender klienten kun slutter_kl (aeldre
--      app-versioner), udledes varigheden af den og afvises, hvis den ikke er
--      3, 5, 7 eller 10 dage. genopsaet_auktion foelger samme regel.
--
--   3. Redigering saa laenge der ikke er bud: ny RPC public.rediger_auktion.
--      Laaser auktionsraekken (for update), saa et samtidigt bud enten
--      venter og derefter ser den nye version, eller er naaet foerst, saa
--      redigeringen afvises. Direkte UPDATE via PostgREST (appen) gaar
--      fortsat gennem auctions_beskyt_kolonner, som nu ogsaa tillader
--      startpris (uden bud) og altid stempler redigeret_kl.
--      Varigheden (slutter_kl, varighed_dage) kan aldrig aendres af brugeren.
--
--   4. Bud paa en forældet visning: auctions.redigeret_kl stemples ved hver
--      redigering. Klienten kan sende den version, byderen saa, med buddet
--      (bids.auktion_redigeret_kl). Er auktionen redigeret siden, afvises
--      buddet, saa ingen byder paa en vare, der er aendret under dem.
--      Feltet er valgfrit (aeldre app-versioner sender det ikke).
--
--   5. Bindende bud: brugere har ingen UPDATE/DELETE-policy paa bids. Her
--      fjernes ogsaa selve tabelrettighederne, saa det ikke afhaenger af,
--      at ingen nogensinde tilfoejer en policy.
--
-- Annullering: public.annuller_egen_auktion (20260930080000) genbruges
-- uaendret. Raekken bevares med status 'annulleret' (slettes aldrig).
--
-- Idempotent: add column if not exists, create or replace, drop trigger if
-- exists. Aendrer ingen eksisterende data ud over at udfylde redigeret_kl.

-- ============================================================ 1. Kolonner

alter table public.auctions
  add column if not exists varighed_dage integer,
  add column if not exists redigeret_kl timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auctions_varighed_dage_check') then
    -- NULL: auktioner oprettet foer denne migration.
    alter table public.auctions add constraint auctions_varighed_dage_check
      check (varighed_dage is null or varighed_dage in (3, 5, 7, 10));
  end if;
end $$;

-- Millisekunder, saa versionen kan sammenlignes eksakt, selv om klienten
-- har sendt den gennem en JavaScript-Date.
update public.auctions
   set redigeret_kl = date_trunc('milliseconds', oprettet)
 where redigeret_kl is null;

alter table public.auctions
  alter column redigeret_kl set default date_trunc('milliseconds', now()),
  alter column redigeret_kl set not null;

comment on column public.auctions.varighed_dage is
  'Valgt varighed ved oprettelse: 3, 5, 7 eller 10 dage. NULL for aeldre auktioner.';
comment on column public.auctions.redigeret_kl is
  'Version af auktionens indhold. Stemples ved oprettelse og hver redigering (millisekunder).';

alter table public.bids
  add column if not exists auktion_redigeret_kl timestamptz;

comment on column public.bids.auktion_redigeret_kl is
  'Valgfri: den version af auktionen (auctions.redigeret_kl), byderen saa. Afviger den, afvises buddet.';

-- ============================================================ 2. Budstigning

-- Budstigningen ud fra det nuvaerende hoejeste bud.
create or replace function public.budstigning(p_beloeb numeric)
returns numeric
language sql
immutable
set search_path = public
as $fn$
  select case
    when p_beloeb < 100  then 5::numeric
    when p_beloeb < 1000 then 10::numeric
    when p_beloeb < 5000 then 50::numeric
    else 100::numeric
  end;
$fn$;

-- Mindste tilladte naeste bud. Uden bud: startprisen (mindst 1 kr - et bud
-- paa 0 kr giver ingen mening). Med bud: nuvaerende bud + budstigning.
create or replace function public.naeste_bud_minimum(p_nuvaerende numeric, p_startpris numeric)
returns numeric
language sql
immutable
set search_path = public
as $fn$
  select case
    when p_nuvaerende is null then greatest(ceil(coalesce(p_startpris, 0)), 1)
    else p_nuvaerende + public.budstigning(p_nuvaerende)
  end;
$fn$;

-- Til browser og app. Security invoker: auctions er laeselig for alle.
create or replace function public.mindste_naeste_bud(p_auktion uuid)
returns numeric
language sql
stable
security invoker
set search_path = public
as $fn$
  select public.naeste_bud_minimum(a."nuværende_bud", a.startpris)
    from public.auctions a
   where a.id = p_auktion;
$fn$;

grant execute on function public.budstigning(numeric) to anon, authenticated, service_role;
grant execute on function public.naeste_bud_minimum(numeric, numeric) to anon, authenticated, service_role;
grant execute on function public.mindste_naeste_bud(uuid) to anon, authenticated, service_role;

-- BEFORE INSERT: tidlig kontrol (uden laas). Den endelige kontrol sker i
-- handle_new_bid efter "for update". Fejlteksten parses af afgivBud
-- ("minimum_bid: ... mindst X kr").
create or replace function public.check_minimum_bid()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  minimum numeric;
begin
  select public.naeste_bud_minimum(a."nuværende_bud", a.startpris) into minimum
    from public.auctions a where a.id = new.auktion_id;

  if minimum is not null and new."beløb" < minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(minimum);
  end if;
  return new;
end;
$function$;

revoke execute on function public.check_minimum_bid() from public, anon, authenticated;

drop trigger if exists trg_check_minimum_bid on public.bids;
create trigger trg_check_minimum_bid
  before insert on public.bids
  for each row execute function public.check_minimum_bid();

-- Som 20261001060000, men:
--   - budstigningen kontrolleres efter laasen (samtidige bud),
--   - et bud paa en forældet version af auktionen afvises.
create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_auktion record;
  v_bruger record;
  v_minimum numeric;
begin
  select suspenderet, suspenderet_til into v_bruger
    from public.users where id = new.bruger_id;

  if v_bruger is null then
    raise exception 'Brugeren findes ikke';
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

  if v_auktion.status <> 'aktiv' then
    raise exception 'Auktionen er ikke aktiv længere';
  end if;

  if v_auktion.slutter_kl <= now() then
    raise exception 'Auktionen er allerede slut';
  end if;

  if new.auktion_redigeret_kl is not null
     and date_trunc('milliseconds', new.auktion_redigeret_kl)
         is distinct from v_auktion.redigeret_kl then
    raise exception 'Sælgeren har lige ændret auktionen. Se den igen, før du byder.';
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
$function$;

revoke execute on function public.handle_new_bid() from public, anon, authenticated;

-- ============================================================ 3. Varighed ved oprettelse

-- Gyldig varighed? Delt af auctions_beskyt_ny og genopsaet_auktion.
create or replace function public.er_gyldig_varighed(p_dage integer)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(p_dage in (3, 5, 7, 10), false);
$fn$;

grant execute on function public.er_gyldig_varighed(integer) to anon, authenticated, service_role;

-- Varighed udledt af et sluttidspunkt (aeldre klienter, genopsaet_auktion).
-- Afrundes til hele dage, saa klientens ur ikke behoever at passe praecist.
create or replace function public.varighed_fra_slutter_kl(p_slutter_kl timestamptz)
returns integer
language sql
stable
set search_path = public
as $fn$
  select case
    when p_slutter_kl is null then null
    else round(extract(epoch from (p_slutter_kl - now())) / 86400)::integer
  end;
$fn$;

-- Bruges af auctions_beskyt_ny, der koerer som den indloggede bruger.
grant execute on function public.varighed_fra_slutter_kl(timestamptz) to anon, authenticated, service_role;

-- Som 20260930030000, men varigheden afgoeres af databasen.
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

  return new;
end;
$fn$;

revoke execute on function public.auctions_beskyt_ny() from public, anon, authenticated;

drop trigger if exists auctions_beskyt_ny on public.auctions;
create trigger auctions_beskyt_ny
  before insert on public.auctions
  for each row execute function public.auctions_beskyt_ny();

-- ============================================================ 4. Direkte UPDATE (appen)

-- Som 20261001036000, men:
--   - startpris maa aendres, saa laenge der ikke er bud,
--   - varighed_dage og slutter_kl kan aldrig aendres af brugeren,
--   - auktionen skal stadig vaere i gang (ikke kun status 'aktiv'),
--   - redigeret_kl stemples altid (brugeren kan ikke selv saette den).
-- Raekkelaasen: en UPDATE, der venter paa et samtidigt bud (handle_new_bid
-- tager "for update"), koeres mod den nyeste version af raekken, og OLD i
-- triggeren er den version - saa "nuværende_bud is not null" fanger buddet.
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

  new.redigeret_kl := date_trunc('milliseconds', clock_timestamp());
  return new;
end;
$fn$;

revoke execute on function public.auctions_beskyt_kolonner() from public, anon, authenticated;

drop trigger if exists auctions_beskyt_kolonner on public.auctions;
create trigger auctions_beskyt_kolonner
  before update on public.auctions
  for each row execute function public.auctions_beskyt_kolonner();

-- ============================================================ 5. rediger_auktion (RPC)

-- Saelgeren redigerer sin egen auktion, saa laenge der ikke er bud.
-- Brugeren udledes af auth.uid(). Postnummer/lokation og varighed kan ikke
-- aendres her. Billeder skal ligge i saelgerens egen mappe i bucket'en
-- auktion-billeder.
-- Returnerer { kode, redigeret_kl }. Koder: ok, ikke_fundet, suspenderet,
-- ikke_aktiv, slut, har_bud, ugyldig_titel, ugyldig_beskrivelse,
-- ugyldige_billeder, ugyldig_kategori, ugyldig_startpris.
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
  v_billede text;
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
  if char_length(v_kat) < 1 or char_length(v_kat) > 60 then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;

  if p_billeder is null or coalesce(array_length(p_billeder, 1), 0) < 1
     or array_length(p_billeder, 1) > 10 then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;
  foreach v_billede in array p_billeder loop
    if v_billede is null or char_length(v_billede) > 1000
       or position('/storage/v1/object/public/auktion-billeder/' || v_uid::text || '/' in v_billede) = 0
       or v_billede !~ '^https?://' then
      return jsonb_build_object('kode', 'ugyldige_billeder');
    end if;
  end loop;

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

-- ============================================================ 6. genopsaet_auktion

-- Uaendret fra 20261002050000 bortset fra varigheden: p_slutter_kl skal
-- svare til 3, 5, 7 eller 10 dage (afrundet), og sluttidspunktet beregnes
-- af databasen. Signaturen er uaendret.
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

-- ============================================================ 7. Bindende bud

-- Der findes ingen UPDATE/DELETE-policy paa bids. Tabelrettighederne fjernes
-- ogsaa, saa et bud aldrig kan trækkes tilbage eller aendres af en bruger -
-- heller ikke hvis nogen senere tilfoejer en for bred policy.
revoke update, delete, truncate on public.bids from anon, authenticated;
