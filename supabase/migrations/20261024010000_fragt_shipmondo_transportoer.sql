-- Fragt via Shipmondo igen (Filip, 15. okt. 2026 - ROADMAP-BESLUTNINGER,
-- "Fragt via Shipmondo igen"). Køberen vælger selv fragtfirma i checkout:
-- DAO, GLS eller PostNord - alle via Shipmondo (FRAGTFIRMA=shipmondo).
-- Priserne er uændrede (låst på auktionen pr. pakkestørrelse og
-- leveringsform) og ens for alle tre. Adapteren: src/lib/fragt/shipmondo.ts.
--
--   1. Kolonnen transportoer ('dao' | 'gls' | 'postnord') på handel_levering
--      (købers valg), leveringsforslag (forudfyldning) og forsendelser (den
--      transportør, labelen er lavet hos). Krævet, når fragtfirma =
--      'shipmondo'. På forsendelser sættes den af databasen ved oprettelsen
--      (triggeren forsendelser_transportoer: købers valg for en udgående, den
--      udgående pakkes for en retur) og kan derefter ikke ændres. Gamle
--      Shipmondo-rækker var altid DAO og får 'dao'.
--   2. handel_gem_levering gemmer købers transportør (og kræver den ved
--      Shipmondo); handel_checkout viser den i 'valgt' (appen).
--   3. Labelgrænsen (forsendelse_claim): en Shipmondo-label, som
--      transportøren har BEKRÆFTET annulleret (cancelled_at_carrier -
--      forsendelser.annullering_bekraeftet_kl), tæller ikke i "højst 2 labels
--      pr. handel"; loftet på 10 labels i alt gælder som for DAO direkte. DAO
--      via Shipmondo kan stadig ikke annullere (422), og GLS/PostNord svarer
--      cancelled_at_carrier = false i sandboxen - så tæller de som før.
--   4. QR-kode til indlevering uden printer (PostNord, GLS retur):
--      forsendelser.qr_png (base64-PNG, højst 20.000 tegn). Ingen læseadgang
--      for authenticated (som label_sti og qr_kode) - serveren viser den kun
--      til den part, der skal sende pakken.
--   5. fragt_ukendte_koder: Shipmondos statuskoder (tekst, fx "EN_ROUTE") og
--      transportøren som liste - ukendte koder ændrer aldrig status.
--
-- Nye funktioner: security definer, search_path = '', kun service_role.
-- Ændrede funktioner, der ligger i produktion, rettes på stedet med
-- md5-drift-tjek (mønstret fra 20261021010000): "gammel" = prod og test før
-- denne migration (hentet med SELECT 15. okt. 2026 - ens), "ny" = efter.
-- Andet afbryder migrationen.
--
-- Idempotent (kan køres igen). Én transaktion: filen køres som én samlet
-- forespørgsel. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.forsendelser') is null or to_regclass('public.handel_levering') is null
     or to_regclass('public.leveringsforslag') is null or to_regclass('public.fragt_ukendte_koder') is null
     or to_regclass('public.returfragt_betalinger') is null then
    raise exception 'Forudsætning mangler: kør 20261012010000, 20261021010000 og 20261022010000 først';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session)
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- md5 før (gammel) eller allerede rettet (ny); hvert mønster skal findes
-- præcis det forventede antal gange; md5 bagefter skal være "ny". Ellers
-- afbrydes migrationen (intet ændres).
create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke - kør de tidligere fragt-migrationer først', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- ===========================================================================
-- 1. Kolonner
-- ===========================================================================
alter table public.handel_levering  add column if not exists transportoer text;
alter table public.leveringsforslag add column if not exists transportoer text;
alter table public.forsendelser
  add column if not exists transportoer               text,
  -- Transportøren har bekræftet annulleringen (Shipmondo:
  -- cancelled_at_carrier; DAO direkte: altid, når den er annulleret).
  add column if not exists annullering_bekraeftet_kl  timestamptz,
  -- QR-koden til indlevering uden printer (PNG i base64).
  add column if not exists qr_png                     text;

