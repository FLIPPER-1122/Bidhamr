-- Advarselssystem for daarlig indpakning (ROADMAP-BESLUTNINGER afsnit 4 og
-- "Advarsler og begrundelse").
--
--   1. gang daarlig indpakning  -> paamindelse til saelgeren (taeller IKKE med)
--   2. gang og derefter         -> en advarsel hver gang (taeller med)
--   3 advarsler (alle typer)    -> forslag til staff: "3 advarsler - skal
--                                  kontoen lukkes?" (Filip, 3. oktober 2026:
--                                  ALDRIG automatisk lukning - admin/chef
--                                  godkender eller afviser)
--
-- Valg:
--   * Paamindelser er en SEPARAT tabel (public.paamindelser), ikke en type paa
--     advarsler. Saa kan en paamindelse aldrig komme til at taelle med i
--     3-reglen, og alle eksisterende steder, der taeller advarsler (admin-
--     lister, mine_advarsler, notifikations-cron, StatusBadge), forbliver
--     korrekte uden aendringer.
--   * advarsler faar kolonnerne grund, sag_id og trade_id. grund er null for
--     almindelige advarsler og 'daarlig_indpakning' for indpaknings-advarsler.
--   * Een vurdering pr. sag: unikt index paa paamindelser.sag_id og paa
--     advarsler.sag_id (hvor grund = 'daarlig_indpakning'), og
--     indpakning_vurder tjekker begge tabeller under laas paa sagen.
--   * 3-reglen: en AFTER INSERT-trigger paa advarsler (gaelder ALLE
--     advarselsveje: admin-brugerside, ubetalte vindere, Betalinger,
--     indpakning) opretter et forslag i public.konto_lukning_forslag med
--     status 'afventer', naar brugeren har 3+ advarsler. Triggeren lukker
--     ALDRIG kontoen og roerer ikke public.users. Hoejst eet afventende
--     forslag pr. bruger (unikt index); kommer der flere advarsler imens,
--     opdateres antallet. Er et forslag afvist, giver naeste advarsel et nyt.
--     Staff-konti faar ogsaa et forslag (bruger_luk_konto_permanent afviser
--     dem med 'staff', saa en chef skal fjerne rollen foerst eller afvise).
--     Systembrugeren kan ikke faa advarsler (advarsler_ikke_systembruger
--     fyrer foer og afviser); triggeren tjekker den alligevel.
--   * Admin/chef godkender via konto_lukning_godkend, der kalder den
--     eksisterende bruger_luk_konto_permanent (rolle, inhabilitet, staff-vaern
--     gaelder uaendret). suspenderet_aarsag bliver '3 advarsler' (brugeren ser
--     den ved login); staffs egen note gemmes kun paa forslaget.
--     Eller afviser via konto_lukning_afvis med begrundelse (logges).
--   * Brugeren faar INGEN besked om forslaget - kun naar lukningen er
--     godkendt (notifikations-cron: forslag med status 'godkendt').
--
-- Eksisterende brugere med 3+ advarsler faar IKKE et forslag af denne
-- migration (kun ved naeste advarsel). Find dem med:
--
--   select a.bruger_id, count(*) as antal, u.navn, u.email, u.rolle, u.konto_lukket_kl
--     from public.advarsler a join public.users u on u.id = a.bruger_id
--    group by a.bruger_id, u.navn, u.email, u.rolle, u.konto_lukket_kl
--   having count(*) >= 3;
--
-- Handelsdata slettes aldrig: paamindelser kan hverken opdateres eller
-- slettes (trigger), og FK'erne er on delete restrict.
--
-- Idempotent: if not exists / create or replace / drop ... if exists.

-- ============================================================ 1. advarsler: grund, sag, handel

alter table public.advarsler
  add column if not exists grund    text,
  add column if not exists sag_id   uuid references public.sager(id) on delete restrict,
  add column if not exists trade_id uuid references public.trades(id) on delete restrict;

alter table public.advarsler drop constraint if exists advarsler_grund_check;
alter table public.advarsler
  add constraint advarsler_grund_check check (
    grund is null or grund in ('daarlig_indpakning'));

