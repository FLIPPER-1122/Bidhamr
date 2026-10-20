-- Funktioner og policies, som de så ud i produktion og test FØR
-- 20261027020000_staff_rls_aal2.sql (pg_get_functiondef / pg_policies, SELECT 20. okt. 2026;
-- normaliseret md5 ens i begge). Bruges af tests/penge-db/staffRlsAal2.test.ts.

-- antal_aabne_sager() md5 ca9343e272605b4e10ba1ba569a68111
CREATE OR REPLACE FUNCTION public.antal_aabne_sager()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case when not public.er_staff() then 0 else (
    (select count(*)::integer from public.sager where status = 'aaben')
    + (select count(*)::integer from public.sag_anker where status = 'afventer')
  ) end;
$function$;

-- antal_ubesvarede_staff_samtaler() md5 eb581257cbb6bd6264ce6fa027ed9eb4
CREATE OR REPLACE FUNCTION public.antal_ubesvarede_staff_samtaler()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case when not public.er_staff() then 0 else (
    select count(*)::integer
      from public.staff_samtaler s
      cross join lateral (
        select b.fra_staff from public.staff_beskeder b
         where b.samtale_id = s.id
         order by b.oprettet_kl desc, b.id desc limit 1) sidste
     where s.lukket_kl is null and not sidste.fra_staff
  ) end;
$function$;

