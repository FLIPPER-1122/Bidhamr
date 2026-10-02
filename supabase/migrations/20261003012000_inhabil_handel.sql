-- Inhabilitet paa handler og betalinger (reviewerfund M-C).
--
-- Ingen medarbejder maa behandle en handel eller betaling, hvor han selv er
-- koeber eller saelger. Funktionerne nedenfor er kopieret praecist fra deres
-- seneste definition; det eneste nye er tjekket, der returnerer kode
-- 'inhabil':
--   admin_annuller_ikke_betalt  (fra 20261002040000_pengestroem_rettelser.sql)
--   advarsel_ubetalt            (fra 20261002062000_advarsel_begrundelse.sql)
--   admin_advarsel_betaling     (fra 20261002062000_advarsel_begrundelse.sql)
--
-- admin_frigiv_handel og betaling_paabegynd_refusion kender ikke
-- medarbejderen; der tjekkes i serverkoden (src/app/actions/adminActions.ts),
-- ligesom for "Markér som løst" og "Prøv overførsel igen".
--
-- Idempotent: kun create or replace. Ingen data aendres.

-- ============================================================ admin_annuller_ikke_betalt

-- Koder: ok, ingen_adgang, begrundelse_mangler, ikke_fundet, inhabil,
-- ikke_annullerbar.
create or replace function public.admin_annuller_ikke_betalt(
  p_trade uuid, p_admin uuid, p_begrundelse text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b     record;
  grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  res   jsonb;
begin
  if not exists (select 1 from public.users
                  where id = p_admin and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;

  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  -- Ingen maa behandle en handel, hvor han selv er koeber eller saelger.
  if p_admin = b.buyer_id or p_admin = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  res := public.betaling_annuller(p_trade);
  if res is null then return jsonb_build_object('kode', 'ikke_annullerbar'); end if;

  insert into public.ubetalte_vindere (
    trade_id, auction_id, buyer_id, seller_id, aarsag,
    status, behandlet_af, behandlet_kl, begrundelse)
  values (
    p_trade, b.auction_id, b.buyer_id, b.seller_id, 'admin_annulleret',
    'afvist', p_admin, now(), left(grund, 1000))
  on conflict (trade_id) do nothing;

  return jsonb_build_object('kode', 'ok', 'payment_intent', res->>'payment_intent');
end;
$fn$;

revoke all on function public.admin_annuller_ikke_betalt(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_annuller_ikke_betalt(uuid, uuid, text) to service_role;

-- ============================================================ advarsel_ubetalt

-- Koder: ok, ikke_fundet, inhabil, ingen_adgang, behandlet, begrundelse_mangler,
-- begrundelse_for_lang, begrundelse_bruger_mangler, begrundelse_bruger_for_lang.
create or replace function public.advarsel_ubetalt(
  p_sag uuid, p_medarbejder uuid, p_giv boolean, p_begrundelse text,
  p_begrundelse_bruger text default null)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  s       record;
  grund   text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  bruger  text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  standard constant text := 'Betalte ikke for vundet auktion';
begin
  if not exists (select 1 from public.users
                  where id = p_medarbejder and rolle in ('medarbejder', 'admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  if grund is not null and char_length(grund) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;
  if p_giv then
    if bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
    if char_length(bruger) > 1000 then
      return jsonb_build_object('kode', 'begrundelse_bruger_for_lang');
    end if;
  elsif grund is null then
    return jsonb_build_object('kode', 'begrundelse_mangler');
  end if;

  select * into s from public.ubetalte_vindere where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  -- Ingen maa behandle en sag, hvor han selv er koeber eller saelger.
  if p_medarbejder = s.buyer_id or p_medarbejder = s.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if s.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;

  -- Idempotent: kun en sag, der stadig afventer, behandles.
  update public.ubetalte_vindere
     set status       = case when p_giv then 'advarsel_givet' else 'afvist' end,
         behandlet_af = p_medarbejder,
         behandlet_kl = now(),
         begrundelse  = case when p_giv then coalesce(grund, standard) else grund end
   where id = s.id and status = 'afventer';
  if not found then return jsonb_build_object('kode', 'behandlet'); end if;

  if p_giv then
    insert into public.advarsler (bruger_id, oprettet_af, aarsag, begrundelse_bruger)
    values (s.buyer_id, p_medarbejder, coalesce(grund, standard), bruger);

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'advarsel', 'handel', s.trade_id, s.buyer_id,
            standard || coalesce(': ' || grund, '') || ' | Til brugeren: ' || bruger);
  else
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'ubetalt_afvist', 'handel', s.trade_id, s.buyer_id, grund);
  end if;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.advarsel_ubetalt(uuid, uuid, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.advarsel_ubetalt(uuid, uuid, boolean, text, text)
  to service_role;

-- ============================================================ admin_advarsel_betaling

-- Koder: ok, ingen_adgang, ugyldig_modtager, begrundelse_for_lang,
-- begrundelse_bruger_mangler, begrundelse_bruger_for_lang, ikke_fundet,
-- inhabil, indsigelse, allerede_loest.
create or replace function public.admin_advarsel_betaling(
  p_betaling uuid, p_medarbejder uuid, p_modtager text, p_begrundelse text,
  p_begrundelse_bruger text default null)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b        record;
  grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  bruger   text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  modtager uuid;
  hvem     text;
begin
  if not exists (select 1 from public.users
                  where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_modtager is null or p_modtager not in ('koeber', 'saelger') then
    return jsonb_build_object('kode', 'ugyldig_modtager');
  end if;
  if bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
  if char_length(bruger) > 1000 then
    return jsonb_build_object('kode', 'begrundelse_bruger_for_lang');
  end if;
  if grund is not null and char_length(grund) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;

  select id, trade_id, buyer_id, seller_id, kraever_opmaerksomhed,
         indsigelse_kl, indsigelse_status
    into b
    from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  -- Ingen maa behandle en betaling, hvor han selv er koeber eller saelger.
  if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;

  -- Idempotent: kun en raekke, der stadig kraever opmaerksomhed, aendres.
  update public.betalinger
     set kraever_opmaerksomhed = false
   where id = b.id and kraever_opmaerksomhed;
  if not found then return jsonb_build_object('kode', 'allerede_loest'); end if;

  if p_modtager = 'koeber' then
    modtager := b.buyer_id; hvem := 'køber';
  else
    modtager := b.seller_id; hvem := 'sælger';
  end if;
  if modtager is null then
    raise exception 'Betalingen mangler %', hvem;
  end if;

  insert into public.advarsler (bruger_id, oprettet_af, aarsag, begrundelse_bruger)
  values (modtager, p_medarbejder, grund, bruger);

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'advarsel', 'handel', b.trade_id, modtager,
          coalesce(grund || ' | ', '') || 'Til brugeren: ' || bruger);

  -- Samme logning som "Markér som løst", saa sagen vises under "Løste".
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'betaling_loest', 'handel', b.trade_id, b.buyer_id,
          'Advarsel givet til ' || hvem || ': ' || coalesce(grund, bruger));

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.admin_advarsel_betaling(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_advarsel_betaling(uuid, uuid, text, text, text)
  to service_role;
