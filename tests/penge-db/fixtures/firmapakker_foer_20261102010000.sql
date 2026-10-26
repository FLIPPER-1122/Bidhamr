-- Funktionerne, som de stod på testdatabasen (pjiigmzqwlfepxnjdvug) før
-- 20261102010000_firmapakker.sql (pg_get_functiondef, 26. okt. 2026).
-- Bruges af tests/penge-db/firmapakker.test.ts (md5-drift-tjekket og
-- funktionerne, migrationen ikke erstatter).

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
$function$
;

CREATE OR REPLACE FUNCTION public.erhverv_ingen_sletning()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if coalesce(current_setting('bidhamr.tillad_brugersletning', true), '') = 'ja' then
    return case when tg_level = 'ROW' then old else null end;
  end if;
  raise exception 'Erhvervsdata kan ikke slettes - arkivér i stedet.' using errcode = '42501';
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_naeste_periode(p_start timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case
    when p_start > now() then p_start
    else p_start + make_interval(months => (
      extract(year from age(now(), p_start))::int * 12
      + extract(month from age(now(), p_start))::int + 1))
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.firma_anvend_planlagt(p_firma uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.firmaer
     set pakke_id = naeste_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null,
         opdateret_kl = now()
   where id = p_firma and naeste_pakke_fra is not null and naeste_pakke_fra <= now();
  if found then
    update public.firma_pakkeskift
       set status = 'gennemfoert', behandlet_kl = now()
     where firma_id = p_firma and status = 'planlagt' and gaelder_fra <= now();
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.erhverv_uge_start(p_ts timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select (date_trunc('week', p_ts at time zone 'Europe/Copenhagen')) at time zone 'Europe/Copenhagen';
$function$
;

CREATE OR REPLACE FUNCTION public.erhverv_pakke_json(p_pakke uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('id', p.id, 'navn', p.navn, 'beskrivelse', p.beskrivelse,
                            'maanedspris', p.maanedspris, 'auktioner_pr_uge', p.auktioner_pr_uge,
                            'aktiv', p.aktiv)
    from public.erhverv_pakker p where p.id = p_pakke;
$function$
;

CREATE OR REPLACE FUNCTION public.erhverv_kvote(p_bruger uuid, p_laas boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f        public.firmaer;
  v_start  timestamptz := public.erhverv_uge_start(now());
  v_naeste timestamptz := (date_trunc('week', now() at time zone 'Europe/Copenhagen') + interval '7 days')
                          at time zone 'Europe/Copenhagen';
  v_pakke  uuid;
  v_max    integer;
  v_brugt  integer;
  v_kode   text;
begin
  if p_laas then
    select * into f from public.firmaer where bruger_id = p_bruger for update;
    if f.id is not null and f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now() then
      perform public.firma_anvend_planlagt(f.id);
      select * into f from public.firmaer where id = f.id;
    end if;
  else
    select * into f from public.firmaer where bruger_id = p_bruger;
  end if;

  if f.id is null then
    return jsonb_build_object('kode', 'erhverv_intet_abonnement', 'brugt', 0, 'max', 0,
                              'uge_start', v_start, 'naeste_uge', v_naeste, 'naeste_ledige', null);
  end if;

  v_pakke := case when f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now()
                  then f.naeste_pakke_id else f.pakke_id end;
  select p.auktioner_pr_uge into v_max from public.erhverv_pakker p where p.id = v_pakke;
  v_max := coalesce(v_max, 0);

  select count(*) into v_brugt from public.auctions a
   where a.bruger_id = p_bruger and a.oprettet >= v_start;

  v_kode := case
    when f.abonnement_status <> 'aktiv' then 'erhverv_intet_abonnement'
    when v_brugt >= v_max then 'erhverv_kvote'
    else 'ok' end;

  return jsonb_build_object(
    'kode', v_kode,
    'brugt', v_brugt,
    'max', v_max,
    'uge_start', v_start,
    'naeste_uge', v_naeste,
    'naeste_ledige', case when v_kode = 'erhverv_intet_abonnement' then null
                          when v_brugt < v_max then now() else v_naeste end);
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_ugekvote()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  k jsonb;
begin
  if v_uid is null or not exists (select 1 from public.firmaer where bruger_id = v_uid) then
    return null;
  end if;
  k := public.erhverv_kvote(v_uid, false);
  return jsonb_build_object(
    'brugt', k->'brugt', 'max', k->'max', 'naeste_ledige', k->'naeste_ledige',
    'uge_start', k->'uge_start', 'naeste_uge', k->'naeste_uge',
    'aktivt_abonnement', k->>'kode' <> 'erhverv_intet_abonnement');
end $function$
;

CREATE OR REPLACE FUNCTION public.auctions_erhverv()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_k jsonb;
begin
  if tg_op = 'INSERT' then
    new.erhverv := coalesce((select u.konto_type = 'erhverv' from public.users u where u.id = new.bruger_id), false);
    if new.erhverv then
      if exists (select 1 from public.firmaer fa
                  where fa.bruger_id = new.bruger_id and fa.abonnement_status = 'afventer_betaling') then
        raise exception 'erhverv_intet_abonnement: Betal for din pakke under Abonnement i Firma oversigt, før du opretter auktioner.'
          using errcode = 'BHE02';
      end if;
      v_k := public.erhverv_kvote(new.bruger_id, true);
      if v_k->>'kode' = 'erhverv_intet_abonnement' then
        raise exception 'erhverv_intet_abonnement: Firmaet har ikke et aktivt abonnement. Kontakt BidHamr på erhverv@bidhamr.dk.'
          using errcode = 'BHE02';
      elsif v_k->>'kode' = 'erhverv_kvote' then
        raise exception 'erhverv_kvote: Du har oprettet % af % auktioner i denne uge. Du kan oprette den næste mandag den %.',
          v_k->>'brugt', v_k->>'max',
          to_char((v_k->>'naeste_uge')::timestamptz at time zone 'Europe/Copenhagen', 'DD.MM.YYYY')
          using errcode = 'BHE03';
      end if;
    end if;
  else
    new.erhverv := old.erhverv;
  end if;

  if not new.erhverv then
    new.producent := null;
    new.sikkerhedsoplysninger := null;
    return new;
  end if;

  new.producent := nullif(btrim(coalesce(new.producent, '')), '');
  new.sikkerhedsoplysninger := nullif(btrim(coalesce(new.sikkerhedsoplysninger, '')), '');

  if public.stand_normaliser(new.stand) = 'ny_med_maerke'
     and (tg_op = 'INSERT'
          or new.stand is distinct from old.stand
          or new.producent is distinct from old.producent
          or new.sikkerhedsoplysninger is distinct from old.sikkerhedsoplysninger)
     and (char_length(coalesce(new.producent, '')) < 3
          or char_length(coalesce(new.sikkerhedsoplysninger, '')) < 3) then
    raise exception 'erhverv_gpsr: Når varen er ny, skal du udfylde producent (navn og adresse) og sikkerhedsoplysninger.'
      using errcode = 'BHE04';
  end if;

  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.erhverv_pakke_gem(p_staff uuid, p_id uuid, p_navn text, p_beskrivelse text, p_maanedspris numeric, p_auktioner_pr_uge integer, p_aktiv boolean DEFAULT true, p_sortering integer DEFAULT 0, p_ugens_butik_rabat_procent integer DEFAULT NULL::integer, p_ugens_butik_rabat_antal integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_navn text := btrim(coalesce(p_navn, ''));
  v_id   uuid;
  v_pct  integer;
  v_ant  integer;
begin
  if not public.erhverv_har_adgang(p_staff, true) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if char_length(v_navn) < 1 or char_length(v_navn) > 60 then
    return jsonb_build_object('kode', 'ugyldigt_navn');
  end if;
  if p_beskrivelse is not null and char_length(p_beskrivelse) > 1000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if p_maanedspris is not null and (p_maanedspris < 0 or p_maanedspris > 1000000 or p_maanedspris <> trunc(p_maanedspris)) then
    return jsonb_build_object('kode', 'ugyldig_pris');
  end if;
  if p_auktioner_pr_uge is null or p_auktioner_pr_uge < 1 or p_auktioner_pr_uge > 1000 then
    return jsonb_build_object('kode', 'ugyldigt_antal');
  end if;
  if (p_ugens_butik_rabat_procent is null) <> (p_ugens_butik_rabat_antal is null)
     or (p_ugens_butik_rabat_procent is not null
         and (p_ugens_butik_rabat_procent not between 0 and 90 or p_ugens_butik_rabat_antal not between 0 and 52)) then
    return jsonb_build_object('kode', 'ugyldig_rabat');
  end if;
  if exists (select 1 from public.erhverv_pakker where lower(navn) = lower(v_navn) and id is distinct from p_id) then
    return jsonb_build_object('kode', 'navn_findes');
  end if;

  if p_id is null then
    insert into public.erhverv_pakker (navn, beskrivelse, maanedspris, auktioner_pr_uge, aktiv, sortering,
                                       oprettet_af, opdateret_af, ugens_butik_rabat_procent, ugens_butik_rabat_antal)
    values (v_navn, nullif(btrim(coalesce(p_beskrivelse, '')), ''), p_maanedspris, p_auktioner_pr_uge,
            coalesce(p_aktiv, true), coalesce(p_sortering, 0), p_staff, p_staff,
            coalesce(p_ugens_butik_rabat_procent, 0), coalesce(p_ugens_butik_rabat_antal, 0))
    returning id, ugens_butik_rabat_procent, ugens_butik_rabat_antal into v_id, v_pct, v_ant;
  else
    update public.erhverv_pakker
       set navn = v_navn, beskrivelse = nullif(btrim(coalesce(p_beskrivelse, '')), ''),
           maanedspris = p_maanedspris, auktioner_pr_uge = p_auktioner_pr_uge,
           aktiv = coalesce(p_aktiv, aktiv), sortering = coalesce(p_sortering, sortering),
           ugens_butik_rabat_procent = coalesce(p_ugens_butik_rabat_procent, ugens_butik_rabat_procent),
           ugens_butik_rabat_antal = coalesce(p_ugens_butik_rabat_antal, ugens_butik_rabat_antal),
           opdateret_af = p_staff, opdateret_kl = now()
     where id = p_id
    returning id, ugens_butik_rabat_procent, ugens_butik_rabat_antal into v_id, v_pct, v_ant;
    if v_id is null then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_pakke_gemt', 'erhverv_pakke', v_id, null,
          left(format('%s: %s auktioner/uge, %s kr./md., %s, Ugens butik-rabat %s',
                      v_navn, p_auktioner_pr_uge, coalesce(p_maanedspris::text, 'pris ikke sat'),
                      case when coalesce(p_aktiv, true) then 'aktiv' else 'ikke aktiv' end,
                      case when v_pct > 0 and v_ant > 0 then format('%s %% de første %s uger pr. kalenderår', v_pct, v_ant)
                           else 'ingen' end), 1000));

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.erhverv_pakker_liste(p_staff uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(public.erhverv_pakke_json(p.id)
                     || jsonb_build_object('sortering', p.sortering,
                                           'antal_firmaer', (select count(*) from public.firmaer f
                                                              where f.pakke_id = p.id and f.abonnement_status <> 'opsagt'))
                     order by p.sortering, p.auktioner_pr_uge, p.navn)
                     from public.erhverv_pakker p), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_oversigt()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid := auth.uid();
  f         public.firmaer;
  v_maaned  timestamptz := (date_trunc('month', now() at time zone 'Europe/Copenhagen')) at time zone 'Europe/Copenhagen';
  v_pakke   uuid;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select * into f from public.firmaer where bruger_id = v_uid;
  if f.id is null then
    return null;
  end if;
  v_pakke := case when f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now()
                  then f.naeste_pakke_id else f.pakke_id end;

  return jsonb_build_object(
    'firma', jsonb_build_object(
      'id', f.id, 'firmanavn', f.firmanavn, 'cvr', f.cvr, 'adresse', f.adresse,
      'postnummer', f.postnummer, 'by', f.bynavn, 'telefon', f.telefon,
      'kontakt_email', f.kontakt_email, 'kontaktperson', f.kontaktperson,
      'abonnement_status', f.abonnement_status, 'abonnement_start', f.abonnement_start,
      'betalt_til', f.betalt_til, 'betaling_mislykket_kl', f.betaling_mislykket_kl,
      'pauset_aarsag', f.pauset_aarsag,
      'naeste_periode', coalesce(f.periode_slut, public.firma_naeste_periode(f.abonnement_start)),
      'periode_slut', f.periode_slut, 'opsiges_fra', f.opsiges_fra,
      'har_stripe_abonnement', f.stripe_subscription_id is not null,
      'stripe_abonnement_status', f.stripe_abonnement_status),
    'pakke', public.erhverv_pakke_json(v_pakke),
    'naeste_pakke', case when v_pakke = f.pakke_id and f.naeste_pakke_id is not null
                         then public.erhverv_pakke_json(f.naeste_pakke_id)
                              || jsonb_build_object('fra', f.naeste_pakke_fra) end,
    'afventende_opgradering', (select public.erhverv_pakke_json(s.til_pakke_id)
                                      || jsonb_build_object('skift_id', s.id, 'anmodet_kl', s.oprettet_kl,
                                         'faktura_url', (select r2.hosted_url from public.firma_regninger r2
                                                          where s.stripe_invoice_id is not null
                                                            and r2.stripe_invoice_id = s.stripe_invoice_id
                                                            and r2.status in ('afventer', 'mislykket')))
                                 from public.firma_pakkeskift s
                                where s.firma_id = f.id and s.status = 'afventer_betaling'),
    'pakker', coalesce((select jsonb_agg(public.erhverv_pakke_json(p.id) order by p.sortering, p.auktioner_pr_uge, p.navn)
                          from public.erhverv_pakker p where p.aktiv), '[]'::jsonb),
    'ugekvote', public.firma_ugekvote(),
    'auktioner', (select jsonb_build_object(
        'aktive', count(*) filter (where a.status = 'aktiv'),
        'i_alt', count(*),
        'visninger', (select count(*) from public.auction_views v
                       join public.auctions a2 on a2.id = v.auktion_id
                      where a2.bruger_id = v_uid),
        'visninger_aktive', (select count(*) from public.auction_views v
                              join public.auctions a2 on a2.id = v.auktion_id
                             where a2.bruger_id = v_uid and a2.status = 'aktiv'),
        'bud', coalesce(sum(a.antal_bud), 0))
      from public.auctions a where a.bruger_id = v_uid),
    'salg', (select jsonb_build_object(
        'solgte_i_alt', count(*),
        'solgte_denne_maaned', count(*) filter (where t.created_at >= v_maaned),
        'omsaetning_i_alt', coalesce(sum(t.amount), 0),
        'omsaetning_denne_maaned', coalesce(sum(t.amount) filter (where t.created_at >= v_maaned), 0),
        'afsluttede_i_alt', count(*) filter (where t.status = 'afsluttet'),
        'omsaetning_afsluttede_i_alt', coalesce(sum(t.amount) filter (where t.status = 'afsluttet'), 0))
      from public.trades t where t.seller_id = v_uid and t.status <> 'annulleret'),
    'udbetalinger', (select jsonb_build_object(
        'udbetalt_i_alt_oere', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl is not null), 0),
        'udbetalt_denne_maaned_oere', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl >= v_maaned), 0),
        'paa_vej_oere', coalesce(sum(b.udbetaling_oere) filter (
            where b.status = 'betalt' and b.overfoert_kl is null and b.refunderet_kl is null
              and b.annulleret_kl is null and b.refusion_anmodet_kl is null
              and b.afsendelsesfrist_annulleret_kl is null and b.afhentningsfrist_annulleret_kl is null
              and b.indsigelse_tabt_kl is null
              and not exists (select 1 from public.trades t2
                               where t2.id = b.trade_id and t2.status = 'annulleret')), 0))
      from public.betalinger b where b.seller_id = v_uid),
    'venter_paa_dig', coalesce((select jsonb_agg(jsonb_build_object(
        'trade_id', t.id, 'auktion_id', t.auction_id, 'titel', a.titel, 'beloeb', t.amount,
        'afhentning', t.afhentning, 'status', t.status, 'oprettet', t.created_at) order by t.created_at)
      from public.trades t left join public.auctions a on a.id = t.auction_id
     where t.seller_id = v_uid and t.status = 'betaling_modtaget'), '[]'::jsonb),
    'ubesvarede_spoergsmaal', coalesce((select jsonb_agg(jsonb_build_object(
        'id', q.id, 'auktion_id', q.auction_id, 'titel', a.titel, 'spoergsmaal', q.question,
        'stillet_kl', q.asked_at) order by q.asked_at)
      from public.auction_questions q join public.auctions a on a.id = q.auction_id
     where a.bruger_id = v_uid and a.status = 'aktiv' and q.answer is null
       and not coalesce(q.hidden, false)), '[]'::jsonb),
    'regninger', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'nummer', r.nummer, 'type', r.type, 'periode_fra', r.periode_fra,
        'periode_til', r.periode_til, 'beloeb_oere', r.beloeb_oere, 'status', r.status,
        'pdf_url', r.pdf_url, 'hosted_url', r.hosted_url,
        'beloeb_ekskl_moms_oere', r.beloeb_ekskl_moms_oere, 'moms_oere', r.moms_oere, 'betalt_kl', r.betalt_kl, 'oprettet', r.oprettet_kl) order by r.oprettet_kl desc)
      from public.firma_regninger r where r.firma_id = f.id), '[]'::jsonb),
    'kontakt_bidhamr', 'erhverv@bidhamr.dk'
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.erhverv_firma_opret(p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text, p_by text, p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid, p_henvendelse uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  u    record;
  h    public.erhverv_henvendelser;
  v_id uuid;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;

  select * into u from public.users where id = p_bruger for update;
  if u.id is null then
    return jsonb_build_object('kode', 'bruger_findes_ikke');
  end if;
  if u.konto_type <> 'privat' or u.rolle <> 'bruger'
     or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or u.oprettet < now() - interval '1 hour'
     or exists (select 1 from public.auctions a where a.bruger_id = p_bruger)
     or exists (select 1 from public.bids b where b.bruger_id = p_bruger)
     or exists (select 1 from public.trades t where t.buyer_id = p_bruger or t.seller_id = p_bruger)
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;
  if not exists (select 1 from auth.users au
                  where au.id = p_bruger
                    and au.invited_at is not null
                    and au.last_sign_in_at is null
                    and coalesce(au.encrypted_password, '') = ''
                    and au.created_at > now() - interval '1 hour') then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;

  if p_cvr is null or p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;
  if exists (select 1 from public.firmaer f where f.cvr = p_cvr and f.abonnement_status <> 'opsagt') then
    return jsonb_build_object('kode', 'cvr_findes');
  end if;
  if not exists (select 1 from public.erhverv_pakker p where p.id = p_pakke) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if p_henvendelse is not null then
    select * into h from public.erhverv_henvendelser where id = p_henvendelse for update;
    if h.id is null then
      return jsonb_build_object('kode', 'henvendelse_findes_ikke');
    end if;
    if exists (select 1 from public.firmaer f where f.henvendelse_id = p_henvendelse) then
      return jsonb_build_object('kode', 'henvendelse_brugt');
    end if;
  end if;

  begin
    insert into public.firmaer (bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon,
                                kontakt_email, kontaktperson, henvendelse_id, pakke_id, oprettet_af)
    values (p_bruger, btrim(p_firmanavn), p_cvr, btrim(p_adresse), btrim(p_postnummer), btrim(p_by),
            btrim(p_telefon), lower(btrim(p_kontakt_email)), btrim(p_kontaktperson), p_henvendelse,
            p_pakke, p_staff)
    returning id into v_id;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  update public.users
     set konto_type = 'erhverv',
         navn = left(btrim(p_firmanavn), 200),
         fornavn = null,
         efternavn = null,
         telefon = btrim(p_telefon)
   where id = p_bruger;

  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl)
  values (v_id, null, p_pakke, 'start', 'gennemfoert', p_staff, now());

  if p_henvendelse is not null then
    update public.erhverv_henvendelser
       set status = 'godkendt', behandlet_af = p_staff, behandlet_kl = now(), opdateret_kl = now()
     where id = p_henvendelse;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_oprettet', 'firma', v_id, p_bruger,
          left(btrim(p_firmanavn) || ' (CVR ' || p_cvr || ')', 1000));

  return jsonb_build_object('kode', 'ok', 'firma_id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.erhverv_firma_opdater(p_staff uuid, p_firma uuid, p_pakke uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_firmanavn text DEFAULT NULL::text, p_cvr text DEFAULT NULL::text, p_adresse text DEFAULT NULL::text, p_postnummer text DEFAULT NULL::text, p_by text DEFAULT NULL::text, p_telefon text DEFAULT NULL::text, p_kontakt_email text DEFAULT NULL::text, p_kontaktperson text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f        public.firmaer;
  v_tekst  text[] := '{}';
  v_pakke  uuid;
  v_status text;
  v_navn   text := nullif(btrim(p_firmanavn), '');
  v_cvr    text;
begin
  -- Chef og saelger (Filip, 10. okt. 2026: begge må alt ved firmaer).
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_status is not null and p_status not in ('aktiv', 'pauset', 'opsagt') then
    return jsonb_build_object('kode', 'ugyldig_status');
  end if;
  if p_pakke is not null and not exists (select 1 from public.erhverv_pakker where id = p_pakke) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if p_cvr is not null and p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;

  -- Kun egentlige ændringer tæller (en formular sender ofte alle felter).
  v_pakke  := case when p_pakke is distinct from f.pakke_id then p_pakke end;
  v_status := case when p_status is distinct from f.abonnement_status then p_status end;
  v_cvr    := case when p_cvr is distinct from f.cvr then p_cvr end;
  if v_navn is not distinct from f.firmanavn then
    v_navn := null;
  end if;

  begin
    update public.firmaer
       set firmanavn      = coalesce(v_navn, firmanavn),
           cvr            = coalesce(v_cvr, cvr),
           adresse        = coalesce(nullif(btrim(p_adresse), ''), adresse),
           postnummer     = coalesce(nullif(btrim(p_postnummer), ''), postnummer),
           bynavn         = coalesce(nullif(btrim(p_by), ''), bynavn),
           telefon        = coalesce(nullif(btrim(p_telefon), ''), telefon),
           kontakt_email  = coalesce(lower(nullif(btrim(p_kontakt_email), '')), kontakt_email),
           kontaktperson  = coalesce(nullif(btrim(p_kontaktperson), ''), kontaktperson),
           abonnement_status = coalesce(v_status, abonnement_status),
           pauset_aarsag  = case when v_status is null then pauset_aarsag
                                 when v_status = 'pauset' then 'bidhamr' else null end,
           opsagt_kl      = case when v_status = 'opsagt' then coalesce(opsagt_kl, now())
                                 when v_status is not null then null else opsagt_kl end,
           pakke_id       = coalesce(v_pakke, pakke_id),
           naeste_pakke_id  = case when v_pakke is not null then null else naeste_pakke_id end,
           naeste_pakke_fra = case when v_pakke is not null then null else naeste_pakke_fra end,
           opdateret_kl   = now()
     where id = p_firma;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  if v_navn is not null then
    update public.users set navn = left(v_navn, 200) where id = f.bruger_id;
  end if;

  if v_pakke is not null then
    update public.firma_pakkeskift
       set status = case when til_pakke_id = v_pakke and status = 'afventer_betaling' then 'gennemfoert' else 'annulleret' end,
           behandlet_kl = now(),
           note = coalesce(note, 'Afgjort af BidHamr')
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl, note)
    values (f.id, f.pakke_id, v_pakke, 'bidhamr', 'gennemfoert', p_staff, now(), left(p_note, 1000));
    v_tekst := v_tekst || 'Pakke ændret'::text;
  end if;
  if v_status is not null then
    v_tekst := v_tekst || ('Status: ' || f.abonnement_status || ' → ' || v_status);
  end if;
  if coalesce(v_navn, v_cvr, p_adresse, p_postnummer, p_by, p_telefon, p_kontakt_email, p_kontaktperson) is not null then
    v_tekst := v_tekst || 'Firmaoplysninger ændret'::text;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_opdateret', 'firma', f.id, f.bruger_id,
          left(concat_ws('; ', array_to_string(v_tekst, '; '), nullif(btrim(coalesce(p_note, '')), ''),
                         f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));

  return jsonb_build_object('kode', 'ok');
