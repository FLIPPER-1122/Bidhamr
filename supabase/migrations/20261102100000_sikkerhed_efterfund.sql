-- Efterfund fra reviewerens gennemgang af sikkerhedsstramningen
-- (27. okt. 2026).
--
-- Bygger på:
--   afhentning_bekraeft    20261102080000_handel_testfund.sql (seneste)
-- Rører IKKE grants på users eller auctions (20261102060000) og kan køres
-- før eller efter 060000 - men efter 080000.
--
-- Indhold:
--   1. afhentning_bekraeft: når den rigtige kode nulstiller betalingens
--      kraever_opmaerksomhed (markeringen skyldtes KUN forkerte
--      afhentningskoder - 080000), skrives det i drift-loggen (drift_fejl via
--      drift_fejl_log, kilde 'action', sti /handel/<handel-id>, sælgeren som
--      bruger) med den tekst, der blev ryddet. Så kan staff se, at
--      markeringen var der og hvorfor den forsvandt. Fejler logningen, rulles
--      bekræftelsen IKKE tilbage (logningen er i sin egen undertransaktion).
--      Ellers uændret.
--
-- Drift-tjek (md5 af kroppen, CRLF -> LF, uden rene kommentarlinjer) før
-- noget ændres. Idempotent (kan køres igen). Kør først på testdatabasen.
-- KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

create or replace function pg_temp.krop_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(regexp_replace(replace(pr.prosrc, E'\r\n', E'\n'),
                            E'^[ \t]*(--[^\n]*)?\n', '', 'gn'))
    from pg_proc pr where pr.oid = p_fn
$$;

-- ---------------------------------------------------------------------------
-- 0. Drift-tjek. Før (efter 080000, test 27. okt. 2026) | efter denne fil.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  v_md5 := pg_temp.krop_md5('public.afhentning_bekraeft(uuid, text)'::regprocedure);
  if v_md5 not in ('0da2abc6dc0051cdd3b39f80caaf2e69', '2fdda775f8091167df567a6ed8783817') then
    raise exception 'afhentning_bekraeft er ændret uden for migrationerne (md5 %). Kør 20261102080000 først, eller tjek den, før den erstattes.', v_md5;
  end if;
  if to_regprocedure('public.drift_fejl_log(text, text, text, text, uuid)') is null then
    raise exception 'drift_fejl_log mangler - kør de tidligere migrationer først.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. afhentning_bekraeft
