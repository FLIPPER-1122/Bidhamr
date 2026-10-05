-- Rettelser til betalingsfristen (20261005010000_betalingsfrist.sql) efter
-- review. Kun handel_forlaeng_betalingsfrist aendres - alt andet fra
-- 20261005010000 er uaendret.
--
--   1. Graensen paa 7 dage regnes fortsat fra betalinger.oprettet (= naar
--      betalingsfristen startede: auktionens afslutning, eller naar naeste
--      byder siger ja til et tilbud). Uaendret - kun praeciseret i teksterne.
--   2. Mod spam:
--      - en forlaengelse skal goere fristen mindst 24 timer laengere end den
--        nuvaerende frist. Er der under 24 timer tilbage til maks-fristen, er
--        maks-fristen selv tilladt. Ellers 'ugyldig_frist'.
--        Graensen sammenlignes paa hele sekunder (som v_ny), saa et forslag
--        paa "nuvaerende frist + 1 dag" fra klienten (millisekunder) ikke
--        afvises paa grund af afrunding.
--      - hoejst 3 forlaengelser pr. betaling (talt i
--        betalingsfrist_forlaengelser) -> 'for_mange'.
--        Taellingen sker, mens betalingen er laast (for update), saa to
--        samtidige kald ikke begge kan blive nr. 3.
--
-- Idempotent: kan koeres flere gange.

-- Kaldes af saelgeren (hjemmeside og app). Brugeren udledes af auth.uid().
-- Returnerer { kode, betal_senest?, maks_frist? }.
-- Koder:
--   ok              fristen er forlaenget (betal_senest = ny frist)
--   ikke_logget_ind
--   ikke_fundet     handlen findes ikke, eller kalderen er ikke saelgeren
--   ikke_afventer   handlen afventer ikke betaling (betalt, annulleret, ...)
--   frist_udloebet  den nuvaerende frist er allerede udloebet
--   for_mange       fristen er allerede forlaenget 3 gange
--   ugyldig_frist   ny frist mangler, er ikke senere end den nuvaerende, eller
--                   er under 24 timer senere (og ikke lig maks-fristen)
--                   (maks_frist returneres)
--   for_sent        ny frist er senere end 7 dage efter fristens start
--                   (maks_frist returneres)
create or replace function public.handel_forlaeng_betalingsfrist(
  p_trade uuid, p_ny_frist timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_bruger uuid := auth.uid();
  v_ny     timestamptz := date_trunc('second', p_ny_frist);
  v_maks   timestamptz;
  v_min    timestamptz;
  v_antal  integer;
  b        record;
  t        record;
begin
  if v_bruger is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_trade is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laaseraekkefoelge som ubetalt_vinder_annuller/betaling_annuller:
  -- betalinger foerst, derefter trades.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found or b.seller_id is distinct from v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  select * into t from public.trades where id = p_trade for update;
  if not found or t.seller_id is distinct from v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if t.status <> 'afventer_betaling' or b.status not in ('afventer', 'behandles') then
    return jsonb_build_object('kode', 'ikke_afventer');
  end if;
  if b.betal_senest <= now() then
    return jsonb_build_object('kode', 'frist_udloebet');
  end if;

  -- Hoejst 3 forlaengelser. Betalingen er laast, saa taellingen er sikker.
  select count(*) into v_antal
    from public.betalingsfrist_forlaengelser
   where betaling_id = b.id;
  if v_antal >= 3 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  v_maks := date_trunc('second', b.oprettet + interval '7 days');
  if v_ny is null or v_ny <= b.betal_senest then
    return jsonb_build_object('kode', 'ugyldig_frist', 'maks_frist', v_maks);
  end if;
  if v_ny > v_maks then
    return jsonb_build_object('kode', 'for_sent', 'maks_frist', v_maks);
  end if;
  -- Mindst 24 timer laengere end den nuvaerende frist - medmindre den nye
  -- frist er maks-fristen (under 24 timer tilbage til graensen).
  v_min := date_trunc('second', b.betal_senest + interval '24 hours');
  if v_ny < v_min and v_ny <> v_maks then
    return jsonb_build_object('kode', 'ugyldig_frist', 'maks_frist', v_maks);
  end if;

  update public.betalinger
     set betal_senest            = v_ny,
         paamindelse_24_sendt_kl = null,
         paamindelse_40_sendt_kl = null,
         opdateret               = now()
   where id = b.id;

  insert into public.betalingsfrist_forlaengelser (
    betaling_id, trade_id, seller_id, buyer_id, gammel_frist, ny_frist)
  values (b.id, t.id, t.seller_id, t.buyer_id, b.betal_senest, v_ny)
  on conflict (betaling_id, ny_frist) do nothing;

  return jsonb_build_object('kode', 'ok', 'betal_senest', v_ny, 'maks_frist', v_maks);
end;
$fn$;

revoke all on function public.handel_forlaeng_betalingsfrist(uuid, timestamptz)
  from public, anon;
grant execute on function public.handel_forlaeng_betalingsfrist(uuid, timestamptz)
  to authenticated, service_role;
