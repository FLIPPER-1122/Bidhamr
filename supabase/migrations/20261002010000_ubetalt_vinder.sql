-- Vinderen betaler ikke (ROADMAP-BESLUTNINGER.md, "Vinderen betaler ikke",
-- Filip 2. oktober 2026).
--
--   1. trades: én AKTIV handel pr. auktion i stedet for én handel i alt.
--      Den unikke begraensning trades_auction_id_key erstattes af et partial
--      unique index (status <> 'annulleret'), saa en annulleret handel kan
--      efterfoelges af en ny handel med naesthoejeste byder.
--      afslut_udloebne_auktioner genoprettes med on conflict mod det nye index.
--   2. ubetalte_vindere: sag til admin, naar en handel annulleres, fordi
--      vinderen ikke betalte. Advarsel gives IKKE automatisk.
--   3. andenchance_tilbud: saelgeren tilbyder varen til naeste byder.
--   4. genopsaetninger: kobling mellem en auktion og dens genopsaetning.
--   5. Funktioner (kun service_role; serveren udleder brugeren og sender id'et):
--      ubetalt_vinder_annuller, andenchance_opret, andenchance_svar,
--      andenchance_udloeb, genopsaet_auktion, advarsel_ubetalt.
--   6. moderation_log: ny handling 'ubetalt_afvist'.
--
-- Idempotent. Intet slettes; ingen eksisterende raekker aendres.

-- ============================================================ 1. trades

alter table public.trades drop constraint if exists trades_auction_id_key;

create unique index if not exists trades_en_aktiv_pr_auktion
  on public.trades (auction_id)
  where status <> 'annulleret';

create index if not exists trades_auction_idx
  on public.trades (auction_id, created_at desc);

comment on index public.trades_en_aktiv_pr_auktion is
  'Hoejst én ikke-annulleret handel pr. auktion. Annullerede handler bevares '
  '(bogfoeringsloven), og en ny handel kan oprettes via andenchance_svar.';

-- Ordret som i 20261002000000_fjern_wallet.sql. Eneste aendring: on conflict
-- rammer det nye partial index. not exists-tjekket staar uaendret: findes der
-- nogen handel paa auktionen (ogsaa en annulleret), oprettes ingen ny her -
-- naeste handel oprettes kun af andenchance_svar.
create or replace function public.afslut_udloebne_auktioner()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  antal integer;
  r     record;
  bud   bigint;
  koeb  bigint;
  saelg bigint;
  fragt bigint;
  besk_valg boolean;
  besk  bigint;
  t_id  uuid;
begin
  update public.auctions a
     set status = 'afsluttet',
         vinder_id = (
           select b.bruger_id
             from public.bids b
            where b.auktion_id = a.id
            order by b.beløb desc, b.oprettet asc
            limit 1
         )
   where a.status = 'aktiv'
     and a.slutter_kl <= now();

  get diagnostics antal = row_count;

  for r in
    select a.id, a.bruger_id, a.vinder_id, a.forsendelse_mulig
      from public.auctions a
     where a.status = 'afsluttet'
       and a.vinder_id is not null
       and a.slutter_kl >= now() - interval '7 days'
       and not exists (select 1 from public.trades t where t.auction_id = a.id)
  loop
    begin
      t_id := null;
      select round(max(b.beløb) * 100)::bigint into bud
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id;

      if bud is null or bud <= 0 then
        raise warning 'ingen gyldigt vinderbud for auktion %', r.id;
        continue;
      end if;

      select coalesce(b.beskyttelse, false) into besk_valg
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id
       order by b.oprettet desc, b.beløb desc
       limit 1;
      besk_valg := coalesce(besk_valg, false);

      koeb  := round(bud * 5 / 100.0)::bigint;
      saelg := round(bud * 5 / 100.0)::bigint;
      fragt := case when coalesce(r.forsendelse_mulig, false) then 3500 else 0 end;
      besk  := case when besk_valg then public.beregn_beskyttelse_oere(bud) else 0 end;

      insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
      values (r.id, r.bruger_id, r.vinder_id, bud / 100.0, 'afventer_betaling')
      on conflict (auction_id) where status <> 'annulleret' do nothing
      returning id into t_id;

      if t_id is null then continue; end if;

      insert into public.betalinger (
        trade_id, auction_id, buyer_id, seller_id,
        bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
        total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
      values (
        t_id, r.id, r.vinder_id, r.bruger_id,
        bud, koeb, fragt, besk_valg, besk,
        bud + koeb + fragt + besk, saelg, bud - saelg,
        now() + interval '24 hours')
      on conflict (trade_id) do nothing;
    exception when others then
      raise warning 'handel/betaling fejlede for auktion %: %', r.id, sqlerrm;
    end;
  end loop;

  return antal;
end;
$fn$;

revoke all on function public.afslut_udloebne_auktioner() from public, anon, authenticated;
grant execute on function public.afslut_udloebne_auktioner() to service_role;

-- ============================================================ faelles: slet aldrig

create or replace function public.handelsdata_forbyd_sletning()
returns trigger language plpgsql set search_path = public as $fn$
begin
  raise exception 'handelsdata_slettes_aldrig: %', tg_table_name;
end;
$fn$;

revoke execute on function public.handelsdata_forbyd_sletning() from public, anon, authenticated;

-- ============================================================ 2. ubetalte_vindere

create table if not exists public.ubetalte_vindere (
  id            uuid primary key default gen_random_uuid(),
  trade_id      uuid not null unique references public.trades(id) on delete restrict,
  auction_id    uuid not null references public.auctions(id) on delete restrict,
  buyer_id      uuid not null references public.users(id) on delete restrict,
  seller_id     uuid not null references public.users(id) on delete restrict,
  oprettet      timestamptz not null default now(),
  status        text not null default 'afventer'
                  check (status in ('afventer', 'advarsel_givet', 'afvist')),
  behandlet_af  uuid references public.users(id) on delete restrict,
  behandlet_kl  timestamptz,
  begrundelse   text,

  -- Cron: Stripe-annullering og mails. Claimes atomisk foer afsendelse.
  stripe_annulleret_kl    timestamptz,
  koeber_mail_sendt_kl    timestamptz,
  saelger_mail_sendt_kl   timestamptz,

  constraint ubetalte_vindere_behandlet check (
    (status = 'afventer' and behandlet_af is null and behandlet_kl is null)
    or (status <> 'afventer' and behandlet_af is not null and behandlet_kl is not null)),
  constraint ubetalte_vindere_afvist_begrundet check (
    status <> 'afvist' or length(btrim(coalesce(begrundelse, ''))) > 0)
);

create index if not exists ubetalte_vindere_status_idx
  on public.ubetalte_vindere (status, oprettet);
create index if not exists ubetalte_vindere_buyer_idx
  on public.ubetalte_vindere (buyer_id, oprettet desc);

comment on table public.ubetalte_vindere is
  'Sag "Ubetalt vinder": oprettes, naar en handel annulleres, fordi koeberen ikke '
  'betalte inden fristen. En medarbejder giver advarsel eller afviser. '
  'Kun service-role. Slettes aldrig.';

alter table public.ubetalte_vindere enable row level security;
revoke all on public.ubetalte_vindere from public, anon, authenticated;
grant all on public.ubetalte_vindere to service_role;

drop trigger if exists ubetalte_vindere_forbyd_sletning_trg on public.ubetalte_vindere;
create trigger ubetalte_vindere_forbyd_sletning_trg
  before delete on public.ubetalte_vindere
  for each row execute function public.handelsdata_forbyd_sletning();

-- ============================================================ 3. andenchance_tilbud

create table if not exists public.andenchance_tilbud (
  id                   uuid primary key default gen_random_uuid(),
  auction_id           uuid not null references public.auctions(id) on delete restrict,
  oprindelig_trade_id  uuid not null references public.trades(id) on delete restrict,
  seller_id            uuid not null references public.users(id) on delete restrict,
  byder_id             uuid not null references public.users(id) on delete restrict,
  bud_oere             bigint not null check (bud_oere > 0),
  beskyttelse          boolean not null default false,
  status               text not null default 'afventer'
                         check (status in ('afventer', 'accepteret', 'afvist',
                                           'udloebet', 'annulleret')),
  udloeber             timestamptz not null,
  ny_trade_id          uuid unique references public.trades(id) on delete restrict,
  oprettet             timestamptz not null default now(),
  besvaret_kl          timestamptz,

  -- Mails. Claimes atomisk foer afsendelse.
  byder_mail_sendt_kl    timestamptz,
  saelger_mail_sendt_kl  timestamptz,

  constraint andenchance_ikke_saelger check (byder_id <> seller_id),
  constraint andenchance_accepteret_har_handel check (
    (status = 'accepteret') = (ny_trade_id is not null)),
  -- Samme byder tilbydes kun én gang pr. auktion.
  constraint andenchance_en_gang_pr_byder unique (auction_id, byder_id)
);

create unique index if not exists andenchance_et_aktivt_pr_auktion
  on public.andenchance_tilbud (auction_id)
  where status = 'afventer';
create index if not exists andenchance_byder_idx
  on public.andenchance_tilbud (byder_id, oprettet desc);
create index if not exists andenchance_status_idx
  on public.andenchance_tilbud (status, udloeber);
create index if not exists andenchance_trade_idx
  on public.andenchance_tilbud (oprindelig_trade_id);

comment on table public.andenchance_tilbud is
  'Saelgerens tilbud til naeste byder, naar vinderen ikke betalte. Byderen har '
  '24 timer. Hoejst ét aktivt tilbud pr. auktion. Slettes aldrig.';

alter table public.andenchance_tilbud enable row level security;

drop policy if exists andenchance_select_part on public.andenchance_tilbud;
-- Kun byderen selv (og staff) kan laese raekken direkte. Saelgeren ser
-- status via serveren (hentAndenchanceStatus) uden byderens id - bydere er
-- anonyme for andre (privatliv, se 20261001035000).
create policy andenchance_select_part on public.andenchance_tilbud
  for select to authenticated using (
    byder_id = auth.uid() or public.er_staff());

revoke all on public.andenchance_tilbud from public, anon, authenticated;
grant select on public.andenchance_tilbud to authenticated;
grant all on public.andenchance_tilbud to service_role;

drop trigger if exists andenchance_forbyd_sletning_trg on public.andenchance_tilbud;
create trigger andenchance_forbyd_sletning_trg
  before delete on public.andenchance_tilbud
  for each row execute function public.handelsdata_forbyd_sletning();

-- ============================================================ 4. genopsaetninger

-- En afsluttet auktion kan genopsaettes én gang. Koblingen ligger i sin egen
-- tabel, saa auctions-triggerne (laas af systemfelter) ikke skal aendres.
create table if not exists public.genopsaetninger (
  id                uuid primary key default gen_random_uuid(),
  gammel_auction_id uuid not null unique references public.auctions(id) on delete restrict,
  ny_auction_id     uuid not null unique references public.auctions(id) on delete restrict,
  seller_id         uuid not null references public.users(id) on delete restrict,
  oprettet          timestamptz not null default now()
);

alter table public.genopsaetninger enable row level security;
revoke all on public.genopsaetninger from public, anon, authenticated;
grant all on public.genopsaetninger to service_role;

drop trigger if exists genopsaetninger_forbyd_sletning_trg on public.genopsaetninger;
create trigger genopsaetninger_forbyd_sletning_trg
  before delete on public.genopsaetninger
  for each row execute function public.handelsdata_forbyd_sletning();

-- ============================================================ 5a. annuller ubetalt

-- Atomisk og idempotent. Returnerer
--   { annulleret: bool, payment_intent: text|null, sag_id: uuid|null }
-- annulleret = true kun for den kørsel, der faktisk annullerede.
create or replace function public.ubetalt_vinder_annuller(p_trade uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b     record;
  sag   uuid;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then
    return jsonb_build_object('annulleret', false, 'payment_intent', null, 'sag_id', null);
  end if;

  if b.status not in ('afventer', 'behandles') or b.betal_senest >= now() then
    return jsonb_build_object('annulleret', false,
                              'payment_intent', b.stripe_payment_intent_id,
                              'sag_id', null);
  end if;

  perform public.betaling_annuller(p_trade);

  insert into public.ubetalte_vindere (trade_id, auction_id, buyer_id, seller_id)
  values (p_trade, b.auction_id, b.buyer_id, b.seller_id)
  on conflict (trade_id) do nothing
  returning id into sag;

  -- Et evt. accepteret andenchance-tilbud, der foerte til handlen, er
  -- uaendret 'accepteret' (historik). Saelgeren kan sende til naeste byder.
  return jsonb_build_object('annulleret', true,
                            'payment_intent', b.stripe_payment_intent_id,
                            'sag_id', sag);
end;
$fn$;

revoke all on function public.ubetalt_vinder_annuller(uuid) from public, anon, authenticated;
grant execute on function public.ubetalt_vinder_annuller(uuid) to service_role;

-- ============================================================ 5b. andenchance opret

-- p_seller er den indloggede bruger (udledt paa serveren via auth).
-- Returnerer { kode, tilbud_id?, byder_id?, bud_oere?, udloeber? }.
-- Koder: ok, ikke_fundet, ikke_saelger, ikke_ubetalt, aktivt_tilbud, solgt,
--        genopsat, ingen_flere_bydere.
create or replace function public.andenchance_opret(p_trade uuid, p_seller uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  t      record;
  a_id   uuid;
  naeste record;
  besk   boolean;
  ny     record;
begin
  select * into t from public.trades where id = p_trade;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if t.seller_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  -- Laas auktionen, saa samtidige kald (opret/svar/genopsaet) koeres i serie.
  select id into a_id from public.auctions where id = t.auction_id for update;

  if t.status <> 'annulleret'
     or not exists (select 1 from public.ubetalte_vindere u where u.trade_id = t.id) then
    return jsonb_build_object('kode', 'ikke_ubetalt');
  end if;

  if exists (select 1 from public.andenchance_tilbud x
              where x.auction_id = t.auction_id and x.status = 'afventer') then
    return jsonb_build_object('kode', 'aktivt_tilbud');
  end if;

  if exists (select 1 from public.trades x
              where x.auction_id = t.auction_id and x.status <> 'annulleret') then
    return jsonb_build_object('kode', 'solgt');
  end if;

  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = t.auction_id) then
    return jsonb_build_object('kode', 'genopsat');
  end if;

  -- Naeste byder: hoejeste bud pr. bruger, uden saelgeren, tidligere koebere
  -- paa auktionen, tidligere tilbudte bydere og aktivt suspenderede brugere.
  -- Ved lige bud gaar den foerst, der foerst bød beloebet (som ved vinderen).
  with hoejeste as (
    select b.bruger_id, max(b.beløb) as maks
      from public.bids b
     where b.auktion_id = t.auction_id
     group by b.bruger_id
  )
  select h.bruger_id,
         round(h.maks * 100)::bigint as bud_oere,
         (select min(b.oprettet) from public.bids b
           where b.auktion_id = t.auction_id
             and b.bruger_id = h.bruger_id
             and b.beløb = h.maks) as foerste
    into naeste
    from hoejeste h
    join public.users u on u.id = h.bruger_id
   where h.maks > 0
     and h.bruger_id <> t.seller_id
     and not exists (select 1 from public.trades x
                      where x.auction_id = t.auction_id and x.buyer_id = h.bruger_id)
     and not exists (select 1 from public.andenchance_tilbud x
                      where x.auction_id = t.auction_id and x.byder_id = h.bruger_id)
     and not (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()))
   order by h.maks desc, foerste asc
   limit 1;

  if not found then return jsonb_build_object('kode', 'ingen_flere_bydere'); end if;

  select coalesce(b.beskyttelse, false) into besk
    from public.bids b
   where b.auktion_id = t.auction_id and b.bruger_id = naeste.bruger_id
   order by b.oprettet desc, b.beløb desc
   limit 1;

  insert into public.andenchance_tilbud (
    auction_id, oprindelig_trade_id, seller_id, byder_id, bud_oere,
    beskyttelse, udloeber)
  values (
    t.auction_id, t.id, t.seller_id, naeste.bruger_id, naeste.bud_oere,
    coalesce(besk, false), now() + interval '24 hours')
  returning id, byder_id, bud_oere, udloeber into ny;

  return jsonb_build_object('kode', 'ok', 'tilbud_id', ny.id, 'byder_id', ny.byder_id,
                            'bud_oere', ny.bud_oere, 'udloeber', ny.udloeber);
end;
$fn$;

revoke all on function public.andenchance_opret(uuid, uuid) from public, anon, authenticated;
grant execute on function public.andenchance_opret(uuid, uuid) to service_role;

-- ============================================================ 5c. andenchance svar

-- p_byder er den indloggede bruger. Returnerer { kode, trade_id? }.
-- Koder: ok, ikke_fundet, ikke_byder, besvaret, udloebet, solgt, genopsat,
--        suspenderet.
create or replace function public.andenchance_svar(p_tilbud uuid, p_byder uuid, p_ja boolean)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  x     record;
  a     record;
  u     record;
  bud   bigint;
  koeb  bigint;
  saelg bigint;
  fragt bigint;
  besk  bigint;
  t_id  uuid;
begin
  select * into x from public.andenchance_tilbud where id = p_tilbud;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if x.byder_id is distinct from p_byder then
    return jsonb_build_object('kode', 'ikke_byder');
  end if;

  -- Samme laaseraekkefoelge som andenchance_opret: auktion, derefter tilbud.
  select * into a from public.auctions where id = x.auction_id for update;
  select * into x from public.andenchance_tilbud where id = p_tilbud for update;

  if x.status <> 'afventer' then return jsonb_build_object('kode', 'besvaret'); end if;
  if x.udloeber <= now() then
    update public.andenchance_tilbud set status = 'udloebet'
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'udloebet');
  end if;

  if not p_ja then
    update public.andenchance_tilbud
       set status = 'afvist', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'ok');
  end if;

  if exists (select 1 from public.trades t
              where t.auction_id = x.auction_id and t.status <> 'annulleret') then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'solgt');
  end if;

  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = x.auction_id) then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'genopsat');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = p_byder;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  -- Samme beloebslogik som afslut_udloebne_auktioner.
  bud   := x.bud_oere;
  koeb  := round(bud * 5 / 100.0)::bigint;
  saelg := round(bud * 5 / 100.0)::bigint;
  fragt := case when coalesce(a.forsendelse_mulig, false) then 3500 else 0 end;
  besk  := case when x.beskyttelse then public.beregn_beskyttelse_oere(bud) else 0 end;

  insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
  values (x.auction_id, x.seller_id, x.byder_id, bud / 100.0, 'afventer_betaling')
  returning id into t_id;

  insert into public.betalinger (
    trade_id, auction_id, buyer_id, seller_id,
    bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
    total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
  values (
    t_id, x.auction_id, x.byder_id, x.seller_id,
    bud, koeb, fragt, x.beskyttelse, besk,
    bud + koeb + fragt + besk, saelg, bud - saelg,
    now() + interval '24 hours');

  update public.auctions set vinder_id = x.byder_id where id = x.auction_id;

  update public.andenchance_tilbud
     set status = 'accepteret', besvaret_kl = now(), ny_trade_id = t_id
   where id = x.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'trade_id', t_id);