-- En indpaknings-advarsel skal vaere knyttet til en sag og en handel.
alter table public.advarsler drop constraint if exists advarsler_indpakning_sag;
alter table public.advarsler
  add constraint advarsler_indpakning_sag check (
    grund is distinct from 'daarlig_indpakning'
    or (sag_id is not null and trade_id is not null));

-- Een indpaknings-advarsel pr. sag.
create unique index if not exists advarsler_indpakning_sag_unik
  on public.advarsler (sag_id) where grund = 'daarlig_indpakning';

create index if not exists advarsler_bruger_idx on public.advarsler (bruger_id);

comment on column public.advarsler.grund is
  'null = almindelig advarsel. daarlig_indpakning = givet via indpakning_vurder.';

-- ============================================================ 2. paamindelser

create table if not exists public.paamindelser (
  id                 uuid primary key default gen_random_uuid(),
  bruger_id          uuid not null references public.users(id) on delete restrict,
  grund              text not null,
  sag_id             uuid not null references public.sager(id) on delete restrict,
  trade_id           uuid not null references public.trades(id) on delete restrict,
  begrundelse_bruger text not null,
  intern_note        text,
  oprettet_af        uuid not null references public.users(id) on delete restrict,
  oprettet_kl        timestamptz not null default now(),
  constraint paamindelser_grund_check check (grund in ('daarlig_indpakning')),
  constraint paamindelser_begrundelse_bruger_laengde check (
    char_length(btrim(begrundelse_bruger)) between 1 and 1000),
  constraint paamindelser_intern_note_laengde check (
    intern_note is null or char_length(intern_note) <= 2000)
);

comment on table public.paamindelser is
  'Paamindelser (fx 1. gang daarlig indpakning). Taeller IKKE med i reglen om '
  '3 advarsler. Slettes og aendres aldrig. Kun service_role; brugeren laeser '
  'sine egne via mine_paamindelser().';
comment on column public.paamindelser.begrundelse_bruger is
  'Begrundelse til brugeren (1-1000 tegn). Vises i notifikation og paa /konto.';
comment on column public.paamindelser.intern_note is
  'Intern note - kun staff. Maa aldrig vises for brugeren.';

-- Een paamindelse pr. sag.
create unique index if not exists paamindelser_sag_unik on public.paamindelser (sag_id);
create index if not exists paamindelser_bruger_idx
  on public.paamindelser (bruger_id, grund);

-- Ingen policies: kun service_role. Ingen grants til browseren.
alter table public.paamindelser enable row level security;
-- Indsaettes kun via indpakning_vurder (security definer).
revoke all on public.paamindelser from public, anon, authenticated, service_role;
grant select on public.paamindelser to service_role;

-- Slettes og aendres aldrig - heller ikke af service_role.
create or replace function public.paamindelser_uforanderlig()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Påmindelser kan ikke ændres eller slettes.' using errcode = '42501';
end;
$fn$;

revoke execute on function public.paamindelser_uforanderlig() from public, anon, authenticated;

drop trigger if exists paamindelser_uforanderlig on public.paamindelser;
create trigger paamindelser_uforanderlig
  before update or delete on public.paamindelser
  for each row execute function public.paamindelser_uforanderlig();

-- Systembrugeren kan ikke faa paamindelser (som advarsler).
create or replace function public.paamindelser_ikke_systembruger()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if new.bruger_id = '00000000-0000-4000-8000-0000000b1d00'::uuid then
    raise exception 'Systembrugeren BidHamr kan ikke få påmindelser.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.paamindelser_ikke_systembruger() from public, anon, authenticated;

drop trigger if exists paamindelser_ikke_systembruger on public.paamindelser;
create trigger paamindelser_ikke_systembruger
  before insert on public.paamindelser
  for each row execute function public.paamindelser_ikke_systembruger();

-- ============================================================ 3. Brugerens egne paamindelser

