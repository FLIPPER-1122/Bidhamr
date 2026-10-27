-- Test af Henvis en ven (20261102230000_henvis_en_ven.sql). KUN testdatabasen.
--
-- Kører alt i én DO-blok, der til sidst kaster en undtagelse med resultatet,
-- så ALT rulles tilbage (intet testdata bliver liggende). Forventet svar:
--   "HENVISNING-TEST OK: ..." (alt bestået) eller "HENVISNING-TEST FEJL: ...".
--
--   npx supabase db query --linked --project-ref pjiigmzqwlfepxnjdvug -f supabase/testscripts/20261102230000_henvis_en_ven_test.sql
--
-- Dækker: knyt (ok, findes, selv, ikke_ny, ukendt, ugyldig), belønning,
-- idempotens (dobbelt registrering, vurder og synk igen, én postering),
-- loft (10 pr. måned), firma, samme person, samme MitID efter sletning
-- (tidligere_konto), før lancering og RLS (kun egne, ingen skrivning).
do $test$
declare
  a uuid; a2 uuid; g uuid;
  v uuid[];
  b uuid; c uuid; d uuid; e uuid; f uuid; h uuid; j uuid; k uuid;
  ha text; hx text;
  kode_a text; kode_a2 text; kode_g text := 'FFFFFFFFFF';
  r jsonb;
  st text;
  saldo0 integer; saldo1 integer;
  fejl text[] := '{}';
  ok integer := 0;
  maaned text := to_char(now() at time zone 'Europe/Copenhagen', 'YYYY-MM');
  fyld uuid[];
  i integer;
  n integer;
