-- Rettelser til 20261004040000_oprydning.sql (reviewer-fund).
--
--   1. handel_afsluttet_kl: en leveret/afsluttet handel er foerst afsluttet,
--      naar pengene faktisk er overfoert til saelgeren (eller refunderet).
--      Foer: frigivet_kl alene talte som afsluttet, selv om overfoerslen
--      endnu ikke var lavet, en refusion var bedt om, eller en indsigelse
--      (chargeback) blokerede.
--   2. auktion_afsluttet_kl: en ubetalt vinder, hvor saelgeren endnu ikke har
--      valgt naeste skridt (tilbud til naeste byder eller genopsaetning),
--      holder arkiveringen tilbage. Efter et afvist/udloebet tilbud faar
--      saelgeren 48 timer, foer auktionen arkiveres, til at sende tilbuddet
--      videre (arkiveringen regnes fra tilbuddets afslutning).
--   3. Indeks paa andenchance_tilbud (auction_id, byder_id) til RLS-
--      hjaelpefunktionen auktion_arkiv_adgang.
--
-- sag_holder_pengene, sager-funktioner og moderation_log beroeres ikke.
-- Idempotent: kan koeres flere gange.

-- ============================================================ 1. handel_afsluttet_kl

create or replace function public.handel_afsluttet_kl(p_trade uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  t            record;
  b            record;
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

  -- Ingen betaling (aeldre handler): b.status er null.
  select status, frigivet_kl, overfoert_kl, refunderet_kl, annulleret_kl,
         stripe_transfer_id, refusion_anmodet_kl, indsigelse_kl, indsigelse_status
    into b
    from public.betalinger
   where trade_id = t.id
   order by oprettet desc
   limit 1;

  if t.status in ('leveret', 'afsluttet') then
    -- Ikke afregnet endnu: betalingen er i gang, eller den er betalt, men
    -- pengene er ikke overfoert, en refusion er bedt om, eller en indsigelse
    -- blokerer.
    if b.status in ('afventer', 'behandles') then
      return null;
    end if;
    if b.status = 'betalt'
       and (b.stripe_transfer_id is null
            or b.refusion_anmodet_kl is not null
            or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)) then
      return null;
    end if;
    return greatest(b.frigivet_kl, b.overfoert_kl, b.refunderet_kl,
                    v_sag, t.received_at, t.created_at);
  end if;

  if t.status = 'annulleret' then
    -- Er der betalt, skal refusionen vaere registreret, foer handlen er slut.
    if b.status is not null and b.status not in ('annulleret', 'refunderet') then
      return null;
    end if;
    return greatest(b.annulleret_kl, b.refunderet_kl, v_sag, t.created_at);
  end if;

  return null;
end;
$fn$;

revoke all on function public.handel_afsluttet_kl(uuid) from public, anon, authenticated;
grant execute on function public.handel_afsluttet_kl(uuid) to service_role;

-- ============================================================ 2. auktion_afsluttet_kl

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
  v_tilbud timestamptz;
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

  -- Ubetalt vinder (eller admin-annulleret handel), hvor saelgeren endnu ikke
  -- har valgt: intet tilbud til naeste byder paa netop den handel, ingen
  -- genopsaetning og ingen ny handel paa auktionen.
  if exists (
       select 1
         from public.ubetalte_vindere u
         join public.trades ut on ut.id = u.trade_id
        where u.auction_id = p_auktion
          and ut.status = 'annulleret'
          and not exists (select 1 from public.andenchance_tilbud c
                           where c.oprindelig_trade_id = u.trade_id)
          and not exists (select 1 from public.genopsaetninger g
                           where g.gammel_auction_id = p_auktion)
          and not exists (select 1 from public.trades x
                           where x.auction_id = p_auktion
                             and x.status <> 'annulleret')) then
    return null;
  end if;

  v_slut := a.afsluttet_kl;

  -- Seneste afsluttede tilbud til naeste byder: saelgeren har 48 timer derfra
  -- til at sende tilbuddet videre, foer auktionen arkiveres.
  select max(coalesce(c.besvaret_kl, c.udloeber))
    into v_tilbud
    from public.andenchance_tilbud c
   where c.auction_id = p_auktion;
  v_slut := greatest(v_slut, v_tilbud);

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

-- ============================================================ 3. indeks

-- Bemaerk: begraensningen andenchance_en_gang_pr_byder (unique (auction_id,
-- byder_id)) giver allerede et tilsvarende indeks. Dette er et sikkerhedsnet,
-- hvis begraensningen en dag fjernes.
create index if not exists andenchance_tilbud_auction_byder_idx
  on public.andenchance_tilbud (auction_id, byder_id);