-- Kun begrundelse til brugeren og dato. Brugeren udledes af auth.uid().
create or replace function public.mine_paamindelser()
returns table (id uuid, grund text, begrundelse_bruger text, oprettet_kl timestamptz)
language sql stable security definer set search_path = public as $fn$
  select p.id, p.grund, p.begrundelse_bruger, p.oprettet_kl
    from public.paamindelser p
   where p.bruger_id = auth.uid()
   order by p.oprettet_kl desc;
$fn$;

revoke all on function public.mine_paamindelser() from public, anon;
grant execute on function public.mine_paamindelser() to authenticated, service_role;

-- ============================================================ 4. moderation_log

-- Bevarer ALLE vaerdier fra 20261003010000_sager.sql og tilfoejer:
--   indpakning_paamindelse    - paamindelse for daarlig indpakning
--   konto_lukning_foreslaaet  - brugeren har naaet 3 advarsler (systemet)
--   konto_lukning_afvist      - staff afviste at lukke kontoen
-- Godkendt lukning logges som 'konto_lukket' af bruger_luk_konto_permanent.
alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest',
    'chat_aabnet','chat_lukket','faellesbesked',
    'sag_afgjort_koeber','sag_afgjort_saelger','sag_retur_afleveret',
    'sag_genaabnet','konto_lukket','sag_afviklet',
    'indpakning_paamindelse','konto_lukning_foreslaaet','konto_lukning_afvist'));

-- ============================================================ 5. 3-reglen: forslag til staff

-- status:
--   afventer   - venter paa admin/chef (rødt badge i admin)
--   godkendt   - kontoen er lukket via konto_lukning_godkend (brugeren faar besked)
--   afvist     - staff afviste med begrundelse
--   bortfaldet - kontoen var allerede lukket ad anden vej, da forslaget blev behandlet
create table if not exists public.konto_lukning_forslag (
  id                  uuid primary key default gen_random_uuid(),
  bruger_id           uuid not null references public.users(id) on delete restrict,
  advarsler_antal     integer not null,
  seneste_advarsel_id uuid references public.advarsler(id) on delete set null,
  status              text not null default 'afventer',
  oprettet_kl         timestamptz not null default now(),
  opdateret_kl        timestamptz not null default now(),
  behandlet_af        uuid references public.users(id) on delete restrict,
  behandlet_kl        timestamptz,
  -- Intern note/begrundelse fra staff (kraeves ved afvisning). Kun staff.
  begrundelse         text,
  constraint konto_lukning_forslag_status_check check (
    status in ('afventer', 'godkendt', 'afvist', 'bortfaldet')),
  constraint konto_lukning_forslag_antal_check check (advarsler_antal >= 3),
  constraint konto_lukning_forslag_begrundelse_laengde check (
    begrundelse is null or char_length(begrundelse) <= 2000),
  constraint konto_lukning_forslag_behandlet_par check (
    status = 'afventer' or (behandlet_af is not null and behandlet_kl is not null)),
  constraint konto_lukning_forslag_afvist_begrundelse check (
    status <> 'afvist' or begrundelse is not null)
);

comment on table public.konto_lukning_forslag is
  'Brugere med 3+ advarsler: "skal kontoen lukkes?". Oprettes af triggeren '
  'advarsler_tre_foreslaa_lukning. Lukker ALDRIG selv - admin/chef godkender '
  '(konto_lukning_godkend) eller afviser (konto_lukning_afvis). Slettes aldrig.';

-- Hoejst eet afventende forslag pr. bruger.
create unique index if not exists konto_lukning_forslag_afventer_unik
  on public.konto_lukning_forslag (bruger_id) where status = 'afventer';
create index if not exists konto_lukning_forslag_status_idx
  on public.konto_lukning_forslag (status, oprettet_kl);
create index if not exists konto_lukning_forslag_bruger_idx
  on public.konto_lukning_forslag (bruger_id);

-- Kun service_role. Ingen policies.
alter table public.konto_lukning_forslag enable row level security;
revoke all on public.konto_lukning_forslag from public, anon, authenticated, service_role;
grant select on public.konto_lukning_forslag to service_role;

