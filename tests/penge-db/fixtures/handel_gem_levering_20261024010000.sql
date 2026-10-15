-- handel_gem_levering, som den ser ud efter 20261024010000 (hentet med
-- pg_get_functiondef fra testdatabasen 15. okt. 2026, md5 a1f676d6...).
-- Bruges af tests/penge-db/glsSlaaetFra.test.ts.
CREATE OR REPLACE FUNCTION public.handel_gem_levering(p_trade uuid, p_bruger uuid, p_valg jsonb, p_annulleret_pi text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t         record;
  b         record;
  a         record;
  v_maade   text := p_valg->>'maade';
  v_firma   text := p_valg->>'fragtfirma';
  v_shop    jsonb := p_valg->'pakkeshop';
  v_mod     jsonb := p_valg->'modtager';
  v_afh     boolean := (p_valg->>'maade') = 'afhentning';
  v_valgbar boolean;
  v_gemt    integer;
  v_pris    integer;
  v_besk    bigint;
  v_aendret boolean := false;
  v_pi_nul  boolean := false;
  v_flag    boolean;
begin
  if p_trade is null or p_bruger is null or p_valg is null
     or jsonb_typeof(p_valg) <> 'object'
     or coalesce(v_maade, '') not in ('pakkeshop', 'doer', 'afhentning')
     or (not v_afh and (coalesce(v_firma, '') not in ('test', 'gls', 'shipmondo', 'dao')
                        or v_mod is null or jsonb_typeof(v_mod) <> 'object'))
     or (v_maade = 'pakkeshop' and (v_shop is null or jsonb_typeof(v_shop) <> 'object'))
     -- Shipmondo (20261024010000): købers transportør (mangler den: DAO).
     or (not v_afh and v_firma = 'shipmondo'
         and coalesce(p_valg->>'transportoer', 'dao') not in ('dao', 'gls', 'postnord')) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  select id, buyer_id, seller_id, status, afhentning, auction_id into t
    from public.trades where id = p_trade for update;
  if t.id is null or t.buyer_id <> p_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select forsendelse_mulig, afhentning_mulig, fragt_pakkeshop_oere, fragt_doer_oere into a
    from public.auctions where id = t.auction_id;
  v_valgbar := coalesce(a.forsendelse_mulig, false) and coalesce(a.afhentning_mulig, false);

  select * into b from public.betalinger where trade_id = p_trade for update;
  if b.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Kun afhentning: intet valg.
  if not v_valgbar and (coalesce(t.afhentning, false) or coalesce(b.fragt_oere, 0) <= 0) then
    return jsonb_build_object('kode', 'afhentning');
  end if;
  if v_afh and not v_valgbar then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  if exists (select 1 from public.forsendelser f
              where f.trade_id = p_trade and f.type = 'udgaaende'
                and f.status not in ('annulleret', 'fejlet')) then
    return jsonb_build_object('kode', 'laast');
  end if;

  v_pris := case v_maade when 'pakkeshop' then a.fragt_pakkeshop_oere
                         when 'doer' then a.fragt_doer_oere
                         else 0 end;
  if v_pris is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;

  -- BidHamr Beskyttelse: 0 ved afhentning (gemmes); ved forsendelse den
  -- nuværende - eller den gemte, hvis afhentning var valgt.
  select hl.beskyttelse_ved_forsendelse_oere into v_gemt
    from public.handel_levering hl where hl.trade_id = p_trade and hl.maade = 'afhentning';
  if coalesce(t.afhentning, false) then
    v_gemt := coalesce(v_gemt, 0);
  else
    v_gemt := b.beskyttelse_oere;
  end if;
  v_besk := case when v_afh then 0 else v_gemt end;
  v_flag := v_afh is distinct from coalesce(t.afhentning, false);

  if b.status = 'afventer' and b.stripe_charge_id is null and t.status = 'afventer_betaling' then
    if v_pris <> b.fragt_oere or v_besk <> b.beskyttelse_oere or v_flag then
      v_aendret := v_pris <> b.fragt_oere or v_besk <> b.beskyttelse_oere;
      if b.stripe_payment_intent_id is not null then
        if p_annulleret_pi is distinct from b.stripe_payment_intent_id then
          return jsonb_build_object('kode', 'pi_skal_annulleres', 'pi', b.stripe_payment_intent_id);
        end if;
        update public.betalinger
           set stripe_payment_intent_id = null,
               pi_forsoeg = pi_forsoeg + 1,
               tidligere_payment_intents = tidligere_payment_intents || b.stripe_payment_intent_id,
               fragt_oere = v_pris,
               beskyttelse = v_besk > 0,
               beskyttelse_oere = v_besk,
               total_oere = bud_oere + koebergebyr_oere + v_pris + v_besk,
               opdateret = now()
         where id = b.id and status = 'afventer' and stripe_charge_id is null
           and stripe_payment_intent_id = b.stripe_payment_intent_id;
        v_pi_nul := true;
      else
        -- pi_forsoeg + 1 også uden PaymentIntent: en PaymentIntent, der er ved
        -- at blive lavet med det gamle beløb (samme idempotency key), kan så
        -- ikke gemmes (sikrPaymentIntent gemmer kun ved samme pi_forsoeg,
        -- total og gebyr).
        update public.betalinger
           set fragt_oere = v_pris,
               beskyttelse = v_besk > 0,
               beskyttelse_oere = v_besk,
               total_oere = bud_oere + koebergebyr_oere + v_pris + v_besk,
               pi_forsoeg = pi_forsoeg + 1,
               opdateret = now()
         where id = b.id and status = 'afventer' and stripe_charge_id is null
           and stripe_payment_intent_id is null;
      end if;
      if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
    end if;
  elsif b.status = 'betalt' and t.status = 'betaling_modtaget' then
    if v_pris <> b.fragt_oere or v_flag then return jsonb_build_object('kode', 'pris_laast'); end if;
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  if v_afh then
    insert into public.handel_levering as hl (
      trade_id, maade, fragtfirma,
      pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
      pakkeshop_lat, pakkeshop_lng,
      modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email,
      fragt_oere, beskyttelse_ved_forsendelse_oere, transportoer)
    values (
      p_trade, 'afhentning', null,
      null, null, null, null, null, null, null,
      null, null, null, null, null, null,
      0, v_gemt, null)
    on conflict (trade_id) do update set
      maade = excluded.maade, fragtfirma = null,
      pakkeshop_id = null, pakkeshop_navn = null, pakkeshop_adresse = null,
      pakkeshop_postnummer = null, pakkeshop_by = null, pakkeshop_lat = null, pakkeshop_lng = null,
      modtager_navn = null, modtager_adresse = null, modtager_postnummer = null,
      modtager_by = null, modtager_telefon = null, modtager_email = null,
      fragt_oere = 0, beskyttelse_ved_forsendelse_oere = excluded.beskyttelse_ved_forsendelse_oere,
      transportoer = null,
      opdateret_kl = now();
  else
    insert into public.handel_levering as hl (
      trade_id, maade, fragtfirma,
      pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
      pakkeshop_lat, pakkeshop_lng,
      modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email,
      fragt_oere, beskyttelse_ved_forsendelse_oere, transportoer)
    values (
      p_trade, v_maade, v_firma,
      case when v_maade = 'pakkeshop' then v_shop->>'id' end,
      case when v_maade = 'pakkeshop' then v_shop->>'navn' end,
      case when v_maade = 'pakkeshop' then v_shop->>'adresse' end,
      case when v_maade = 'pakkeshop' then v_shop->>'postnummer' end,
      case when v_maade = 'pakkeshop' then v_shop->>'by' end,
      case when v_maade = 'pakkeshop' then (v_shop->>'lat')::double precision end,
      case when v_maade = 'pakkeshop' then (v_shop->>'lng')::double precision end,
      btrim(v_mod->>'navn'), nullif(btrim(coalesce(v_mod->>'adresse', '')), ''),
      nullif(btrim(coalesce(v_mod->>'postnummer', '')), ''), nullif(btrim(coalesce(v_mod->>'by', '')), ''),
      v_mod->>'telefon', nullif(btrim(coalesce(v_mod->>'email', '')), ''),
      v_pris, null, case when v_firma = 'shipmondo' then coalesce(p_valg->>'transportoer', 'dao') end)
    on conflict (trade_id) do update set
      maade = excluded.maade, fragtfirma = excluded.fragtfirma,
      pakkeshop_id = excluded.pakkeshop_id, pakkeshop_navn = excluded.pakkeshop_navn,
      pakkeshop_adresse = excluded.pakkeshop_adresse, pakkeshop_postnummer = excluded.pakkeshop_postnummer,
      pakkeshop_by = excluded.pakkeshop_by, pakkeshop_lat = excluded.pakkeshop_lat,
      pakkeshop_lng = excluded.pakkeshop_lng,
      modtager_navn = excluded.modtager_navn, modtager_adresse = excluded.modtager_adresse,
      modtager_postnummer = excluded.modtager_postnummer, modtager_by = excluded.modtager_by,
      modtager_telefon = excluded.modtager_telefon, modtager_email = excluded.modtager_email,
      fragt_oere = excluded.fragt_oere, beskyttelse_ved_forsendelse_oere = null,
      transportoer = excluded.transportoer,
      opdateret_kl = now();
  end if;

  -- Afhentning <-> forsendelse: handlens flag følger valget (trades_saet_afhentning
  -- tjekker igen). Bliver flaget ikke som valgt, rulles alt tilbage.
  if v_flag then
    update public.trades set afhentning = v_afh where id = p_trade;
    if (select tr.afhentning from public.trades tr where tr.id = p_trade) is distinct from v_afh then
      raise exception 'afhentning_skift_afvist: Handlens leveringsform kunne ikke ændres.' using errcode = 'BHT11';
    end if;
  end if;

  if not v_afh and coalesce((p_valg->>'gem_forslag')::boolean, true) then
    insert into public.leveringsforslag as lf (
      user_id, maade, pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
      modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, transportoer, opdateret_kl)
    select p_bruger, hl.maade, hl.pakkeshop_id, hl.pakkeshop_navn, hl.pakkeshop_adresse,
           hl.pakkeshop_postnummer, hl.pakkeshop_by, hl.modtager_navn, hl.modtager_adresse,
           hl.modtager_postnummer, hl.modtager_by, hl.modtager_telefon, hl.transportoer, now()
      from public.handel_levering hl where hl.trade_id = p_trade
    on conflict (user_id) do update set
      maade = excluded.maade,
      pakkeshop_id = coalesce(excluded.pakkeshop_id, lf.pakkeshop_id),
      pakkeshop_navn = coalesce(excluded.pakkeshop_navn, lf.pakkeshop_navn),
      pakkeshop_adresse = coalesce(excluded.pakkeshop_adresse, lf.pakkeshop_adresse),
      pakkeshop_postnummer = coalesce(excluded.pakkeshop_postnummer, lf.pakkeshop_postnummer),
      pakkeshop_by = coalesce(excluded.pakkeshop_by, lf.pakkeshop_by),
      modtager_navn = excluded.modtager_navn,
      modtager_adresse = coalesce(excluded.modtager_adresse, lf.modtager_adresse),
      modtager_postnummer = coalesce(excluded.modtager_postnummer, lf.modtager_postnummer),
      modtager_by = coalesce(excluded.modtager_by, lf.modtager_by),
      modtager_telefon = excluded.modtager_telefon,
      transportoer = coalesce(excluded.transportoer, lf.transportoer),
      opdateret_kl = now();
  end if;

  select fragt_oere, total_oere, beskyttelse_oere into b from public.betalinger where trade_id = p_trade;
  return jsonb_build_object('kode', 'ok', 'fragt_oere', b.fragt_oere, 'total_oere', b.total_oere,
                            'beskyttelse_oere', b.beskyttelse_oere, 'afhentning', v_afh,
                            'pris_aendret', v_aendret, 'pi_nulstillet', v_pi_nul);
end;
$function$
;
