-- De rigtige funktioner fra testdatabasen (pjiigmzqwlfepxnjdvug) efter 20261102210000
-- og før 20261102350000 (hentet 28. okt. 2026), så md5-drift-tjekket genkender dem.
-- Kun dem, der ikke allerede er i sagsregler_foer_20261102210000.sql.

CREATE OR REPLACE FUNCTION public.ekstra_fragt_regning_spaerrer(p_status text, p_frist timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(p_status = 'afventer_betaling' and p_frist <= now(), false);
$function$
;

CREATE OR REPLACE FUNCTION public.ekstra_fragt_spaerret(p_bruger uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_bruger is not null and exists (
    select 1 from public.ekstra_fragt_regninger r
     where r.saelger_id = p_bruger and r.status = 'afventer_betaling'
       and public.ekstra_fragt_regning_spaerrer(r.status, r.frist));
$function$
;

CREATE OR REPLACE FUNCTION public.ekstra_fragt_kraev(p_bruger uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then return; end if;
  if public.ekstra_fragt_spaerret(p_bruger) then
    raise exception 'ekstra_fragt_ubetalt: Du har en ubetalt regning for ekstra fragt, og betalingsfristen er overskredet. Betal regningen på handlen under Mine handler, før du kan sætte flere varer til salg eller tilbyde en vare til næste byder.'
      using errcode = 'BHX01';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sag_genaabn(p_medarbejder uuid, p_sag uuid, p_begrundelse text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_trade uuid;
  s       record;
  t       record;
  b       record;
  -- NYT: 7 dages ventetid ved retur (som sag_afgoer).
  v_anke_behandlet timestamptz;
  v_retur_frist    timestamptz;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if exists (select 1 from public.sag_anker a where a.sag_id = s.id) then
    return jsonb_build_object('kode', 'anket');
  end if;

  if s.status not in ('afventer_retur', 'afgjort_koeber', 'afgjort_saelger', 'lukket') then
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  -- NYT: venter sagen paa en retur, der ikke er registreret, kan den
  -- foerst genaabnes, naar koeberens 7 dages frist til at sende varen er
  -- udloebet - ellers kunne en genaabning + ny afgoerelse omgaa ventetiden
  -- i sag_afgoer. Samme beregning som sag_afgoer (20261005020000).
  -- (En anket sag er allerede afvist ovenfor; behandlet_kl er med for at
  -- holde beregningen ens.)
  if s.status = 'afventer_retur' and s.retur_afleveret_kl is null then
    select behandlet_kl into v_anke_behandlet from public.sag_anker where sag_id = s.id;
    v_retur_frist := greatest(coalesce(s.penge_flyttes_efter_kl, s.afgjort_kl + interval '4 days'),
                              coalesce(v_anke_behandlet, '-infinity'::timestamptz))
                     + interval '7 days';
    if v_retur_frist is null or now() < v_retur_frist then
      return jsonb_build_object('kode', 'retur_ventetid', 'retur_frist_kl', v_retur_frist);
    end if;
  end if;
  if t.status = 'annulleret'
     or b.id is null
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then
    return jsonb_build_object('kode', 'penge_flyttet');
  end if;

  begin
    update public.sager
       set status = 'aaben', afgjort_af = null, afgjort_kl = null, begrundelse = null,
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = null, penge_flyttes_efter_kl = null,
           afviklet_kl = null, penge_fejl = null,
           genaabnet_antal = genaabnet_antal + 1, genaabnet_kl = now()
     where id = s.id;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  update public.trades
     set sag_aaben = true,
         sag_note = coalesce(sag_note, 'Sag fra køberen (genåbnet)'),
         sag_aabnet_at = now()
   where id = t.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_genaabnet', 'sag', s.id, t.buyer_id,
          left('Sag genåbnet (tidligere status: ' || s.status || ')'
               || case when s.penge_handling in ('refunder', 'frigiv') and s.afviklet_kl is null
                       then ' - den planlagte ' || case s.penge_handling when 'refunder'
                            then 'refusion' else 'udbetaling' end || ' er annulleret'
                       else '' end
               || ' | ' || v_grund, 4000));

  return jsonb_build_object(
    'kode', 'ok',
    'annulleret_planlagt', s.penge_handling in ('refunder', 'frigiv') and s.afviklet_kl is null,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal + 1);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sager_fragt_reklamation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.type = 'skadet' then
    perform public.fragt_reklamation_synkroniser_sikker(new.id);
  end if;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fragt_reklamationer_synkroniser_alle(p_graense integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_graense integer := greatest(1, least(coalesce(p_graense, 200), 1000));
  v_sag uuid;
  v_res text;
  v_ud  jsonb := '{}'::jsonb;
begin
  -- 1. Eksisterende reklamationer.
  for v_sag in
    select r.sag_id
      from public.fragt_reklamationer r
     where r.status in ('afventer_bidhamr', 'anmeldt')
        or (r.status = 'godkendt' and r.fremdrift_kl > now() - interval '180 days')
        or (r.status = 'annulleret' and r.annulleret_auto and r.annulleret_kl > now() - interval '180 days')
     order by (r.status in ('afventer_bidhamr', 'anmeldt')) desc, random()
     limit v_graense
  loop
    v_res := public.fragt_reklamation_synkroniser_sikker(v_sag);
    if v_res <> 'uaendret' and v_res <> 'ikke_relevant' then
      v_ud := v_ud || jsonb_build_object(v_res, coalesce((v_ud->>v_res)::integer, 0) + 1);
    end if;
  end loop;

  -- 2. Kandidater uden reklamation.
  for v_sag in
    select o.sag_id
      from public.indpakning_ordentlig o
      join public.sager s on s.id = o.sag_id
      join public.trades t on t.id = s.trade_id
     where o.tilbagekaldt_kl is null and s.type = 'skadet'
       and s.status in ('afgjort_koeber', 'lukket')
       and s.afviklet_kl is not null and s.afviklet_kl > now() - interval '180 days'
       and s.penge_handling is distinct from 'ingen'
       and not coalesce(t.afhentning, false)
       and exists (select 1 from public.forsendelser fo
                    where fo.trade_id = t.id and fo.type = 'udgaaende'
                      and fo.status not in ('opretter', 'annulleret', 'fejlet')
                      and coalesce(fo.transportoer,
                                   case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) in ('dao', 'gls'))
       and not exists (select 1 from public.fragt_reklamationer r where r.sag_id = o.sag_id)
     order by random()
     limit v_graense
  loop
    v_res := public.fragt_reklamation_synkroniser_sikker(v_sag);
    if v_res <> 'uaendret' and v_res <> 'ikke_relevant' then
      v_ud := v_ud || jsonb_build_object(v_res, coalesce((v_ud->>v_res)::integer, 0) + 1);
    end if;
  end loop;
  return v_ud;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fragt_reklamation_synkroniser(p_sag uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  sys      constant uuid := public.bidhamr_system_id();
  c        record;
  r        record;
  v_findes boolean;
  v_maks   bigint;
  v_krav   bigint;
  v_status text;
begin
  select * into c from public.fragt_reklamation_betingelser(p_sag);

  select * into r from public.fragt_reklamationer where sag_id = p_sag for update;
  v_findes := found;

  if c.ok then
    if not v_findes then
      select e.maks_oere into v_maks from public.fragt_transportoer_erstatning e where e.transportoer = c.transportoer;
      v_krav := least(c.vaerdi_oere, coalesce(v_maks, c.vaerdi_oere));

      insert into public.fragt_reklamationer (
        sag_id, trade_id, saelger_id, forsendelse_id, transportoer, trackingnummer,
        varens_vaerdi_oere, maks_erstatning_oere, kravbeloeb_oere, oprettet_af)
      values (
        p_sag, c.trade_id, c.saelger_id, c.forsendelse_id, c.transportoer, c.sporingsnummer,
        c.vaerdi_oere, v_maks, v_krav, sys)
      on conflict (sag_id) do nothing;
      if not found then return 'uaendret'; end if;

      perform public.fragt_reklamation_log(sys, 'reklamation_oprettet', p_sag, c.saelger_id,
        'Reklamation hos ' || upper(c.transportoer) || ' oprettet automatisk (skadet under fragten, ordentlig '
        || 'indpakning, køberen er refunderet, og afgørelsen er endelig). BidHamr anmelder - kravbeløb '
        || public.fragt_reklamation_kr(v_krav)
        || case when v_maks is null then ' (maks. erstatning ukendt - varens værdi)' else '' end);
      return 'oprettet';
    end if;

    -- Genåbnet inden for 1 time efter den automatiske annullering (fx staff
    -- fortryder "ordentlig" og vurderer igen): aktiv_fra_kl beholdes, så
    -- sælgeren ikke får "Vi reklamerer for dig" igen (samme nøgle), og
    -- "stoppet"-beskeden er heller ikke sendt endnu (den venter 1 time -
    -- AUTO_STOP_VENT i src/lib/reklamation/notifikationer.ts). Senere: ny
    -- aktivering og ny besked.
    if r.status = 'annulleret' and r.annulleret_auto then
      update public.fragt_reklamationer
         set status = 'afventer_bidhamr', annulleret_auto = false, annulleret_grund = null,
             annulleret_af = null, annulleret_kl = null,
             sag_aendret_kl = null, sag_aendret_kvitteret_kl = null, sag_aendret_kvitteret_af = null,
             sag_aendret_kvitteret_aarsag = null,
             aktiv_fra_kl = case when r.annulleret_kl > now() - interval '1 hour' then r.aktiv_fra_kl else now() end,
             fremdrift_kl = now()
       where id = r.id and status = 'annulleret' and annulleret_auto;
      perform public.fragt_reklamation_log(sys, 'reklamation_genaabnet', p_sag, r.saelger_id,
        'Reklamationen er aktiv igen: køberen er refunderet, afgørelsen er endelig, og indpakningen er ordentlig');
      return 'genaabnet';
    end if;

    -- Sagen var markeret ændret, men betingelserne er opfyldt igen (fx
    -- refusionen er gennemført igen): systemet kvitterer.
    if r.sag_aendret_kl is not null and r.sag_aendret_kvitteret_kl is null
       and r.status in ('anmeldt', 'godkendt') then
      update public.fragt_reklamationer
         set sag_aendret_kvitteret_kl = now(), sag_aendret_kvitteret_af = sys,
             sag_aendret_kvitteret_aarsag = null, fremdrift_kl = now()
       where id = r.id and sag_aendret_kl is not null and sag_aendret_kvitteret_kl is null;
      perform public.fragt_reklamation_log(sys, 'reklamation_sag_aendret_kvitteret', p_sag, r.saelger_id,
        'Betingelserne er opfyldt igen (køberen er refunderet, afgørelsen er endelig, indpakningen er '
        || 'ordentlig) - kvitteret automatisk, reklamationen fortsætter (status ' || r.status || ')');
      return 'sag_aendret_kvitteret';
    end if;
    return 'uaendret';
  end if;

  -- Betingelserne er ikke (længere) opfyldt.
  if not v_findes then return 'ikke_relevant'; end if;

  select status into v_status from public.sager where id = p_sag;

  if r.status = 'afventer_bidhamr' then
    update public.fragt_reklamationer
       set status = 'annulleret', annulleret_auto = true, annulleret_af = sys, annulleret_kl = now(),
           annulleret_grund = 'Sagen er ændret (refusionen, afgørelsen eller vurderingen af indpakningen).'
     where id = r.id and status = 'afventer_bidhamr';
    perform public.fragt_reklamation_log(sys, 'reklamation_annulleret', p_sag, r.saelger_id,
      'Reklamationen er annulleret automatisk, før skaden blev anmeldt (' || coalesce(c.aarsag, '?')
      || ', sagens status ' || coalesce(v_status, '?') || ')');
    return 'annulleret';
  end if;

  -- Ny markering, når sagen ikke er markeret, ELLER når den er kvitteret og
  -- er ændret igen bagefter:
  --   - kvitteret under opfyldte betingelser (sag_aendret_kvitteret_aarsag
  --     null - systemets eller staffs kvittering): altid markeres igen.
  --   - kvitteret af staff under en midlertidig årsag (anke_venter /
  --     ankefrist): kun når årsagen nu er en anden end de midlertidige.
  -- En udbetalt reklamation røres ikke (pengene er sendt).
  if r.status in ('anmeldt', 'godkendt')
     and (r.sag_aendret_kl is null
          or (r.sag_aendret_kvitteret_kl is not null
              and (r.sag_aendret_kvitteret_aarsag is null
                   or coalesce(c.aarsag, '') not in ('anke_venter', 'ankefrist')))) then
    update public.fragt_reklamationer
       set sag_aendret_kl = now(), sag_aendret_kvitteret_kl = null, sag_aendret_kvitteret_af = null,
           sag_aendret_kvitteret_aarsag = null
     where id = r.id;
    perform public.fragt_reklamation_log(sys, 'reklamation_sag_aendret', p_sag, r.saelger_id,
      'OBS: sagen er ændret (' || coalesce(c.aarsag, '?') || ', status ' || coalesce(v_status, '?')
      || '), efter skaden er anmeldt hos ' || upper(r.transportoer)
      || '. "Godkendt" og udbetalingen er spærret, til staff har kvitteret.');
    return 'sag_aendret';
  end if;

  return 'uaendret';
end;
$function$
;