end $function$
;

CREATE OR REPLACE FUNCTION public.erhverv_firmaer_liste(p_staff uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(f)
        || jsonb_build_object(
             'login_email', u.email,
             'har_logget_ind', au.last_sign_in_at is not null,
             'pakke', public.erhverv_pakke_json(f.pakke_id),
             'naeste_pakke', public.erhverv_pakke_json(f.naeste_pakke_id),
             'afventende_opgradering', (select public.erhverv_pakke_json(s.til_pakke_id)
                                               || jsonb_build_object('skift_id', s.id)
                                          from public.firma_pakkeskift s
                                         where s.firma_id = f.id and s.status = 'afventer_betaling'),
             'aktive_auktioner', (select count(*) from public.auctions a
                                   where a.bruger_id = f.bruger_id and a.status = 'aktiv'),
             'oprettet_af_navn', s.navn)
        order by f.oprettet_kl desc)
      from public.firmaer f
      join public.users u on u.id = f.bruger_id
      left join auth.users au on au.id = f.bruger_id
      left join public.users s on s.id = f.oprettet_af), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_skift_pakke_server(p_bruger uuid, p_pakke uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f       public.firmaer;
  nu      public.erhverv_pakker;
  ny      public.erhverv_pakker;
  u       record;
  v_fra   timestamptz;
  v_id    uuid;
  v_snap  jsonb;
  v_laas  uuid := gen_random_uuid();
begin
  if p_bruger is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select suspenderet, suspenderet_til, konto_lukket_kl, konto_slettet_kl into u
    from public.users where id = p_bruger;
  if not found or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now())) then
    raise exception 'erhverv_konto_spaerret: Din konto er spærret, så du kan ikke skifte pakke. Skriv til erhverv@bidhamr.dk.'
      using errcode = 'BHE06';
  end if;
  select * into f from public.firmaer where bruger_id = p_bruger for update;
  if f.id is null then
    raise exception 'erhverv_intet_abonnement: Kun firmakonti har et abonnement.' using errcode = 'BHE02';
  end if;
  if f.pakkeskift_i_gang_kl is not null and f.pakkeskift_i_gang_kl > now() - interval '5 minutes' then
    raise exception 'erhverv_skift_i_gang: Vi er ved at skifte din pakke. Vent et øjeblik, og opdater siden.'
      using errcode = 'BHE07';
  end if;
  if not public.rate_limit_tjek('firma_skift_pakke:' || p_bruger::text, 10, 3600) then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.' using errcode = 'BHR01';
  end if;
  if f.abonnement_status <> 'aktiv' then
    raise exception 'erhverv_intet_abonnement: Abonnementet er ikke aktivt. Kontakt BidHamr på erhverv@bidhamr.dk.'
      using errcode = 'BHE02';
  end if;

  perform public.firma_anvend_planlagt(f.id);
  select * into f from public.firmaer where id = f.id;

  v_snap := jsonb_build_object(
    'naeste_pakke_id', f.naeste_pakke_id,
    'naeste_pakke_fra', f.naeste_pakke_fra,
    'planlagt', (select s.id from public.firma_pakkeskift s where s.firma_id = f.id and s.status = 'planlagt'),
    'afventer', (select s.id from public.firma_pakkeskift s where s.firma_id = f.id and s.status = 'afventer_betaling'));

  select * into ny from public.erhverv_pakker where id = p_pakke and aktiv;
  if ny.id is null then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  select * into nu from public.erhverv_pakker where id = f.pakke_id;

  if ny.id = nu.id then
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now(),
           pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
     where id = f.id;
    return jsonb_build_object('kode', 'uaendret', 'tilbagerul', v_snap, 'laas', v_laas);
  end if;

  if ny.auktioner_pr_uge > nu.auktioner_pr_uge then
    update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
     where firma_id = f.id and status = 'afventer_betaling';
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status = 'planlagt';
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now(),
           pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
     where id = f.id;
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af)
    values (f.id, nu.id, ny.id, 'opgradering', 'afventer_betaling', p_bruger)
    returning id into v_id;
    return jsonb_build_object('kode', 'opgradering_afventer_betaling', 'skift_id', v_id,
                              'pakke', public.erhverv_pakke_json(ny.id), 'tilbagerul', v_snap, 'laas', v_laas);
  end if;

  if f.opsiges_fra is not null then
    raise exception 'erhverv_opsagt: Dit abonnement er opsagt og stopper %. Du kan ikke skifte til en mindre pakke. Skriv til erhverv@bidhamr.dk, hvis du vil fortsætte.',
      to_char(f.opsiges_fra at time zone 'Europe/Copenhagen', 'DD.MM.YYYY')
      using errcode = 'BHE08';
  end if;

  v_fra := coalesce(f.periode_slut, f.betalt_til, public.firma_naeste_periode(f.abonnement_start));
  update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
   where firma_id = f.id and status = 'planlagt';
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = f.id and status = 'afventer_betaling';
  update public.firmaer set naeste_pakke_id = ny.id, naeste_pakke_fra = v_fra, opdateret_kl = now(),
         pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
   where id = f.id;
  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, gaelder_fra, anmodet_af)
  values (f.id, nu.id, ny.id, 'nedgradering', 'planlagt', v_fra, p_bruger)
  returning id into v_id;
  return jsonb_build_object('kode', 'nedgradering_planlagt', 'skift_id', v_id, 'gaelder_fra', v_fra,
                            'pakke', public.erhverv_pakke_json(ny.id), 'tilbagerul', v_snap, 'laas', v_laas);
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_stripe_abonnement_spejl(p_firma uuid, p_subscription_id text, p_stripe_status text, p_opsiges_fra timestamp with time zone, p_periode_slut timestamp with time zone, p_slettet boolean DEFAULT false, p_aarsag text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f public.firmaer;
begin
  if p_subscription_id is null or btrim(p_subscription_id) = '' then
    raise exception 'Mangler abonnements-id';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if p_slettet then
    if f.stripe_subscription_id is distinct from p_subscription_id then
      return jsonb_build_object('kode', 'ukendt_abonnement');
    end if;
    if coalesce(p_aarsag, '') = 'cancellation_requested' or f.opsiges_fra is not null then
      update public.firmaer
         set abonnement_status = 'opsagt', opsagt_kl = coalesce(opsagt_kl, now()), pauset_aarsag = null,
             stripe_abonnement_status = 'canceled', opsiges_fra = null,
             naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
       where id = f.id;
      update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now(),
             note = coalesce(note, 'Abonnementet er opsagt')
       where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
      return jsonb_build_object('kode', 'opsagt');
    end if;
    update public.firmaer
       set stripe_subscription_id = null, stripe_abonnement_status = 'canceled', periode_slut = null,
           abonnement_status = case when abonnement_status = 'aktiv' then 'pauset' else abonnement_status end,
           pauset_aarsag = case when abonnement_status = 'aktiv' then 'betaling' else pauset_aarsag end,
           opdateret_kl = now()
     where id = f.id;
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now(),
           note = coalesce(note, 'Abonnementet blev afsluttet af Stripe')
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null where id = f.id;
    return jsonb_build_object('kode', 'pause_betaling');
  end if;

  if f.stripe_subscription_id is not null and f.stripe_subscription_id <> p_subscription_id then
    return jsonb_build_object('kode', 'andet_abonnement', 'nuvaerende', f.stripe_subscription_id);
  end if;

  update public.firmaer
     set stripe_subscription_id = p_subscription_id,
         stripe_abonnement_status = left(p_stripe_status, 40),
         opsiges_fra = p_opsiges_fra,
         periode_slut = coalesce(p_periode_slut, periode_slut),
         opdateret_kl = now()
   where id = f.id;
  return jsonb_build_object('kode', 'ok');
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_statistik()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz := (date_trunc('month', now() at time zone 'Europe/Copenhagen') - interval '11 months')
                         at time zone 'Europe/Copenhagen';
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.firmaer f where f.bruger_id = v_uid) then
    return null;
  end if;

  return jsonb_build_object(
    'maaneder', (
      select jsonb_agg(jsonb_build_object(
               'maaned', to_char(m.maaned, 'YYYY-MM'),
               'visninger', (select count(*) from public.auction_views v
                               join public.auctions a on a.id = v.auktion_id
                              where a.bruger_id = v_uid
                                and v.foerste_visning >= m.fra and v.foerste_visning < m.til),
               'bud', (select count(*) from public.bids b
                         join public.auctions a on a.id = b.auktion_id
                        where a.bruger_id = v_uid
                          and b.oprettet >= m.fra and b.oprettet < m.til),
               'solgte', (select count(*) from public.trades t
                           where t.seller_id = v_uid and t.status <> 'annulleret'
                             and t.created_at >= m.fra and t.created_at < m.til),
               'omsaetning', (select coalesce(sum(t.amount), 0) from public.trades t
                               where t.seller_id = v_uid and t.status <> 'annulleret'
                                 and t.created_at >= m.fra and t.created_at < m.til))
             order by m.maaned)
        from (select s.maaned,
                     s.maaned at time zone 'Europe/Copenhagen' as fra,
                     (s.maaned + interval '1 month') at time zone 'Europe/Copenhagen' as til
                from generate_series(v_start at time zone 'Europe/Copenhagen',
                                     date_trunc('month', now() at time zone 'Europe/Copenhagen'),
                                     interval '1 month') as s(maaned)) m),
    'auktioner', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'titel', a.titel, 'status', a.status, 'oprettet', a.oprettet,
               'slutter_kl', a.slutter_kl, 'bud', coalesce(a.antal_bud, 0),
               'visninger', (select count(*) from public.auction_views v where v.auktion_id = a.id),
               'solgt_for', (select t.amount from public.trades t
                              where t.auction_id = a.id and t.status <> 'annulleret'
                              order by t.created_at desc limit 1))
             order by a.oprettet desc)
        from (select * from public.auctions a0 where a0.bruger_id = v_uid
               order by a0.oprettet desc limit 100) a), '[]'::jsonb)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.firma_pakkeskift_betalt(p_skift uuid, p_stripe_reference text, p_beloeb_oere bigint, p_stripe_invoice_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s public.firma_pakkeskift;
begin
  if p_stripe_reference is null or btrim(p_stripe_reference) = '' then
    raise exception 'Mangler Stripe-reference';
  end if;
  select * into s from public.firma_pakkeskift where id = p_skift for update;
  if s.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.status = 'gennemfoert' and s.stripe_reference = p_stripe_reference then
    return jsonb_build_object('kode', 'allerede_registreret');
  end if;
  if s.status <> 'afventer_betaling' then
    perform public.drift_fejl_log(
      'webhook', 'firma_pakkeskift_betalt',
      left(format('Opgradering betalt, men pakkeskiftet afventer ikke længere (status %s) - '
                  || 'refundér eller undersøg i Stripe. Skift %s, firma %s, reference %s, faktura %s, beløb %s øre.',
                  s.status, s.id, s.firma_id, p_stripe_reference, coalesce(p_stripe_invoice_id, '-'),
                  coalesce(p_beloeb_oere::text, '-')), 1000),
      'pakkeskift_betalt:' || s.id::text || ':' || p_stripe_reference,
      null);
    return jsonb_build_object('kode', 'betalt_men_ikke_afventende', 'status', s.status,
                              'firma_id', s.firma_id, 'skal_undersoeges', true);
  end if;

  perform 1 from public.firmaer where id = s.firma_id for update;

  update public.firma_pakkeskift
     set status = 'gennemfoert', behandlet_kl = now(), stripe_reference = p_stripe_reference,
         stripe_invoice_id = coalesce(stripe_invoice_id, p_stripe_invoice_id)
   where id = s.id;
  update public.firmaer
     set pakke_id = s.til_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
   where id = s.firma_id;
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = s.firma_id and status = 'planlagt';

  insert into public.firma_regninger as r (firma_id, type, periode_fra, beloeb_oere, status,
                                           stripe_invoice_id, stripe_reference, betalt_kl)
  values (s.firma_id, 'opgradering', (now() at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), 'betalt', p_stripe_invoice_id,
          'skift:' || p_stripe_reference, now())
  on conflict (stripe_invoice_id) do update
     set status = 'betalt', type = 'opgradering', betalt_kl = coalesce(r.betalt_kl, now()),
         beloeb_oere = excluded.beloeb_oere,
         stripe_reference = coalesce(r.stripe_reference, excluded.stripe_reference)
   where r.firma_id = s.firma_id;

  return jsonb_build_object('kode', 'ok', 'firma_id', s.firma_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_abonnement_betalt(p_firma uuid, p_periode_start timestamp with time zone, p_periode_slut timestamp with time zone, p_beloeb_oere bigint, p_stripe_reference text, p_stripe_invoice_id text DEFAULT NULL::text, p_subscription_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f public.firmaer;
  v_flere_fejl boolean;
begin
  if p_stripe_reference is null or btrim(p_stripe_reference) = '' then
    raise exception 'Mangler Stripe-reference';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if exists (select 1 from public.firma_regninger r
              where r.firma_id = f.id and r.status = 'betalt'
                and ((p_stripe_invoice_id is not null and r.stripe_invoice_id = p_stripe_invoice_id)
                     or r.stripe_reference = 'abon:' || p_stripe_reference)) then
    return jsonb_build_object('kode', 'allerede_registreret');
  end if;

  insert into public.firma_regninger as r (firma_id, type, periode_fra, periode_til, beloeb_oere, status,
                                           stripe_invoice_id, stripe_reference, betalt_kl, stripe_subscription_id)
  values (f.id, 'abonnement', (p_periode_start at time zone 'Europe/Copenhagen')::date,
          (p_periode_slut at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), 'betalt', p_stripe_invoice_id,
          'abon:' || p_stripe_reference, now(), left(nullif(btrim(p_subscription_id), ''), 255))
  on conflict (stripe_invoice_id) do update
     set status = 'betalt',
         stripe_subscription_id = coalesce(r.stripe_subscription_id, excluded.stripe_subscription_id),
         type = 'abonnement',
         betalt_kl = coalesce(r.betalt_kl, now()),
         beloeb_oere = excluded.beloeb_oere,
         periode_fra = coalesce(r.periode_fra, excluded.periode_fra),
         periode_til = coalesce(r.periode_til, excluded.periode_til),
         stripe_reference = coalesce(r.stripe_reference, excluded.stripe_reference)
   where r.firma_id = f.id;

  v_flere_fejl := exists (select 1 from public.firma_regninger r
                           where r.firma_id = f.id and r.type = 'abonnement' and r.status = 'mislykket'
                             and r.stripe_subscription_id is not distinct from nullif(btrim(p_subscription_id), ''));

  update public.firmaer
     set betalt_til = greatest(coalesce(betalt_til, p_periode_slut), p_periode_slut),
         betaling_mislykket_kl = case when v_flere_fejl then betaling_mislykket_kl else null end,
         abonnement_start = case when abonnement_status = 'afventer_betaling' then p_periode_start
                                 else abonnement_start end,
         abonnement_status = case
           when abonnement_status = 'afventer_betaling' then 'aktiv'
           when abonnement_status = 'pauset' and pauset_aarsag = 'betaling' and not v_flere_fejl then 'aktiv'
           else abonnement_status end,
         pauset_aarsag = case
           when abonnement_status = 'pauset' and pauset_aarsag = 'betaling' and not v_flere_fejl then null
           else pauset_aarsag end,
         opdateret_kl = now()
   where id = f.id;

  update public.firmaer
     set pakke_id = naeste_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
   where id = f.id and naeste_pakke_id is not null and naeste_pakke_fra is not null
     and naeste_pakke_fra <= p_periode_start + interval '1 day';
  if found then
    update public.firma_pakkeskift set status = 'gennemfoert', behandlet_kl = now()
     where firma_id = f.id and status = 'planlagt';
  end if;
  perform public.firma_anvend_planlagt(f.id);

  return jsonb_build_object('kode', 'ok', 'foerste', f.abonnement_status = 'afventer_betaling');
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_pakkeskift_laas_tag(p_firma uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_laas uuid := gen_random_uuid();
begin
  update public.firmaer
     set pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
   where id = p_firma
     and (pakkeskift_i_gang_kl is null or pakkeskift_i_gang_kl <= now() - interval '5 minutes');
  if not found then
    return null;
  end if;
  return v_laas;
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_pakkeskift_laas_frigiv(p_firma uuid, p_laas uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.firmaer set pakkeskift_i_gang_kl = null, pakkeskift_laas = null
   where id = p_firma and pakkeskift_laas = p_laas;
  return jsonb_build_object('kode', case when found then 'ok' else 'ikke_laast' end);
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_faktura_spejl(p_firma uuid, p_stripe_invoice_id text, p_nummer text, p_type text, p_periode_fra timestamp with time zone, p_periode_til timestamp with time zone, p_beloeb_oere bigint, p_ekskl_moms_oere bigint, p_moms_oere bigint, p_stripe_status text, p_pdf_url text, p_hosted_url text, p_subscription_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
  v_pdf    text := case when p_pdf_url ~ '^https://' then left(p_pdf_url, 2000) end;
  v_hosted text := case when p_hosted_url ~ '^https://' then left(p_hosted_url, 2000) end;
begin
  if p_stripe_invoice_id is null or btrim(p_stripe_invoice_id) = '' then
    raise exception 'Mangler faktura-id';
  end if;
  perform 1 from public.firmaer where id = p_firma for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_stripe_status = 'draft' then
    return jsonb_build_object('kode', 'kladde');
  end if;
  v_status := case p_stripe_status
    when 'void' then 'annulleret'
    when 'uncollectible' then 'mislykket'
    else 'afventer' end;

  insert into public.firma_regninger as r (firma_id, nummer, type, periode_fra, periode_til, beloeb_oere,
                                           beloeb_ekskl_moms_oere, moms_oere, status, stripe_invoice_id,
                                           pdf_url, hosted_url, stripe_subscription_id)
  values (p_firma, left(p_nummer, 50), case when p_type in ('abonnement', 'opgradering') then p_type else 'andet' end,
          (p_periode_fra at time zone 'Europe/Copenhagen')::date,
          (p_periode_til at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), p_ekskl_moms_oere, p_moms_oere, v_status,
          p_stripe_invoice_id, v_pdf, v_hosted, left(nullif(btrim(p_subscription_id), ''), 255))
  on conflict (stripe_invoice_id) do update
     set nummer = coalesce(excluded.nummer, r.nummer),
         stripe_subscription_id = coalesce(r.stripe_subscription_id, excluded.stripe_subscription_id),
         type = excluded.type,
         periode_fra = coalesce(excluded.periode_fra, r.periode_fra),
         periode_til = coalesce(excluded.periode_til, r.periode_til),
         beloeb_oere = excluded.beloeb_oere,
         beloeb_ekskl_moms_oere = coalesce(excluded.beloeb_ekskl_moms_oere, r.beloeb_ekskl_moms_oere),
         moms_oere = coalesce(excluded.moms_oere, r.moms_oere),
         pdf_url = coalesce(excluded.pdf_url, r.pdf_url),
         hosted_url = coalesce(excluded.hosted_url, r.hosted_url),
         status = case
           when r.status in ('betalt', 'krediteret') then r.status
           when p_stripe_status = 'paid' then r.status
           when excluded.status = 'afventer' and r.status = 'mislykket' then 'mislykket'
           else excluded.status end
   where r.firma_id = p_firma;

  return jsonb_build_object('kode', 'ok');
end $function$
;

CREATE OR REPLACE FUNCTION public.firma_regning_krediteret(p_firma uuid, p_stripe_invoice_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.firma_regninger set status = 'krediteret'
   where firma_id = p_firma and stripe_invoice_id = p_stripe_invoice_id;
  return jsonb_build_object('kode', case when found then 'ok' else 'ikke_fundet' end);
end $function$
;

