-- Test af 20261102270000_henvis_rettelser.sql. KUN testdatabasen.
--
-- Kører alt i én DO-blok, der til sidst kaster en undtagelse med resultatet,
-- så ALT rulles tilbage (intet testdata bliver liggende). Forventet svar:
--   "HENVIS-RETTELSER-TEST OK: ..." eller "HENVIS-RETTELSER-TEST FEJL: ...".
--
--   npx supabase db query --linked --project-ref pjiigmzqwlfepxnjdvug -f supabase/testscripts/20261102270000_henvis_rettelser_test.sql
--
-- Dækker:
--   - henviser uden MitID: 0 point, status 'henviser_uverificeret' (også
--     selvhenvisning: samme person uden MitID henviser sin anden konto),
--     min_henvisning().mitid_verificeret,
--   - henvisning_vurder venter ikke (skip locked + pg_try_advisory_xact_lock,
--     ingen ventende pg_advisory_xact_lock),
--   - henvisning_synk: de mindst forsøgte først (en række, der er forsøgt
--     mange gange, kommer bagerst), svaret har 'udskudt',
--   - min_henvisningskode: egen kode, null for firma og uden kode, opretter
--     intet, anon kan ikke kalde den,
--   - påmindelse før slut: ikke til lukkede eller suspenderede konti,
--   - mine_data: nøglen 'henvis_en_ven' uden vennens id.
-- Den eksisterende test (20261102230000_henvis_en_ven_test.sql) skal stadig
-- give OK efter denne migration.
do $test$
declare
  a uuid; u0 uuid; g uuid;
  v uuid[];
  b uuid; c uuid; d uuid; e uuid; n_u uuid; s_u uuid; l_u uuid;
  kode_a text; kode_u0 text;
  r jsonb;
  st text;
  saldo0 integer;
  fejl text[] := '{}';
  ok integer := 0;
  n integer;
  def text;
  auk uuid;
