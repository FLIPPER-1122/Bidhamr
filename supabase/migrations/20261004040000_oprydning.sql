-- Oprydning (ROADMAP fase 1):
--   A. Behandlede rapporter (reports) slettes 48 timer efter behandling.
--   B. Afsluttede auktioner ARKIVERES 48 timer efter afsluttet handel. De
--      slettes aldrig (kvitteringer, bedoemmelser, DAC7, bogfoeringsloven: 5 aar).
--   C. pg_cron-job hver time, der koerer begge dele.
--
-- Idempotent: kan koeres flere gange.
--
-- ------------------------------------------------------------------ A. Rapporter
-- Rapporter er ikke handelsdata, og intet andet refererer til reports.id
-- (ingen FK peger paa tabellen). Afgoerelsen bevares i moderation_log:
--   - 'fjernet' / 'under_behandling' logges allerede af admin-panelet
--     (handling 'slet_auktion' med aarsag) i det oejeblik, de traeffes.
--   - 'behandlet' (afsluttet uden handling) blev ikke logget. Lige foer en
--     saadan rapport slettes, skriver oprydningen derfor en linje i
--     moderation_log med handling 'rapport_behandlet', medarbejderen der
--     behandlede den (handled_by) og tidspunktet for behandlingen
--     (handled_at), saa medarbejder-loggen stadig viser, hvem der gjorde hvad
--     og hvornaar. Anmelderens id og fritekst gemmes IKKE i loggen
--     (dataminimering) - kun kategori og medarbejderens note.
-- Undtagelse: hoerer rapporten til en auktion, hvis handel stadig er i gang
-- (ikke afregnet, aaben sag, penge holdt af en sag, ventende tilbud til
-- naeste byder), beholdes den, til handlen er afsluttet - den kan vaere
-- dokumentation i en sag. 'pending' og 'under_behandling' slettes aldrig.
--
-- ------------------------------------------------------------------ B. Arkivering
-- auctions.afsluttet_kl: hvornaar auktionen gik fra 'aktiv' til afsluttet/
--   annulleret (saettes af trigger; nulstilles, hvis den bliver aktiv igen).
-- auctions.arkiveret_kl: hvornaar oprydningen arkiverede den.
--
-- "Afsluttet handel" (handel_afsluttet_kl):
--   - status leveret/afsluttet: pengene er frigivet til saelgeren.
--   - status annulleret: betalingen er annulleret eller refunderet (eller
--     der var ingen betaling).
--   - og ingen sag holder pengene / er aaben (sag_holder_pengene, sag_aaben).
--   Tidspunktet er det seneste af frigivelse, overfoersel, refusion,
--   annullering og sagens afgoerelse/afvikling.
-- En auktion arkiveres 48 timer efter det seneste af afsluttet_kl og alle dens
-- handlers afslutning. Auktion uden bud (eller annulleret uden handel):
-- 48 timer efter afsluttet_kl. Ventende "tilbud til naeste byder" holder
-- arkiveringen tilbage. Oprettes der senere en ny handel paa auktionen
-- (naeste byder siger ja), fjernes arkiveringen igen (trigger paa trades).
--
-- Synlighed (RLS paa auctions):
--   anon:          kun ikke-arkiverede.
--   authenticated: ikke-arkiverede + arkiverede, hvor brugeren er part
--                  (saelger, vinder, byder, koeber/saelger i en handel,
--                  modtager af tilbud til naeste byder) eller staff.
--   service_role:  alt (admin-panel, cron, kvitteringer).
-- Saa forsvinder arkiverede auktioner fra soegning, forside, kategorier,
-- offentlige profiler og andres favoritter - ogsaa i appen - mens parterne
-- stadig kan aabne auktionssiden, handlen og kvitteringen via direkte link.
-- Bedoemmelser (ratings) beroeres ikke.

-- ============================================================ B1. kolonner

alter table public.auctions
  add column if not exists afsluttet_kl timestamptz,
  add column if not exists arkiveret_kl timestamptz;

