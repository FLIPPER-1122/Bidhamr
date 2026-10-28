-- Rettelser til ventende refusioner af køb i appen
-- (20261102370000_boost_iap_rettelser.sql) efter reviewerens anden
-- gennemgang (28. okt. 2026).
--
--   1. En REFUND_REVERSED blev ophævet igen, når den daglige cron kørte den
--      samme REFUND igen (Apples Get Notification History): upsert'en
--      nulstillede ophaevet_kl. Nu gemmes refusionens og ophævelsens
--      notifikation (Apples notificationUUID) og tidspunkt (Apples
--      signedDate) på rækken:
--        - en ophævet række genåbnes KUN af en refusion, der er signeret
--          efter ophævelsen (en gentaget/ældre REFUND gør intet),
--        - en REFUND_REVERSED ophæver KUN, hvis den er signeret efter den
--          seneste refusion (en gentaget/ældre REFUND_REVERSED gør intet),
--        - kommer REFUND_REVERSED før REFUND (tabt webhook), gemmes en
--          allerede ophævet række, så den ældre REFUND ikke blokerer købet.
--      (Serveren markerer desuden nu notifikationen som behandlet, når den
--      ventende række er gemt - src/lib/iap/server.ts.)
--   2. boost_iap_tilbagekald_testkoeb låser i fast rækkefølge (alle
--      Google-tokens, så alle transaktioner, så alle pointkonti - som
--      kreditering og refusion), så den ikke kan give deadlock med en
--      samtidig kreditering eller webhook.
--
-- Idempotent (kan køres igen). Én transaktion. Kun testdatabasen, indtil
-- Filip siger ja (og først efter 20261102370000).

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.boost_iap_ventende_refusioner') is null
     or to_regprocedure('public.boost_iap_laas_koeb(text, text)') is null then
    raise exception 'Forudsætning mangler: 20261102370000_boost_iap_rettelser.sql';
  end if;
end $do$;

-- ===========================================================================
-- 1. Notifikation og tidspunkt på den ventende række
-- ===========================================================================
alter table public.boost_iap_ventende_refusioner add column if not exists refusion_notifikation text;
alter table public.boost_iap_ventende_refusioner add column if not exists refusion_signeret_kl timestamptz;
alter table public.boost_iap_ventende_refusioner add column if not exists ophaevet_notifikation text;
alter table public.boost_iap_ventende_refusioner add column if not exists ophaevet_signeret_kl timestamptz;
alter table public.boost_iap_ventende_refusioner drop constraint if exists boost_iap_ventende_notifikation_check;
alter table public.boost_iap_ventende_refusioner add constraint boost_iap_ventende_notifikation_check check (
  coalesce(char_length(refusion_notifikation), 0) <= 200 and coalesce(char_length(ophaevet_notifikation), 0) <= 200);
comment on column public.boost_iap_ventende_refusioner.refusion_signeret_kl is
  'Hvornår Apple/Google signerede den seneste refusion (Apples signedDate). En ophævet række genåbnes kun af en refusion, der er nyere end ophaevet_signeret_kl.';
comment on column public.boost_iap_ventende_refusioner.ophaevet_signeret_kl is
  'Hvornår Apple signerede REFUND_REVERSED (signedDate). Ophævelsen gælder kun, hvis den er nyere end refusion_signeret_kl.';