-- app_auktion_synlig(uuid) md5 65249e41b13c3bfbde034b8ab688d10f
CREATE OR REPLACE FUNCTION public.app_auktion_synlig(p_auktion uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  a record;
begin
  if p_auktion is null then return false; end if;
  select x.id, x.bruger_id, x.arkiveret_kl, coalesce(x.skjult, false) as skjult, x.kunst_kontrol
    into a from public.auctions x where x.id = p_auktion;
  if a.id is null then return false; end if;
  return (a.arkiveret_kl is null and not a.skjult and a.kunst_kontrol is distinct from 'afventer')
      or (v_uid is not null and (a.bruger_id = v_uid or public.er_staff() or public.auktion_arkiv_adgang(a.id)));
end;
$function$;

-- auktion_arkiv_adgang(uuid) md5 5e80d78bcd9a312d2ff38a18d1c95f9f
CREATE OR REPLACE FUNCTION public.auktion_arkiv_adgang(p_auktion uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null and (
       exists (select 1 from public.auctions a
                where a.id = p_auktion
                  and (a.bruger_id = auth.uid() or a.vinder_id = auth.uid()))
    or exists (select 1 from public.bids b
                where b.auktion_id = p_auktion and b.bruger_id = auth.uid())
    or exists (select 1 from public.trades t
                where t.auction_id = p_auktion
                  and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
    or exists (select 1 from public.andenchance_tilbud c
                where c.auction_id = p_auktion and c.byder_id = auth.uid())
    or public.er_staff()
  );
$function$;

-- auktion_spoergsmaal_liste(uuid) md5 38fc55bfba916542f7448e67aaf8bd6e
CREATE OR REPLACE FUNCTION public.auktion_spoergsmaal_liste(p_auktion uuid)
 RETURNS TABLE(id uuid, question text, answer text, asked_at timestamp with time zone, answered_at timestamp with time zone, asker_name text, is_mine boolean, hidden boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with mig as (
    select auth.uid() as uid,
           (auth.uid() is not null
            and public.staff_chat_har_rolle(auth.uid(), 'medarbejder')) as staff
  ),
  synlig as (
    select 1
      from public.auctions a, mig
     where a.id = p_auktion
       and (mig.staff
            or a.bruger_id = mig.uid
            or (not a.skjult
                and (a.arkiveret_kl is null
                     or (mig.uid is not null and public.auktion_arkiv_adgang(a.id)))))
  )
  select q.id, q.question, q.answer, q.asked_at, q.answered_at,
         public.kort_visningsnavn(u.navn),
         coalesce(q.asker_id = mig.uid, false),
         q.hidden
    from public.auction_questions q
    cross join mig
    left join public.users u on u.id = q.asker_id
   where q.auction_id = p_auktion
     and exists (select 1 from synlig)
     and (not q.hidden or mig.staff)
   order by q.asked_at desc
   limit 200;
$function$;

-- beta_fejl_billede_maa_uploade(text) md5 5a107368fca910d964b4cbfda56c7c78
CREATE OR REPLACE FUNCTION public.beta_fejl_billede_maa_uploade(p_sti text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_bruger uuid := (select auth.uid());
  v_dele   text[] := string_to_array(coalesce(p_sti, ''), '/');
begin
  if v_bruger is null or coalesce(array_length(v_dele, 1), 0) <> 2 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return false;
  end if;
  if not public.er_staff() then
    if not public.min_beta_adgang() then return false; end if;
    if exists (select 1 from public.users u
                where u.id = v_bruger and u.konto_type = 'erhverv') then
      return false;
    end if;
  end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'beta-fejl-billeder'
             and o.name like v_bruger::text || '/%'
             and o.created_at > now() - interval '1 hour') < 30;
end;
$function$;

-- er_staff() md5 c60104d50290ed101923d4bb3d059840
CREATE OR REPLACE FUNCTION public.er_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.rolle in ('medarbejder', 'admin', 'chef'));
$function$;

-- erhverv_har_adgang(uuid,boolean) md5 6ede9b5d6a11c4a431fb1b59c197670f
CREATE OR REPLACE FUNCTION public.erhverv_har_adgang(p_bruger uuid, p_kun_chef boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_bruger is not null and exists (
    select 1 from public.users u
     where u.id = p_bruger
       and u.konto_lukket_kl is null
       and u.konto_slettet_kl is null
       and not (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()))
       and (u.rolle = 'chef' or (not coalesce(p_kun_chef, false) and u.rolle = 'saelger')));
$function$;

-- erhverv_klage_billede_maa_uploade(text) md5 e2ff938084d3c09cefabb62e34410418
CREATE OR REPLACE FUNCTION public.erhverv_klage_billede_maa_uploade(p_sti text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_bruger uuid := auth.uid();
  v_dele   text[] := string_to_array(coalesce(p_sti, ''), '/');
  v_trade  uuid;
begin
  if v_bruger is null or coalesce(array_length(v_dele, 1), 0) <> 3 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  -- Filnavnet starter med et bogstav/tal (ingen ".", "..", "-x").
  if v_dele[3] !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then return false; end if;
  v_trade := v_dele[2]::uuid;

  if public.erhverv_klage_adgang(v_bruger, v_trade) is not null then
    return false;
  end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'erhverv-klage-billeder'
             and o.name like v_bruger::text || '/' || v_trade::text || '/%') < 30;
end;
$function$;

-- firma_faktura_salg(date,date,uuid,uuid) md5 3e19eebfe328958da847fde4c09febc8
CREATE OR REPLACE FUNCTION public.firma_faktura_salg(p_fra date DEFAULT NULL::date, p_til date DEFAULT NULL::date, p_trade uuid DEFAULT NULL::uuid, p_firma uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid;
  v_staff boolean := false;
  f       record;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  if p_firma is null or p_firma = v_uid then
    v_firma := v_uid;
    -- En lukket eller slettet firmakonto får ingen købsoplysninger.
    if not exists (select 1 from public.users u
                    where u.id = v_uid
                      and u.konto_lukket_kl is null
                      and u.konto_slettet_kl is null) then
      raise exception 'Ingen adgang.' using errcode = '42501';
    end if;
  elsif public.erhverv_har_adgang(v_uid, true) then
    -- Kun chef (ikke rollen saelger) må se et andet firmas købere.
    v_firma := p_firma;
    v_staff := true;
  else
    raise exception 'Ingen adgang.' using errcode = '42501';
  end if;

  select fm.id, fm.firmanavn, fm.cvr, fm.bruger_brugtmoms
    into f
    from public.firmaer fm
   where fm.bruger_id = v_firma;
  if not found then
    return null;
  end if;

  -- Chef slår et firmas købsoplysninger op: logges.
  if v_staff then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (v_uid, 'firma_faktura_opslag', 'firma', f.id, v_firma,
            left(concat_ws('; ',
                           'Oplysninger til faktura (købere) slået op',
                           case when p_trade is not null then 'Handel ' || p_trade::text end,
                           case when p_fra is not null or p_til is not null
                                then 'Periode ' || coalesce(p_fra::text, '…') || ' - ' || coalesce(p_til::text, '…') end,
                           f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));
  end if;

  return jsonb_build_object(
    'firma', jsonb_build_object(
      'firmanavn', f.firmanavn,
      'cvr', f.cvr,
      'brugtmoms', f.bruger_brugtmoms),
    'salg', coalesce((
      select jsonb_agg(r.data order by r.solgt desc)
        from (
          select t.created_at as solgt,
                 jsonb_build_object(
                   'trade_id', t.id,
                   'solgt_kl', t.created_at,
                   'betalt_kl', b.betalt_kl,
                   'refunderet_kl', b.refunderet_kl,
                   'titel', a.titel,
                   'stand', a.stand,
                   'pris_oere', coalesce(b.bud_oere, round(t.amount * 100)::bigint),
                   'afhentning', coalesce(t.afhentning, false),
                   'levering', hl.maade,
                   -- Aldrig navnet fra MitID (kun internt).
                   'koeber_navn', coalesce(
                     nullif(btrim(hl.modtager_navn), ''),
                     nullif(btrim(concat_ws(' ', u.fornavn, u.efternavn)), ''),
                     nullif(btrim(u.navn), '')),
                   'koeber_email', coalesce(
                     nullif(btrim(hl.modtager_email), ''),
                     nullif(btrim(u.email), ''),
                     (select au.email::text from auth.users au where au.id = t.buyer_id)),
                   -- Kun adressen, køberen gav til handlen (levering til
                   -- døren). Ingen profiladresse.
                   'adresse', case when hl.maade = 'doer'
                                   then nullif(btrim(hl.modtager_adresse), '') end,
                   'postnummer', case when hl.maade = 'doer'
                                      then nullif(btrim(hl.modtager_postnummer), '') end,
                   'by', case when hl.maade = 'doer'
                              then nullif(btrim(hl.modtager_by), '') end
                 ) as data
            from public.trades t
            join public.betalinger b on b.trade_id = t.id and b.betalt_kl is not null
            left join public.auctions a on a.id = t.auction_id
            left join public.users u on u.id = t.buyer_id
            left join public.handel_levering hl on hl.trade_id = t.id
           where t.seller_id = v_firma
             and (p_trade is null or t.id = p_trade)
             and (p_fra is null or t.created_at >= (p_fra::timestamp at time zone 'Europe/Copenhagen'))
             and (p_til is null or t.created_at < ((p_til + 1)::timestamp at time zone 'Europe/Copenhagen'))
           order by t.created_at desc
           limit 2000
        ) r), '[]'::jsonb));
end;
$function$;

-- fragt_label_maa_laese(text) md5 7ba9ca1bf0fdc79889e71d60a83565cb
CREATE OR REPLACE FUNCTION public.fragt_label_maa_laese(p_sti text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null and (
       public.er_staff()
    or exists (
         select 1 from public.forsendelser f
           join public.trades t on t.id = f.trade_id
          where f.label_sti = p_sti
            and f.status not in ('opretter', 'annulleres', 'annulleret', 'fejlet')
            and ((f.type = 'udgaaende' and t.seller_id = auth.uid())
              or (f.type = 'retur' and t.buyer_id = auth.uid())))
  );
$function$;

-- hent_medarbejdere() md5 3a1b2bf8434a1750c3fed59f22ab91d8
CREATE OR REPLACE FUNCTION public.hent_medarbejdere()
 RETURNS TABLE(id uuid, navn text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select u.id, coalesce(nullif(btrim(u.navn), ''), 'Ukendt')
    from public.users u
   where public.er_staff()
     and u.rolle in ('medarbejder', 'admin', 'chef')
   order by 2;
$function$;

-- kort_visningsnavn(text) md5 7fe13b650486dd25ca965ed739749277
CREATE OR REPLACE FUNCTION public.kort_visningsnavn(p_navn text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when btrim(coalesce(p_navn, '')) = '' then 'Anonym'
    else (select case when cardinality(d) = 1 then d[1]
                      else d[1] || ' ' || upper(left(d[2], 1)) || '.' end
            from (select regexp_split_to_array(btrim(p_navn), '[[:space:]]+') as d) x)
  end;
$function$;

-- min_beta_adgang() md5 0cfb82994e5957c6e6955d56f39b453f
CREATE OR REPLACE FUNCTION public.min_beta_adgang()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select s.beta_aaben from public.beta_indstillinger s where s.id), false)
     and (select auth.uid()) is not null
     and exists (select 1 from public.beta_invitationer i
                  where i.bruger_id = (select auth.uid())
                    and i.tilbagekaldt_kl is null)
$function$;

-- min_profil() md5 5a4b00fa8869ba98b0c54fc56efca1c3
CREATE OR REPLACE FUNCTION public.min_profil()
 RETURNS TABLE(email text, telefon text, rolle text, suspenderet boolean, suspenderet_aarsag text, suspenderet_kl timestamp with time zone, suspenderet_til timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select u.email, u.telefon, u.rolle, u.suspenderet, u.suspenderet_aarsag, u.suspenderet_kl, u.suspenderet_til
    from public.users u where u.id = auth.uid();
$function$;

-- min_rolle() md5 2e2b6b44f51252f5f292c9748367800c
CREATE OR REPLACE FUNCTION public.min_rolle()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select u.rolle from public.users u where u.id = auth.uid();
$function$;

-- mine_forsendelse_label(uuid) md5 fd7a6b0a913451575ba9b091e37dba21
CREATE OR REPLACE FUNCTION public.mine_forsendelse_label(p_forsendelse uuid)
 RETURNS TABLE(label_sti text, qr_kode text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select f.label_sti, f.qr_kode
    from public.forsendelser f
    join public.trades t on t.id = f.trade_id
   where f.id = p_forsendelse
     and auth.uid() is not null
     and (public.er_staff()
       or (f.status not in ('opretter', 'annulleres', 'annulleret', 'fejlet')
           and ((f.type = 'udgaaende' and t.seller_id = auth.uid())
             or (f.type = 'retur' and t.buyer_id = auth.uid()))));
$function$;

-- mit_leveringsvalg(uuid) md5 afb942a4dfa04ce77503bda4fbb83f08
CREATE OR REPLACE FUNCTION public.mit_leveringsvalg(p_trade uuid)
 RETURNS TABLE(trade_id uuid, maade text, fragtfirma text, pakkeshop_id text, pakkeshop_navn text, pakkeshop_adresse text, pakkeshop_postnummer text, pakkeshop_by text, pakkeshop_lat double precision, pakkeshop_lng double precision, modtager_navn text, modtager_adresse text, modtager_postnummer text, modtager_by text, modtager_telefon text, modtager_email text, fragt_oere integer, valgt_kl timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select hl.trade_id, hl.maade, hl.fragtfirma,
         hl.pakkeshop_id, hl.pakkeshop_navn, hl.pakkeshop_adresse,
         hl.pakkeshop_postnummer, hl.pakkeshop_by, hl.pakkeshop_lat, hl.pakkeshop_lng,
         hl.modtager_navn, hl.modtager_adresse, hl.modtager_postnummer, hl.modtager_by,
         hl.modtager_telefon, hl.modtager_email, hl.fragt_oere, hl.valgt_kl
    from public.handel_levering hl
    join public.trades t on t.id = hl.trade_id
   where hl.trade_id = p_trade
     and auth.uid() is not null
     and (t.buyer_id = auth.uid() or public.er_staff());
$function$;

-- pakke_billede_maa_laese(text) md5 2a48730e4aeb4cd1a67463391aa8d7c8
CREATE OR REPLACE FUNCTION public.pakke_billede_maa_laese(p_sti text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null and (
       split_part(coalesce(p_sti, ''), '/', 1) = auth.uid()::text
    or public.er_staff()
    or exists (
         select 1 from public.pakke_billeder b
           join public.trades t on t.id = b.trade_id
          where b.sti = p_sti
            and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );
$function$;

-- pakke_billede_maa_uploade(text) md5 c7d100829165f92f60141241b0af5ba7
CREATE OR REPLACE FUNCTION public.pakke_billede_maa_uploade(p_sti text)
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
  if v_bruger is null or coalesce(array_length(v_dele, 1), 0) <> 3 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if v_dele[3] !~ '^[A-Za-z0-9._-]{1,100}$' then return false; end if;
  v_trade := v_dele[2]::uuid;

  if not exists (
    select 1 from public.trades t
     where t.id = v_trade
       and t.seller_id = v_bruger
       and t.status = 'betaling_modtaget'
       and not t.afhentning
  ) then
    return false;
  end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'pakke-billeder'
             and o.name like v_bruger::text || '/' || v_trade::text || '/%') < 20;
end;
$function$;

-- sag_billede_maa_laese(text) md5 9f4ee9b149ecc5ebbb71696178764a6b
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

-- sag_billede_maa_uploade(text) md5 3ff2a50ca373980ea1a7ec3e0602e43e
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

-- staff_chat_har_rolle(uuid,text) md5 3cbd4e285666ed3e15239eb2230925f4
CREATE OR REPLACE FUNCTION public.staff_chat_har_rolle(p_bruger uuid, p_min text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.users u
     where u.id = p_bruger
       and case p_min
             when 'medarbejder' then u.rolle in ('medarbejder', 'admin', 'chef')
             when 'admin'       then u.rolle in ('admin', 'chef')
             when 'chef'        then u.rolle = 'chef'
             else false
           end);
$function$;

-- storage_mappe_under_loft(text,integer) md5 b3d6f991142d077c71f176b88f196c89
CREATE OR REPLACE FUNCTION public.storage_mappe_under_loft(p_bucket text, p_loft integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null
     and (select count(*)
            from storage.objects o
           where o.bucket_id = p_bucket
             and o.name like auth.uid()::text || '/%'
             and o.created_at > now() - interval '1 day') < p_loft;
$function$;

-- public.andenchance_tilbud.andenchance_select_part
create policy andenchance_select_part on public.andenchance_tilbud as PERMISSIVE for SELECT to authenticated using (((byder_id = auth.uid()) OR er_staff()));

-- public.auctions.auctions_insert_own
create policy auctions_insert_own on public.auctions as PERMISSIVE for INSERT to public with check ((auth.uid() = bruger_id));

-- public.auctions.auctions_select_anon
create policy auctions_select_anon on public.auctions as PERMISSIVE for SELECT to anon using (((arkiveret_kl IS NULL) AND (NOT COALESCE(skjult, false)) AND (kunst_kontrol IS DISTINCT FROM 'afventer'::text)));

-- public.auctions.auctions_select_authenticated
create policy auctions_select_authenticated on public.auctions as PERMISSIVE for SELECT to authenticated using ((((arkiveret_kl IS NULL) AND (NOT COALESCE(skjult, false)) AND (kunst_kontrol IS DISTINCT FROM 'afventer'::text)) OR (bruger_id = ( SELECT auth.uid() AS uid)) OR ( SELECT er_staff() AS er_staff) OR auktion_arkiv_adgang(id)));

-- public.auctions.auctions_update_own
create policy auctions_update_own on public.auctions as PERMISSIVE for UPDATE to public using ((auth.uid() = bruger_id));

-- public.betaling_afvigelser.betaling_afvigelser_select_chef
create policy betaling_afvigelser_select_chef on public.betaling_afvigelser as PERMISSIVE for SELECT to authenticated using ((min_rolle() = 'chef'::text));

-- public.betalinger.betalinger_select_part
create policy betalinger_select_part on public.betalinger as PERMISSIVE for SELECT to authenticated using (((buyer_id = auth.uid()) OR (seller_id = auth.uid()) OR (min_rolle() = 'chef'::text)));

-- public.employee_complaints.employee_complaints_insert_own
create policy employee_complaints_insert_own on public.employee_complaints as PERMISSIVE for INSERT to public with check ((auth.uid() = user_id));

-- public.employee_complaints.employee_complaints_select_chef
create policy employee_complaints_select_chef on public.employee_complaints as PERMISSIVE for SELECT to public using ((min_rolle() = 'chef'::text));

-- public.employee_complaints.employee_complaints_update_chef
create policy employee_complaints_update_chef on public.employee_complaints as PERMISSIVE for UPDATE to public using ((min_rolle() = 'chef'::text));

-- public.forsendelse_haendelser.forsendelse_haendelser_select_parter
create policy forsendelse_haendelser_select_parter on public.forsendelse_haendelser as PERMISSIVE for SELECT to authenticated using ((er_staff() OR (EXISTS ( SELECT 1
   FROM (forsendelser f
     JOIN trades t ON ((t.id = f.trade_id)))
  WHERE ((f.id = forsendelse_haendelser.forsendelse_id) AND ((t.buyer_id = auth.uid()) OR (t.seller_id = auth.uid())))))));

-- public.forsendelser.forsendelser_select_parter
create policy forsendelser_select_parter on public.forsendelser as PERMISSIVE for SELECT to authenticated using ((er_staff() OR (EXISTS ( SELECT 1
   FROM trades t
  WHERE ((t.id = forsendelser.trade_id) AND ((t.buyer_id = auth.uid()) OR (t.seller_id = auth.uid())))))));

-- public.handel_levering.handel_levering_select_parter
create policy handel_levering_select_parter on public.handel_levering as PERMISSIVE for SELECT to authenticated using ((er_staff() OR (EXISTS ( SELECT 1
   FROM trades t
  WHERE ((t.id = handel_levering.trade_id) AND ((t.buyer_id = auth.uid()) OR (t.seller_id = auth.uid())))))));

-- public.messages.messages_insert_part
create policy messages_insert_part on public.messages as PERMISSIVE for INSERT to public with check (((auth.uid() = sender_id) AND (EXISTS ( SELECT 1
   FROM trades t
  WHERE ((t.id = messages.trade_id) AND ((auth.uid() = t.buyer_id) OR (auth.uid() = t.seller_id)))))));

-- public.messages.messages_select_part
create policy messages_select_part on public.messages as PERMISSIVE for SELECT to public using ((er_staff() OR (EXISTS ( SELECT 1
   FROM trades t
  WHERE ((t.id = messages.trade_id) AND ((auth.uid() = t.buyer_id) OR (auth.uid() = t.seller_id)) AND ((messages.blokeret_grund IS NULL) OR (messages.sender_id = auth.uid())))))));

-- public.trades.trades_select_own
create policy trades_select_own on public.trades as PERMISSIVE for SELECT to public using (((auth.uid() = buyer_id) OR (auth.uid() = seller_id) OR er_staff()));

-- storage.objects.auktion_billeder_delete_own
create policy auktion_billeder_delete_own on storage.objects as PERMISSIVE for DELETE to authenticated using (((bucket_id = 'auktion-billeder'::text) AND ((( SELECT auth.uid() AS uid))::text = (storage.foldername(name))[1]) AND auktion_billede_maa_slettes(name) AND storage_to_trin_ok()));

-- storage.objects.auktion_billeder_ingen_update
create policy auktion_billeder_ingen_update on storage.objects as RESTRICTIVE for UPDATE to anon, authenticated using ((bucket_id <> 'auktion-billeder'::text)) with check ((bucket_id <> 'auktion-billeder'::text));

-- storage.objects.auktion_billeder_insert_own
create policy auktion_billeder_insert_own on storage.objects as PERMISSIVE for INSERT to authenticated with check (((bucket_id = 'auktion-billeder'::text) AND ((( SELECT auth.uid() AS uid))::text = (storage.foldername(name))[1]) AND storage_mappe_under_loft('auktion-billeder'::text, 100) AND storage_to_trin_ok()));

-- storage.objects.auktion_billeder_select_egen
create policy auktion_billeder_select_egen on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'auktion-billeder'::text) AND ((( SELECT auth.uid() AS uid))::text = (storage.foldername(name))[1])));

-- storage.objects.auktion_billeder_slet_ikke_laast
create policy auktion_billeder_slet_ikke_laast on storage.objects as RESTRICTIVE for DELETE to authenticated using (((bucket_id <> 'auktion-billeder'::text) OR (NOT auktion_billede_laast(name))));

-- storage.objects.avatarer_delete_own
create policy avatarer_delete_own on storage.objects as PERMISSIVE for DELETE to public using (((bucket_id = 'avatarer'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));

-- storage.objects.avatarer_insert_own
create policy avatarer_insert_own on storage.objects as PERMISSIVE for INSERT to authenticated with check (((bucket_id = 'avatarer'::text) AND ((( SELECT auth.uid() AS uid))::text = (storage.foldername(name))[1]) AND storage_mappe_under_loft('avatarer'::text, 10) AND storage_to_trin_ok()));

-- storage.objects.avatarer_select_egen
create policy avatarer_select_egen on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'avatarer'::text) AND ((( SELECT auth.uid() AS uid))::text = (storage.foldername(name))[1])));

-- storage.objects.beta_fejl_billeder_upload_egen
create policy beta_fejl_billeder_upload_egen on storage.objects as PERMISSIVE for INSERT to authenticated with check (((bucket_id = 'beta-fejl-billeder'::text) AND beta_fejl_billede_maa_uploade(name)));

-- storage.objects.erhverv_klage_billeder_laes_egne
create policy erhverv_klage_billeder_laes_egne on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'erhverv-klage-billeder'::text) AND (split_part(name, '/'::text, 1) = (( SELECT auth.uid() AS uid))::text)));

-- storage.objects.erhverv_klage_billeder_upload_koeber
create policy erhverv_klage_billeder_upload_koeber on storage.objects as PERMISSIVE for INSERT to authenticated with check (((bucket_id = 'erhverv-klage-billeder'::text) AND erhverv_klage_billede_maa_uploade(name)));

-- storage.objects.fragt_labels_laes
create policy fragt_labels_laes on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'fragt-labels'::text) AND fragt_label_maa_laese(name)));

-- storage.objects.pakke_billeder_laes_parter
create policy pakke_billeder_laes_parter on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'pakke-billeder'::text) AND pakke_billede_maa_laese(name)));

-- storage.objects.pakke_billeder_upload_saelger
create policy pakke_billeder_upload_saelger on storage.objects as PERMISSIVE for INSERT to authenticated with check (((bucket_id = 'pakke-billeder'::text) AND pakke_billede_maa_uploade(name)));

-- storage.objects.sag_billeder_laes_parter
create policy sag_billeder_laes_parter on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'sag-billeder'::text) AND sag_billede_maa_laese(name)));

-- storage.objects.sag_billeder_upload_koeber
create policy sag_billeder_upload_koeber on storage.objects as PERMISSIVE for INSERT to authenticated with check (((bucket_id = 'sag-billeder'::text) AND sag_billede_maa_uploade(name)));