-- Slettes aldrig (heller ikke af service_role). Aendringer sker kun via
-- funktionerne nedenfor (security definer, ejet af postgres).
create or replace function public.konto_lukning_forslag_beskyt()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Forslag om lukning kan ikke slettes.' using errcode = '42501';
  end if;
  -- Et behandlet forslag kan ikke aendres igen.
  if old.status <> 'afventer' then
    raise exception 'Forslaget er allerede behandlet.' using errcode = '42501';
  end if;
  if new.bruger_id is distinct from old.bruger_id
     or new.oprettet_kl is distinct from old.oprettet_kl then
    raise exception 'Forslaget kan ikke flyttes til en anden bruger.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.konto_lukning_forslag_beskyt() from public, anon, authenticated;

drop trigger if exists konto_lukning_forslag_beskyt on public.konto_lukning_forslag;
create trigger konto_lukning_forslag_beskyt
  before update or delete on public.konto_lukning_forslag
  for each row execute function public.konto_lukning_forslag_beskyt();

-- Efter hver ny advarsel: har brugeren nu 3+ advarsler (alle typer;
-- paamindelser taeller ikke), og er kontoen ikke lukket, oprettes (eller
-- opdateres) et afventende forslag. Lukker ALDRIG kontoen og aendrer intet
-- paa brugeren.
create or replace function public.advarsler_tre_foreslaa_lukning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  u      record;
  antal  integer;
  v_id   uuid;
  sys    constant uuid := public.bidhamr_system_id();
begin
  if new.bruger_id is null or new.bruger_id = sys then
    return null;
  end if;

  -- Laas brugeren (uden at blokere FK-opslag), saa samtidige advarsler
  -- taelles korrekt: den sidste ser altid den foerste.
  select id, konto_lukket_kl into u
    from public.users where id = new.bruger_id for no key update;
  if not found or u.konto_lukket_kl is not null then return null; end if;

  select count(*) into antal from public.advarsler where bruger_id = new.bruger_id;
  if antal < 3 then return null; end if;

  -- Findes der allerede et afventende forslag, opdateres antallet.
  update public.konto_lukning_forslag
     set advarsler_antal = antal,
         seneste_advarsel_id = new.id,
         opdateret_kl = now()
   where bruger_id = new.bruger_id and status = 'afventer';
  if found then return null; end if;

  insert into public.konto_lukning_forslag (bruger_id, advarsler_antal, seneste_advarsel_id)
  values (new.bruger_id, antal, new.id)
  on conflict (bruger_id) where status = 'afventer' do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (sys, 'konto_lukning_foreslaaet', 'bruger', new.bruger_id, new.bruger_id,
            'Brugeren har ' || antal || ' advarsler. Forslag om permanent lukning '
            || v_id::text || ' afventer admin/chef.');
  end if;

  return null;
end;
$fn$;

revoke execute on function public.advarsler_tre_foreslaa_lukning() from public, anon, authenticated;

drop trigger if exists advarsler_tre_foreslaa_lukning on public.advarsler;
create trigger advarsler_tre_foreslaa_lukning
  after insert on public.advarsler
  for each row execute function public.advarsler_tre_foreslaa_lukning();