-- ===========================================================================
-- 2. Refusionen (nye parametre p_notifikation og p_signeret_kl)
-- ===========================================================================
-- Svar som før. For et køb, der ikke er krediteret:
--   {kode: 'ukendt', ventende: true}                    gemt/stadig ventende - købet afvises
--   {kode: 'ukendt', ventende: false, ophaevet: true}   rækken er ophævet af en nyere
--                                                        REFUND_REVERSED - intet ændret
drop function if exists public.boost_iap_refusion(text, text, text, integer, text);
create or replace function public.boost_iap_refusion(
  p_platform text, p_ekstern_id text, p_google_token text, p_andel_milli integer, p_kilde text,
  p_notifikation text default null, p_signeret_kl timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_bruger uuid;
  k record;
  v record;
  v_maal integer;
  v_delta integer;
  v_saldo integer;
  v_hvem text;
  v_e text := nullif(p_ekstern_id, '');
  v_t text := case when p_platform = 'android' then nullif(p_google_token, '') else null end;
  v_n text := left(nullif(p_notifikation, ''), 200);
begin
  if p_platform not in ('ios', 'android') or p_andel_milli is null or p_andel_milli not between 1 and 100000
     or (v_e is null and v_t is null)
     or p_kilde not in ('apple_notifikation', 'apple_historik', 'google_rtdn', 'google_voided',
                        'apple_opslag', 'google_opslag', 'staff_testkoeb') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if v_t is not null then perform public.boost_iap_laas_koeb(p_platform, 't:' || v_t); end if;
  if v_e is not null then perform public.boost_iap_laas_koeb(p_platform, 'e:' || v_e); end if;
  select x.bruger_id into v_bruger from public.boost_iap_koeb x
   where x.platform = p_platform
     and ((v_e is not null and x.ekstern_id = v_e) or (v_t is not null and x.google_token = v_t))
   limit 1;
  if v_bruger is null then
    if p_kilde = 'staff_testkoeb' then return jsonb_build_object('kode', 'ukendt'); end if;
    -- Ikke krediteret (endnu): gem som ventende, så købet afvises bagefter.
    select r.id, r.ophaevet_kl, r.ophaevet_signeret_kl, r.refusion_notifikation, r.refusion_signeret_kl into v
      from public.boost_iap_ventende_refusioner r
     where r.platform = p_platform
       and ((v_e is not null and r.ekstern_id = v_e) or (v_t is not null and r.google_token = v_t))
     limit 1
     for update;
    if v.id is null then
      begin
        insert into public.boost_iap_ventende_refusioner (platform, ekstern_id, google_token, andel_milli, kilde,
                                                          refusion_notifikation, refusion_signeret_kl)
        values (p_platform, v_e, v_t, p_andel_milli, p_kilde, v_n, p_signeret_kl);
      exception when unique_violation then
        null; -- samme refusion er netop gemt
      end;
      return jsonb_build_object('kode', 'ukendt', 'ventende', true);
    end if;
    if v.ophaevet_kl is not null
       and (p_signeret_kl is null
            or p_signeret_kl <= coalesce(v.ophaevet_signeret_kl, v.ophaevet_kl)
            or (v_n is not null and v_n is not distinct from v.refusion_notifikation)) then
      -- Refusionen er ophævet (REFUND_REVERSED) efter denne refusion - fx
      -- den samme REFUND igen fra den daglige historik. Rækken genåbnes ikke.
      return jsonb_build_object('kode', 'ukendt', 'ventende', false, 'ophaevet', true);
    end if;
    -- Stadig ventende, eller en ny refusion efter ophævelsen: (gen)åbn.
    update public.boost_iap_ventende_refusioner
       set andel_milli = case when v.ophaevet_kl is null then greatest(andel_milli, p_andel_milli) else p_andel_milli end,
           ophaevet_kl = null,
           refusion_notifikation = case when p_signeret_kl is not null
                                         and (v.refusion_signeret_kl is null or p_signeret_kl >= v.refusion_signeret_kl)
                                        then coalesce(v_n, refusion_notifikation) else refusion_notifikation end,
           refusion_signeret_kl = greatest(refusion_signeret_kl, p_signeret_kl),
           opdateret_kl = now()
     where id = v.id;
    return jsonb_build_object('kode', 'ukendt', 'ventende', true);
  end if;
  -- Låserækkefølge: købet (ovenfor), pointkontoen, så rækken.
  perform public.boost_laas_bruger(v_bruger);
  select x.id, x.point, x.refunderet_point, x.bruger_id into k from public.boost_iap_koeb x
   where x.platform = p_platform
     and ((v_e is not null and x.ekstern_id = v_e) or (v_t is not null and x.google_token = v_t))
   limit 1
   for update;
  v_maal := least(ceil(k.point::numeric * p_andel_milli / 100000)::integer, k.point);
  v_delta := v_maal - k.refunderet_point;
  if v_delta <= 0 then
    return jsonb_build_object('kode', 'allerede', 'id', k.id, 'bruger_id', k.bruger_id,
                              'saldo', public.boost_saldo(k.bruger_id));
  end if;
  insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, iap_koeb_id)
  values (k.bruger_id, case when p_platform = 'ios' then 'refusion_apple' else 'refusion_google' end, -v_delta, 0, k.id);
  v_saldo := public.boost_saldo(k.bruger_id);
  v_hvem := case when p_kilde = 'staff_testkoeb' then 'BidHamr har trukket testkøbet tilbage'
                 when p_platform = 'ios' then 'Apple har refunderet købet'
                 else 'Google har refunderet købet' end;
  update public.boost_iap_koeb
     set refunderet_point = v_maal, refunderet_kl = coalesce(refunderet_kl, now()),
         refusion_kilde = coalesce(refusion_kilde, p_kilde),
         kraever_opmaerksomhed = kraever_opmaerksomhed or v_saldo < 0,
         opmaerksomhed_tekst = case when v_saldo < 0 then left(concat_ws(E'\n', opmaerksomhed_tekst,
           format('%s - %s point er trukket tilbage, og saldoen er nu %s (i minus). Nye boost er blokeret, til saldoen er over prisen for et boost.',
                  v_hvem, v_delta, v_saldo)), 4000)
                                    else opmaerksomhed_tekst end
   where id = k.id;
  return jsonb_build_object('kode', 'tilbagefoert', 'id', k.id, 'bruger_id', k.bruger_id, 'point', v_delta,
                            'saldo', v_saldo, 'i_minus', v_saldo < 0);
