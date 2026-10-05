-- KUN TESTDATABASEN "Bidhamr Test" (pjiigmzqwlfepxnjdvug). ALDRIG PRODUKTION.
-- Datatest af 20261007011000_brugerens_egne_ting_rettelser.sql (V2, M1, M2,
-- M3, M5). Kraever supabase/seed.sql og at 20261007010000 + 011000 er koert.
-- Alt rulles tilbage: blokken slutter med en BEVIDST exception. Forventet:
--   ERROR:  ALLE TESTS OK (bevidst exception - intet er gemt)
-- Enhver anden fejl = en test fejlede. NOTICE-linjer viser sprungne dele.

do $test$
declare
  A  constant uuid := '11111111-1111-4111-8111-000000000001';   -- saelger A (spaerrer)
  B  constant uuid := '11111111-1111-4111-8111-000000000002';   -- byder B (spaerret anonymt)
  X  constant uuid := '11111111-1111-4111-8111-000000000005';   -- tredjemand
  KILDE constant uuid := '22222222-2222-4222-8222-000000000004';
  AUK_A constant uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  AUK_B constant uuid := 'aaaaaaaa-0000-4000-8000-00000000000b';
  S_A constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000a';
  S_B constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  v_kode text;
  v_n    integer;
  v_m    integer;
  v_j    jsonb;
  v_j2   jsonb;
  r      record;
  v_fandt_a boolean := false;
  v_fandt_b boolean := false;
