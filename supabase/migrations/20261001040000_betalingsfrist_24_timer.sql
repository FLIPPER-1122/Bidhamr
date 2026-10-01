-- Betalingsfristen saettes ned fra 48 til 24 timer (Filips beslutning 1. okt. 2026,
-- CLAUDE.md regel 3 og ROADMAP-BESLUTNINGER.md).
--
-- 1) afslut_udloebne_auktioner genoprettes praecis som i
--    20261001020000_fragt_beskyttelse_cron.sql. Eneste aendring:
--    betal_senest = now() + 24 timer (foer 48).
-- 2) Ventende betalinger forkortes til hoejst 24 timer efter oprettelse.
--    Fristen kan kun blive kortere (least), og allerede udloebne raekker roeres ikke.
--
-- De oevrige 48-timersregler (sag efter afhentning, auto-frigivelse, oprydning)
-- er uaendrede.

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
        bud + koeb + fragt + besk, saelg, bud - saelg + fragt,
        now() + interval '24 hours')
      on conflict (trade_id) do nothing;
    exception when others then
      raise warning 'handel/betaling fejlede for auktion %: %', r.id, sqlerrm;
    end;
  end loop;

  -- Gamle reservationer fra saldo-modellen maa ikke holde paa penge.
  if to_regclass('public.bid_reservations') is not null then
    for r in
      select br.auction_id as id
        from public.bid_reservations br
        join public.auctions a on a.id = br.auction_id
       where a.status <> 'aktiv'
    loop
      begin
        perform public.wallet_frigiv(r.id);
      exception when others then
        raise warning 'wallet_frigiv fejlede for auktion %: %', r.id, sqlerrm;
      end;
    end loop;
  end if;

  return antal;
end;
$fn$;

revoke all on function public.afslut_udloebne_auktioner() from public, anon, authenticated;
grant execute on function public.afslut_udloebne_auktioner() to service_role;

-- Ventende betalinger: fristen forkortes til hoejst 24 timer efter oprettelse.
update public.betalinger
   set betal_senest = least(betal_senest, oprettet + interval '24 hours')
 where status = 'afventer'
   and betal_senest > now();