begin
  update public.henvisning_indstillinger set optjening_fra_kl = now() - interval '1 minute' where id;

  -- A: verificeret privat henviser. U0: privat henviser UDEN MitID.
  select u.id into a from public.users u
    join public.mitid_verificeringer m on m.bruger_id = u.id and m.status = 'aktiv'
   where u.konto_type = 'privat' and u.konto_slettet_kl is null and u.konto_lukket_kl is null
     and not coalesce(u.suspenderet, false)
     and not exists (select 1 from public.henvisninger x where x.ven_id = u.id or x.henviser_id = u.id)
   order by u.id limit 1;
  select u.id into g from public.users u where u.konto_type = 'erhverv' order by u.id limit 1;

  select array_agg(id order by id) into v from (
    select u.id from public.users u
     where u.konto_type = 'privat' and u.konto_slettet_kl is null and u.konto_lukket_kl is null
       and not coalesce(u.suspenderet, false) and u.mitid_verificeret_kl is null
       and u.id <> public.bidhamr_system_id()
       and not exists (select 1 from public.mitid_verificeringer m where m.bruger_id = u.id)
       and not exists (select 1 from public.henvisninger x where x.ven_id = u.id or x.henviser_id = u.id)
     order by u.id limit 8) s;
  if a is null or g is null or coalesce(array_length(v, 1), 0) < 8 then
    raise exception 'HENVIS-RETTELSER-TEST FEJL: for få testbrugere (a %, g %, venner %)', a, g, array_length(v, 1);
  end if;
  u0 := v[1]; b := v[2]; c := v[3]; d := v[4]; e := v[5]; n_u := v[6]; s_u := v[7]; l_u := v[8];
  update public.users set oprettet = now() where id = any (v);

  -- ---- min_henvisningskode før koden findes: null, og intet oprettes ----
  perform set_config('request.jwt.claims', json_build_object('sub', u0, 'role', 'authenticated')::text, true);
  if public.min_henvisningskode() is not null then fejl := fejl || 'kode_uden_kode'::text; else ok := ok + 1; end if;
  if exists (select 1 from public.henvisning_koder where bruger_id = u0) then fejl := fejl || 'kode_oprettet_af_opslag'::text; else ok := ok + 1; end if;

  -- ---- henviser uden MitID ----
  r := public.min_henvisning();
  kode_u0 := r ->> 'kode';
  if (r ->> 'mitid_verificeret')::boolean is distinct from false then fejl := fejl || ('u0_mitid_flag ' || r::text); else ok := ok + 1; end if;
  if public.min_henvisningskode() is distinct from kode_u0 then fejl := fejl || 'kode_opslag'::text; else ok := ok + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  r := public.min_henvisning();
  kode_a := r ->> 'kode';
  if (r ->> 'mitid_verificeret')::boolean is distinct from true then fejl := fejl || ('a_mitid_flag ' || r::text); else ok := ok + 1; end if;

  -- Firma: ingen kode via opslaget, heller ikke hvis der ligger en.
  insert into public.henvisning_koder (bruger_id, kode) values (g, 'GGGGGGGGGG') on conflict do nothing;
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  if public.min_henvisningskode() is not null then fejl := fejl || 'kode_firma'::text; else ok := ok + 1; end if;

  -- B henvist af U0 (uden MitID) -> 0 point, henviser_uverificeret.
  if public.henvisning_knyt(b, kode_u0) ->> 'kode' <> 'ok' then fejl := fejl || 'knyt_b'::text; else ok := ok + 1; end if;
  saldo0 := public.boost_saldo(u0);
  r := public.mitid_registrer(b, encode(sha256(('hr-b-' || b)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  if r ->> 'kode' <> 'ok' then fejl := fejl || ('mitid_b ' || r::text); end if;
  select status into st from public.henvisninger where ven_id = b;
  if st is distinct from 'henviser_uverificeret' then fejl := fejl || ('uverificeret ' || coalesce(st, 'null')); else ok := ok + 1; end if;
  if public.boost_saldo(u0) <> saldo0 then fejl := fejl || 'uverificeret_point'::text; else ok := ok + 1; end if;
  -- Endeligt: bliver U0 verificeret bagefter, gives der stadig ingen point.
  perform public.mitid_registrer(u0, encode(sha256(('hr-u0-' || u0)::bytea), 'hex'), 'Test Henviser', date '1985-01-01');
  perform public.henvisning_synk(1000);
  select status into st from public.henvisninger where ven_id = b;
  if st is distinct from 'henviser_uverificeret' or public.boost_saldo(u0) <> saldo0 then
    fejl := fejl || ('uverificeret_endeligt ' || coalesce(st, 'null'));
  else ok := ok + 1;
  end if;
  -- Nu er U0 verificeret: næste ven giver point.
  perform public.henvisning_knyt(c, kode_u0);
  perform public.mitid_registrer(c, encode(sha256(('hr-c-' || c)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  select status into st from public.henvisninger where ven_id = c;
  if st is distinct from 'belonnet' then fejl := fejl || ('efter_verificering ' || coalesce(st, 'null')); else ok := ok + 1; end if;

  -- ---- henvisning_vurder venter ikke ----
  select pg_get_functiondef('public.henvisning_vurder(uuid, text)'::regprocedure) into def;
  if position('skip locked' in def) = 0 or position('pg_try_advisory_xact_lock' in def) = 0
     or position('boost_proev_laas_bruger' in def) = 0
     or def ~ 'pg_advisory_xact_lock\(' or position('boost_laas_bruger(' in def) > 0 then
    fejl := fejl || 'vurder_laas'::text;
  else ok := ok + 1;
  end if;

  -- ---- henvisning_synk: mindst forsøgte først ----
  -- D og E afventer med en aktiv MitID (triggeren slået fra imens). D er
  -- forsøgt 50 gange; E aldrig. Med plads til én tages E først.
  perform public.henvisning_knyt(x, kode_a) from unnest(array[d, e]) x;
  execute 'alter table public.mitid_verificeringer disable trigger mitid_verificeringer_henvisning';
  perform public.mitid_registrer(d, encode(sha256(('hr-d-' || d)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  perform public.mitid_registrer(e, encode(sha256(('hr-e-' || e)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  execute 'alter table public.mitid_verificeringer enable trigger mitid_verificeringer_henvisning';
  update public.henvisninger set synk_forsoeg = 50, synk_sidst_kl = now() where ven_id = d;
  -- Andre afventende rækker i testdatabasen må ikke gå forud for E.
  update public.henvisninger set synk_forsoeg = 40 where status = 'afventer' and ven_id not in (d, e);
  r := public.henvisning_synk(1);
  if (r ->> 'vurderet')::int <> 1 or not (r ? 'udskudt') then fejl := fejl || ('synk_svar ' || r::text); else ok := ok + 1; end if;
  if (select status from public.henvisninger where ven_id = e) = 'afventer'
     or (select status from public.henvisninger where ven_id = d) <> 'afventer' then
    fejl := fejl || 'synk_raekkefoelge'::text;
  else ok := ok + 1;
  end if;
  perform public.henvisning_synk(1000);
  if (select status from public.henvisninger where ven_id = d) = 'afventer' then fejl := fejl || 'synk_d'::text; else ok := ok + 1; end if;

  -- ---- RLS: synk-kolonnerne kan ikke læses, anon kan ikke slå kode op ----
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform synk_forsoeg from public.henvisninger limit 1;
    fejl := fejl || 'rls_synk_forsoeg'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  if public.min_henvisningskode() is distinct from kode_a then fejl := fejl || 'kode_som_bruger'::text; else ok := ok + 1; end if;
  execute 'reset role';
  execute 'set local role anon';
  begin
    perform public.min_henvisningskode();
    fejl := fejl || 'anon_kode'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  execute 'reset role';

  -- ---- mine_data: henvis_en_ven uden vennens id ----
  perform set_config('request.jwt.claims', json_build_object('sub', u0, 'role', 'authenticated')::text, true);
  r := public.mine_data() -> 'henvis_en_ven';
  if r is null or r ->> 'kode' is distinct from kode_u0 or jsonb_array_length(r -> 'henvisninger') <> 2
     or (r ->> 'point_i_alt')::int <> 10 or (r -> 'henvisninger' -> 0) ? 'ven_id'
     or (r -> 'henvisninger' -> 0 ->> 'status') is null or r::text like '%' || b::text || '%' then
    fejl := fejl || ('mine_data ' || coalesce(r::text, 'null'));
  else ok := ok + 1;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  r := public.mine_data() -> 'henvis_en_ven';
  if r -> 'henvist_af_en_ven' is null or r::text like '%' || u0::text || '%' then
    fejl := fejl || ('mine_data_ven ' || coalesce(r::text, 'null'));
  else ok := ok + 1;
  end if;

  -- ---- påmindelse før slut: ikke lukkede eller suspenderede ----
  select x.id into auk from public.auctions x
   where x.status = 'aktiv' and x.skjult = false and x.pauset_kl is null
     and x.kunst_kontrol is distinct from 'afventer'
     and x.bruger_id not in (n_u, s_u, l_u)
   order by x.id limit 1;
  if auk is null then
    fejl := fejl || 'paamind_ingen_auktion'::text;
  else
    update public.auctions set slutter_kl = now() + interval '30 minutes' where id = auk;
    insert into public.favorites (user_id, auction_id) values (n_u, auk), (s_u, auk), (l_u, auk) on conflict do nothing;
    update public.users set suspenderet = true, suspenderet_kl = now(), suspenderet_til = now() + interval '7 days' where id = s_u;
    update public.users set konto_lukket_kl = now() where id = l_u;
    select count(*) filter (where p.bruger_id = n_u), count(*) filter (where p.bruger_id in (s_u, l_u))
      into n, saldo0
      from public.paamindelser_foer_slut_claim(5000) p where p.auktion_id = auk;
    if n <> 1 or saldo0 <> 0 then fejl := fejl || ('paamind normal ' || n || ' spaerret ' || saldo0); else ok := ok + 1; end if;
  end if;

  if array_length(fejl, 1) is null then
    raise exception 'HENVIS-RETTELSER-TEST OK: % tjek bestået (alt rulles tilbage)', ok;
  end if;
  raise exception 'HENVIS-RETTELSER-TEST FEJL: % bestået, fejl: %', ok, array_to_string(fejl, ' | ');
end $test$;