comment on column public.handel_levering.transportoer is
  'Købers valgte transportør ved Shipmondo: dao | gls | postnord (null ved andre fragtfirmaer og afhentning).';
comment on column public.forsendelser.transportoer is
  'Transportøren, labelen er lavet hos (sat af databasen ved oprettelsen, kan ikke ændres).';
comment on column public.forsendelser.annullering_bekraeftet_kl is
  'Transportøren har bekræftet annulleringen - labelen tæller ikke i labelgrænsen, og en returkode kan erstattes.';
comment on column public.forsendelser.qr_png is
  'QR-kode til indlevering uden printer (PNG, base64). Kun service_role.';

-- Gamle Shipmondo-rækker (før valget af transportør) var altid DAO.
update public.handel_levering set transportoer = 'dao'
 where fragtfirma = 'shipmondo' and transportoer is null;
update public.forsendelser set transportoer = 'dao'
 where fragtfirma in ('shipmondo', 'dao') and transportoer is null;

alter table public.handel_levering drop constraint if exists handel_levering_transportoer_check;
alter table public.handel_levering add constraint handel_levering_transportoer_check check (
      (transportoer is null or transportoer in ('dao', 'gls', 'postnord'))
  and (fragtfirma is distinct from 'shipmondo' or transportoer is not null));

alter table public.leveringsforslag drop constraint if exists leveringsforslag_transportoer_check;
alter table public.leveringsforslag add constraint leveringsforslag_transportoer_check check (
  transportoer is null or transportoer in ('dao', 'gls', 'postnord'));

alter table public.forsendelser drop constraint if exists forsendelser_transportoer_check;
alter table public.forsendelser add constraint forsendelser_transportoer_check check (
      (transportoer is null or transportoer in ('dao', 'gls', 'postnord'))
  and (fragtfirma <> 'shipmondo' or transportoer is not null)
  and (annullering_bekraeftet_kl is null or status = 'annulleret')
  and (qr_png is null or (char_length(qr_png) <= 20000 and qr_png ~ '^iVBORw0KGgo[A-Za-z0-9+/]+=*$')));

-- Parterne må se transportøren (som fragtfirma). qr_png får ingen
-- læseadgang (som label_sti og qr_kode).
grant select (transportoer) on public.handel_levering to authenticated;
grant select (transportoer) on public.forsendelser to authenticated;

-- ===========================================================================
-- 2. Transportøren på forsendelsen sættes af databasen og låses
-- ===========================================================================
create or replace function public.forsendelser_transportoer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.transportoer is null then
      if new.fragtfirma = 'dao' then
        new.transportoer := 'dao';
      elsif new.fragtfirma = 'shipmondo' then
        if new.type = 'udgaaende' then
          -- Købers valg (låst, når labelen er lavet: handel_gem_levering 'laast').
          select hl.transportoer into new.transportoer
            from public.handel_levering hl
           where hl.trade_id = new.trade_id and hl.fragtfirma = 'shipmondo';
        else
          -- Retur: samme transportør som den udgående pakke (den aktive først).
          select f.transportoer into new.transportoer
            from public.forsendelser f
           where f.trade_id = new.trade_id and f.type = 'udgaaende' and f.fragtfirma = 'shipmondo'
             and f.transportoer is not null
           order by (f.status in ('annulleret', 'fejlet')), f.oprettet_kl desc
           limit 1;
        end if;
        -- Gamle Shipmondo-handler (før valget) var altid DAO.
        new.transportoer := coalesce(new.transportoer, 'dao');
      end if;
    end if;
    if new.annullering_bekraeftet_kl is not null or new.qr_png is not null then
      raise exception 'forsendelse_ny: annullering og QR-kode sættes først senere' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.transportoer is not null and new.transportoer is distinct from old.transportoer then
    raise exception 'Forsendelsens transportør kan ikke ændres.' using errcode = '42501';
  end if;
  if old.annullering_bekraeftet_kl is not null
     and new.annullering_bekraeftet_kl is distinct from old.annullering_bekraeftet_kl then
    raise exception 'En bekræftet annullering kan ikke ændres.' using errcode = '42501';
  end if;
  if old.qr_png is not null and new.qr_png is distinct from old.qr_png then
    raise exception 'Forsendelsens QR-kode kan ikke ændres.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.forsendelser_transportoer() from public, anon, authenticated;

