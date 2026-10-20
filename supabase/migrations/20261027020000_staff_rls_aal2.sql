-- Migration B: staff-PRIVILEGIER i databasen kræver to-trins-login (aal2)
-- (Filip, 19. okt. 2026 - ROADMAP-BESLUTNINGER, "Admin på admin.bidhamr.dk";
-- docs/ADMIN-VAERT.md, "Migration B").
--
-- Før denne migration beskyttede to-trins-login kun admin-siderne. RLS og
-- databasefunktionerne kendte kun rollen, så en medarbejder med kun
-- adgangskoden (aal1, fx appen eller bidhamr.dk) kunne læse andres handler,
-- beskeder, betalinger osv. direkte via Supabase. Nu kræver staff-privilegier
-- staff_aal2_ok() (20261027010000): aal2, to-trins-login aktivt i
-- staff_to_trin, ingen ukendte faktorer og en kode fra app'en højst 12 timer
-- gammel. Uden det opfører en medarbejder sig PRÆCIS som en almindelig
-- bruger: egne data virker stadig.
--
-- INGEN db_pre_request (det var den globale pre-request, der lukkede appen 7.
-- okt. 2026 - 20261009060000_fjern_to_trin.sql). min_rolle() og min_profil()
-- ændres IKKE: gaten før lancering, rolle-cookien, topbaren, hentStaffAdgang
-- og appen bruger dem. Service-role-funktioner med p_staff/p_chef ændres
-- ikke - serveren har allerede tjekket aal2 (hentStaffAdgang).
--
-- Fuld liste (hentet med SELECT fra både produktion og test 20. okt. 2026 -
-- ens i begge; alle pg_policies inkl. storage og alle funktioner, som
-- authenticated kan kalde, og som bruger er_staff, rollen eller min_rolle):
--
-- ÆNDRET (md5 = normaliseret prosrc / policy, se pg_temp-hjælperne):
--   1. er_staff()                                gammel c60104d50290ed101923d4bb3d059840
--      Rollen OG staff_aal2_ok().                ny    f87987aa4d8ca499b7cd5cf90fbf31ad
--   2. auktion_spoergsmaal_liste(uuid)           gammel 38fc55bfba916542f7448e67aaf8bd6e  ny ac39193832d11e663ecbc536355f85bb
--      Skjulte spørgsmål/auktioner for staff: staff_chat_har_rolle -> er_staff().
--   3. beta_fejl_billede_maa_uploade(text)       gammel 5a107368fca910d964b4cbfda56c7c78  ny 1eef75deb6b4193a474f807a3851edc9
--      "Meld fejl" før lancering: staff uploader et skærmbillede til sin EGEN
--      mappe uden beta-invitation - det er ikke et staff-privilegium (gaten
--      lukker staff ind på rollen), så rollen alene gælder stadig
--      (som maaMeldeBetaFejl i src/lib/betaFejlAdgang.ts). Før: er_staff().
--   4. firma_faktura_salg(date,date,uuid,uuid)   gammel 3e19eebfe328958da847fde4c09febc8  ny 7ffab70526bf6f5e5af9d4c8310d7550
--      En chef, der slår et ANDET firmas købere op (p_firma), kræver aal2.
--      Firmaets eget opslag er uændret.
--   5. Policy betaling_afvigelser.betaling_afvigelser_select_chef   gammel c881bce9511c07a33de7f08341ab9f3d  ny ed7ceff41575845b759f455dd7c20ddb
--   6. Policy betalinger.betalinger_select_part                     gammel b6ee707d622710484e14086b0e01ade6  ny 278297185e39392396a5bd88934000ad
--   7. Policy employee_complaints.employee_complaints_select_chef   gammel e17d2d7d9152046c5a00c81f4a6b4fe0  ny 55342f176933d9e188d6ee2056a542e5
--   8. Policy employee_complaints.employee_complaints_update_chef   gammel 9daecf0383eeb2863ceb1c9723d0f9a1  ny c9efc546fd91142b99848f90d1cf6cf3
--      min_rolle() = 'chef'  ->  (select min_rolle()) = 'chef' and (select staff_aal2_ok()).
--
-- ARVER aal2 via er_staff() (ingen ændring i selve funktionen/policyen):
--   policies: andenchance_tilbud.andenchance_select_part,
--     auctions.auctions_select_authenticated (også via auktion_arkiv_adgang),
--     forsendelse_haendelser.forsendelse_haendelser_select_parter,
--     forsendelser.forsendelser_select_parter,
--     handel_levering.handel_levering_select_parter,
--     messages.messages_select_part, trades.trades_select_own;
--     storage.objects: fragt_labels_laes, pakke_billeder_laes_parter,
--     sag_billeder_laes_parter (via *_maa_laese).
--   funktioner (authenticated): antal_aabne_sager, antal_ubesvarede_staff_samtaler,
--     auktion_arkiv_adgang, fragt_label_maa_laese, hent_medarbejdere,
--     mine_forsendelse_label, mit_leveringsvalg, pakke_billede_maa_laese,
--     sag_billede_maa_laese, og indirekte app_auktion_synlig ->
--     auktion_budhistorik, auktion_saelger_kan_saelge, rapporter_auktion.
--
-- UÆNDRET med vilje: min_rolle() (2e2b6b44f51252f5f292c9748367800c),
--   min_profil() (5a4b00fa8869ba98b0c54fc56efca1c3), min_staff_adgang,
--   staff_aal2_ok; upload-policies for sag/pakke/erhverv-klage (ingen
--   staff-tjek); min_returfragt, mit_ikke_afhentet, forbudte_varer,
--   mine_data_grund, konto_sletning_blokeringer_grund (ordet "rolle", intet
--   staff-privilegium); alle service-role-funktioner.
--
-- GAMLE KROPPE (til tilbagerulning - færdig fil: prod-koersel/rollback-20261027020000.sql,
-- beskrevet i docs/ADMIN-VAERT.md):
--   er_staff():
--     select exists (select 1 from public.users u where u.id = auth.uid()
--                     and u.rolle in ('medarbejder', 'admin', 'chef'));
--   auktion_spoergsmaal_liste: "public.staff_chat_har_rolle(auth.uid(), 'medarbejder')"
--     i stedet for "public.er_staff()" (resten uændret).
--   beta_fejl_billede_maa_uploade: "if not public.er_staff() then" i stedet
--     for rolle-tjekket (resten uændret).
--   firma_faktura_salg: "elsif public.erhverv_har_adgang(v_uid, true) then"
--     uden "and public.staff_aal2_ok()" (resten uændret).
--   betaling_afvigelser_select_chef: as permissive for select to authenticated
--     using (min_rolle() = 'chef'::text)
--   betalinger_select_part: as permissive for select to authenticated
--     using ((buyer_id = auth.uid()) OR (seller_id = auth.uid()) OR (min_rolle() = 'chef'::text))
--   employee_complaints_select_chef: as permissive for select to public
--     using (min_rolle() = 'chef'::text)
--   employee_complaints_update_chef: as permissive for update to public
--     using (min_rolle() = 'chef'::text)
--
-- md5-drift-tjek (mønstret fra 20261024010000): "gammel" = produktion og test
-- før denne migration, "ny" = efter. Andet afbryder migrationen, og intet
-- ændres. er_staff() har forskellig formatering i produktion og test (samme
-- normaliserede md5), så den skrives helt (fn_ret); de tre andre rettes på
-- stedet (ps_ret, CR fjernes først).
--
-- RÆKKEFØLGE I PRODUKTION: efter 20261026010000 og 20261027010000. Kør den
-- FØRST, når ADMIN_VAERT er sat i Vercel, og AL staff har to-trins-login aktivt
-- (Admin -> Medarbejdere). En medarbejder uden aktivt to-trins-login mister
-- straks staff-adgangen i databasen. Admin-siderne bruger service role og
-- påvirkes ikke.
--
-- Idempotent (kan køres igen). Én transaktion: filen køres som én samlet
-- forespørgsel. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regprocedure('public.staff_aal2_ok(integer)') is null
     or to_regclass('public.staff_to_trin') is null then
    raise exception 'Forudsætning mangler: kør 20261027010000_staff_to_trin.sql først (staff_aal2_ok)';
  end if;
  if to_regprocedure('public.er_staff()') is null or to_regprocedure('public.min_rolle()') is null then
    raise exception 'Forudsætning mangler: public.er_staff() og public.min_rolle()';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session)
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- md5 før (gammel) eller allerede rettet (ny); hvert mønster skal findes
-- præcis det forventede antal gange; md5 bagefter skal være "ny".
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
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
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