end;
$fn$;

revoke all on function public.andenchance_svar(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.andenchance_svar(uuid, uuid, boolean) to service_role;

-- ============================================================ 5d. andenchance udloeb

create or replace function public.andenchance_udloeb()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  antal integer;
begin
  update public.andenchance_tilbud
     set status = 'udloebet'
   where status = 'afventer'
     and udloeber <= now();
  get diagnostics antal = row_count;
  return antal;
end;
$fn$;

revoke all on function public.andenchance_udloeb() from public, anon, authenticated;
grant execute on function public.andenchance_udloeb() to service_role;

-- ============================================================ 5e. genopsaet

-- p_seller er den indloggede bruger. Opretter en NY auktion med samme indhold;
-- den gamle roeres ikke. Et ventende andenchance-tilbud annulleres.
-- Returnerer { kode, auction_id? }.
-- Koder: ok, ikke_fundet, ikke_saelger, ikke_afsluttet, skjult, solgt,
--        allerede_genopsat, ugyldig_startpris, ugyldig_slutdato.
create or replace function public.genopsaet_auktion(
  p_auction uuid, p_seller uuid, p_startpris numeric, p_slutter_kl timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  a     record;
  ny_id uuid;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;
  if a.status <> 'afsluttet' then return jsonb_build_object('kode', 'ikke_afsluttet'); end if;
  if a.skjult then return jsonb_build_object('kode', 'skjult'); end if;

  if exists (select 1 from public.trades t
              where t.auction_id = a.id and t.status <> 'annulleret') then
    return jsonb_build_object('kode', 'solgt');
  end if;
  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = a.id) then
    return jsonb_build_object('kode', 'allerede_genopsat');
  end if;

  -- Samme regler som ved oprettelse (auctions_beskyt_ny og formularen).
  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  if p_slutter_kl is null or p_slutter_kl <= now()
     or p_slutter_kl > now() + interval '30 days' then
    return jsonb_build_object('kode', 'ugyldig_slutdato');
  end if;

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, kategori, postnummer, lat, lng,
    maerke, stand, skjult)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, p_startpris, a.lokation,
    a.forsendelse_mulig, 'aktiv', p_slutter_kl, a.kategori, a.postnummer, a.lat, a.lng,
    a.maerke, a.stand, false)
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

