-- KUN TESTDATABASEN "Bidhamr Test" (pjiigmzqwlfepxnjdvug). ALDRIG PRODUKTION.
-- Datatest af 20261006031000_spamfilter_rettelser.sql (M1, M2, L6, L7).
-- Kraever supabase/seed.sql (handel 44444444-...-000000000001 mellem
-- saelger ...0001 og koeber ...0002). Alt rulles tilbage: blokken slutter
-- med en BEVIDST exception. Forventet resultat:
--   ERROR:  ALLE TESTS OK (bevidst exception - intet er gemt)
-- Enhver anden fejl = en test fejlede.
-- (Rene funktionstests af spamfilteret ligger i selve migrationen.)

do $test$
declare
  S constant uuid := '11111111-1111-4111-8111-000000000001';   -- saelger
  K constant uuid := '11111111-1111-4111-8111-000000000002';   -- koeber
  X constant uuid := '11111111-1111-4111-8111-000000000005';   -- tester (fremmed)
  T constant uuid := '44444444-4444-4444-8444-000000000001';
  v_grund text;
  v_kode  text;
  i int;
begin
  if exists (select 1 from public.users where email = 'test@t.com') then
    raise exception 'Ligner produktion - stop.';
  end if;

  -- Handlen er afsluttet (uden sag), saa blokeringer gaelder i chatten.
  update public.trades set status = 'afsluttet', sag_aaben = false where id = T;
  delete from public.brugerblokeringer where blokerer_id in (S, K, X) or blokeret_id in (S, K, X);

  -- ---------------------------------------------------------------- M1
  insert into public.brugerblokeringer (blokerer_id, blokeret_id, kilde_auktion_id)
  select S, K, auction_id from public.trades where id = T;

  perform set_config('request.jwt.claims', json_build_object('sub', K, 'role', 'authenticated')::text, true);
  begin
    insert into public.messages (trade_id, sender_id, content) values (T, K, 'Tak for handlen, alt fint')
      returning blokeret_grund into v_grund;
  exception when others then
    raise exception 'M1 FEJL: anonym spaerring stoppede chatten (%)', sqlstate;
  end;

  perform set_config('request.jwt.claims', '', true);
  insert into public.brugerblokeringer (blokerer_id, blokeret_id) values (S, K);
  perform set_config('request.jwt.claims', json_build_object('sub', K, 'role', 'authenticated')::text, true);
  v_kode := null;
  begin
    insert into public.messages (trade_id, sender_id, content) values (T, K, 'Hallo, er du der?');
  exception when others then
    v_kode := sqlstate;
  end;
  if v_kode is distinct from 'BHB01' then
    raise exception 'M1 FEJL: navngiven blokering gav % (forventet BHB01)', coalesce(v_kode, 'ingen fejl');
  end if;

  -- ---------------------------------------------------------------- M2
  -- Fremmed (ikke part) og blokeret: triggeren maa hverken give BHB01
  -- eller BHM03 - RLS afviser (42501), eller hvis blokken koeres som
  -- postgres (RLS omgaas), indsaettes raekken bare.
  perform set_config('request.jwt.claims', '', true);
  insert into public.brugerblokeringer (blokerer_id, blokeret_id) values (S, X);
  perform set_config('request.jwt.claims', json_build_object('sub', X, 'role', 'authenticated')::text, true);
  for i in 1..12 loop
    v_kode := null;
    begin
      insert into public.messages (trade_id, sender_id, content) values (T, X, 'Fremmed besked ' || i);
    exception when others then
      v_kode := sqlstate;
    end;
    if v_kode in ('BHB01', 'BHM03') then
      raise exception 'M2 FEJL: fremmed fik % (afsloerer blokering/hastighed)', v_kode;
    end if;
  end loop;

  -- ---------------------------------------------------------------- L6
  perform set_config('request.jwt.claims', '', true);
  delete from public.brugerblokeringer where blokerer_id in (S, K, X) or blokeret_id in (S, K, X);
  update public.trades set status = 'betaling_modtaget' where id = T;
  perform set_config('request.jwt.claims', json_build_object('sub', K, 'role', 'authenticated')::text, true);
  insert into public.messages (trade_id, sender_id, content) values (T, K, 'Er varen stadig til salg L6?');
  insert into public.messages (trade_id, sender_id, content) values (T, K, 'Er varen stadig til salg L6?')
    returning blokeret_grund into v_grund;
  if v_grund is not null then
    raise exception 'L6 FEJL: 2. ens besked blev stoppet (%)', v_grund;
  end if;
  insert into public.messages (trade_id, sender_id, content) values (T, K, 'Er varen stadig til salg L6?')
    returning blokeret_grund into v_grund;
  if v_grund is distinct from 'gentaget' then
    raise exception 'L6 FEJL: 3. ens besked i samme handel gav %', coalesce(v_grund, 'null');
  end if;

  -- Spamfilteret via triggeren.
  insert into public.messages (trade_id, sender_id, content) values (T, K, 'Postnr 8000 8200')
    returning blokeret_grund into v_grund;
  if v_grund is not null then raise exception 'Telefon FEJL: falsk positiv (%)', v_grund; end if;
  insert into public.messages (trade_id, sender_id, content) values (T, K, 'ring på 22 34 56 78')
    returning blokeret_grund into v_grund;
  if v_grund is distinct from 'telefon' then raise exception 'Telefon FEJL: gav %', coalesce(v_grund, 'null'); end if;

  -- ---------------------------------------------------------------- L7
  perform set_config('request.jwt.claims', '', true);
  if public.handel_i_gang(T) is not true then
    raise exception 'L7 FEJL: betaling_modtaget skal vaere i gang';
  end if;

  raise exception 'ALLE TESTS OK (bevidst exception - intet er gemt)';
end;
$test$;