end;
$fn$;

-- ===========================================================================
-- 3. REFUND_REVERSED for et køb, vi ikke har krediteret
-- ===========================================================================
-- true = en ventende refusion er ophævet (købet må krediteres nu).
-- Ophæver kun, hvis REFUND_REVERSED er signeret efter den seneste refusion.
-- Findes der ingen række (REFUND_REVERSED kom før REFUND), gemmes en
-- allerede ophævet række (false), så en ældre REFUND ikke blokerer købet.
drop function if exists public.boost_iap_ventende_ophaev(text, text, text);
create or replace function public.boost_iap_ventende_ophaev(
  p_platform text, p_ekstern_id text, p_google_token text,
  p_notifikation text default null, p_signeret_kl timestamptz default null, p_kilde text default 'apple_notifikation')
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  v_e text := nullif(p_ekstern_id, '');
  v_t text := case when p_platform = 'android' then nullif(p_google_token, '') else null end;
  v_n text := left(nullif(p_notifikation, ''), 200);
  v record;
begin
  if p_platform not in ('ios', 'android') or (v_e is null and v_t is null)
     or p_kilde not in ('apple_notifikation', 'apple_historik') then
    return false;
  end if;
  if v_t is not null then perform public.boost_iap_laas_koeb(p_platform, 't:' || v_t); end if;
  if v_e is not null then perform public.boost_iap_laas_koeb(p_platform, 'e:' || v_e); end if;
  select r.id, r.ophaevet_kl, r.ophaevet_signeret_kl, r.refusion_signeret_kl into v
    from public.boost_iap_ventende_refusioner r
   where r.platform = p_platform
     and ((v_e is not null and r.ekstern_id = v_e) or (v_t is not null and r.google_token = v_t))
   limit 1
   for update;
  if v.id is null then
    begin
      insert into public.boost_iap_ventende_refusioner (platform, ekstern_id, google_token, andel_milli, kilde,
                                                        ophaevet_kl, ophaevet_notifikation, ophaevet_signeret_kl)
      values (p_platform, v_e, v_t, 100000, p_kilde, now(), v_n, p_signeret_kl);
    exception when unique_violation then
      null;
    end;
    return false;
  end if;
  if v.ophaevet_kl is not null then
    -- Allerede ophævet: husk den nyeste ophævelse.
    if p_signeret_kl is not null and (v.ophaevet_signeret_kl is null or p_signeret_kl > v.ophaevet_signeret_kl) then
      update public.boost_iap_ventende_refusioner
         set ophaevet_signeret_kl = p_signeret_kl, ophaevet_notifikation = coalesce(v_n, ophaevet_notifikation),
             opdateret_kl = now()
       where id = v.id;
    end if;
    return false;
  end if;
  -- En ældre REFUND_REVERSED (fx gentaget fra historikken) ophæver ikke en
  -- nyere refusion.
  if p_signeret_kl is not null and v.refusion_signeret_kl is not null and p_signeret_kl <= v.refusion_signeret_kl then
    return false;
  end if;
  update public.boost_iap_ventende_refusioner
     set ophaevet_kl = now(), ophaevet_notifikation = v_n, ophaevet_signeret_kl = p_signeret_kl, opdateret_kl = now()
   where id = v.id;
  return true;