comment on column public.auctions.afsluttet_kl is
  'Hvornaar auktionen gik fra aktiv til afsluttet/annulleret. Saettes af '
  'triggeren auctions_arkiv_felter. Bruges til arkivering efter 48 timer.';
comment on column public.auctions.arkiveret_kl is
  'Saettes af oprydning_koer() 48 timer efter afsluttet handel. Arkiverede '
  'auktioner vises kun for parterne og staff (RLS). Slettes aldrig.';

-- Eksisterende afsluttede/annullerede auktioner: bedste bud paa tidspunktet.
update public.auctions
   set afsluttet_kl = least(slutter_kl, now())
 where status <> 'aktiv'
   and afsluttet_kl is null;

create index if not exists auctions_til_arkivering_idx
  on public.auctions (afsluttet_kl)
  where arkiveret_kl is null and status <> 'aktiv';

create index if not exists trades_auction_id_idx on public.trades (auction_id);
create index if not exists reports_handled_at_idx
  on public.reports (handled_at)
  where status in ('behandlet', 'fjernet');

-- ============================================================ B2. trigger paa auctions

-- Brugere maa aldrig selv saette afsluttet_kl/arkiveret_kl. For alle roller:
-- skift til ikke-aktiv saetter afsluttet_kl; bliver auktionen aktiv igen
-- (fx en rapport genaabnes), nulstilles begge.
-- Eget trigger (ikke i auctions_beskyt_kolonner), saa andre migrationer kan
-- aendre den uden at skulle kende til arkiveringen.
create or replace function public.auctions_arkiv_felter()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_priv boolean :=
    coalesce(auth.role(), '') = 'service_role'
    or current_user in ('postgres', 'supabase_admin', 'service_role');
begin
  if tg_op = 'INSERT' then
    if not v_priv then
      new.afsluttet_kl := null;
      new.arkiveret_kl := null;
    end if;
    if new.status = 'aktiv' then
      new.afsluttet_kl := null;
      new.arkiveret_kl := null;
    elsif new.afsluttet_kl is null then
      new.afsluttet_kl := now();
    end if;
    return new;
  end if;

  if not v_priv
     and (new.afsluttet_kl is distinct from old.afsluttet_kl
          or new.arkiveret_kl is distinct from old.arkiveret_kl) then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;

  if new.status = 'aktiv' then
    new.afsluttet_kl := null;
    new.arkiveret_kl := null;
  elsif old.status = 'aktiv' or new.afsluttet_kl is null then
    new.afsluttet_kl := now();
  end if;

  return new;
end;
$fn$;

revoke execute on function public.auctions_arkiv_felter() from public, anon, authenticated;

drop trigger if exists auctions_arkiv_felter on public.auctions;
create trigger auctions_arkiv_felter
  before insert or update on public.auctions
  for each row execute function public.auctions_arkiv_felter();

-- ============================================================ B3. ny handel = ikke arkiveret

-- Accepterer naeste byder et tilbud efter arkiveringen, oprettes en ny handel
-- paa samme auktion. Saa er handlen ikke afsluttet laengere.
create or replace function public.trades_fjern_arkivering()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.auctions
     set arkiveret_kl = null
   where id = new.auction_id
     and arkiveret_kl is not null;
  return new;
end;
$fn$;

revoke execute on function public.trades_fjern_arkivering() from public, anon, authenticated;

drop trigger if exists trades_fjern_arkivering on public.trades;
create trigger trades_fjern_arkivering
  after insert on public.trades
  for each row execute function public.trades_fjern_arkivering();

-- ============================================================ B4. hvornaar er en handel afsluttet

