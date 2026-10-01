-- Fjern den gamle saldo/wallet-model helt (roadmap Fase 1: "Testmiljoet flyttes
-- til Stripe"). Stripe holder alle penge; BidHamr har ingen saldo.
--
-- Idempotent og sikker i baade test og produktion:
--   - Produktion har IKKE wallets/wallet_entries/bid_reservations eller
--     wallet_*-funktionerne. Alt guardes med if exists/to_regclass/to_regprocedure.
--   - Test har wallet-tabeller med falske testdata - de droppes.
--   - public.transactions er gammel handelshistorik og roeres IKKE.
--
--   1. Gamle handler uden betaling annulleres (intet slettes, ingen penge flyttes).
--   2. admin_frigiv_handel genoprettes uden wallet-grenen.
--   3. admin_refunder_handel droppes (refusion gaar via betaling_paabegynd_refusion
--      og Stripe).
--   4. afslut_udloebne_auktioner genoprettes uden bid_reservations/wallet_frigiv.
--   5. Wallet-triggere, -funktioner, -policies og -tabeller droppes.

-- ============================================================ 1. gamle handler

-- Handler fra saldo-modellen, der stadig staar som aktive, men ikke har en
-- raekke i betalinger, kan ikke laengere afregnes eller refunderes: pengene laa
-- i den nu nedlagte saldo, ikke hos Stripe. I produktion er det 4 af Filips
-- egne testhandler (godkendt af Filip). De saettes til 'annulleret' og en evt.
-- aaben sag lukkes. Raekkerne bevares (bogfoeringsloven/DAC7).
update public.trades
   set status = 'annulleret',
       sag_aaben = false
 where status in ('betaling_modtaget', 'pakke_sendt', 'modtaget')
   and not exists (select 1 from public.betalinger b where b.trade_id = trades.id);

-- ============================================================ 2. admin frigiv

-- Kun handler med en betalt Stripe-betaling kan frigives. Serveren opretter
-- derefter Stripe-overfoerslen til saelgeren.
-- Fejlkoder (raise exception): HANDEL_UDEN_BETALING, hvis der ingen betaling er.
-- Returnerer false, hvis betalingen ikke er betalt, er under refusion, eller
-- handlen allerede er afsluttet (idempotent: status tjekkes i samme update).
create or replace function public.admin_frigiv_handel(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;

  if not found then
    raise exception 'HANDEL_UDEN_BETALING'
      using hint = 'Handlen har ingen betaling og kan ikke frigives.';
  end if;

  if b.status <> 'betalt' or b.refusion_anmodet_kl is not null then
    return false;
  end if;

  update public.trades
     set status = 'leveret',
         received_at = coalesce(received_at, now()),
         sag_aaben = false
   where id = p_trade
     and status in ('betaling_modtaget', 'pakke_sendt', 'modtaget');

  if not found then return false; end if;

  update public.betalinger
     set frigivet_kl = coalesce(frigivet_kl, now()), opdateret = now()
   where id = b.id;
  return true;
end;
$fn$;

revoke execute on function public.admin_frigiv_handel(uuid) from public, anon, authenticated;
grant execute on function public.admin_frigiv_handel(uuid) to service_role;

-- ============================================================ 3. admin refunder

-- Bruges ikke laengere: refusion gaar via betaling_paabegynd_refusion + Stripe.
drop function if exists public.admin_refunder_handel(uuid);

-- ============================================================ 4. cron

-- Ordret som i 20261001070000_fragt_til_fragtfirma.sql, men uden blokken, der
-- frigav gamle bid_reservations via wallet_frigiv.
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

  -- Handel + betaling for afsluttede auktioner med vinder og uden handel.
  -- Begraenset til de seneste 7 dage, saa gamle auktioner ikke backfilles.
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

      -- Vinderens seneste bud afgoer, om han oensker BidHamr Beskyttelse.
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
      on conflict (auction_id) do nothing
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

-- ============================================================ 5. wallet ud

-- Triggere (tabellerne bids/users findes altid).
drop trigger if exists bids_reserver_midler_trg on public.bids;
drop trigger if exists users_opret_wallet on public.users;
drop function if exists public.bids_reserver_midler();
drop function if exists public.opret_wallet_til_ny_bruger();

-- Alle wallet_*-funktioner, uanset signatur.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'wallet\_%'
  loop
    execute format('drop function if exists %s', f.sig);
  end loop;
end $$;

-- Policies paa wallet-tabellerne, derefter tabellerne selv (kun paa test).
do $$
declare
  t   text;
  pol record;
begin
  foreach t in array array['bid_reservations', 'wallet_entries', 'wallets'] loop
    if to_regclass('public.' || t) is not null then
      for pol in
        select policyname from pg_policies
         where schemaname = 'public' and tablename = t
      loop
        execute format('drop policy if exists %I on public.%I', pol.policyname, t);
      end loop;
      execute format('drop table public.%I', t);
    end if;
  end loop;
end $$;

-- Kontrol: advar, hvis en funktion stadig omtaler den gamle model.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.prosrc ilike '%wallet%' or p.prosrc ilike '%bid_reservations%')
  loop
    raise warning 'funktion omtaler stadig wallet: %', f.sig;
  end loop;
end $$;
