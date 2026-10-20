-- TILBAGERULNING af 20261027020000_staff_rls_aal2.sql (migration B).
-- IKKE en migration - køres kun i en nødsituation (fx hvis staff ikke kan
-- komme ind i admin, og det skyldes migration B). Kopi til Filip:
-- prod-koersel/rollback-20261027020000.sql (gitignored). Se docs/ADMIN-VAERT.md.
--
-- Gendanner den præcise gamle opførsel: staff-adgang i RLS og funktionerne
-- følger igen kun rollen (også uden to-trins-login). md5-drift-tjek som i
-- migrationen: "gammel" = efter migration B, "ny" = før migration B. Andet
-- afbryder (intet ændres). Idempotent. Én transaktion. KØRES IKKE i
-- produktion uden Filips "ja".
--
-- er_staff() får testdatabasens formatering tilbage; produktion havde samme
-- krop over flere linjer - den normaliserede md5 er den samme
-- (c60104d50290ed101923d4bb3d059840).

set local lock_timeout = '5s';

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

create or replace function pg_temp.fn_ret(p_fn text, p_gammel text, p_ny text, p_ddl text)
returns text
language plpgsql
as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen', p_fn, h;
  end if;
  execute p_ddl;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

create or replace function pg_temp.pol_md5(p_schema text, p_tabel text, p_policy text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(replace(
           p.permissive || '|' || p.cmd || '|' || array_to_string(p.roles, ',') || '|'
             || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''),
           'public.', ''), '\s', '', 'g')))
    from pg_policies p
   where p.schemaname = p_schema and p.tablename = p_tabel and p.policyname = p_policy;
$f$;

create or replace function pg_temp.pol_ret(p_schema text, p_tabel text, p_policy text,
                                           p_gammel text, p_ny text, p_create text)
returns text
language plpgsql
as $f$
declare
  h text := pg_temp.pol_md5(p_schema, p_tabel, p_policy);
begin
  if h is null then
    raise exception '%.%.%: policyen findes ikke', p_schema, p_tabel, p_policy;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%.%.%: md5 % er hverken gammel eller ny - kontrollér policyen', p_schema, p_tabel, p_policy, h;
  end if;
  execute format('drop policy %I on %I.%I', p_policy, p_schema, p_tabel);
  execute p_create;
  h := pg_temp.pol_md5(p_schema, p_tabel, p_policy);
  if h is distinct from p_ny then
    raise exception '%.%.%: efter rettelsen er md5 % (forventet %)', p_schema, p_tabel, p_policy, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

do $do$
begin
  -- 1. er_staff(): kun rollen igen.
  raise notice 'er_staff: %', pg_temp.fn_ret(
    'public.er_staff()',
    'f87987aa4d8ca499b7cd5cf90fbf31ad',
    'c60104d50290ed101923d4bb3d059840',
    $ddl$
create or replace function public.er_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.rolle in ('medarbejder', 'admin', 'chef'));
$fn$
    $ddl$);

  -- 2.-4.
  raise notice 'auktion_spoergsmaal_liste: %', pg_temp.ps_ret(
    'public.auktion_spoergsmaal_liste(uuid)',
    'ac39193832d11e663ecbc536355f85bb',
    '38fc55bfba916542f7448e67aaf8bd6e',
    jsonb_build_array(jsonb_build_array(
      $n$public.er_staff()$n$,
      $g$public.staff_chat_har_rolle(auth.uid(), 'medarbejder')$g$, 1)));

  raise notice 'beta_fejl_billede_maa_uploade: %', pg_temp.ps_ret(
    'public.beta_fejl_billede_maa_uploade(text)',
    '1eef75deb6b4193a474f807a3851edc9',
    '5a107368fca910d964b4cbfda56c7c78',
    jsonb_build_array(jsonb_build_array(
      $n$  -- Rollen (ikke aal2): eget skærmbillede i egen mappe (migration B).
  if not exists (select 1 from public.users s
                  where s.id = v_bruger and s.rolle in ('medarbejder', 'admin', 'chef')) then$n$,
      $g$  if not public.er_staff() then$g$, 1)));

  raise notice 'firma_faktura_salg: %', pg_temp.ps_ret(
    'public.firma_faktura_salg(date,date,uuid,uuid)',
    '7ffab70526bf6f5e5af9d4c8310d7550',
    '3e19eebfe328958da847fde4c09febc8',
    jsonb_build_array(jsonb_build_array(
      $n$elsif public.erhverv_har_adgang(v_uid, true) and public.staff_aal2_ok() then$n$,
      $g$elsif public.erhverv_har_adgang(v_uid, true) then$g$, 1)));

  -- 5.-8. Policies: min_rolle() = 'chef' igen.
  raise notice 'betaling_afvigelser_select_chef: %', pg_temp.pol_ret(
    'public', 'betaling_afvigelser', 'betaling_afvigelser_select_chef',
    'ed7ceff41575845b759f455dd7c20ddb', 'c881bce9511c07a33de7f08341ab9f3d',
    $p$create policy betaling_afvigelser_select_chef on public.betaling_afvigelser
         as permissive for select to authenticated
         using (min_rolle() = 'chef'::text)$p$);

  raise notice 'betalinger_select_part: %', pg_temp.pol_ret(
    'public', 'betalinger', 'betalinger_select_part',
    '278297185e39392396a5bd88934000ad', 'b6ee707d622710484e14086b0e01ade6',
    $p$create policy betalinger_select_part on public.betalinger
         as permissive for select to authenticated
         using ((buyer_id = auth.uid()) OR (seller_id = auth.uid()) OR (min_rolle() = 'chef'::text))$p$);

  raise notice 'employee_complaints_select_chef: %', pg_temp.pol_ret(
    'public', 'employee_complaints', 'employee_complaints_select_chef',
    '55342f176933d9e188d6ee2056a542e5', 'e17d2d7d9152046c5a00c81f4a6b4fe0',
    $p$create policy employee_complaints_select_chef on public.employee_complaints
         as permissive for select to public
         using (min_rolle() = 'chef'::text)$p$);

  raise notice 'employee_complaints_update_chef: %', pg_temp.pol_ret(
    'public', 'employee_complaints', 'employee_complaints_update_chef',
    'c9efc546fd91142b99848f90d1cf6cf3', '9daecf0383eeb2863ceb1c9723d0f9a1',
    $p$create policy employee_complaints_update_chef on public.employee_complaints
         as permissive for update to public
         using (min_rolle() = 'chef'::text)$p$);
end $do$;

comment on function public.er_staff() is null;