-- Returnerer tidspunktet, handlen blev afsluttet, eller null, hvis den stadig
-- er i gang (eller penge/sag stadig er i spil). Intern: kun service_role og
-- databasens egne funktioner.
create or replace function public.handel_afsluttet_kl(p_trade uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  t            record;
  v_b_status   text;
  v_frigivet   timestamptz;
  v_overfoert  timestamptz;
  v_refunderet timestamptz;
  v_annulleret timestamptz;
  v_sag        timestamptz;
begin
  select id, status, sag_aaben, created_at, received_at
    into t
    from public.trades
   where id = p_trade;
  if not found then return null; end if;

  if t.sag_aaben or public.sag_holder_pengene(t.id) then return null; end if;
  if exists (select 1 from public.sager s
              where s.trade_id = t.id
                and s.status in ('aaben', 'afventer_retur')) then
    return null;
  end if;

  select max(greatest(s.oprettet_kl, s.afgjort_kl, s.afviklet_kl))
    into v_sag
    from public.sager s
   where s.trade_id = t.id;

  -- Ingen betaling (aeldre handler): variablerne forbliver null.
  select status, frigivet_kl, overfoert_kl, refunderet_kl, annulleret_kl
    into v_b_status, v_frigivet, v_overfoert, v_refunderet, v_annulleret
    from public.betalinger
   where trade_id = t.id
   order by oprettet desc
   limit 1;

  if t.status in ('leveret', 'afsluttet') then
    return greatest(v_frigivet, v_overfoert, v_refunderet,
                    v_sag, t.received_at, t.created_at);
  end if;

  if t.status = 'annulleret' then
    -- Er der betalt, skal refusionen vaere registreret, foer handlen er slut.
    if v_b_status is not null and v_b_status not in ('annulleret', 'refunderet') then
      return null;
    end if;
    return greatest(v_annulleret, v_refunderet, v_sag, t.created_at);
  end if;

  return null;
end;
$fn$;

revoke all on function public.handel_afsluttet_kl(uuid) from public, anon, authenticated;
grant execute on function public.handel_afsluttet_kl(uuid) to service_role;

-- Tidspunktet, hvor auktionen og alle dens handler er afsluttet, eller null.
create or replace function public.auktion_afsluttet_kl(p_auktion uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  a        record;
  v_t      record;
  v_handel timestamptz;
  v_slut   timestamptz;
  v_antal  integer := 0;
begin
  select id, status, vinder_id, afsluttet_kl
    into a
    from public.auctions
   where id = p_auktion;
  if not found or a.status = 'aktiv' or a.afsluttet_kl is null then
    return null;
  end if;

  if exists (select 1 from public.andenchance_tilbud c
              where c.auction_id = p_auktion and c.status = 'afventer') then
    return null;
  end if;

  v_slut := a.afsluttet_kl;
  for v_t in select id from public.trades where auction_id = p_auktion loop
    v_antal  := v_antal + 1;
    v_handel := public.handel_afsluttet_kl(v_t.id);
    if v_handel is null then return null; end if;
    v_slut := greatest(v_slut, v_handel);
  end loop;

  -- Afsluttet med vinder, men handlen er ikke oprettet endnu.
  if v_antal = 0 and a.status = 'afsluttet' and a.vinder_id is not null then
    return null;
  end if;

  return v_slut;
end;
$fn$;

revoke all on function public.auktion_afsluttet_kl(uuid) from public, anon, authenticated;
grant execute on function public.auktion_afsluttet_kl(uuid) to service_role;

-- ============================================================ B5. RLS paa auctions

-- Er den kaldende bruger part i auktionen (eller staff)? Bruges af RLS til
-- arkiverede auktioner. Tager kun auktions-id; brugeren udledes af auth.uid().
create or replace function public.auktion_arkiv_adgang(p_auktion uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null and (
       exists (select 1 from public.auctions a
                where a.id = p_auktion
                  and (a.bruger_id = auth.uid() or a.vinder_id = auth.uid()))
    or exists (select 1 from public.bids b
                where b.auktion_id = p_auktion and b.bruger_id = auth.uid())
    or exists (select 1 from public.trades t
                where t.auction_id = p_auktion
                  and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
    or exists (select 1 from public.andenchance_tilbud c
                where c.auction_id = p_auktion and c.byder_id = auth.uid())
    or public.er_staff()
  );
$fn$;

revoke all on function public.auktion_arkiv_adgang(uuid) from public, anon;
grant execute on function public.auktion_arkiv_adgang(uuid) to authenticated;

-- Separate policies for anon og authenticated, saa anon aldrig evaluerer
-- hjaelpefunktionen (den maa ikke kaldes af anon).
drop policy if exists "auctions_select_all" on public.auctions;
drop policy if exists auctions_select_anon on public.auctions;
drop policy if exists auctions_select_authenticated on public.auctions;

create policy auctions_select_anon on public.auctions
  for select to anon
  using (arkiveret_kl is null);

create policy auctions_select_authenticated on public.auctions
  for select to authenticated
  using (arkiveret_kl is null or public.auktion_arkiv_adgang(id));

-- ============================================================ A1. moderation_log

-- Alle vaerdier fra 20261003061000_connect_rettelser.sql bevares; kun
-- 'rapport_behandlet' er ny.
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
    'indpakning_paamindelse','konto_lukning_foreslaaet','konto_lukning_afvist',
    'udbetalingskonto_loest',
    'udbetalingskonto_nulstillet',
    'rapport_behandlet'));

-- ============================================================ C. oprydningen

-- Koeres af pg_cron hver time. Begraenset pr. koersel, saa et stort efterslaeb
-- tages over flere koersler. Returnerer antal slettede rapporter og
-- arkiverede auktioner.
create or replace function public.oprydning_koer()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_system     uuid;
  v_rapporter  integer := 0;
  v_arkiveret  integer := 0;
begin
  -- Systembrugeren bruges kun, hvis medarbejderen ikke laengere findes.
  select id into v_system from public.users where id = public.bidhamr_system_id();

  -- A. Rapporter. Laaser raekkerne, saa en samtidig "Genaabn" enten vinder
  -- (og rapporten er ikke laengere behandlet) eller venter.
  with kandidater as (
    select r.id, r.auction_id, r.category, r.status, r.handled_note,
           r.handled_at, coalesce(r.handled_by, v_system) as medarbejder_id,
           a.bruger_id
      from public.reports r
      join public.auctions a on a.id = r.auction_id
     where r.status in ('behandlet', 'fjernet')
       and r.handled_at is not null
       and r.handled_at < now() - interval '48 hours'
       and coalesce(r.handled_by, v_system) is not null
       and not (a.status <> 'aktiv' and public.auktion_afsluttet_kl(a.id) is null)
     order by r.handled_at
     limit 5000
       for update of r skip locked
  ), log as (
    insert into public.moderation_log
      (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag, oprettet_kl)
    select k.medarbejder_id, 'rapport_behandlet', 'auktion', k.auction_id,
           k.bruger_id,
           left('Anmeldelse (' || k.category || ') afsluttet uden handling: '
                || coalesce(nullif(btrim(k.handled_note), ''), '(ingen note)'), 2000),
           k.handled_at
      from kandidater k
     where k.status = 'behandlet'
    returning 1
  )
  delete from public.reports r
   using kandidater k
   where r.id = k.id;
  get diagnostics v_rapporter = row_count;

  -- B. Arkivering af afsluttede auktioner. Kun visning - intet slettes.
  update public.auctions a
     set arkiveret_kl = now()
   where a.id in (
           select x.id
             from public.auctions x
            where x.arkiveret_kl is null
              and x.status <> 'aktiv'
              and x.afsluttet_kl < now() - interval '48 hours'
              and public.auktion_afsluttet_kl(x.id) < now() - interval '48 hours'
            order by x.afsluttet_kl
            limit 2000)
     and a.arkiveret_kl is null
     and a.status <> 'aktiv';
  get diagnostics v_arkiveret = row_count;

  return jsonb_build_object(
    'rapporter_slettet', v_rapporter,
    'auktioner_arkiveret', v_arkiveret);
end;
$fn$;

revoke all on function public.oprydning_koer() from public, anon, authenticated;
grant execute on function public.oprydning_koer() to service_role;

select cron.unschedule('oprydning')
 where exists (select 1 from cron.job where jobname = 'oprydning');

select cron.schedule(
  'oprydning',
  '17 * * * *',
  $$select public.oprydning_koer();$$
);