-- Admin/chef godkender: kontoen lukkes via den eksisterende
-- bruger_luk_konto_permanent (rolle admin+, sig_selv, staff, inhabil gaelder
-- uaendret). Brugeren ser aarsagen '3 advarsler' ved login; p_note er intern.
-- Koder: ok, ingen_adgang, ikke_fundet, behandlet, for_lang_tekst,
-- bortfaldet (kontoen var allerede lukket - forslaget markeres bortfaldet),
-- + alle koder fra bruger_luk_konto_permanent (sig_selv, staff, inhabil, ...).
create or replace function public.konto_lukning_godkend(
  p_medarbejder uuid,
  p_forslag     uuid,
  p_note        text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f      record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  r      jsonb;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select * into f from public.konto_lukning_forslag where id = p_forslag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if f.status <> 'afventer' then
    return jsonb_build_object('kode', 'behandlet', 'status', f.status);
  end if;

  r := public.bruger_luk_konto_permanent(p_medarbejder, f.bruger_id, '3 advarsler', null);

  if r->>'kode' = 'allerede_lukket' then
    update public.konto_lukning_forslag
       set status = 'bortfaldet', behandlet_af = p_medarbejder, behandlet_kl = now(),
           begrundelse = coalesce(v_note, 'Kontoen var allerede lukket.'), opdateret_kl = now()
     where id = f.id and status = 'afventer';
    return jsonb_build_object('kode', 'bortfaldet', 'bruger_id', f.bruger_id);
  end if;
  if r->>'kode' <> 'ok' then
    return r;
  end if;

  update public.konto_lukning_forslag
     set status = 'godkendt', behandlet_af = p_medarbejder, behandlet_kl = now(),
         begrundelse = v_note, opdateret_kl = now()
   where id = f.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'bruger_id', f.bruger_id, 'forslag_id', f.id);
end;
$fn$;

