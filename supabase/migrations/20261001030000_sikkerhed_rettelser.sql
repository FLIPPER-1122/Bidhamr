-- Sikkerhedsrettelser efter sikkerhedsgennemgangen og testrapporten 2026-10-01,
-- samt betalingsfrist 24 timer (Filips beslutning 2026-10-01).
--
-- Filen er idempotent og kan koeres sikkert i produktion senere. Produktion
-- har IKKE wallet-tabellerne/-funktionerne (og maaske endnu ikke betalinger),
-- saa alt, der roerer dem, er bag to_regclass/to_regprocedure-tjek.
--
-- Indhold:
--   H1  push_tokens: update-policy faar with check.
--   H2  Pengetal (betalinger, betaling_afvigelser, wallets) kun for chef.
--   T4  Saelger/koeber kan kun laese ufarlige kolonner i betalinger.
--   M2  Execute lukkes paa trigger-funktioner; visningsfunktioner kun for
--       indloggede.
--   24t Betalingsfrist 24 timer i stedet for 48.

-- =============================================================== H1 push_tokens
-- Tabellen og dens RLS er indfanget i 20260930130000_indfang_prod_drift.sql.
-- Update-policyen manglede with check, saa en bruger kunne flytte sin raekke
-- (user_id) over paa en anden bruger.
do $$
begin
  if to_regclass('public.push_tokens') is not null then
    execute 'alter table public.push_tokens enable row level security';
    execute 'drop policy if exists push_tokens_update_own on public.push_tokens';
    execute 'create policy push_tokens_update_own on public.push_tokens
               for update using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    -- Insert-policyen har allerede with check; genskabes for at vaere sikker.
    execute 'drop policy if exists push_tokens_insert_own on public.push_tokens';
    execute 'create policy push_tokens_insert_own on public.push_tokens
               for insert with check (auth.uid() = user_id)';
  end if;
end $$;

-- =============================================================== H2 + T4 betalinger
-- min_rolle() (20260930100000) er security definer og udleder brugeren af
-- auth.uid(); returnerer users.rolle. Kun 'chef' maa se andres beloeb.
do $$
begin
  if to_regclass('public.betalinger') is not null then
    execute 'drop policy if exists betalinger_select_part on public.betalinger';
    execute 'create policy betalinger_select_part on public.betalinger
               for select to authenticated using (
                 buyer_id = auth.uid() or seller_id = auth.uid()
                 or public.min_rolle() = ''chef'')';

    -- T4: kolonne-grants. Interne felter (sidste_fejl, autobetaling_*,
    -- stripe_*, mail-tidsstempler, pi_forsoeg, saelgergebyr/udbetaling) kan
    -- ikke laeses med brugerens JWT. Hjemmesiden laeser dem via service-role
    -- i hentBetalingsstatus og filtrerer pr. part.
    execute 'revoke select on public.betalinger from anon, authenticated';
    execute 'grant select (id, trade_id, auction_id, buyer_id, seller_id,
               bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
               total_oere, valuta, status, betal_senest, betalt_kl,
               frigivet_kl, overfoert_kl, oprettet, opdateret)
             on public.betalinger to authenticated';
  end if;

  if to_regclass('public.betaling_afvigelser') is not null then
    execute 'drop policy if exists betaling_afvigelser_select_staff on public.betaling_afvigelser';
    execute 'drop policy if exists betaling_afvigelser_select_chef on public.betaling_afvigelser';
    execute 'create policy betaling_afvigelser_select_chef on public.betaling_afvigelser
               for select to authenticated using (public.min_rolle() = ''chef'')';
  end if;

  if to_regclass('public.wallets') is not null then
    execute 'drop policy if exists wallets_select_own on public.wallets';
    execute 'create policy wallets_select_own on public.wallets
               for select using (auth.uid() = user_id or public.min_rolle() = ''chef'')';
  end if;

  if to_regclass('public.wallet_entries') is not null then
    execute 'drop policy if exists wallet_entries_select_own on public.wallet_entries';
    execute 'create policy wallet_entries_select_own on public.wallet_entries
               for select using (auth.uid() = user_id or public.min_rolle() = ''chef'')';
  end if;
end $$;

-- =============================================================== M2 trigger-funktioner
-- Trigger-funktioner skal aldrig kunne kaldes direkte. Revoke paavirker ikke,
-- at triggerne fyrer.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.handle_new_user()',
    'public.check_ikke_egen_auktion()',
    'public.bids_reserver_midler()',
    'public.opret_wallet_til_ny_bruger()',
    'public.rls_auto_enable()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;

-- =============================================================== M2/L2 visninger
-- oeg_auktion_visning: kun indloggede, og funktionen kraever selv auth.uid(),
-- saa visningstallet ikke kan pumpes op anonymt.
create or replace function public.oeg_auktion_visning(p_auktion_id uuid)
returns void
language sql
security definer
set search_path = public
as $function$
  update public.auctions
     set visninger = visninger + 1
   where id = p_auktion_id
     and auth.uid() is not null;
$function$;
revoke execute on function public.oeg_auktion_visning(uuid) from public, anon;
grant execute on function public.oeg_auktion_visning(uuid) to authenticated;

-- registrer_auktion_visning / hent_mine_visninger findes kun i produktion
-- (appen). Definitionerne er IKKE indfanget her (ingen katalogadgang ved
-- skrivning). Uanset signatur lukkes de for anon, men forbliver aabne for
-- indloggede, saa appen virker.
do $$
declare
  p regprocedure;
begin
  for p in
    select oid::regprocedure from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname in ('registrer_auktion_visning', 'hent_mine_visninger')
  loop
    execute format('revoke execute on function %s from public, anon', p);
    execute format('grant execute on function %s to authenticated', p);
  end loop;
end $$;

-- =============================================================== 24 timers betalingsfrist
-- afslut_udloebne_auktioner er uaendret fra 20261001020000 bortset fra, at
-- betal_senest nu er now() + 24 timer.
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

-- Ventende betalinger med en frist laengere end 24 timer fra oprettelse
-- forkortes. Idempotent; i praksis kun relevant paa testdatabasen.
do $$
begin
  if to_regclass('public.betalinger') is not null then
    update public.betalinger
       set betal_senest = oprettet + interval '24 hours',
           opdateret = now()
     where status = 'afventer'
       and betal_senest > now()
       and betal_senest > oprettet + interval '24 hours';

    -- Kolonnenavnene er bevaret, men daekker nu 12 og 20 timer efter start.
    execute $c$comment on column public.betalinger.paamindelse_24_sendt_kl is
      'Foerste paamindelse: 12 timer efter start (12 timer foer fristen). Navnet stammer fra 48-timers-fristen.'$c$;
    execute $c$comment on column public.betalinger.paamindelse_40_sendt_kl is
      'Sidste paamindelse: 20 timer efter start (4 timer foer fristen). Navnet stammer fra 48-timers-fristen.'$c$;
  end if;
end $$;
