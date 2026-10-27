-- De RIGTIGE funktioner fra testdatabasen (pjiigmzqwlfepxnjdvug) før 20261102210000_sagsregler.sql,
-- hentet 27. okt. 2026 med pg_get_functiondef. Bruges af tests/penge-db/sagsregler.test.ts
-- (md5-drift-tjekket skal genkende dem som "gammel").

CREATE OR REPLACE FUNCTION public.sag_opret(p_trade uuid, p_type text, p_beskrivelse text, p_billeder jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bruger   uuid := auth.uid();
  v_beskr    text := btrim(coalesce(p_beskrivelse, ''));
  v_billeder jsonb := coalesce(p_billeder, '[]'::jsonb);
  b          record;
  t          record;
  v_sendt    timestamptz;
  v_fejl     text;
  v_sag      uuid;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if p_type is null or p_type not in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if char_length(v_beskr) not between 10 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;

  if not exists (select 1 from public.trades
                  where id = p_trade and buyer_id = v_bruger) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select * into b from public.betalinger where trade_id = p_trade for update;
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or t.buyer_id <> v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if exists (select 1 from public.sager s where s.trade_id = p_trade) then
    return jsonb_build_object('kode', 'findes');
  end if;

  if b.id is null
     or b.status <> 'betalt'
     or b.frigivet_kl is not null
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then
    return jsonb_build_object('kode', 'ikke_betalt');
  end if;

  if p_type in ('skadet', 'ikke_som_beskrevet') and not b.beskyttelse then
    return jsonb_build_object('kode', 'kraever_beskyttelse');
  end if;

  if t.status = 'modtaget' then
    -- 20261030010000: bortkommet også, når fragtfirmaets leveringsmelding
    -- startede uret (køberen har ikke selv kvitteret) - inden for 48 timer.
    if p_type = 'bortkommet' and t.modtaget_kilde is distinct from 'fragt' then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    if t.received_at is null or t.received_at < now() - interval '48 hours' then
      return jsonb_build_object('kode', 'for_sent');
    end if;
  elsif t.status = 'pakke_sendt' then
    if p_type not in ('bortkommet', 'svindel') then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    v_sendt := coalesce(t.sendt_kl, b.betalt_kl);
    if v_sendt is null or v_sendt > now() - interval '7 days' then
      return jsonb_build_object('kode', 'for_tidligt');
    end if;
  else
    return jsonb_build_object('kode', 'forkert_trin');
  end if;

  v_fejl := public.sag_valider_billeder(v_bruger, p_trade, v_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  if t.status = 'modtaget' and p_type <> 'bortkommet' and not (
       exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'pakke')
   and exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'label')
   and exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'indhold')) then
    return jsonb_build_object('kode', 'billeder_kraeves');
  end if;

  begin
    insert into public.sager (trade_id, oprettet_af, type, beskrivelse, beskyttelse,
                              handel_status_ved_oprettelse, tjek_sporing)
    values (p_trade, v_bruger, p_type, v_beskr, b.beskyttelse, t.status,
            t.status = 'pakke_sendt' or p_type = 'bortkommet')
    returning id into v_sag;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  insert into public.sag_billeder (sag_id, sti, kategori)
  select v_sag, e->>'sti', e->>'kategori'
    from jsonb_array_elements(v_billeder) e;

  update public.trades
     set sag_aaben = true,
         sag_note = 'Sag fra køberen: ' || case p_type
                      when 'bortkommet' then 'pakken er ikke kommet frem'
                      when 'skadet' then 'varen er skadet'
                      when 'ikke_som_beskrevet' then 'varen er ikke som beskrevet'
                      else 'svindel' end,
         sag_aabnet_af = v_bruger,
         sag_aabnet_at = now()
   where id = p_trade;

  return jsonb_build_object('kode', 'ok', 'sag_id', v_sag);
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_valider_billeder(p_koeber uuid, p_trade uuid, p_billeder jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e        jsonb;
  v_sti    text;
  v_kat    text;
  v_stier  text[] := '{}';
begin
  if p_billeder is null or jsonb_typeof(p_billeder) <> 'array' then
    return 'ugyldige_billeder';
  end if;
  if jsonb_array_length(p_billeder) > 10 then return 'for_mange_billeder'; end if;

  for e in select * from jsonb_array_elements(p_billeder) loop
    if jsonb_typeof(e) <> 'object' then return 'ugyldige_billeder'; end if;
    v_sti := e->>'sti';
    v_kat := e->>'kategori';
    if v_sti is null or v_kat is null
       or v_kat not in ('pakke', 'label', 'indhold', 'andet') then
      return 'ugyldige_billeder';
    end if;
    if split_part(v_sti, '/', 1) <> p_koeber::text
       or split_part(v_sti, '/', 2) <> p_trade::text
       or v_sti !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$' then
      return 'ugyldige_billeder';
    end if;
    if v_sti = any(v_stier) then return 'ugyldige_billeder'; end if;
    v_stier := v_stier || v_sti;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'sag-billeder' and o.name = v_sti) then
      return 'billede_mangler';
    end if;
    if exists (select 1 from public.sag_billeder b where b.sti = v_sti) then
      return 'ugyldige_billeder';
    end if;
  end loop;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_billede_maa_uploade(p_sti text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bruger uuid := auth.uid();
  v_dele   text[] := string_to_array(coalesce(p_sti, ''), '/');
  v_trade  uuid;
begin
  if v_bruger is null or array_length(v_dele, 1) <> 3 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if v_dele[3] !~ '^[A-Za-z0-9._-]{1,100}$' then return false; end if;
  v_trade := v_dele[2]::uuid;

  if not exists (
    select 1 from public.trades t
     where t.id = v_trade
       and t.buyer_id = v_bruger
       and (t.status in ('pakke_sendt', 'modtaget')
            or exists (select 1 from public.sager s
                        where s.trade_id = t.id
                          and s.status in ('aaben', 'afventer_retur')))
  ) and not exists (
    select 1 from public.sager s
     where s.trade_id = v_trade
       and public.sag_anke_vurder(s.id, v_bruger)->>'kode' = 'kan_anke'
  ) then
    return false;
  end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'sag-billeder'
             and o.name like v_bruger::text || '/' || v_trade::text || '/%') < 30;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_billede_maa_laese(p_sti text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null and (
       split_part(coalesce(p_sti, ''), '/', 1) = auth.uid()::text
    or public.er_staff()
    or exists (
         select 1 from public.sag_billeder b
           join public.sager s on s.id = b.sag_id
           join public.trades t on t.id = s.trade_id
          where b.sti = p_sti
            and (t.seller_id = auth.uid() or t.buyer_id = auth.uid()))
    or exists (
         select 1 from public.sag_anke_billeder ab
           join public.sag_anker a on a.id = ab.anke_id
           join public.trades t on t.id = a.trade_id
          where ab.sti = p_sti
            and (t.seller_id = auth.uid() or t.buyer_id = auth.uid()))
  );
$function$;

CREATE OR REPLACE FUNCTION public.sager_beskyt()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.id                           is distinct from old.id
  or new.trade_id                     is distinct from old.trade_id
  or new.oprettet_af                  is distinct from old.oprettet_af
  or new.type                         is distinct from old.type
  or new.beskrivelse                  is distinct from old.beskrivelse
  or new.beskyttelse                  is distinct from old.beskyttelse
  or new.handel_status_ved_oprettelse is distinct from old.handel_status_ved_oprettelse
  or new.tjek_sporing                 is distinct from old.tjek_sporing
  or new.oprettet_kl                  is distinct from old.oprettet_kl then
    raise exception 'Sagens faste oplysninger kan ikke ændres.' using errcode = '42501';
  end if;
  new.opdateret := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_refusion_oere(p_prismodel text, p_bud_oere bigint, p_total_oere bigint, p_beskyttelse_oere bigint)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when p_prismodel in ('ny', 'ny2') then p_bud_oere
              else p_total_oere - coalesce(p_beskyttelse_oere, 0) end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_claim_refusion(p_betaling uuid, OUT beloeb bigint, OUT fejl text)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  b record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then
    fejl := 'ikke_mulig';
    return;
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    fejl := 'indsigelse';
    return;
  end if;
  if b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then
    fejl := 'ikke_mulig';
    return;
  end if;

  -- Ny prismodel (Filip, 26. okt. 2026 - som Trendsales): køberen får kun
  -- buddet tilbage; købergebyr og fragt refunderes ikke. Gamle handler: alt
  -- undtagen BidHamr Beskyttelse (som før). public.sag_refusion_oere.
  beloeb := public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere);
  if beloeb <= 0 or beloeb > b.total_oere then
    beloeb := null;
    fejl := 'ikke_mulig';
    return;
  end if;

  update public.betalinger
     set refusion_anmodet_kl = now(),
         refusion_aarsag = 'sag',
         refusion_oere = beloeb,
         opdateret = now()
   where id = b.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.betaling_bidhamr_daekker_claim(p_medarbejder uuid, p_betaling uuid, p_begrundelse text, p_noegle uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  b      record;
  v_begr text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_ust  text;
  v_r    bigint;
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users u where u.id = p_medarbejder and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_noegle is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  perform 1 from public.trades where id = b.trade_id for update;
  if public.penge_inhabil(p_medarbejder, b.buyer_id, b.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if b.bidhamr_daekker_refunderet_kl is not null or b.status = 'refunderet' then
    return jsonb_build_object('kode', 'allerede');
  end if;
  if b.bidhamr_daekker_laas_til is not null and b.bidhamr_daekker_laas_til > now() then
    return jsonb_build_object('kode', 'i_gang');
  end if;
  -- Første gang kræves begrundelse; et nyt forsøg genbruger den låste plan.
  if b.bidhamr_daekker_kl is null then
    if v_begr is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
    if char_length(v_begr) > 2000 then return jsonb_build_object('kode', 'begrundelse_for_lang'); end if;
  end if;
  if b.pengemodel <> 'destination' or b.stripe_payment_intent_id is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return jsonb_build_object('kode', 'ikke_betalt'); end if;
  if b.saelger_udbetaling_id is null then return jsonb_build_object('kode', 'ikke_udbetalt'); end if;
  select u.status into v_ust from public.saelger_udbetalinger u where u.id = b.saelger_udbetaling_id;
  if v_ust is null or v_ust <> 'paid' then
    return jsonb_build_object('kode', 'udbetaling_uafklaret');
  end if;
  if b.indsigelse_kl is not null
     and (public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) or b.indsigelse_status = 'lost') then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if b.stripe_refund_id is not null or b.gebyr_refunderet_kl is not null or b.refusion_tilbagefoert_kl is not null then
    return jsonb_build_object('kode', 'konflikt');
  end if;

  if b.bidhamr_daekker_oere is null then
    v_r := case
      when exists (select 1 from public.sager s
                    where s.trade_id = b.trade_id and s.penge_handling = 'refunder' and s.afviklet_kl is null)
        -- 20261031010000: ny prismodel = kun buddet (public.sag_refusion_oere).
        then public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere)
      else coalesce(b.refusion_oere, b.total_oere) end;
    if v_r <= 0 or v_r > b.total_oere then return jsonb_build_object('kode', 'ugyldig'); end if;
    update public.betalinger
       set bidhamr_daekker_kl = now(),
           bidhamr_daekker_af = p_medarbejder,
           bidhamr_daekker_oere = v_r,
           bidhamr_daekker_begrundelse = left(v_begr, 2000),
           bidhamr_daekker_foer_fejl = sidste_fejl,
           bidhamr_daekker_foer_opm = kraever_opmaerksomhed
     where id = b.id;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'bidhamr_daekker', 'handel', b.trade_id, b.buyer_id,
            left('BidHamr dækker: køberen refunderes fra BidHamr efter udbetaling - ' || v_begr, 2000));
  else
    v_r := b.bidhamr_daekker_oere;
  end if;

  update public.betalinger
     set bidhamr_daekker_laas_noegle = p_noegle,
         bidhamr_daekker_laas_til = now() + interval '15 minutes',
         bidhamr_daekker_fejl = null,
         opdateret = now()
   where id = b.id;

  return jsonb_build_object('kode', 'ok', 'refusion_oere', v_r,
                            'payment_intent', b.stripe_payment_intent_id,
                            'charge', b.stripe_charge_id,
                            'trade_id', b.trade_id, 'buyer_id', b.buyer_id, 'seller_id', b.seller_id,
                            'refund_id', b.bidhamr_daekker_refund_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.handel_auto_frigiv()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  k       record;
  b       record;
  t       record;
  v_grund text;
  v_label boolean;
  v_lev   boolean;
  v_tekst text;
  v_ud    jsonb := '[]'::jsonb;
begin
  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.trades tr
      join public.betalinger bt on bt.trade_id = tr.id
     where bt.status = 'betalt'
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null and bt.saelger_udbetaling_id is null
       and not coalesce(tr.sag_aaben, false)
       -- Frasorteres her, saa de ikke fylder de 200 pladser hver gang.
       and not public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
       and not exists (
         select 1 from public.sager s
          where s.trade_id = tr.id
            and (s.status in ('aaben', 'afventer_retur')
                 or (s.penge_handling is not null and s.afviklet_kl is null)))
       -- Pakken er sendt retur (ikke afhentet): aldrig automatisk.
       and not exists (
         select 1 from public.forsendelser fo
          where fo.trade_id = tr.id and fo.type = 'udgaaende' and fo.returneret_kl is not null)
       and not exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = tr.id)
       and ((tr.status = 'modtaget' and tr.received_at < now() - interval '48 hours')
            or (tr.status = 'pakke_sendt'
                and coalesce(tr.sendt_kl, bt.betalt_kl) < now() - interval '14 days'
                -- 20261030010000: 48 timer efter en leveringsmelding.
                and not public.handel_leveret_melding_ny(tr.id)
                -- Opgaven er givet: kun med igen, når pakken er meldt leveret.
                and (bt.auto_frigiv_opgave_kl is null
                     or exists (select 1 from public.forsendelser fo
                                 where fo.trade_id = tr.id and fo.type = 'udgaaende'
                                   and fo.status not in ('annulleret', 'fejlet')
                                   and fo.leveret_kl is not null and fo.leveret_frigiver))))
     order by tr.id
     limit 200
  loop
    -- Hver raekke i sin egen undertransaktion: een fejl (fx en constraint)
    -- ruller kun den raekke tilbage og stopper ikke resten af batchen.
    begin
      -- Laaseraekkefoelge: betaling, handel. Alt tjekkes igen under laas.
      select * into b from public.betalinger where id = k.betaling_id for update;
      select * into t from public.trades where id = k.trade_id for update;

      if b.status <> 'betalt'
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
         or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
         or coalesce(t.sag_aaben, false)
         or public.sag_holder_pengene(t.id)
         or exists (select 1 from public.forsendelser fo
                     where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.returneret_kl is not null)
         or exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id) then
        continue;
      end if;

      if t.status = 'modtaget' and t.received_at < now() - interval '48 hours' then
        v_grund := '48_timer';
      elsif t.status = 'pakke_sendt'
            and coalesce(t.sendt_kl, b.betalt_kl) < now() - interval '14 days'
            -- 20261030010000: 48 timer efter en leveringsmelding (ellers venter
            -- handlen - ingen opgave til staff endnu).
            and not public.handel_leveret_melding_ny(t.id) then
        select count(*) > 0,
               -- 20261024010000: Shipmondos leveret frigiver kun med flaget.
               coalesce(bool_or(fo.leveret_kl is not null and fo.leveret_frigiver), false)
          into v_label, v_lev
          from public.forsendelser fo
         where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.status not in ('annulleret', 'fejlet');
        if v_label and v_lev then
          v_grund := '14_dage';
        else
          -- Aldrig automatisk: en opgave til staff (én gang).
          if b.auto_frigiv_opgave_kl is null then
            v_tekst := case when v_label
              then 'Pakken blev sendt med BidHamrs fragtlabel for over 14 dage siden, men fragtfirmaet har ikke meldt den leveret eller afhentet (eller meldingen kom fra Shipmondo, som endnu ikke må frigive penge automatisk). Pengene frigives ikke automatisk - efterlys pakken hos fragtfirmaet og afgør handlen.'
              else 'Pakken blev sendt uden BidHamrs fragtlabel (sælgerens eget sporingsnummer) for over 14 dage siden, og køberen har ikke bekræftet modtagelsen. Pengene frigives aldrig automatisk - kontakt køberen og afgør handlen.'
            end;
            update public.betalinger
               set auto_frigiv_opgave_kl = now(),
                   kraever_opmaerksomhed = true,
                   sidste_fejl = left(coalesce(nullif(sidste_fejl, '') || ' | ', '') || v_tekst, 500),
                   opdateret = now()
             where id = b.id and auto_frigiv_opgave_kl is null;
          end if;
          continue;
        end if;
      else
        continue;
      end if;

      update public.trades
         set status = 'leveret', received_at = coalesce(received_at, now())
       where id = t.id and status = t.status;
      if not found then continue; end if;

      update public.betalinger
         set frigivet_kl = now(), opdateret = now()
       where id = b.id and frigivet_kl is null;

      v_ud := v_ud || jsonb_build_array(jsonb_build_object(
        'betaling_id', b.id, 'trade_id', t.id, 'buyer_id', t.buyer_id,
        'seller_id', t.seller_id, 'auction_id', t.auction_id, 'grund', v_grund));
    exception when others then
      raise warning 'handel_auto_frigiv: handel % fejlede: %', k.trade_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$function$;