-- Som ps_ret, men hele funktionen skrives (p_ddl = create or replace ...).
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
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  execute p_ddl;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- Policy: permissive, kommando, roller, using og with check (uden "public."
-- og mellemrum, så search_path ikke betyder noget).
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
    raise exception '%.%.%: md5 % er hverken gammel eller ny - kontrollér policyen, før migrationen køres',
      p_schema, p_tabel, p_policy, h;
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

-- ===========================================================================
-- 1. er_staff(): rollen OG to-trins-login (aal2)
-- ===========================================================================
do $do$
begin
  raise notice 'er_staff: %', pg_temp.fn_ret(
    'public.er_staff()',
    'c60104d50290ed101923d4bb3d059840',
    'f87987aa4d8ca499b7cd5cf90fbf31ad',
    $ddl$
create or replace function public.er_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  -- Staff-privilegier kræver to-trins-login (aal2) - migration B
  -- (20261027020000). Rollen alene: min_rolle().
  select case
           when exists (select 1 from public.users u
                         where u.id = auth.uid() and u.rolle in ('medarbejder', 'admin', 'chef'))
             then public.staff_aal2_ok()
           else false
         end;
$fn$
    $ddl$);
end $do$;

comment on function public.er_staff() is
  'Staff (medarbejder/admin/chef) MED to-trins-login (staff_aal2_ok: aal2, aktivt, kode højst 12 timer gammel). Migration B, 20261027020000. Rollen alene: min_rolle().';