-- ============================================================ 6. moderation_log

alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist'));

-- ============================================================ 5f. advarsel

-- p_medarbejder er den indloggede medarbejder (assertRole paa serveren;
-- rollen tjekkes ogsaa her). p_giv = true giver advarsel til koeberen,
-- false afviser sagen (begrundelse paakraevet).
-- Returnerer { kode }. Koder: ok, ikke_fundet, ingen_adgang, behandlet,
-- begrundelse_mangler.
create or replace function public.advarsel_ubetalt(
  p_sag uuid, p_medarbejder uuid, p_giv boolean, p_begrundelse text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  s      record;
  grund  text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  aarsag constant text := 'Betalte ikke for vundet auktion';
begin
  if not exists (select 1 from public.users
                  where id = p_medarbejder and rolle in ('medarbejder', 'admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  select * into s from public.ubetalte_vindere where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if s.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;
  if not p_giv and grund is null then
    return jsonb_build_object('kode', 'begrundelse_mangler');
  end if;

  update public.ubetalte_vindere
     set status       = case when p_giv then 'advarsel_givet' else 'afvist' end,
         behandlet_af = p_medarbejder,
         behandlet_kl = now(),
         begrundelse  = case when p_giv then coalesce(grund, aarsag) else grund end
   where id = s.id and status = 'afventer';

  if p_giv then
    insert into public.advarsler (bruger_id, oprettet_af, aarsag)
    values (s.buyer_id, p_medarbejder, aarsag);

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'advarsel', 'handel', s.trade_id, s.buyer_id,
            aarsag || coalesce(': ' || grund, ''));
  else
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'ubetalt_afvist', 'handel', s.trade_id, s.buyer_id, grund);
  end if;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.advarsel_ubetalt(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.advarsel_ubetalt(uuid, uuid, boolean, text) to service_role;
