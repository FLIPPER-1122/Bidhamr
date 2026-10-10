-- Sikkerhedsgennemgang 10. okt. 2026 - rettelser i databasen.
--
--   1. mitid_verificeringer: RLS-policyen mitid_verificeringer_laes giver
--      kun brugeren selv adgang til sin egen række (ikke længere staff via
--      er_staff()). Admin læser via service role i serveren efter
--      rolletjek og logger opslaget i moderation_log (handling
--      'mitid_opslag' - src/components/admin/MitIdAdminKort.tsx).
--   2. firma_faktura_salg(p_firma): kun chef må slå et ANDET firmas
--      købsoplysninger op (erhverv_har_adgang(v_uid, true)) - ikke rollen
--      saelger. Firmaets eget opslag er uændret.
--   3. pg_net: anon og authenticated må ikke kalde net.* (http_post osv.)
--      eller bruge skemaet. Se bemærkningen ved afsnittet: på Supabase ejes
--      net-funktionerne af supabase_admin, så postgres-rollen kan ikke selv
--      fjerne rettighederne - afsnittet forsøger og melder status.
--      kald_drift_alarm/kald_betalings_cron er security definer (ejer
--      postgres) og påvirkes ikke.
--   4. auction_templates_saet_updated_at: fast search_path = ''.
--
-- Idempotent (kan køres igen). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælper: flet værdier ind i en eksisterende CHECK (som 20261014020000).
-- ---------------------------------------------------------------------------
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['mitid_opslag']);

-- ---------------------------------------------------------------------------
-- 1. mitid_verificeringer: kun brugeren selv (direkte). Staff via service
--    role i serveren (logges).
-- ---------------------------------------------------------------------------
drop policy if exists mitid_verificeringer_laes on public.mitid_verificeringer;
create policy mitid_verificeringer_laes on public.mitid_verificeringer
  for select to authenticated
  using (bruger_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. firma_faktura_salg: kun chef slår et andet firma op.
-- ---------------------------------------------------------------------------
-- Drift-tjek: kroppen skal være den fra 20261014020000 (gammel) eller den
-- herunder (ny - så filen kan køres igen). md5 af prosrc med LF-linjeskift.
do $$
declare
  v_md5 text;
begin
  select md5(replace(p.prosrc, E'\r\n', E'\n')) into v_md5
    from pg_proc p
   where p.oid = 'public.firma_faktura_salg(date, date, uuid, uuid)'::regprocedure;
  if v_md5 is distinct from 'a98fd13c74252f0f41b6271e68849fe4'
     and v_md5 is distinct from '1700141e318ba8e2979a7a6f66460787' then
    raise exception 'firma_faktura_salg er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
end $$;

-- p_fra/p_til: periode (salgsdato, dansk tid, begge dage med). p_trade: kun
-- én handel. p_firma: firmaets bruger-id - kun for chef i admin (logges);
-- ellers altid den indloggede firmakonto selv.
-- Kun salg, køberen har betalt (adresse og e-mail kendes først da).
-- Returnerer null, hvis brugeren ikke er en firmakonto.
create or replace function public.firma_faktura_salg(
  p_fra   date default null,
  p_til   date default null,
  p_trade uuid default null,
  p_firma uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.firma_faktura_salg(date, date, uuid, uuid) from public, anon;
-- authenticated skal kunne kalde den: adgangen afgøres af auth.uid() i
-- funktionen (firmaet selv eller chef).
grant execute on function public.firma_faktura_salg(date, date, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. pg_net: ingen adgang for anon/authenticated.
-- ---------------------------------------------------------------------------
-- net-skemaet og -funktionerne ejes af supabase_admin, og rettighederne er
-- givet af supabase_admin (EXECUTE til PUBLIC, USAGE til anon/authenticated).
-- Kører migrationen som postgres (som på Supabase), har REVOKE ingen virkning
-- (kun en advarsel). Afsnittet fejler derfor ikke, men melder status. Køres
-- den af en rolle med rettigheden (supabase_admin), virker den.
-- Bemærk: net er ikke et skema, PostgREST udstiller, og ingen funktion i
-- public kalder net.* som security invoker, så anon/authenticated kan i
-- praksis ikke nå det i dag.
do $$
begin
  -- postgres (ejer af kald_*-funktionerne og cron) og service_role har i dag
  -- kun EXECUTE via PUBLIC, så de får den eksplicit, før PUBLIC fjernes.
  grant execute on all functions in schema net to postgres, service_role;
  revoke execute on all functions in schema net from public, anon, authenticated;
  revoke usage on schema net from anon, authenticated;
  if has_function_privilege('anon', 'net.http_post(text, jsonb, jsonb, jsonb, integer)', 'EXECUTE')
     or has_schema_privilege('authenticated', 'net', 'USAGE') then
    raise notice 'pg_net: rettighederne for anon/authenticated kunne ikke fjernes af %, da net ejes af supabase_admin. Kræver Supabase (supabase_admin).', current_user;
  end if;
exception
  when invalid_schema_name or undefined_function then
    raise notice 'pg_net er ikke installeret - intet at gøre.';
end $$;

-- ---------------------------------------------------------------------------
-- 4. auction_templates_saet_updated_at: fast search_path.
-- ---------------------------------------------------------------------------
-- Kroppen (new.updated_at := now()) er uændret; kun search_path sættes.
alter function public.auction_templates_saet_updated_at() set search_path = '';