end;
$fn$;

-- ===========================================================================
-- 4. Tilbagekald testkøb - låse i fast rækkefølge
-- ===========================================================================
-- Samme rækkefølge som kreditering og refusion (token 't:', så transaktion
-- 'e:', så pointkontoen), her for alle købene på én gang og sorteret. Kun de
-- køb, der er låst, behandles - et testkøb, der krediteres imens, tages næste
-- gang.
create or replace function public.boost_iap_tilbagekald_testkoeb()
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_ids uuid[];
  k record;
  r jsonb;
  n integer := 0;
  p integer := 0;
begin
  select coalesce(array_agg(x.id), '{}') into v_ids from public.boost_iap_koeb x
   where x.markering = 'testkoeb_prod' and x.refunderet_point < x.point;
  for k in select distinct x.platform, x.google_token from public.boost_iap_koeb x
            where x.id = any(v_ids) and x.google_token is not null
            order by x.platform, x.google_token loop
    perform public.boost_iap_laas_koeb(k.platform, 't:' || k.google_token);
  end loop;
  for k in select distinct x.platform, x.ekstern_id from public.boost_iap_koeb x
            where x.id = any(v_ids)
            order by x.platform, x.ekstern_id loop
    perform public.boost_iap_laas_koeb(k.platform, 'e:' || k.ekstern_id);
  end loop;
  for k in select distinct x.bruger_id from public.boost_iap_koeb x
            where x.id = any(v_ids)
            order by x.bruger_id loop
    perform public.boost_laas_bruger(k.bruger_id);
  end loop;
  for k in select x.platform, x.ekstern_id, x.google_token from public.boost_iap_koeb x
            where x.id = any(v_ids)
            order by x.krediteret_kl, x.id loop
    r := public.boost_iap_refusion(k.platform, k.ekstern_id, k.google_token, 100000, 'staff_testkoeb');
    if r->>'kode' = 'tilbagefoert' then
      n := n + 1;
      p := p + (r->>'point')::integer;
    end if;
  end loop;
  return jsonb_build_object('tilbagekaldt', n, 'point', p);
end;
$fn$;

-- ===========================================================================
-- 5. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.boost_iap_refusion(text, text, text, integer, text, text, timestamptz)',
    'public.boost_iap_ventende_ophaev(text, text, text, text, timestamptz, text)',
    'public.boost_iap_tilbagekald_testkoeb()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