begin
  if exists (select 1 from public.users where email = 'test@t.com') then
    raise exception 'Ligner produktion - stop.';
  end if;

  perform set_config('request.jwt.claims', '', true);
  delete from public.brugerblokeringer where blokerer_id in (A, B, X) or blokeret_id in (A, B, X);
  delete from public.seller_follows where follower_id in (A, B, X) or seller_id in (A, B, X);
  update public.users set konto_lukket_kl = null where id in (A, B, X);

  -- A spaerrer B anonymt (byder-spaerring fra A's auktion).
  insert into public.brugerblokeringer (blokerer_id, blokeret_id, kilde_auktion_id)
  values (A, B, KILDE);

  -- To nye auktioner uden lat/lng i 4700 (M3: postnummer-fallback).
  insert into public.auctions
    (id, bruger_id, titel, beskrivelse, billeder, startpris, kategori, postnummer,
     lokation, forsendelse_mulig, stand, slutter_kl)
  values
    (AUK_A, A, 'Testvare V2 zqx fra A', 'Test', '{}', 100, 'Sport', '4700', 'Næstved', false, 'god', now() + interval '3 days'),
    (AUK_B, B, 'Testvare V2 zqx fra B', 'Test', '{}', 100, 'Sport', '4700', 'Næstved', false, 'god', now() + interval '3 days');
  update public.auctions set oprettet = now() - interval '10 minutes', lat = null, lng = null
   where id in (AUK_A, AUK_B);

  -- Gemte soegninger med afstand (10 km fra Naestved).
  insert into public.gemte_soegninger (id, bruger_id, navn, soegeord, postnummer, radius_km, lat, lng)
  values (S_A, A, 'Test A', 'Testvare V2 zqx', '4700', 10, 55.2237, 11.7629),
         (S_B, B, 'Test B', 'Testvare V2 zqx', '4700', 10, 55.2237, 11.7629);
  update public.gemte_soegninger set tjekket_fra_kl = now() - interval '1 hour'
   where id in (S_A, S_B);

  -- ------------------------------------------------------------ V2 + M3
  for r in select * from public.gemte_soegninger_find_nye(2000) loop
    if r.soegning_id = S_A then
      v_fandt_a := true;
      if r.antal <> 1 or r.foerste_id <> AUK_B then
        raise exception 'V2/M3 FEJL: A fik % match (forste %), forventet 1 (B''s auktion)', r.antal, r.foerste_id;
      end if;
    elsif r.soegning_id = S_B then
      v_fandt_b := true;
    end if;
  end loop;
  if not v_fandt_a then
    raise exception 'V2/M3 FEJL: A (som selv har spaerret B anonymt) fik ingen besked om B''s auktion';
  end if;
  if v_fandt_b then
    raise exception 'V2 FEJL: B (spaerret af A) fik besked om A''s auktion';
  end if;

  -- ------------------------------------------------------------ V2 spoerg saelger
  perform set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  v_kode := public.stil_spoergsmaal(AUK_B, 'Er den stadig til salg?') ->> 'kode';
  if v_kode is distinct from 'ok' then
    raise exception 'V2 FEJL: A kunne ikke spoerge paa B''s auktion (kode %)', v_kode;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', B, 'role', 'authenticated')::text, true);
  v_kode := public.stil_spoergsmaal(AUK_A, 'Er den stadig til salg?') ->> 'kode';
  if v_kode is distinct from 'blokeret' then
    raise exception 'V2 FEJL: B kunne spoerge paa A''s auktion (kode %, forventet blokeret)', v_kode;
  end if;

  -- ------------------------------------------------------------ V2 foelg
  perform set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  v_kode := public.foelg_saelger(B) ->> 'kode';
  if v_kode is distinct from 'ok' then
    raise exception 'V2 FEJL: A kunne ikke foelge B (kode %)', v_kode;
  end if;

  -- ------------------------------------------------------------ M5
  perform set_config('request.jwt.claims', '', true);
  insert into public.seller_follows (follower_id, seller_id) values (X, A)
  on conflict do nothing;
  v_n := public.antal_foelgere(A);
  update public.users set konto_lukket_kl = now() where id = X;
  v_m := public.antal_foelgere(A);
  if v_m <> v_n - 1 then
    raise exception 'M5 FEJL: antal_foelgere taeller lukket konto (% -> %)', v_n, v_m;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  v_kode := public.foelg_saelger(X) ->> 'kode';
  if v_kode is distinct from 'ikke_fundet' then
    raise exception 'M5 FEJL: foelg af lukket konto gav %', v_kode;
  end if;
  perform set_config('request.jwt.claims', '', true);
  begin
    insert into public.seller_follows (follower_id, seller_id) values (B, X);
    raise exception 'M5 FEJL: direkte insert af foelgning af lukket konto blev godtaget';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ikke_fundet' then
      raise;
    end if;
  end;
  update public.users set konto_lukket_kl = null where id = X;

  -- ------------------------------------------------------------ M2
  perform set_config('request.jwt.claims', json_build_object('sub', B, 'role', 'authenticated')::text, true);
  v_n := (public.min_statistik() ->> 'bud_paa')::integer;
  select count(*) into v_m from public.mine_bud_auktioner(200);
  if v_n <> v_m then
    raise exception 'M2 FEJL: bud_paa=% men listen har % (foer skjul)', v_n, v_m;
  end if;
  perform set_config('request.jwt.claims', '', true);
  update public.auctions set skjult = true
   where id = (select bi.auktion_id from public.bids bi where bi.bruger_id = B limit 1);
  if found then
    perform set_config('request.jwt.claims', json_build_object('sub', B, 'role', 'authenticated')::text, true);
    if (public.min_statistik() ->> 'bud_paa')::integer <> v_n - 1 then
      raise exception 'M2 FEJL: skjult auktion taelles stadig med i bud_paa';
    end if;
  else
    raise notice 'M2: B har ingen bud - skjul-delen sprunget over';
  end if;

  -- ------------------------------------------------------------ M1
  perform set_config('request.jwt.claims', '', true);
  select b.id, b.seller_id, b.udbetaling_oere into r
    from public.betalinger b
   where b.status in ('betalt', 'frigivet') and b.betalt_kl is not null
     and b.overfoert_kl is null and b.refunderet_kl is null and b.annulleret_kl is null
     and b.refusion_anmodet_kl is null and b.afsendelsesfrist_annulleret_kl is null
     and b.afhentningsfrist_annulleret_kl is null and b.udbetaling_oere > 0
   limit 1;
  if found then
    perform set_config('request.jwt.claims', json_build_object('sub', r.seller_id, 'role', 'authenticated')::text, true);
    v_j := public.min_statistik();
    perform set_config('request.jwt.claims', '', true);
    update public.betalinger set refusion_anmodet_kl = now() where id = r.id;
    perform set_config('request.jwt.claims', json_build_object('sub', r.seller_id, 'role', 'authenticated')::text, true);
    v_j2 := public.min_statistik();
    if (v_j2 #>> '{indtjening_oere,paa_vej}')::bigint
         <> (v_j #>> '{indtjening_oere,paa_vej}')::bigint - r.udbetaling_oere then
      raise exception 'M1 FEJL: paa_vej % -> % (forventet minus %)',
        v_j #>> '{indtjening_oere,paa_vej}', v_j2 #>> '{indtjening_oere,paa_vej}', r.udbetaling_oere;
    end if;
    if (v_j2 #>> '{auktioner,solgte}')::integer > (v_j #>> '{auktioner,solgte}')::integer then
      raise exception 'M1 FEJL: solgte steg';
    end if;
  else
    raise notice 'M1: ingen betalt, ikke-overfoert betaling i testdata - sprunget over';
  end if;

  perform set_config('request.jwt.claims', '', true);
  raise exception 'ALLE TESTS OK (bevidst exception - intet er gemt)';
end
$test$;