begin
  -- Optjeningen er åben (testdatabasen er "lanceret").
  update public.henvisning_indstillinger set optjening_fra_kl = now() - interval '1 minute' where id;

  -- Henvisere: verificerede private konti (aktiv MitID) uden henvisninger.
  select u.id into a from public.users u
    join public.mitid_verificeringer m on m.bruger_id = u.id and m.status = 'aktiv'
   where u.konto_type = 'privat' and u.konto_slettet_kl is null and u.konto_lukket_kl is null
     and not coalesce(u.suspenderet, false)
     and not exists (select 1 from public.henvisninger x where x.ven_id = u.id or x.henviser_id = u.id)
   order by u.id limit 1;
  select u.id into a2 from public.users u
    join public.mitid_verificeringer m on m.bruger_id = u.id and m.status = 'aktiv'
   where u.konto_type = 'privat' and u.konto_slettet_kl is null and u.konto_lukket_kl is null
     and not coalesce(u.suspenderet, false) and u.id <> a
     and not exists (select 1 from public.henvisninger x where x.ven_id = u.id or x.henviser_id = u.id)
   order by u.id limit 1;
  select u.id into g from public.users u where u.konto_type = 'erhverv' order by u.id limit 1;
  select m.id_hash into ha from public.mitid_verificeringer m where m.bruger_id = a and m.status = 'aktiv';

  -- Venner: private konti uden MitID (gøres "nye").
  select array_agg(id order by id) into v from (
    select u.id from public.users u
     where u.konto_type = 'privat' and u.konto_slettet_kl is null and u.konto_lukket_kl is null
       and not coalesce(u.suspenderet, false) and u.mitid_verificeret_kl is null
       and u.id <> public.bidhamr_system_id()
       and not exists (select 1 from public.mitid_verificeringer m where m.bruger_id = u.id)
       and not exists (select 1 from public.henvisninger x where x.ven_id = u.id or x.henviser_id = u.id)
     order by u.id limit 8) s;
  if a is null or a2 is null or g is null or coalesce(array_length(v, 1), 0) < 8 then
    raise exception 'HENVISNING-TEST FEJL: for få testbrugere (a %, a2 %, g %, venner %)', a, a2, g, array_length(v, 1);
  end if;
  b := v[1]; c := v[2]; d := v[3]; e := v[4]; f := v[5]; h := v[6]; j := v[7]; k := v[8];
  update public.users set oprettet = now() where id = any (v);

  -- Henviserens kode (som brugeren selv via min_henvisning).
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  r := public.min_henvisning();
  kode_a := r ->> 'kode';
  if kode_a !~ '^[A-HJ-NP-Z2-9]{10}$' then fejl := fejl || ('kode_form ' || coalesce(kode_a, 'null')); else ok := ok + 1; end if;
  if (public.min_henvisning() ->> 'kode') <> kode_a then fejl := fejl || 'kode_stabil'::text; else ok := ok + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', a2, 'role', 'authenticated')::text, true);
  kode_a2 := public.min_henvisning() ->> 'kode';
  -- Firmaet får intet link.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  r := public.min_henvisning();
  if (r ->> 'kan_henvise')::boolean or r ? 'kode' then fejl := fejl || 'firma_link'::text; else ok := ok + 1; end if;
  -- Et firma med en kode (fx konto_type ændret bagefter): lægges direkte.
  insert into public.henvisning_koder (bruger_id, kode) values (g, kode_g) on conflict do nothing;
  select kode into kode_g from public.henvisning_koder where bruger_id = g;

  -- ---- knyt ----
  if public.henvisning_knyt(b, lower(kode_a)) ->> 'kode' <> 'ok' then fejl := fejl || 'knyt_ok'::text; else ok := ok + 1; end if;
  if public.henvisning_knyt(b, kode_a2) ->> 'kode' <> 'findes' then fejl := fejl || 'knyt_skift'::text; else ok := ok + 1; end if;
  if (select henviser_id from public.henvisninger where ven_id = b) <> a then fejl := fejl || 'knyt_skift_henviser'::text; else ok := ok + 1; end if;
  if public.henvisning_knyt(a, kode_a) ->> 'kode' <> 'selv' then fejl := fejl || 'knyt_selv'::text; else ok := ok + 1; end if;
  if public.henvisning_knyt(a2, kode_a) ->> 'kode' <> 'ikke_ny' then fejl := fejl || 'knyt_verificeret'::text; else ok := ok + 1; end if;
  update public.users set oprettet = now() - interval '30 days' where id = k;
  if public.henvisning_knyt(k, kode_a) ->> 'kode' <> 'ikke_ny' then fejl := fejl || 'knyt_gammel'::text; else ok := ok + 1; end if;
  update public.users set oprettet = now() where id = k;
  if public.henvisning_knyt(c, 'ABCDEFGHJK') ->> 'kode' <> 'ukendt' then fejl := fejl || 'knyt_ukendt'::text; else ok := ok + 1; end if;
  if public.henvisning_knyt(c, 'kort') ->> 'kode' <> 'ugyldig' then fejl := fejl || 'knyt_ugyldig'::text; else ok := ok + 1; end if;
  perform public.henvisning_knyt(x, kode_a) from unnest(array[c, d, e, h]) x;
  perform public.henvisning_knyt(f, kode_g);
  perform public.henvisning_knyt(x, kode_a2) from unnest(array[j, k]) x;

  -- ---- belønning + idempotens ----
  saldo0 := public.boost_saldo(a);
  r := public.mitid_registrer(b, encode(sha256(('hv-b-' || b)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  if r ->> 'kode' <> 'ok' then fejl := fejl || ('mitid_b ' || r::text); end if;
  select status into st from public.henvisninger where ven_id = b;
  if st <> 'belonnet' then fejl := fejl || ('belonnet ' || st); else ok := ok + 1; end if;
  saldo1 := public.boost_saldo(a);
  if saldo1 - saldo0 <> 10 then fejl := fejl || ('saldo ' || (saldo1 - saldo0)); else ok := ok + 1; end if;
  -- Igen: samme MitID (allerede), vurder og synk - ingen nye point.
  r := public.mitid_registrer(b, encode(sha256(('hv-b-' || b)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  if r ->> 'kode' <> 'allerede' then fejl := fejl || ('mitid_b_igen ' || r::text); end if;
  if public.henvisning_vurder(b, encode(sha256(('hv-b-' || b)::bytea), 'hex')) is not null then fejl := fejl || 'vurder_igen'::text; else ok := ok + 1; end if;
  perform public.henvisning_synk(100);
  if public.boost_saldo(a) <> saldo1 then fejl := fejl || 'idempotens_saldo'::text; else ok := ok + 1; end if;
  select count(*) into n from public.boost_posteringer p join public.henvisninger x on x.id = p.henvisning_id where x.ven_id = b;
  if n <> 1 then fejl := fejl || ('posteringer ' || n); else ok := ok + 1; end if;
  -- En vurderet henvisning kan ikke laves om.
  begin
    update public.henvisninger set status = 'afventer', point = 0, vurderet_kl = null where ven_id = b;
    fejl := fejl || 'laast_update'::text;
  exception when others then ok := ok + 1;
  end;
  begin
    delete from public.henvisninger where ven_id = b;
    fejl := fejl || 'laast_delete'::text;
  exception when others then ok := ok + 1;
  end;

  -- ---- samme MitID efter sletning (tidligere_konto) ----
  hx := encode(sha256(('hv-e-' || e)::bytea), 'hex');
  perform public.mitid_registrer(e, hx, 'Test Ven', date '1990-01-01');
  select status into st from public.henvisninger where ven_id = e;
  if st <> 'belonnet' then fejl := fejl || ('e_belonnet ' || st); else ok := ok + 1; end if;
  -- E's konto slettes (verificeringen markeres 'slettet', som ved kontosletning),
  -- og samme person opretter sig igen som D via samme henviser.
  update public.mitid_verificeringer set status = 'slettet', slettet_kl = now() where bruger_id = e;
  update public.users set mitid_verificeret_kl = null where id = e;
  saldo0 := public.boost_saldo(a);
  r := public.mitid_registrer(d, hx, 'Test Ven', date '1990-01-01');
  if r ->> 'kode' <> 'ok' then fejl := fejl || ('mitid_d ' || r::text); end if;
  select status into st from public.henvisninger where ven_id = d;
  if st <> 'tidligere_konto' then fejl := fejl || ('tidligere_konto ' || st); else ok := ok + 1; end if;
  if public.boost_saldo(a) <> saldo0 then fejl := fejl || 'tidligere_konto_point'::text; else ok := ok + 1; end if;

  -- ---- samme person (henviserens egen MitID) ----
  update public.mitid_verificeringer set status = 'nulstillet', nulstillet_kl = now() where bruger_id = a and status = 'aktiv';
  r := public.mitid_registrer(c, ha, 'Test Ven', date '1990-01-01');
  if r ->> 'kode' <> 'ok' then fejl := fejl || ('mitid_c ' || r::text); end if;
  select status into st from public.henvisninger where ven_id = c;
  if st <> 'samme_person' then fejl := fejl || ('samme_person ' || st); else ok := ok + 1; end if;

  -- ---- firma ----
  saldo0 := public.boost_saldo(g);
  perform public.mitid_registrer(f, encode(sha256(('hv-f-' || f)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  select status into st from public.henvisninger where ven_id = f;
  if st <> 'firma' then fejl := fejl || ('firma ' || coalesce(st, 'null')); else ok := ok + 1; end if;
  if public.boost_saldo(g) <> saldo0 then fejl := fejl || 'firma_point'::text; else ok := ok + 1; end if;

  -- ---- loft: 9 belønnede i forvejen -> J bliver nr. 10, K får 0 ----
  select array_agg(id) into fyld from (
    select u.id from public.users u
     where u.id not in (a, a2, g) and not (u.id = any (v)) and u.id <> public.bidhamr_system_id()
       and not exists (select 1 from public.henvisninger x where x.ven_id = u.id)
     order by u.id limit 9) s;
  if coalesce(array_length(fyld, 1), 0) < 9 then
    fejl := fejl || 'loft_fyld_brugere'::text;
  else
    for i in 1..9 loop
      insert into public.henvisninger (henviser_id, ven_id, kode, status, point, mitid_hash, vurderet_kl, maaned)
      values (a2, fyld[i], kode_a2, 'belonnet', 10, encode(sha256(('hv-fyld-' || i || fyld[i])::bytea), 'hex'), now(), maaned);
    end loop;
    perform public.mitid_registrer(j, encode(sha256(('hv-j-' || j)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
    select status into st from public.henvisninger where ven_id = j;
    if st <> 'belonnet' then fejl := fejl || ('loft_10 ' || st); else ok := ok + 1; end if;
    saldo0 := public.boost_saldo(a2);
    perform public.mitid_registrer(k, encode(sha256(('hv-k-' || k)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
    select status into st from public.henvisninger where ven_id = k;
    if st <> 'loft' then fejl := fejl || ('loft_11 ' || st); else ok := ok + 1; end if;
    if public.boost_saldo(a2) <> saldo0 then fejl := fejl || 'loft_point'::text; else ok := ok + 1; end if;
    perform set_config('request.jwt.claims', json_build_object('sub', a2, 'role', 'authenticated')::text, true);
    r := public.min_henvisning();
    if (r ->> 'belonnet_denne_maaned')::int <> 10 or (r ->> 'tilbage_denne_maaned')::int <> 0 then
      fejl := fejl || ('loft_status ' || r::text);
    else ok := ok + 1;
    end if;
  end if;

  -- ---- før lancering ----
  update public.henvisning_indstillinger set optjening_fra_kl = null where id;
  perform public.mitid_registrer(h, encode(sha256(('hv-h-' || h)::bytea), 'hex'), 'Test Ven', date '1990-01-01');
  select status into st from public.henvisninger where ven_id = h;
  if st <> 'foer_lancering' then fejl := fejl || ('foer_lancering ' || st); else ok := ok + 1; end if;
  if public.henvisning_start_optjening() is null then fejl := fejl || 'start_optjening'::text; else ok := ok + 1; end if;

  -- ---- min_henvisning for A ----
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  r := public.min_henvisning();
  if (r ->> 'antal_venner')::int <> 5 or (r ->> 'antal_belonnet')::int <> 2 or (r ->> 'point_i_alt')::int <> 20
     or jsonb_array_length(r -> 'venner') <> 5 or (r -> 'venner' -> 0) ? 'ven_id' then
    fejl := fejl || ('min_henvisning ' || r::text);
  else ok := ok + 1;
  end if;

  -- ---- RLS som brugeren ----
  execute 'set local role authenticated';
  begin
    select count(*) into n from public.henvisninger;
    if n <> 5 then fejl := fejl || ('rls_egne ' || n); else ok := ok + 1; end if;
  exception when others then fejl := fejl || ('rls_egne_fejl ' || sqlerrm);
  end;
  begin
    perform ven_id from public.henvisninger limit 1;
    fejl := fejl || 'rls_ven_id'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  begin
    perform mitid_hash from public.henvisninger limit 1;
    fejl := fejl || 'rls_mitid_hash'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  begin
    insert into public.henvisninger (henviser_id, ven_id, kode) values (a, k, kode_a);
    fejl := fejl || 'rls_insert_henvisning'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  begin
    insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, henvisning_id)
    values (a, 'henvisning', 10, 0, (select id from public.henvisninger limit 1));
    fejl := fejl || 'rls_insert_point'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  begin
    perform public.henvisning_knyt(k, kode_a);
    fejl := fejl || 'rls_knyt'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  begin
    perform public.henvisning_start_optjening();
    fejl := fejl || 'rls_start'::text;
  exception when insufficient_privilege then ok := ok + 1;
  end;
  begin
    select count(*) into n from public.henvisning_koder;
    if n <> 1 then fejl := fejl || ('rls_koder ' || n); else ok := ok + 1; end if;
  exception when others then fejl := fejl || ('rls_koder_fejl ' || sqlerrm);
  end;
  execute 'reset role';

  if array_length(fejl, 1) is null then
    raise exception 'HENVISNING-TEST OK: % tjek bestået (alt rulles tilbage)', ok;
  end if;
  raise exception 'HENVISNING-TEST FEJL: % bestået, fejl: %', ok, array_to_string(fejl, ' | ');
end $test$;