drop trigger if exists forsendelser_transportoer on public.forsendelser;
create trigger forsendelser_transportoer
  before insert or update of transportoer, annullering_bekraeftet_kl, qr_png on public.forsendelser
  for each row execute function public.forsendelser_transportoer();

-- Transportøren har bekræftet annulleringen (kaldes af serveren efter
-- forsendelse_annuller_afslut). Svar: true = sat nu.
create or replace function public.forsendelse_annullering_bekraeftet(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.forsendelser
     set annullering_bekraeftet_kl = now()
   where id = p_id and status = 'annulleret' and annullering_bekraeftet_kl is null;
  return found;
end;
$fn$;
revoke all on function public.forsendelse_annullering_bekraeftet(uuid) from public, anon, authenticated;
grant execute on function public.forsendelse_annullering_bekraeftet(uuid) to service_role;

-- Gemmer QR-koden (PNG, base64) på en aktiv forsendelse - kun én gang.
-- Svar: true = gemt.
create or replace function public.forsendelse_gem_qr(p_id uuid, p_png text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_png is null or char_length(p_png) > 20000 or p_png !~ '^iVBORw0KGgo[A-Za-z0-9+/]+=*$' then
    raise exception 'ugyldig QR-kode' using errcode = '22023';
  end if;
  update public.forsendelser
     set qr_png = p_png
   where id = p_id and qr_png is null
     and status not in ('annulleres', 'annulleret', 'fejlet');
  return found;
end;
$fn$;
revoke all on function public.forsendelse_gem_qr(uuid, text) from public, anon, authenticated;
grant execute on function public.forsendelse_gem_qr(uuid, text) to service_role;

-- ===========================================================================
-- 3. Ukendte statuskoder fra Shipmondo (tekst + transportør)
-- ===========================================================================
alter table public.fragt_ukendte_koder drop constraint if exists fragt_ukendte_koder_check;
alter table public.fragt_ukendte_koder add constraint fragt_ukendte_koder_check check (
      fragtfirma in ('test', 'gls', 'shipmondo', 'dao')
  and (kode ~ '^[0-9]{1,6}$' or (fragtfirma = 'shipmondo' and kode ~ '^[A-Za-z0-9_:]{1,60}$'))
  and liste in ('', 'pakkeshop', 'direkte', 'dao', 'gls', 'postnord')
  and char_length(coalesce(beskrivelse, '')) <= 200
  and char_length(coalesce(eksempel_sporingsnummer, '')) <= 40
  and antal >= 1);

-- ===========================================================================
-- 4. handel_gem_levering, handel_checkout og forsendelse_claim (på stedet)
-- ===========================================================================
do $do$
begin
  raise notice 'handel_gem_levering: %', pg_temp.ps_ret(
    'public.handel_gem_levering(uuid,uuid,jsonb,text)',
    '2b8e1936694bccdf80635b7a9c2e4d5a',
    '73ae3eb68c501079445e4384881f6f92',
    jsonb_build_array(
      jsonb_build_array(
$g$     or (v_maade = 'pakkeshop' and (v_shop is null or jsonb_typeof(v_shop) <> 'object')) then$g$,
$n$     or (v_maade = 'pakkeshop' and (v_shop is null or jsonb_typeof(v_shop) <> 'object'))
     -- Shipmondo (20261024010000): købers transportør er krævet.
     or (not v_afh and v_firma = 'shipmondo'
         and coalesce(p_valg->>'transportoer', '') not in ('dao', 'gls', 'postnord')) then$n$, 1),
      jsonb_build_array(
$g$      fragt_oere, beskyttelse_ved_forsendelse_oere)$g$,
$n$      fragt_oere, beskyttelse_ved_forsendelse_oere, transportoer)$n$, 2),
      jsonb_build_array(
$g$      0, v_gemt)$g$,
$n$      0, v_gemt, null)$n$, 1),
      jsonb_build_array(
$g$      v_pris, null)$g$,
$n$      v_pris, null, case when v_firma = 'shipmondo' then p_valg->>'transportoer' end)$n$, 1),
      jsonb_build_array(
$g$      fragt_oere = 0, beskyttelse_ved_forsendelse_oere = excluded.beskyttelse_ved_forsendelse_oere,$g$,
$n$      fragt_oere = 0, beskyttelse_ved_forsendelse_oere = excluded.beskyttelse_ved_forsendelse_oere,
      transportoer = null,$n$, 1),
      jsonb_build_array(
$g$      fragt_oere = excluded.fragt_oere, beskyttelse_ved_forsendelse_oere = null,$g$,
$n$      fragt_oere = excluded.fragt_oere, beskyttelse_ved_forsendelse_oere = null,
      transportoer = excluded.transportoer,$n$, 1),
      jsonb_build_array(
$g$modtager_by, modtager_telefon, opdateret_kl)$g$,
$n$modtager_by, modtager_telefon, transportoer, opdateret_kl)$n$, 1),
      jsonb_build_array(
$g$hl.modtager_by, hl.modtager_telefon, now()$g$,
$n$hl.modtager_by, hl.modtager_telefon, hl.transportoer, now()$n$, 1),
      jsonb_build_array(
$g$      modtager_telefon = excluded.modtager_telefon,
      opdateret_kl = now();$g$,
$n$      modtager_telefon = excluded.modtager_telefon,
      transportoer = coalesce(excluded.transportoer, lf.transportoer),
      opdateret_kl = now();$n$, 1)));

  raise notice 'handel_checkout: %', pg_temp.ps_ret(
    'public.handel_checkout(uuid)',
    'e2766090ed57381b98c34f3a08c0982a',
    'b4cf86e0fbcabf3ebe4d4ebf27c6de54',
    jsonb_build_array(jsonb_build_array(
$g$'pakkeshop_navn', hl.pakkeshop_navn, 'fragt_oere', hl.fragt_oere)$g$,
$n$'pakkeshop_navn', hl.pakkeshop_navn, 'fragt_oere', hl.fragt_oere,
                                        'transportoer', hl.transportoer)$n$, 1)));

  raise notice 'forsendelse_claim: %', pg_temp.ps_ret(
    'public.forsendelse_claim(uuid,uuid,text,text,text)',
    '4a9203d3dcb0800bc67375f3ae225c2e',
    'ded190d444b679c231f1f2ffdab8b9fd',
    jsonb_build_array(
      jsonb_build_array(
$g$       and not (p_fragtfirma = 'dao' and fragtfirma = 'dao' and status = 'annulleret');$g$,
$n$       and not (p_fragtfirma = 'dao' and fragtfirma = 'dao' and status = 'annulleret')
       -- Shipmondo (20261024010000): en label, transportøren har bekræftet
       -- annulleret (cancelled_at_carrier), tæller heller ikke.
       and not (fragtfirma = 'shipmondo' and status = 'annulleret'
                and annullering_bekraeftet_kl is not null);$n$, 1),
      jsonb_build_array(
$g$    if p_fragtfirma = 'dao' then$g$,
$n$    if p_fragtfirma in ('dao', 'shipmondo') then$n$, 1)));
end $do$;

-- Grants som før (uændrede af rettelsen på stedet - gentages for en
-- sikkerheds skyld).
revoke all on function public.handel_gem_levering(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.handel_gem_levering(uuid, uuid, jsonb, text) to service_role;
revoke all on function public.forsendelse_claim(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.forsendelse_claim(uuid, uuid, text, text, text) to service_role;
revoke all on function public.handel_checkout(uuid) from public, anon;
grant execute on function public.handel_checkout(uuid) to authenticated;