-- ---------------------------------------------------------------------------
create or replace function public.afhentning_bekraeft(p_trade uuid, p_kode text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  kalder   uuid := auth.uid();
  v_kode   text := regexp_replace(coalesce(p_kode, ''), '\s', '', 'g');
  b        record;
  t        record;
  a        record;
  v_vindue integer;
  v_i_alt  integer;
  v_tekst  text;
  v_ryddet integer;
  maks_pr_time constant integer := 5;
  maks_i_alt   constant integer := 15;
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if v_kode !~ '^[0-9]{6}$' then return jsonb_build_object('kode', 'ugyldig_kode'); end if;

  -- Laaseraekkefoelge: betaling, handel, afhentning.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.frigivet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or public.sag_holder_pengene(p_trade) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  select * into t from public.trades where id = p_trade for update;
  if not found
     or t.seller_id <> kalder
     or not t.afhentning
     or t.status <> 'betaling_modtaget'
     or coalesce(t.sag_aaben, false) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  select * into a from public.afhentninger where trade_id = p_trade for update;
  if found and a.annulleret_kl is not null then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;
  if not found or a.vist_kl is null then
    return jsonb_build_object('kode', 'ikke_vist');
  end if;
  if a.laast_kl is not null then
    return jsonb_build_object('kode', 'laast');
  end if;
  if a.laast_til_kl is not null and a.laast_til_kl > now() then
    return jsonb_build_object('kode', 'laast_midlertidigt', 'laast_til', a.laast_til_kl);
  end if;

  if v_kode <> a.kode then
    -- Nyt vindue, hvis det gamle er over en time gammelt.
    if a.vindue_start_kl is null or a.vindue_start_kl < now() - interval '1 hour' then
      v_vindue := 1;
      update public.afhentninger set vindue_start_kl = now() where trade_id = p_trade;
    else
      v_vindue := a.forkerte_forsoeg_vindue + 1;
    end if;
    v_i_alt := a.forkerte_forsoeg_i_alt + 1;

    update public.afhentninger
       set forkerte_forsoeg_vindue = v_vindue,
           forkerte_forsoeg_i_alt = v_i_alt,
           laast_til_kl = case when v_vindue >= maks_pr_time
                               then coalesce(vindue_start_kl, now()) + interval '1 hour'
                               else laast_til_kl end,
           laast_kl = case when v_i_alt >= maks_i_alt then now() else laast_kl end
     where trade_id = p_trade
    returning * into a;

    if a.laast_kl is not null or v_vindue >= maks_pr_time then
      v_tekst := case when a.laast_kl is not null
        then 'Afhentningskode: låst efter ' || v_i_alt || ' forkerte forsøg'
        else 'Afhentningskode: ' || v_vindue || ' forkerte forsøg inden for en time' end;
      update public.betalinger
         set kraever_opmaerksomhed = true,
             sidste_fejl = left(case
               when kraever_opmaerksomhed and sidste_fejl is not null
                    and position(v_tekst in sidste_fejl) = 0
                 then sidste_fejl || ' · ' || v_tekst
               when kraever_opmaerksomhed and sidste_fejl is not null
                 then sidste_fejl
               else v_tekst end, 500),
             opdateret = now()
       where id = b.id;
    end if;

    if a.laast_kl is not null then
      return jsonb_build_object('kode', 'laast');
    end if;
    if v_vindue >= maks_pr_time then
      return jsonb_build_object('kode', 'laast_midlertidigt', 'laast_til', a.laast_til_kl);
    end if;
    return jsonb_build_object('kode', 'forkert', 'tilbage', maks_pr_time - v_vindue);
  end if;

  -- Rigtig kode: frigiv.
  update public.trades
     set status = 'leveret',
         received_at = coalesce(received_at, now())
   where id = p_trade
     and seller_id = kalder
     and afhentning
     and status = 'betaling_modtaget'
     and not coalesce(sag_aaben, false);
  if not found then return jsonb_build_object('kode', 'ikke_mulig'); end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where id = b.id and frigivet_kl is null;

  -- 20261102080000: skyldtes markeringen KUN forkerte afhentningskoder (de
  -- tekster, der sættes ovenfor), er der intet at kigge på, når den rigtige
  -- kode er tastet. Andre grunde (også blandet med koderne) bliver stående.
  update public.betalinger
     set kraever_opmaerksomhed = false,
         sidste_fejl = null,
         opdateret = now()
   where id = b.id
     and kraever_opmaerksomhed
     and sidste_fejl ~ '^Afhentningskode: [^·]+( · Afhentningskode: [^·]+)*$';
  get diagnostics v_ryddet = row_count;

  -- 20261102100000: nulstillingen skrives i drift-loggen, så staff kan se den
  -- (b er låst og læst før opdateringen, så b.sidste_fejl er den ryddede
  -- tekst). En fejl i logningen må ikke vælte bekræftelsen.
  if v_ryddet > 0 then
    begin
      perform public.drift_fejl_log(
        'action',
        '/handel/' || p_trade::text,
        left('Afhentning: markeringen på betalingen er ryddet, fordi sælgeren tastede den rigtige kode. Ryddet: '
             || coalesce(b.sidste_fejl, '(ingen tekst)'), 1000),
        null,
        kalder);
    exception when others then
      raise warning 'afhentning_bekraeft: drift-log fejlede (%): %', sqlstate, sqlerrm;
    end;
  end if;

  update public.afhentninger
     set bekraeftet_kl = now()
   where trade_id = p_trade and bekraeftet_kl is null;

  -- Bedoemmelsen offentliggoeres nu, hvor afhentningen er gennemfoert:
  -- altid fra handlens koeber til handlens saelger (aldrig fra kalderen, som
  -- her er saelgeren). Statusskiftet ovenfor sker kun een gang, saa et
  -- dobbeltklik naar aldrig hertil to gange.
  if a.bedoemmelse_stjerner is not null and t.buyer_id <> t.seller_id then
    insert into public.ratings
      (fra_bruger_id, til_bruger_id, auktion_id, trade_id, stjerner, kommentar)
    values
      (t.buyer_id, t.seller_id, t.auction_id, t.id,
       a.bedoemmelse_stjerner, a.bedoemmelse_kommentar)
    on conflict do nothing;
  end if;

  return jsonb_build_object('kode', 'ok');
end;
$function$;

-- Uændrede rettigheder (create or replace bevarer dem) - sat igen for en
-- sikkerheds skyld: kun indloggede sælgere (kalderen udledes af auth.uid()).
revoke all on function public.afhentning_bekraeft(uuid, text) from public, anon;
grant execute on function public.afhentning_bekraeft(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Efter-tjek
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  v_md5 := pg_temp.krop_md5('public.afhentning_bekraeft(uuid, text)'::regprocedure);
  if v_md5 <> '2fdda775f8091167df567a6ed8783817' then
    raise exception 'afhentning_bekraeft: uventet md5 efter migrationen (%).', v_md5;
  end if;
end $$;

notify pgrst, 'reload schema';