-- ===========================================================================
-- 2.-4. Funktioner, der tjekker rollen selv
-- ===========================================================================
do $do$
begin
  raise notice 'auktion_spoergsmaal_liste: %', pg_temp.ps_ret(
    'public.auktion_spoergsmaal_liste(uuid)',
    '38fc55bfba916542f7448e67aaf8bd6e',
    'ac39193832d11e663ecbc536355f85bb',
    jsonb_build_array(jsonb_build_array(
      $g$public.staff_chat_har_rolle(auth.uid(), 'medarbejder')$g$,
      $n$public.er_staff()$n$, 1)));

  raise notice 'beta_fejl_billede_maa_uploade: %', pg_temp.ps_ret(
    'public.beta_fejl_billede_maa_uploade(text)',
    '5a107368fca910d964b4cbfda56c7c78',
    '1eef75deb6b4193a474f807a3851edc9',
    jsonb_build_array(jsonb_build_array(
      $g$  if not public.er_staff() then$g$,
      $n$  -- Rollen (ikke aal2): eget skærmbillede i egen mappe (migration B).
  if not exists (select 1 from public.users s
                  where s.id = v_bruger and s.rolle in ('medarbejder', 'admin', 'chef')) then$n$, 1)));

  raise notice 'firma_faktura_salg: %', pg_temp.ps_ret(
    'public.firma_faktura_salg(date,date,uuid,uuid)',
    '3e19eebfe328958da847fde4c09febc8',
    '7ffab70526bf6f5e5af9d4c8310d7550',
    jsonb_build_array(jsonb_build_array(
      $g$elsif public.erhverv_har_adgang(v_uid, true) then$g$,
      $n$elsif public.erhverv_har_adgang(v_uid, true) and public.staff_aal2_ok() then$n$, 1)));
end $do$;

-- ===========================================================================
-- 5.-8. Policies med min_rolle() = 'chef'
-- ===========================================================================
do $do$
begin
  raise notice 'betaling_afvigelser_select_chef: %', pg_temp.pol_ret(
    'public', 'betaling_afvigelser', 'betaling_afvigelser_select_chef',
    'c881bce9511c07a33de7f08341ab9f3d', 'ed7ceff41575845b759f455dd7c20ddb',
    $p$create policy betaling_afvigelser_select_chef on public.betaling_afvigelser
         as permissive for select to authenticated
         using ((select public.min_rolle()) = 'chef' and (select public.staff_aal2_ok()))$p$);

  raise notice 'betalinger_select_part: %', pg_temp.pol_ret(
    'public', 'betalinger', 'betalinger_select_part',
    'b6ee707d622710484e14086b0e01ade6', '278297185e39392396a5bd88934000ad',
    $p$create policy betalinger_select_part on public.betalinger
         as permissive for select to authenticated
         using (buyer_id = auth.uid() or seller_id = auth.uid()
                or ((select public.min_rolle()) = 'chef' and (select public.staff_aal2_ok())))$p$);

  raise notice 'employee_complaints_select_chef: %', pg_temp.pol_ret(
    'public', 'employee_complaints', 'employee_complaints_select_chef',
    'e17d2d7d9152046c5a00c81f4a6b4fe0', '55342f176933d9e188d6ee2056a542e5',
    $p$create policy employee_complaints_select_chef on public.employee_complaints
         as permissive for select to public
         using ((select public.min_rolle()) = 'chef' and (select public.staff_aal2_ok()))$p$);

  raise notice 'employee_complaints_update_chef: %', pg_temp.pol_ret(
    'public', 'employee_complaints', 'employee_complaints_update_chef',
    '9daecf0383eeb2863ceb1c9723d0f9a1', 'c9efc546fd91142b99848f90d1cf6cf3',
    $p$create policy employee_complaints_update_chef on public.employee_complaints
         as permissive for update to public
         using ((select public.min_rolle()) = 'chef' and (select public.staff_aal2_ok()))$p$);
end $do$;

-- ===========================================================================
-- 9. Kontrol
-- ===========================================================================
do $do$
begin
  -- min_rolle() og min_profil() må ALDRIG kræve aal2 (fejlen fra 7. okt.).
  if pg_temp.krop_md5('public.min_rolle()') is distinct from '2e2b6b44f51252f5f292c9748367800c'
     or pg_temp.krop_md5('public.min_profil()') is distinct from '5a4b00fa8869ba98b0c54fc56efca1c3' then
    raise exception 'min_rolle()/min_profil() er ændret - de må ikke kræve to-trins-login';
  end if;
  if pg_get_functiondef('public.min_rolle()'::regprocedure) ~ 'staff_aal2_ok|aal' then
    raise exception 'min_rolle() bruger aal - det må den ikke';
  end if;
  -- Uden session er er_staff() falsk.
  if public.er_staff() then
    raise exception 'er_staff() er sand uden en session';
  end if;
end $do$;