revoke all on function public.konto_lukning_godkend(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.konto_lukning_godkend(uuid, uuid, text) to service_role;

-- Admin/chef afviser med begrundelse (intern, kraeves). Samme inhabilitet som
-- bruger_luk_konto_permanent: ikke sig selv, og ikke hvis der findes en sag
-- paa en handel mellem medarbejderen og brugeren.
-- Koder: ok, ingen_adgang, begrundelse_mangler, for_lang_tekst, ikke_fundet,
-- behandlet, sig_selv, inhabil.
create or replace function public.konto_lukning_afvis(
  p_medarbejder uuid,
  p_forslag     uuid,
  p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f      record;
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select * into f from public.konto_lukning_forslag where id = p_forslag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if f.status <> 'afventer' then
    return jsonb_build_object('kode', 'behandlet', 'status', f.status);
  end if;
  if f.bruger_id = p_medarbejder then return jsonb_build_object('kode', 'sig_selv'); end if;
  if exists (
    select 1 from public.sager s join public.trades t on t.id = s.trade_id
     where (t.buyer_id = p_medarbejder and t.seller_id = f.bruger_id)
        or (t.seller_id = p_medarbejder and t.buyer_id = f.bruger_id)) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.konto_lukning_forslag
     set status = 'afvist', behandlet_af = p_medarbejder, behandlet_kl = now(),
         begrundelse = v_grund, opdateret_kl = now()
   where id = f.id and status = 'afventer';
  if not found then return jsonb_build_object('kode', 'behandlet'); end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'konto_lukning_afvist', 'bruger', f.bruger_id, f.bruger_id,
          left('Lukning efter ' || f.advarsler_antal || ' advarsler afvist | ' || v_grund, 4000));

  return jsonb_build_object('kode', 'ok', 'bruger_id', f.bruger_id);
end;
$fn$;

revoke all on function public.konto_lukning_afvis(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.konto_lukning_afvis(uuid, uuid, text) to service_role;

-- ============================================================ 6. indpakning_vurder

-- Staff (medarbejder+) vurderer, at saelgeren har pakket daarligt i en sag.
-- Saelgeren findes via sagens handel.
--   Ingen tidligere indpaknings-paamindelse -> paamindelse (taeller ikke).
--   Ellers                                   -> advarsel (taeller med; 3-reglen
--                                               giver et forslag til staff via triggeren).
-- Een vurdering pr. sag: en ny vurdering paa samme sag afvises med
-- 'allerede_vurderet' (og hvad der skete foerste gang).
--
-- Returnerer {"kode": "ok", "resultat": "paamindelse"|"advarsel", "id",
-- "saelger_id", "trade_id", "advarsler_antal", "lukning_foreslaaet"} eller
-- fejlkoder: ingen_adgang, begrundelse_bruger_mangler,
-- begrundelse_bruger_for_lang, for_lang_tekst, ikke_fundet, inhabil,
-- afhentning, allerede_vurderet (+ "resultat").
create or replace function public.indpakning_vurder(
  p_medarbejder        uuid,
  p_sag                uuid,
  p_begrundelse_bruger text,
  p_intern_note        text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger  text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  v_note    text := nullif(btrim(coalesce(p_intern_note, '')), '');
  s         record;
  t         record;
  v_id      uuid;
  v_antal   integer;
  v_forslag boolean;
  standard  constant text := 'Dårlig indpakning';
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
  if char_length(v_bruger) > 1000 then
    return jsonb_build_object('kode', 'begrundelse_bruger_for_lang');
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  -- Laas sagen: samtidige vurderinger af samme sag serialiseres.
  select id, trade_id into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select id, buyer_id, seller_id, afhentning into t
    from public.trades where id = s.trade_id;
  if not found or t.seller_id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  -- Ingen maa behandle en sag, hvor han selv er koeber eller saelger.
  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  -- Ved afhentning er der ingen indpakning at vurdere.
  if coalesce(t.afhentning, false) then
    return jsonb_build_object('kode', 'afhentning');
  end if;
  if t.seller_id = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Idempotent: een vurdering pr. sag.
  if exists (select 1 from public.paamindelser where sag_id = s.id) then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'paamindelse');
  end if;
  if exists (select 1 from public.advarsler
              where sag_id = s.id and grund = 'daarlig_indpakning') then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'advarsel');
  end if;

  -- Laas saelgeren: samtidige vurderinger paa FORSKELLIGE sager med samme
  -- saelger maa ikke begge give "foerste gang" (paamindelse).
  perform 1 from public.users where id = t.seller_id for no key update;

  if not exists (select 1 from public.paamindelser
                  where bruger_id = t.seller_id and grund = 'daarlig_indpakning') then
    insert into public.paamindelser (
      bruger_id, grund, sag_id, trade_id, begrundelse_bruger, intern_note, oprettet_af)
    values (
      t.seller_id, 'daarlig_indpakning', s.id, t.id, v_bruger, v_note, p_medarbejder)
    returning id into v_id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'indpakning_paamindelse', 'sag', s.id, t.seller_id,
            left('Påmindelse: dårlig indpakning' || coalesce(' | ' || v_note, '')
                 || ' | Til sælgeren: ' || v_bruger, 4000));

    select count(*) into v_antal from public.advarsler where bruger_id = t.seller_id;
    return jsonb_build_object(
      'kode', 'ok', 'resultat', 'paamindelse', 'id', v_id,
      'saelger_id', t.seller_id, 'trade_id', t.id,
      'advarsler_antal', v_antal,
      'lukning_foreslaaet', exists (select 1 from public.konto_lukning_forslag
                                     where bruger_id = t.seller_id and status = 'afventer'));
  end if;

  -- Advarsel. 3-reglen (forslag til staff) koerer i triggeren
  -- advarsler_tre_foreslaa_lukning. Kontoen lukkes ALDRIG her.
  insert into public.advarsler (
    bruger_id, oprettet_af, aarsag, begrundelse_bruger, grund, sag_id, trade_id)
  values (
    t.seller_id, p_medarbejder, coalesce(v_note, standard), v_bruger,
    'daarlig_indpakning', s.id, t.id)
  returning id into v_id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'advarsel', 'sag', s.id, t.seller_id,
          left('Advarsel: dårlig indpakning' || coalesce(' | ' || v_note, '')
               || ' | Til sælgeren: ' || v_bruger, 4000));

  select count(*) into v_antal from public.advarsler where bruger_id = t.seller_id;
  v_forslag := exists (select 1 from public.konto_lukning_forslag
                        where bruger_id = t.seller_id and status = 'afventer');

  return jsonb_build_object(
    'kode', 'ok', 'resultat', 'advarsel', 'id', v_id,
    'saelger_id', t.seller_id, 'trade_id', t.id,
    'advarsler_antal', v_antal,
    'lukning_foreslaaet', v_forslag);
end;
$fn$;

revoke all on function public.indpakning_vurder(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.indpakning_vurder(uuid, uuid, text, text) to service_role;
