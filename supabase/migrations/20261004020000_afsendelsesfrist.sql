-- Afsendelsesfrist (ROADMAP-BESLUTNINGER, "Midlertidige beslutninger":
-- "sælger skal markere pakken sendt inden 5 dage efter betaling. Ellers
-- annulleres handlen automatisk, og køber refunderes fuldt (inkl. fragt og
-- BidHamr Beskyttelse)").
--
-- Gælder kun handler med forsendelse (trades.afhentning = false). Afhentning
-- har sin egen staff-markering efter 7 dage (afhentning_marker_ikke_hentet).
--
-- Indhold:
--   1. betalinger.afsendelsesfrist_annulleret_kl - tidsstempel for den
--      automatiske annullering (læses kun via service-role; ingen nye grants).
--   2. afsendelsesfrist_annuller() - cron (service_role). Claimer en FULD
--      refusion (refusion_anmodet_kl, refusion_aarsag 'afsendelsesfrist',
--      refusion_oere null) og annullerer handlen atomisk. Selve refusionen
--      laves bagefter hos Stripe af serveren (refunderBetaling, idempotency
--      key pr. betaling). Betalingen markeres til staff (kraever_opmaerksomhed),
--      så en medarbejder kan vurdere en advarsel til sælgeren. Ingen
--      automatisk advarsel.
--   3. trade_marker_sendt: svarer 'annulleret' (i stedet for 'allerede_sendt'),
--      når handlen er annulleret. Ellers uændret fra 20261003040000.
--
-- Ingen ændring af moderation_log-CHECK: loggen bruger den eksisterende
-- handling 'handel_refunderet' med BidHamr-systembrugeren som afsender.
--
-- Idempotent: kan køres flere gange.

-- ============================================================ 1. Kolonne

alter table public.betalinger
  add column if not exists afsendelsesfrist_annulleret_kl timestamptz;

comment on column public.betalinger.afsendelsesfrist_annulleret_kl is
  'Handlen blev annulleret automatisk, fordi saelgeren ikke markerede pakken '
  'sendt inden 5 dage efter betalingen. Koeberen refunderes fuldt.';

-- Kandidatsoegning i cron: betalte, ikke frigivne, ikke refusions-claimede.
create index if not exists betalinger_afsendelsesfrist_idx
  on public.betalinger (betalt_kl)
  where status = 'betalt'
    and frigivet_kl is null
    and refusion_anmodet_kl is null;

-- ============================================================ 2. Annullering

-- Returnerer en jsonb-liste med de handler, der blev annulleret i denne
-- kørsel: [{betaling_id, trade_id, buyer_id, seller_id, auction_id, total_oere}].
--
-- Annullerer IKKE, hvis: handlen ikke længere er 'betaling_modtaget' (sendt,
-- modtaget, leveret, annulleret ...), det er en afhentningshandel, der er en
-- sag (trades.sag_aaben eller sag_holder_pengene), en blokerende indsigelse
-- hos køberens bank, en refusion allerede er claimet, pengene er frigivet
-- eller en overførsel er påbegyndt/gennemført, eller betalingen ikke har et
-- PaymentIntent at refundere.
--
-- Låserækkefølge: betaling, handel (samme som handel_auto_frigiv,
-- afhentning_marker_ikke_hentet og betaling_registrer_refunderet). Alt
-- tjekkes igen under lås. trade_marker_sendt låser kun handlen: kommer
-- sælgeren først, er status 'pakke_sendt', og handlen springes over;
-- kommer cron først, er status 'annulleret', og sælgeren får 'annulleret'.
create or replace function public.afsendelsesfrist_annuller()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  k      record;
  b      record;
  t      record;
  v_ud   jsonb := '[]'::jsonb;
  tekst  constant text :=
    'Sælgeren sendte ikke varen inden 5 dage efter betalingen. Handlen er annulleret, '
    || 'og køberen refunderes fuldt. Vurdér, om sælgeren skal have en advarsel.';
begin
  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.betalinger bt
      join public.trades tr on tr.id = bt.trade_id
     where bt.status = 'betalt'
       and bt.betalt_kl is not null
       and bt.betalt_kl < now() - interval '5 days'
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null
       and bt.stripe_payment_intent_id is not null
       and bt.afsendelsesfrist_annulleret_kl is null
       and tr.status = 'betaling_modtaget'
       and not coalesce(tr.afhentning, false)
       and not coalesce(tr.sag_aaben, false)
       and not public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
       and not public.sag_holder_pengene(tr.id)
     order by bt.betalt_kl
     limit 200
  loop
    -- Hver handel i sin egen undertransaktion: én fejl ruller kun den
    -- handel tilbage og stopper ikke resten.
    begin
      select * into b from public.betalinger where id = k.betaling_id for update;
      if not found then continue; end if;
      select * into t from public.trades where id = k.trade_id for update;
      if not found then continue; end if;

      if b.status <> 'betalt'
         or b.betalt_kl is null
         or not (b.betalt_kl < now() - interval '5 days')
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null
         or b.stripe_payment_intent_id is null
         or b.afsendelsesfrist_annulleret_kl is not null
         or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
         or t.status <> 'betaling_modtaget'
         or coalesce(t.afhentning, false)
         or coalesce(t.sag_aaben, false)
         or public.sag_holder_pengene(t.id) then
        continue;
      end if;

      -- Claim den fulde refusion (refusion_oere null = hele total_oere:
      -- bud + købergebyr + fragt + BidHamr Beskyttelse). Blokerer samtidig
      -- enhver frigivelse/overførsel (alle pengeveje kræver, at
      -- refusion_anmodet_kl er tom).
      update public.betalinger
         set refusion_anmodet_kl = now(),
             refusion_aarsag = 'afsendelsesfrist',
             refusion_oere = null,
             afsendelsesfrist_annulleret_kl = now(),
             kraever_opmaerksomhed = true,
             sidste_fejl = left(case
               when kraever_opmaerksomhed and sidste_fejl is not null
                 then sidste_fejl || ' · ' || tekst
               else tekst end, 500),
             opdateret = now()
       where id = b.id
         and refusion_anmodet_kl is null
         and afsendelsesfrist_annulleret_kl is null;
      if not found then continue; end if;

      update public.trades
         set status = 'annulleret', sag_aaben = false
       where id = t.id
         and status = 'betaling_modtaget';
      if not found then
        -- Kan ikke ske under lås, men så rulles claimet tilbage.
        raise exception 'status aendret under laas';
      end if;

      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (public.bidhamr_system_id(), 'handel_refunderet', 'handel', t.id, t.seller_id,
              'Automatisk annulleret: sælgeren sendte ikke varen inden 5 dage efter betalingen. '
              || 'Fuld refusion til køberen via Stripe.');

      v_ud := v_ud || jsonb_build_array(jsonb_build_object(
        'betaling_id', b.id, 'trade_id', t.id, 'buyer_id', t.buyer_id,
        'seller_id', t.seller_id, 'auction_id', t.auction_id,
        'total_oere', b.total_oere));
    exception when others then
      raise warning 'afsendelsesfrist_annuller: handel % fejlede: %', k.trade_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.afsendelsesfrist_annuller() from public, anon, authenticated;
grant execute on function public.afsendelsesfrist_annuller() to service_role;

-- ============================================================ 3. trade_marker_sendt

-- Som 20261003040000_pakkebilleder.sql, men en annulleret handel giver koden
-- 'annulleret' (fx efter afsendelsesfristen), så sælgeren får at vide, at
-- varen ikke skal sendes.
create or replace function public.trade_marker_sendt(
  p_trade    uuid,
  p_tracking text,
  p_billeder jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder   uuid := auth.uid();
  tracking text := nullif(btrim(p_tracking), '');
  t        record;
  v_fejl   text;
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if tracking is null or char_length(tracking) > 100 then
    return jsonb_build_object('kode', 'ugyldigt_tracking');
  end if;

  -- Ikke saelgeren: samme svar som en ukendt handel. Tjekkes foer laasen, saa
  -- uvedkommende ikke kan laase fremmede raekker.
  if not exists (select 1 from public.trades
                  where id = p_trade and seller_id = kalder) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laas handlen, saa to samtidige kald ikke begge knytter billeder.
  select id, seller_id, status, afhentning into t
    from public.trades where id = p_trade for update;
  if t.id is null or t.seller_id <> kalder then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if t.afhentning then return jsonb_build_object('kode', 'afhentning'); end if;
  if t.status = 'annulleret' then
    return jsonb_build_object('kode', 'annulleret');
  end if;
  if t.status <> 'betaling_modtaget' then
    return jsonb_build_object('kode', 'allerede_sendt');
  end if;

  v_fejl := public.pakke_valider_billeder(kalder, p_trade, p_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  update public.trades
     set status = 'pakke_sendt',
         tracking_number = tracking,
         sendt_kl = coalesce(sendt_kl, now())
   where id = p_trade
     and seller_id = kalder
     and status = 'betaling_modtaget'
     and not afhentning;

  if not found then return jsonb_build_object('kode', 'allerede_sendt'); end if;

  insert into public.pakke_billeder (trade_id, sti, kategori)
  select p_trade, e->>'sti', e->>'kategori'
    from jsonb_array_elements(p_billeder) e;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;
revoke execute on function public.trade_marker_sendt(uuid, text, jsonb) from public, anon;
grant execute on function public.trade_marker_sendt(uuid, text, jsonb) to authenticated;