CREATE OR REPLACE FUNCTION public.handel_leveret_melding_ny(p_trade uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.forsendelser fo
     where fo.trade_id = p_trade and fo.type = 'udgaaende'
       and fo.status not in ('annulleret', 'fejlet')
       and fo.leveret_kl is not null and fo.leveret_frigiver
       and greatest(fo.leveret_kl,
                    coalesce((select min(h.modtaget_kl) from public.forsendelse_haendelser h
                               where h.forsendelse_id = fo.id and h.type = 'leveret'),
                             fo.leveret_kl)) >= now() - interval '48 hours');
$function$;

CREATE OR REPLACE FUNCTION public.admin_penge_holdes(p_graense integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with h as (
    select bt.id as betaling_id, bt.trade_id, bt.auction_id, bt.total_oere,
           bt.udbetaling_oere, bt.betalt_kl, bt.kraever_opmaerksomhed,
           t.status as handel_status, s.penge_fejl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then 'indsigelse'
             when bt.refusion_anmodet_kl is not null then 'refusion_i_gang'
             when su.id is not null then 'udbetaling_paa_vej'
             when bt.frigivet_kl is not null
                  and bp.connect_udbetaling_fejlet_kl is not null then 'venter_paa_bank'
             when bt.frigivet_kl is not null then 'afventer_udbetaling'
             when an.id is not null then 'afventer_anke'
             when s.status = 'aaben' then 'afventer_sag'
             when s.status = 'afventer_retur' then 'afventer_retur'
             when s.penge_handling is not null then 'ankefrist'
             when coalesce(t.sag_aaben, false) then 'frosset'
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'afhentning'
             when t.status = 'betaling_modtaget' then 'afventer_afsendelse'
             when t.status = 'pakke_sendt' then 'auto_frigivelse'
             when t.status = 'modtaget' and t.received_at is not null then 'auto_frigivelse'
             else 'kraever_tjek'
           end as grund,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
                  or bt.refusion_anmodet_kl is not null
               then null
             when bt.frigivet_kl is not null and su.id is null
                  and bp.connect_udbetaling_fejlet_kl is null
               then greatest(coalesce(bt.midler_tilgaengelige_kl, now()),
                             coalesce(bt.udbetal_tidligst, '-infinity'::timestamptz))
             when su.id is not null
                  or bt.frigivet_kl is not null
                  or an.id is not null
                  or s.status = 'aaben'
               then null
             when s.status = 'afventer_retur' or s.penge_handling is not null
               then s.penge_flyttes_efter_kl
             when coalesce(t.sag_aaben, false) or coalesce(t.afhentning, false) then null
             when t.status = 'betaling_modtaget' then bt.betalt_kl + interval '5 days'
             when t.status = 'pakke_sendt'
               then coalesce(t.sendt_kl, bt.betalt_kl) + interval '14 days'
             when t.status = 'modtaget' then t.received_at + interval '48 hours'
           end as forventet_kl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then null
             when bt.refusion_anmodet_kl is not null then 'refunder'
             when su.id is not null or bt.frigivet_kl is not null
               then 'frigiv'
             when an.id is not null or s.status = 'aaben' then null
             when s.status = 'afventer_retur' then 'refunder'
             when s.penge_handling is not null then s.penge_handling
             when coalesce(t.sag_aaben, false) then null
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'frigiv'
             when t.status = 'betaling_modtaget' then 'refunder'
             when t.status in ('pakke_sendt', 'modtaget') then 'frigiv'
           end as handling
      from public.betalinger bt
      join public.trades t on t.id = bt.trade_id
      left join public.saelger_udbetalinger su on su.id = bt.saelger_udbetaling_id
      left join public.betalingsprofiler bp on bp.user_id = bt.seller_id
      left join lateral (
        select s1.status, s1.penge_handling, s1.penge_flyttes_efter_kl, s1.penge_fejl
          from public.sager s1
         where s1.trade_id = bt.trade_id
           and (s1.status in ('aaben', 'afventer_retur')
                or (s1.penge_handling is not null and s1.afviklet_kl is null))
         order by s1.oprettet_kl desc
         limit 1
      ) s on true
      left join lateral (
        select a1.id from public.sag_anker a1
         where a1.trade_id = bt.trade_id and a1.status = 'afventer'
         limit 1
      ) an on true
     where bt.pengemodel = 'destination'
       and bt.status = 'betalt'
       and bt.refunderet_kl is null
       and (su.id is null or su.status <> 'paid')
       and coalesce(bt.indsigelse_status, '') <> 'lost'
  ),
  afv as (
    select a.id, a.trade_id, a.modtaget_oere, a.oprettet, a.sidste_fejl
      from public.betaling_afvigelser a
     where a.refunderet_kl is null
  )
  select jsonb_build_object(
    'antal', (select count(*) from h),
    'beloeb', (select coalesce(sum(total_oere), 0) from h),
    'til_saelgere', (select coalesce(sum(udbetaling_oere), 0) from h),
    'efter_grund', coalesce((
      select jsonb_agg(jsonb_build_object('grund', grund, 'antal', antal, 'beloeb', beloeb)
                       order by beloeb desc)
        from (select grund, count(*) as antal, sum(total_oere) as beloeb
                from h group by grund) x), '[]'::jsonb),
    'forkerte_beloeb', jsonb_build_object(
        'antal',  (select count(*) from afv),
        'beloeb', (select coalesce(sum(modtaget_oere), 0) from afv)),
    'liste', coalesce((
      select jsonb_agg(jsonb_build_object(
               'betaling_id', l.betaling_id,
               'trade_id', l.trade_id,
               'auction_id', l.auction_id,
               'titel', au.titel,
               'total_oere', l.total_oere,
               'udbetaling_oere', l.udbetaling_oere,
               'betalt_kl', l.betalt_kl,
               'handel_status', l.handel_status,
               'grund', l.grund,
               'forventet_kl', l.forventet_kl,
               'handling', l.handling,
               'penge_fejl', l.penge_fejl,
               'kraever_opmaerksomhed', l.kraever_opmaerksomhed)
             order by l.forventet_kl asc nulls last, l.betalt_kl asc)
        from (select * from h
               order by forventet_kl asc nulls last, betalt_kl asc
               limit greatest(1, least(coalesce(p_graense, 200), 1000))) l
        left join public.auctions au on au.id = l.auction_id), '[]'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION public.returfragt_sag(p_trade uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id       uuid;
  v_status   text;
  v_retur    boolean;
  v_afl      timestamptz;
  v_penge    timestamptz;
  v_anke_id  uuid;
  v_anke     text;
begin
  select s.id, s.status, s.retur_kraeves, s.retur_afleveret_kl, s.penge_flyttes_efter_kl
    into v_id, v_status, v_retur, v_afl, v_penge
    from public.sager s
   where s.trade_id = p_trade
   order by s.oprettet_kl desc
   limit 1;
  if v_id is null then return jsonb_build_object('kode', 'ingen_sag'); end if;
  if v_status <> 'afventer_retur' or not v_retur then
    return jsonb_build_object('kode', 'ingen_retur', 'sag_id', v_id);
  end if;
  if v_afl is not null then return jsonb_build_object('kode', 'afleveret', 'sag_id', v_id); end if;
  select a.id, a.status into v_anke_id, v_anke
    from public.sag_anker a where a.sag_id = v_id order by a.indgivet_kl desc limit 1;
  if v_anke = 'afventer' then return jsonb_build_object('kode', 'anke', 'sag_id', v_id); end if;
  if v_anke_id is null and v_penge is not null and v_penge > now() then
    return jsonb_build_object('kode', 'ankefrist', 'sag_id', v_id, 'til_kl', v_penge);
  end if;
  return jsonb_build_object('kode', 'ok', 'sag_id', v_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.returfragt_start(p_trade uuid, p_koeber uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t        record;
  rf       record;
  v_sag    jsonb;
  v_bet    uuid;
  v_fragt  bigint;
  v_stoerrelse text;
  v_shop   bigint;
  v_pris   bigint;
  v_id     uuid;
begin
  if p_trade is null or p_koeber is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  select tr.id, tr.buyer_id, tr.auction_id, tr.afhentning into t
    from public.trades tr where tr.id = p_trade for update;
  if t.id is null or t.buyer_id is distinct from p_koeber then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'ingen_retur'); end if;

  select r.id, r.status, r.beloeb_oere, r.stripe_payment_intent_id, r.pi_forsoeg into rf
    from public.returfragt_betalinger r
   where r.trade_id = p_trade and r.status in ('afventer', 'behandles', 'betalt', 'refunderes')
   limit 1
   for update;
  if rf.id is not null then
    if rf.status in ('betalt', 'refunderes') then
      return jsonb_build_object('kode', rf.status, 'id', rf.id, 'beloeb_oere', rf.beloeb_oere);
    end if;
    -- Ubetalt række: kun videre, hvis sagen stadig kræver retur nu (ellers
    -- annullerer cron'en PaymentIntenten).
    v_sag := public.returfragt_sag(p_trade);
    if v_sag->>'kode' <> 'ok' and rf.status = 'afventer' then
      return jsonb_build_object('kode', v_sag->>'kode', 'til_kl', v_sag->'til_kl');
    end if;
    return jsonb_build_object('kode', 'findes', 'id', rf.id, 'beloeb_oere', rf.beloeb_oere,
                              'pi', rf.stripe_payment_intent_id, 'pi_forsoeg', rf.pi_forsoeg, 'status', rf.status);
  end if;

  v_sag := public.returfragt_sag(p_trade);
  if v_sag->>'kode' <> 'ok' then
    return jsonb_build_object('kode', v_sag->>'kode', 'til_kl', v_sag->'til_kl');
  end if;

  -- Sælgerens adresse (modtager) står på den udgående label.
  if not exists (select 1 from public.forsendelser f
                  where f.trade_id = p_trade and f.type = 'udgaaende' and f.afsender is not null) then
    return jsonb_build_object('kode', 'mangler_adresse');
  end if;

  -- Prisen: fragten ud, som køberen betalte (handlens betaling).
  select b.id, b.fragt_oere into v_bet, v_fragt
    from public.betalinger b
   where b.trade_id = p_trade and b.betalt_kl is not null
   order by b.betalt_kl desc
   limit 1;
  if v_bet is null then return jsonb_build_object('kode', 'ingen_betaling'); end if;
  select a.pakkestoerrelse, a.fragt_pakkeshop_oere into v_stoerrelse, v_shop
    from public.auctions a where a.id = t.auction_id;
  v_pris := v_fragt;
  if v_pris is null or v_pris < 300 then v_pris := v_shop; end if;
  if v_pris is null or v_pris < 300 then
    select p.pakkeshop_oere into v_pris from public.fragt_pakkestoerrelser p
     where p.kode = coalesce(v_stoerrelse, 'mellem');
  end if;
  if v_pris is null or v_pris < 300 or v_pris > 1000000 then
    return jsonb_build_object('kode', 'ingen_pris');
  end if;

  insert into public.returfragt_betalinger (trade_id, sag_id, koeber_id, betaling_id, beloeb_oere, pakkestoerrelse)
  values (p_trade, (v_sag->>'sag_id')::uuid, p_koeber, v_bet, v_pris, v_stoerrelse)
  returning id into v_id;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'beloeb_oere', v_pris, 'pi', null, 'pi_forsoeg', 0);
end;
$function$;

CREATE OR REPLACE FUNCTION public.returfragt_refusion_claim(p_id uuid, p_aarsag text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  rf record;
  f  record;
  v_fstatus text;
begin
  if p_aarsag is null or p_aarsag not in ('label_umulig', 'ikke_noedvendig', 'staff') then return 'ugyldig'; end if;
  select r.id, r.status, r.label_klar_kl, r.forsendelse_id, r.label_annulleret_bekraeftet_kl into rf
    from public.returfragt_betalinger r where r.id = p_id for update;
  if rf.id is null or rf.status <> 'betalt' then return 'forkert_status'; end if;
  if rf.forsendelse_id is not null then
    select fo.id, fo.status, fo.forsoegt_kl, fo.oprettet_kl, fo.ukendt_udfald_kl into f
      from public.forsendelser fo where fo.id = rf.forsendelse_id for update;
    -- Seneste returkode er annulleret (evt. kun i BidHamr - den kan stadig
    -- være gyldig hos fragtfirmaet): kun staff må refundere.
    v_fstatus := f.status;
    -- (Er annulleringen bekræftet af fragtfirmaet, er der ingen gyldig kode.)
    if f.status = 'annulleret' and rf.label_annulleret_bekraeftet_kl is null and p_aarsag <> 'staff' then
      return 'staff_afgoer';
    end if;
    if f.status not in ('opretter', 'fejlet', 'annulleret') then return 'label_findes'; end if;
  end if;
  if rf.label_klar_kl is not null and v_fstatus is distinct from 'annulleret' then return 'label_findes'; end if;
  if rf.forsendelse_id is not null then
    if f.status = 'opretter' then
      -- Et forsøg kan stadig være i gang hos fragtfirmaet.
      if f.ukendt_udfald_kl is null and coalesce(f.forsoegt_kl, f.oprettet_kl) > now() - interval '10 minutes' then
        return 'i_gang';
      end if;
      -- Opgivet: koden er aldrig vist køberen (en evt. forældreløs pakke hos
      -- DAO indleveres aldrig og faktureres ikke).
      update public.forsendelser
         set status = 'fejlet', fejl = left(concat_ws(' - ', fejl, 'Returfragten er refunderet'), 500)
       where id = f.id;
    end if;
  end if;
  update public.returfragt_betalinger
     set status = 'refunderes', refusion_aarsag = p_aarsag, refusion_anmodet_kl = now(),
         refusion_naeste_kl = null
   where id = p_id;
  return 'ok';
end;
$function$;

CREATE OR REPLACE FUNCTION public.faktura_planlaeg_returfragt(p_graense integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_graense integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura integer := 0;
  v_kredit  integer := 0;
  n         integer;
  r         record;
  v_linjer  jsonb;
  v_ok      boolean;
  v_fejl    text := 'Returfragten er betalt med et andet beløb end prisen (eller handlens betaling mangler) - kontrollér betalingen hos Stripe og lav dokumentet manuelt i Dinero.';
begin
  for r in
    select x.id, x.koeber_id, x.trade_id, x.betaling_id, x.beloeb_oere, x.modtaget_oere, x.betalt_kl,
           x.stripe_charge_id, x.stripe_payment_intent_id
      from public.returfragt_betalinger x
     where x.betalt_kl is not null
       and x.status in ('betalt', 'refunderes', 'refunderet')
       and x.betaling_id is not null
       and not exists (select 1 from public.fakturaer f where f.returfragt_id = x.id and f.dokument = 'faktura')
     order by x.betalt_kl
     limit v_graense
  loop
    v_ok := r.modtaget_oere is not distinct from r.beloeb_oere;
    v_linjer := jsonb_build_array(public.faktura_linje('fragt', 'Returfragt (retur i sag)', r.beloeb_oere));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, returfragt_id)
    values ('faktura', 'koeber', r.koeber_id, r.betaling_id, r.trade_id, v_linjer, public.faktura_sum(v_linjer),
            public.faktura_moms(v_linjer), (r.betalt_kl at time zone 'Europe/Copenhagen')::date,
            coalesce(r.stripe_charge_id, r.stripe_payment_intent_id),
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else v_fejl end, 'sag_returfragt', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_faktura := v_faktura + n;
  end loop;

  for r in
    select fa.id as faktura_id, fa.bruger_id, fa.betaling_id, fa.trade_id, fa.linjer, fa.manuel, fa.status as moder_status,
           x.id, x.refunderet_kl, x.stripe_refund_id
      from public.fakturaer fa
      join public.returfragt_betalinger x on x.id = fa.returfragt_id
     where fa.dokument = 'faktura'
       and fa.slags = 'sag_returfragt'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k where k.returfragt_id = x.id and k.dokument = 'kreditnota')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_ok := not (r.manuel or r.moder_status in ('kraever_handling', 'haandteret_manuelt'));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, returfragt_id)
    values ('kreditnota', 'koeber', r.bruger_id, r.betaling_id, r.trade_id, r.faktura_id, r.linjer,
            public.faktura_sum(r.linjer), public.faktura_moms(r.linjer),
            (r.refunderet_kl at time zone 'Europe/Copenhagen')::date, r.stripe_refund_id,
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.' end,
            'sag_returfragt', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit);
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_retur_afleveret(p_medarbejder uuid, p_sag uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_trade uuid;
  s       record;
  t       record;
  b       record;
  v_res   jsonb;
  v_handling text;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(coalesce(v_note, '')) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if p_medarbejder = t.buyer_id or p_medarbejder = t.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'anke_afventer');
  end if;

  if s.status <> 'afventer_retur' or s.penge_handling is distinct from 'refunder' then
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  -- NYT: saelgeren kan anke indtil afgjort_kl + 4 dage (sag_anke_kan), men
  -- ikke naar returen er registreret. Saa laenge fristen loeber, og der ikke
  -- er anket, maa returen ikke registreres. Er anken afgjort (stadfaestet),
  -- er afgoerelsen endelig, og returen kan registreres som foer.
  if s.afgjort_kl is not null
     and now() < s.afgjort_kl + interval '4 days'
     and not exists (select 1 from public.sag_anker a where a.sag_id = s.id) then
    return jsonb_build_object('kode', 'ankefrist_loeber',
                              'ankefrist_kl', s.afgjort_kl + interval '4 days');
  end if;

  update public.sager
     set status = 'afgjort_koeber',
         retur_afleveret_kl = now(),
         retur_registreret_af = p_medarbejder,
         intern_note = case when v_note is null then intern_note
                            else left(coalesce(intern_note || chr(10), '') || 'Retur: ' || v_note, 4000) end
   where id = s.id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_retur_afleveret', 'sag', s.id, t.buyer_id,
          left('Returpakken er afleveret - refusion til køber (alt undtagen BidHamr Beskyttelse)'
               || case when s.penge_flyttes_efter_kl > now()
                       then ', når ankefristen er udløbet' else '' end
               || coalesce(' | ' || v_note, ''), 4000));

  if s.penge_flyttes_efter_kl <= now() then
    v_res := public.sag_afvikl(s.id);
    v_handling := case v_res->>'kode' when 'ok' then 'refunder' else 'refusion_blokeret' end;
  else
    v_handling := 'planlagt_refusion';
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'grund', v_res->>'grund',
    'penge_flyttes_efter_kl', s.penge_flyttes_efter_kl, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_afvikl(p_sag uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_trade uuid;
  s       record;
  t       record;
  b       record;
  r       record;
  v_grund text;
  v_res   jsonb;
begin
  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  v_res := jsonb_build_object(
    'sag_id', s.id, 'betaling_id', b.id, 'trade_id', t.id,
    'buyer_id', t.buyer_id, 'seller_id', t.seller_id, 'auction_id', t.auction_id,
    'type', s.type, 'version', s.genaabnet_antal, 'handling', s.penge_handling);

  if s.penge_handling is null or s.afviklet_kl is not null
     or s.status not in ('afventer_retur', 'afgjort_koeber', 'afgjort_saelger', 'lukket') then
    return v_res || jsonb_build_object('kode', 'intet');
  end if;
  -- Anke venter: pengene flyttes ikke, foer anken er afgjort.
  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return v_res || jsonb_build_object('kode', 'venter_anke');
  end if;
  if s.penge_flyttes_efter_kl > now() then
    return v_res || jsonb_build_object('kode', 'venter');
  end if;

  if s.penge_handling = 'refunder' then
    if s.status <> 'afgjort_koeber' then
      return v_res || jsonb_build_object('kode', 'venter_retur');
    end if;
    if b.id is null then
      v_grund := 'ingen_betaling';
    else
      select * into r from public.sag_claim_refusion(b.id);
      v_grund := r.fejl;
    end if;
    if v_grund is null then
      update public.sager
         set refusion_oere = r.beloeb, afviklet_kl = now(), penge_fejl = null
       where id = s.id;
      -- Sagen er afviklet; handlen annulleres og frysningen fjernes.
      update public.trades
         set status = 'annulleret', sag_aaben = false
       where id = t.id
         and status in ('betaling_modtaget', 'pakke_sendt', 'modtaget', 'leveret', 'annulleret');
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (public.bidhamr_system_id(), 'sag_afviklet', 'sag', s.id, t.buyer_id,
              'Ankefristen er udløbet - refusion til køber sendt til Stripe (alt undtagen BidHamr Beskyttelse)');
      return v_res || jsonb_build_object('kode', 'ok');
    end if;

  elsif s.penge_handling = 'frigiv' then
    v_grund := case
      when b.id is null then 'ingen_betaling'
      when public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then 'indsigelse'
      when b.status = 'refunderet' or b.refusion_anmodet_kl is not null then 'refusion'
      when b.status <> 'betalt' then 'ikke_betalt'
      -- Allerede frigivet (fx sagen genaabnet efter frigivelse): ok - der
      -- overfoeres blot (L3).
      when b.frigivet_kl is null and t.status not in ('pakke_sendt', 'modtaget', 'leveret')
        then 'handel_status'
      else null end;
    if v_grund is null then
      update public.sager set afviklet_kl = now(), penge_fejl = null where id = s.id;
      update public.trades
         set status = case when status in ('pakke_sendt', 'modtaget') then 'leveret' else status end,
             received_at = coalesce(received_at, now()),
             sag_aaben = false
       where id = t.id;
      update public.betalinger
         set frigivet_kl = coalesce(frigivet_kl, now()), opdateret = now()
       where id = b.id;
      insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
      values (public.bidhamr_system_id(), 'sag_afviklet', 'sag', s.id, t.seller_id,
              'Ankefristen er udløbet - pengene er frigivet til sælger');
      return v_res || jsonb_build_object('kode', 'ok');
    end if;

  else
    -- 'ingen' (lukket): frysningen fjernes; handlen fortsaetter normalt.
    update public.sager set afviklet_kl = now(), penge_fejl = null where id = s.id;
    update public.trades set sag_aaben = false where id = t.id;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (public.bidhamr_system_id(), 'sag_afviklet', 'sag', s.id, t.buyer_id,
            'Ankefristen er udløbet - frysningen er fjernet, og handlen fortsætter');
    return v_res || jsonb_build_object('kode', 'ok');
  end if;

  -- Blokeret. Markeres til admin een gang pr. grund (ingen beloeb i teksten).
  if s.penge_fejl is distinct from v_grund then
    update public.sager set penge_fejl = v_grund where id = s.id;
    if b.id is not null then
      update public.betalinger
         set kraever_opmaerksomhed = true,
             sidste_fejl = left('Sagens afgørelse kan ikke gennemføres efter ankefristen ('
                                || v_grund || ') - se sagen', 500),
             opdateret = now()
       where id = b.id;
    end if;
  end if;
  return v_res || jsonb_build_object('kode', 'blokeret', 'grund', v_grund);
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_holder_pengene(p_trade uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.sager s
     where s.trade_id = p_trade
       and (s.status in ('aaben', 'afventer_retur')
            or (s.penge_handling is not null and s.afviklet_kl is null)))
  or exists (
    select 1 from public.sag_anker a
     where a.trade_id = p_trade and a.status = 'afventer');
$function$;

CREATE OR REPLACE FUNCTION public.ekstra_fragt_lav_faktura(p_id uuid, OUT faktura_id uuid, OUT ny boolean)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r        record;
  v_linjer jsonb;
  v_ok     boolean;
  v_fejl   text := 'Ekstraregningen er betalt med et andet beløb end regningen - kontrollér betalingen hos Stripe og lav dokumentet manuelt i Dinero.';
begin
  ny := false;
  select x.id, x.saelger_id, x.trade_id, x.betaling_id, x.beloeb_oere, x.modtaget_oere, x.betalt_kl, x.runde,
         x.stripe_charge_id, x.stripe_payment_intent_id, x.fragtfirma_fakturanummer
    into r
    from public.ekstra_fragt_regninger x
   where x.id = p_id and x.betalt_kl is not null and x.status in ('betalt', 'refunderet');
  if r.id is null then faktura_id := null; return; end if;
  select f.id into faktura_id from public.fakturaer f
   where f.ekstra_fragt_id = r.id and coalesce(f.ekstra_fragt_runde, 0) = r.runde and f.dokument = 'faktura';
  if faktura_id is not null then return; end if;
  v_ok := r.modtaget_oere is not distinct from r.beloeb_oere;
  v_linjer := jsonb_build_array(public.faktura_linje('fragt',
    left('Ekstra fragt - pakken var større/tungere end den valgte størrelse (fragtfirmaets faktura ' || r.fragtfirma_fakturanummer || ')', 250),
    r.beloeb_oere));
  insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                slags, ekstra_fragt_id, ekstra_fragt_runde)
  values ('faktura', 'saelger', r.saelger_id, r.betaling_id, r.trade_id, v_linjer, public.faktura_sum(v_linjer),
          public.faktura_moms(v_linjer), (r.betalt_kl at time zone 'Europe/Copenhagen')::date,
          coalesce(r.stripe_charge_id, r.stripe_payment_intent_id),
          case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
          case when v_ok then null else v_fejl end, 'ekstra_fragt', r.id, r.runde)
  on conflict do nothing
  returning id into faktura_id;
  if faktura_id is not null then
    ny := true;
  else
    -- Lavet af en samtidig kørsel.
    select f.id into faktura_id from public.fakturaer f
     where f.ekstra_fragt_id = r.id and coalesce(f.ekstra_fragt_runde, 0) = r.runde and f.dokument = 'faktura';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ekstra_fragt_log(p_medarbejder uuid, p_handling text, p_trade uuid, p_saelger uuid, p_tekst text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, p_handling, 'handel', p_trade, p_saelger, left(coalesce(p_tekst, '-'), 4000));
$function$;

CREATE OR REPLACE FUNCTION public.ekstra_fragt_kr(p_oere bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select replace(to_char(p_oere / 100.0, 'FM999999990.00'), '.', ',') || ' kr.';
$function$;

CREATE OR REPLACE FUNCTION public.fragt_reklamation_betingelser(p_sag uuid, OUT ok boolean, OUT aarsag text, OUT trade_id uuid, OUT saelger_id uuid, OUT forsendelse_id uuid, OUT transportoer text, OUT sporingsnummer text, OUT vaerdi_oere bigint)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s record;
  t record;
  b record;
  f record;
begin
  ok := false;
  select * into s from public.sager where id = p_sag;
  if not found or s.type <> 'skadet' then aarsag := 'ikke_skadet'; return; end if;

  select * into t from public.trades where id = s.trade_id;
  if not found or t.seller_id is null then aarsag := 'ingen_handel'; return; end if;
  trade_id := t.id;
  saelger_id := t.seller_id;
  if coalesce(t.afhentning, false) then aarsag := 'afhentning'; return; end if;

  -- Den udgående pakke med DAO eller GLS (den seneste aktive).
  select fo.id, fo.sporingsnummer,
         coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) as transportoer
    into f
    from public.forsendelser fo
   where fo.trade_id = t.id and fo.type = 'udgaaende'
     and fo.status not in ('opretter', 'annulleret', 'fejlet')
     and coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) in ('dao', 'gls')
   order by fo.oprettet_kl desc
   limit 1;
  if not found then aarsag := 'ingen_forsendelse'; return; end if;
  forsendelse_id := f.id;
  transportoer := f.transportoer;
  sporingsnummer := left(nullif(btrim(coalesce(f.sporingsnummer, t.tracking_number, '')), ''), 100);

  if not exists (select 1 from public.indpakning_ordentlig o
                  where o.sag_id = s.id and o.tilbagekaldt_kl is null) then
    aarsag := 'indpakning'; return;
  end if;

  -- Køberen HAR fået pengene tilbage: refunderet (bekræftet af Stripe -
  -- samme regel som admin: status 'refunderet' og refunderet_kl) eller tabt
  -- indsigelse (banken har givet køberen pengene).
  -- OG sælgeren beholder ikke salgsbeløbet (ellers får han erstatning oven i
  -- salgsbeløbet):
  --   - refunderet: intet er givet til sælgeren. Separat: ingen transfer er
  --     sat i gang. Destination: ingen udbetaling til banken, OG hele
  --     sælgerens andel er hentet tilbage fra Connect-kontoen
  --     (refusion_tilbagefoert_kl sat og refusion_fra_saelger_oere =
  --     udbetaling_oere). Ellers (tilbageførslen mangler, eller planen tog
  --     kun en del af sælgerens andel) kan sælgeren have beholdt penge ->
  --     'saelger_beholder'. Ikke-afhentet pakke (S = R < U) rammes også, men
  --     er aldrig en skadet-sag; det fejler den sikre vej.
  --     NB (separat): er en transfer sendt og derefter hentet tilbage af
  --     staff, er stripe_transfer_id/overfoersel_paabegyndt_kl stadig sat, så
  --     handlen giver 'saelger_beholder' (ingen reklamation). Det fejler
  --     bevidst den sikre vej: hellere ingen reklamation end erstatning til
  --     en sælger, der måske har beholdt salgsbeløbet.
  --   - tabt indsigelse: separat - ingen transfer er sat i gang (pengene
  --     blev aldrig sendt til sælgeren); destination - hele udbetaling_oere
  --     er hentet tilbage fra sælgerens Connect-konto (tilbageførslen er
  --     gennemført, ikke i gang/opgivet/delvis). Var handlen udbetalt, bærer
  --     BidHamr tabet (betaling_indsigelse_tilbagefoersel_claim 'udbetalt'),
  --     og sælgeren beholder pengene -> ingen reklamation.
  select * into b from public.betalinger where betalinger.trade_id = t.id;
  if not found then aarsag := 'ikke_refunderet'; return; end if;
  if b.status = 'refunderet' and b.refunderet_kl is not null then
    if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
       or b.overfoersel_paabegyndt_kl is not null
       or (b.pengemodel = 'destination'
           and (b.refusion_tilbagefoert_kl is null
                or b.refusion_fra_saelger_oere is distinct from b.udbetaling_oere)) then
      aarsag := 'saelger_beholder'; return;
    end if;
  elsif coalesce(b.indsigelse_status, '') = 'lost' then
    if not (
         (b.pengemodel = 'separat'
          and b.stripe_transfer_id is null and b.overfoersel_paabegyndt_kl is null)
      or (b.pengemodel = 'destination'
          and b.saelger_udbetaling_id is null and b.stripe_transfer_id is null
          and b.indsigelse_tilbagefoersel_id is not null
          and b.indsigelse_tilbagefoert_kl is not null
          and b.indsigelse_tilbagefoert_oere is not null
          and b.indsigelse_tilbagefoert_oere >= b.udbetaling_oere)) then
      aarsag := 'saelger_beholder'; return;
    end if;
  else
    aarsag := 'ikke_refunderet'; return;
  end if;

  -- Endelig til købers fordel.
  if s.status = 'afgjort_koeber' and s.penge_handling = 'refunder' and s.afviklet_kl is not null then
    if exists (select 1 from public.sag_anker a where a.sag_id = s.id and a.status = 'afventer') then
      aarsag := 'anke_venter'; return;
    end if;
    -- Ankefristen (afgjort_kl + 4 dage) er udløbet - eller anken er afgjort
    -- (endelig). Refunderet hos Stripe før fristen: vent til fristen.
    if not exists (select 1 from public.sag_anker a where a.sag_id = s.id)
       and (s.afgjort_kl is null or s.afgjort_kl > now() - interval '4 days') then
      aarsag := 'ankefrist'; return;
    end if;
  elsif s.status = 'lukket' and s.penge_handling is null and s.afviklet_kl is not null then
    -- Lukket af systemet ved refusion / tabt indsigelse (kan ikke ankes).
    null;
  else
    aarsag := 'ikke_koebers_fordel'; return;
  end if;

  vaerdi_oere := coalesce(b.bud_oere, round(coalesce(t.amount, 0) * 100)::bigint);
  if vaerdi_oere is null or vaerdi_oere <= 0 then aarsag := 'ingen_vaerdi'; return; end if;

  ok := true;
  aarsag := null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fragt_reklamation_log(p_medarbejder uuid, p_handling text, p_sag uuid, p_saelger uuid, p_tekst text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, p_handling, 'sag', p_sag, p_saelger, left(p_tekst, 4000));
$function$;

CREATE OR REPLACE FUNCTION public.sag_afgoer(p_medarbejder uuid, p_sag uuid, p_udfald text, p_begrundelse text, p_intern_note text, p_retur_ikke_sendt boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_note     text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_frist    timestamptz := now() + interval '4 days';
  v_trade    uuid;
  s          record;
  t          record;
  b          record;
  v_handling text;
  v_advarsel text;
  v_log      text;
  -- Sagen har en afgjort anke (afgoerelsen paa anken er endelig).
  ak         record;
  v_anket    boolean := false;
  v_res      jsonb;
  -- Tekst til moderation_log, naar medarbejderen har bekraeftet, at
  -- koeberen ikke har sendt varen retur.
  v_retur_tjek text := '';
  -- NYT: hvornaar koeberen fik besked om at sende varen retur, og hvornaar
  -- de 7 dages ventetid er udloebet.
  v_anke_behandlet timestamptz;
  v_retur_frist    timestamptz;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('koeber', 'saelger', 'lukket') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  -- Ingen maa afgoere en sag, hvor han selv er part.
  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- En anke venter: den skal afgoeres foerst.
  if exists (select 1 from public.sag_anker a
              where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'anke_afventer');
  end if;

  -- Anken er afgjort, og afgoerelsen er endelig. Kun hvis sagen venter
  -- paa en retur, der ikke kommer (fx koeberen sender aldrig varen), maa en
  -- admin/chef afgoere den igen (til saelger eller lukke den - se
  -- statustjekket nedenfor) - og kun en anden end dem, der afgjorde sagen og
  -- anken. Der er ingen ny ankefrist: pengene flyttes straks.
  select * into ak from public.sag_anker where sag_id = s.id;
  if found then
    v_anke_behandlet := ak.behandlet_kl;
    if s.status <> 'afventer_retur' then
      return jsonb_build_object('kode', 'anket');
    end if;
    if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
      return jsonb_build_object('kode', 'anke_endelig');
    end if;
    if p_medarbejder = ak.ankede_afgjort_af
       or p_medarbejder = ak.behandlet_af
       or p_medarbejder = s.afgjort_af then
      return jsonb_build_object('kode', 'samme_medarbejder');
    end if;
    v_anket := true;
    v_frist := now();
  end if;

  if s.status = 'aaben' then
    null;
  elsif s.status = 'afventer_retur' and p_udfald in ('saelger', 'lukket') then
    -- Fx koeberen sender aldrig varen retur.
    -- NYT: foerst 7 dage efter, at koeberen fik besked om at sende varen
    -- retur. Beskeden gives, naar ankefristen er udloebet
    -- (penge_flyttes_efter_kl = afgjort_kl + 4 dage), eller naar anken er
    -- afgjort (sag_anke_afgoer saetter penge_flyttes_efter_kl = nu).
    v_retur_frist := greatest(coalesce(s.penge_flyttes_efter_kl, s.afgjort_kl + interval '4 days'),
                              coalesce(v_anke_behandlet, '-infinity'::timestamptz))
                     + interval '7 days';
    if v_retur_frist is null or now() < v_retur_frist then
      return jsonb_build_object('kode', 'retur_ventetid', 'retur_frist_kl', v_retur_frist);
    end if;
    -- Medarbejderen skal bekraefte, at koeberen ikke har sendt varen
    -- retur (heller ikke undervejs) - ellers kunne saelgeren faa baade varen
    -- og pengene (eller handlen fortsaette, mens varen er paa vej tilbage).
    if not coalesce(p_retur_ikke_sendt, false) then
      return jsonb_build_object('kode', 'bekraeft_retur_ikke_sendt');
    end if;
    v_retur_tjek := ' | Bekræftet af medarbejderen: køberen har ikke sendt varen retur (heller ikke undervejs)';
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  if p_udfald = 'koeber' then
    -- Tjek allerede nu, at en refusion vil vaere mulig (ingen indsigelse,
    -- intet overfoert). sag_afvikl tjekker igen, naar fristen er udloebet.
    if b.id is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;
    if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
      return jsonb_build_object('kode', 'indsigelse');
    end if;
    if b.status <> 'betalt'
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then
      return jsonb_build_object('kode', 'ikke_mulig');
    end if;

    if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
      -- Svindel/bortkommet refunderes uden retur. (Er returpakken allerede
      -- registreret - sagen er genaabnet efter retur - venter vi ikke igen.)
      update public.sager
         set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             retur_kraeves = (s.retur_afleveret_kl is not null),
             returfragt_betaler = case when s.retur_afleveret_kl is not null
                                       then 'koeber' end,
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'planlagt_refusion';
      v_log := 'Medhold til køber - refusion (alt undtagen BidHamr Beskyttelse) efter ankefristen på 4 dage';
    else
      -- Skadet / ikke som beskrevet: retur foer refusion.
      update public.sager
         set status = 'afventer_retur', retur_kraeves = true,
             returfragt_betaler = 'koeber',
             afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
             penge_handling = 'refunder', penge_flyttes_efter_kl = v_frist,
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_handling := 'afvent_retur';
      v_log := 'Medhold til køber - varen sendes retur (køberen betaler selv returfragten), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';
    end if;
    -- trades.sag_aaben forbliver true: pengene er frosset til sag_afvikl.

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_koeber', 'sag', s.id, t.buyer_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  elsif p_udfald = 'saelger' then
    update public.sager
       set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'frigiv', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    -- Vil frigivelsen vaere blokeret? (samme regler som sag_afvikl)
    v_advarsel := case
      when b.id is null then 'ingen_betaling'
      when public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then 'indsigelse'
      when b.status = 'refunderet' or b.refusion_anmodet_kl is not null then 'refusion'
      when b.status <> 'betalt' then 'ikke_betalt'
      else null end;

    v_handling := 'planlagt_frigivelse';
    v_log := case when v_anket
                  then 'Medhold til sælger efter anke - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - pengene frigives nu'
                  else 'Medhold til sælger - pengene frigives efter ankefristen på 4 dage' end
             || coalesce(' (OBS: frigivelsen er blokeret lige nu: ' || v_advarsel || ')', '')
             || v_retur_tjek;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_afgjort_saelger', 'sag', s.id, t.seller_id,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

  else
    update public.sager
       set status = 'lukket', afgjort_af = p_medarbejder, afgjort_kl = now(),
           begrundelse = v_grund, intern_note = coalesce(v_note, intern_note),
           retur_kraeves = false, returfragt_betaler = null,
           penge_handling = 'ingen', penge_flyttes_efter_kl = v_frist,
           afviklet_kl = null, penge_fejl = null
     where id = s.id;

    v_handling := 'lukket';
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', s.id, t.buyer_id,
            left(case when v_anket
                      then 'Sag lukket efter anke uden at flytte penge - køberen har ikke sendt varen retur. Endelig, ingen ny ankefrist - frysningen fjernes nu'
                      else 'Sag lukket uden at flytte penge - frysningen fjernes efter ankefristen på 4 dage (køberen kan anke)' end
                 || v_retur_tjek
                 || ' | Til parterne: '
                 || v_grund || coalesce(' | Intern note: ' || v_note, ''), 4000));
  end if;

  -- Anket sag - ingen ny ankefrist, saa afgoerelsen gennemfoeres straks.
  -- Serveren kalder Stripe (udfoerSagAfvikling), naar afvikling.kode = 'ok';
  -- ellers proever cron igen (sag_afvikl_forfaldne).
  if v_anket then
    v_res := public.sag_afvikl(s.id);
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'handling', v_handling, 'penge_flyttes_efter_kl', v_frist,
    'endelig', v_anket, 'afvikling', v_res,
    'advarsel', v_advarsel, 'betaling_id', b.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$function$;

CREATE OR REPLACE FUNCTION public.sag_anke_afgoer(p_medarbejder uuid, p_anke uuid, p_udfald text, p_begrundelse text, p_intern_note text, p_retur_ikke_sendt boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_grund    text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_note     text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_sag      uuid;
  v_trade    uuid;
  a          record;
  s          record;
  t          record;
  b          record;
  v_res      jsonb;
  v_handling text;
  v_hvem     text;
  v_log      text;
  v_retur    boolean := false;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udfald is null or p_udfald not in ('stadfaest', 'omgoer') then
    return jsonb_build_object('kode', 'ugyldigt_udfald');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 or char_length(coalesce(v_note, '')) > 4000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select sag_id, trade_id into v_sag, v_trade from public.sag_anker where id = p_anke;
  if v_sag is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Laaseraekkefoelge: betaling, handel, sag, anke.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = v_sag for update;
  select * into a from public.sag_anker where id = p_anke for update;

  if a.status <> 'afventer' then return jsonb_build_object('kode', 'behandlet'); end if;
  -- Ingen maa behandle en anke, hvor han selv er part.
  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  -- En anden end den, der afgjorde sagen.
  if p_medarbejder = a.ankede_afgjort_af or p_medarbejder = s.afgjort_af then
    return jsonb_build_object('kode', 'samme_medarbejder');
  end if;

  v_hvem := case a.part when 'koeber' then 'køberens' else 'sælgerens' end;

  if p_udfald = 'stadfaest' then
    update public.sag_anker
       set status = 'stadfaestet', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_stadfaestet', 'sag', s.id, a.indgivet_af,
            left('Anken (' || v_hvem || ') er afvist - afgørelsen står og er endelig. '
                 -- NYT: en lukket sag forbliver lukket; der flyttes ingen penge.
                 || case when s.status = 'lukket'
                         then 'Sagen forbliver lukket, og frysningen fjernes nu'
                         else 'Pengene flyttes nu' end
                 || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if s.afviklet_kl is not null or s.penge_handling is null then
      v_handling := 'allerede_afviklet';
    else
      update public.sager set penge_flyttes_efter_kl = now() where id = s.id;
      if s.status = 'afventer_retur' then
        v_handling := 'afvent_retur';
      else
        v_res := public.sag_afvikl(s.id);
        -- NYT: 'ingen' (lukket) -> 'lukket'.
        v_handling := case v_res->>'kode'
                        when 'ok' then case s.penge_handling when 'ingen' then 'lukket'
                                                             else s.penge_handling end
                        else 'blokeret' end;
      end if;
    end if;

  else
    -- Omgoer: kun hvis pengene ikke er flyttet.
    if s.afviklet_kl is not null
       or b.id is null
       or b.refusion_anmodet_kl is not null
       or b.overfoersel_paabegyndt_kl is not null
       or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
       or b.status <> 'betalt' then
      return jsonb_build_object('kode', 'penge_flyttet');
    end if;

    if a.part = 'saelger' then
      -- Saelgeren faar medhold. Har han allerede faaet varen retur, ville han
      -- faa baade varen og pengene.
      if s.retur_afleveret_kl is not null then
        return jsonb_build_object('kode', 'retur_afleveret');
      end if;
      -- Venter sagen paa retur, kan koeberen have sendt varen (pakken er
      -- bare ikke registreret endnu). Behandleren skal bekraefte, at den
      -- ikke er sendt.
      if s.status = 'afventer_retur' and not coalesce(p_retur_ikke_sendt, false) then
        return jsonb_build_object('kode', 'bekraeft_retur_ikke_sendt');
      end if;
      update public.sager
         set status = 'afgjort_saelger', afgjort_af = p_medarbejder, afgjort_kl = now(),
             begrundelse = v_grund,
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = 'frigiv', penge_flyttes_efter_kl = now(),
             afviklet_kl = null, penge_fejl = null
       where id = s.id;
      v_log := 'Anken (sælgerens) er godkendt - afgørelsen er ændret til medhold til sælger og er endelig. Pengene frigives til sælger nu'
               || case when s.status = 'afventer_retur'
                       then ' | Bekræftet af behandleren: køberen har ikke sendt varen retur' else '' end;
    else
      -- Koeberen faar medhold (ogsaa naar sagen var lukket). Samme
      -- forhaandstjek som sag_afgoer.
      if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
        return jsonb_build_object('kode', 'indsigelse');
      end if;
      if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
        update public.sager
           set status = 'afgjort_koeber', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = (s.retur_afleveret_kl is not null),
               returfragt_betaler = case when s.retur_afleveret_kl is not null then 'koeber' end,
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Refusion (alt undtagen BidHamr Beskyttelse) nu';
      else
        v_retur := true;
        update public.sager
           set status = 'afventer_retur', afgjort_af = p_medarbejder, afgjort_kl = now(),
               begrundelse = v_grund,
               retur_kraeves = true, returfragt_betaler = 'koeber',
               penge_handling = 'refunder', penge_flyttes_efter_kl = now(),
               afviklet_kl = null, penge_fejl = null
         where id = s.id;
        v_log := 'Anken (køberens) er godkendt - afgørelsen er ændret til medhold til køber og er endelig. Varen sendes retur (køberen betaler selv returfragten); refusion, så snart returpakken er registreret';
      end if;
      if s.status = 'lukket' then
        v_log := v_log || ' | Den ankede afgørelse var en lukning af sagen';
      end if;
    end if;

    update public.sag_anker
       set status = 'omgjort', behandlet_af = p_medarbejder, behandlet_kl = now(),
           afgoerelse_begrundelse = v_grund, intern_note = v_note
     where id = a.id;

    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_anke_omgjort', 'sag', s.id, a.indgivet_af,
            left(v_log || ' | Til parterne: ' || v_grund
                 || coalesce(' | Intern note: ' || v_note, ''), 4000));

    if v_retur then
      v_handling := 'afvent_retur';
    else
      v_res := public.sag_afvikl(s.id);
      v_handling := case v_res->>'kode'
                      when 'ok' then case a.part when 'saelger' then 'frigiv' else 'refunder' end
                      else 'blokeret' end;
    end if;
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'udfald', p_udfald, 'handling', v_handling, 'afvikling', v_res,
    'anke_id', a.id, 'part', a.part, 'sag_id', s.id,
    'trade_id', t.id, 'buyer_id', t.buyer_id, 'seller_id', t.seller_id,
    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);
end;
$function$;
