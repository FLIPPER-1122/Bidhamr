-- =========================================================
-- TESTDATA – KUN TIL TESTDATABASEN "Bidhamr Test"
-- (projekt-ref pjiigmzqwlfepxnjdvug). KØR ALDRIG MOD PRODUKTION
-- (lkifkrexeldimmghnsie).
-- =========================================================
--
-- Kan køres igen: alt har faste id'er og "on conflict do nothing".
--
-- Testbrugere (e-mail er bekræftet, log ind med adgangskoden):
--
--   rolle        e-mail                        adgangskode
--   sælger       saelger@test.bidhamr.dk       _4mghVLVUr716cMt
--   køber        koeber@test.bidhamr.dk        6iPgNlFfXauDMDAp
--   admin        admin@test.bidhamr.dk         XfmzQkQfDevL71WJ
--   chef         chef@test.bidhamr.dk          0hz1020kbKcMf1BE
--   tester-agent tester@test.bidhamr.dk        WZYWlaZcZ558016I
--
-- Adgangskoderne gælder kun testdatabasen. De må ikke genbruges andre steder.
--
-- NB om gaten før lancering: middleware lukker alle andre end staff
-- (medarbejder/admin/chef) ude. Sælger og køber er almindelige brugere og
-- lander derfor på /coming-soon, indtil gaten åbnes. Tester-agenten er
-- 'medarbejder', så den kan komme ind og bruge siden.
-- =========================================================

do $$
declare
  instans constant uuid := '00000000-0000-0000-0000-000000000000';
  brugere constant jsonb := '[
    {"id":"11111111-1111-4111-8111-000000000001","email":"saelger@test.bidhamr.dk","pw":"_4mghVLVUr716cMt","navn":"Sofie Sælger"},
    {"id":"11111111-1111-4111-8111-000000000002","email":"koeber@test.bidhamr.dk","pw":"6iPgNlFfXauDMDAp","navn":"Kasper Køber"},
    {"id":"11111111-1111-4111-8111-000000000003","email":"admin@test.bidhamr.dk","pw":"XfmzQkQfDevL71WJ","navn":"Anna Admin"},
    {"id":"11111111-1111-4111-8111-000000000004","email":"chef@test.bidhamr.dk","pw":"0hz1020kbKcMf1BE","navn":"Christian Chef"},
    {"id":"11111111-1111-4111-8111-000000000005","email":"tester@test.bidhamr.dk","pw":"WZYWlaZcZ558016I","navn":"Tester Agent"}
  ]';
  b jsonb;
begin
  -- Sikkerhedsnet: nægt at køre, hvis databasen ligner produktion.
  if exists (select 1 from public.users where email = 'test@t.com')
     or (select count(*) from public.users) > 50 then
    raise exception 'seed.sql: databasen ligner produktion – afbryder.';
  end if;

  for b in select * from jsonb_array_elements(brugere) loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      instans, (b->>'id')::uuid, 'authenticated', 'authenticated', b->>'email',
      extensions.crypt(b->>'pw', extensions.gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('navn', b->>'navn'),
      now(), now(), '', '', '', ''
    ) on conflict (id) do nothing;

    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      (b->>'id')::uuid, b->>'id', (b->>'id')::uuid,
      jsonb_build_object('sub', b->>'id', 'email', b->>'email', 'email_verified', true),
      'email', now(), now(), now()
    ) on conflict do nothing;
  end loop;
end $$;

-- public.users-rækkerne oprettes af on_auth_user_created. Roller:
update public.users set rolle = 'admin'       where id = '11111111-1111-4111-8111-000000000003';
update public.users set rolle = 'chef'        where id = '11111111-1111-4111-8111-000000000004';
update public.users set rolle = 'medarbejder' where id = '11111111-1111-4111-8111-000000000005';

-- ---------------------------------------------------------
-- Auktioner (sælger)
-- ---------------------------------------------------------
insert into public.auctions
  (id, bruger_id, titel, beskrivelse, billeder, startpris, kategori, postnummer,
   lokation, forsendelse_mulig, stand, slutter_kl)
values
  ('22222222-2222-4222-8222-000000000001', '11111111-1111-4111-8111-000000000001',
   'Cykel, Kildemoes 7 gear', 'Velholdt damecykel, nye dæk i foråret.', '{}',
   500, 'Sport', '4700', 'Næstved', false, 'Brugt', now() + interval '3 days'),
  ('22222222-2222-4222-8222-000000000002', '11111111-1111-4111-8111-000000000001',
   'Sofabord i eg', 'Massivt egetræ, 120 x 60 cm. Lidt ridser.', '{}',
   0, 'Møbler', '4700', 'Næstved', false, 'Brugt', now() + interval '5 days'),
  ('22222222-2222-4222-8222-000000000003', '11111111-1111-4111-8111-000000000001',
   'iPhone 13, 128 GB', 'Virker perfekt, batteri 88 %. Oplader medfølger.', '{}',
   1500, 'Elektronik', '4700', 'Næstved', true, 'Som ny', now() + interval '1 day'),
  -- Afsluttet auktion med vinder (grundlag for handlen nedenfor)
  ('22222222-2222-4222-8222-000000000004', '11111111-1111-4111-8111-000000000001',
   'LEGO Technic 42115', 'Komplet sæt med æske og vejledning.', '{}',
   800, 'Legetøj', '4700', 'Næstved', true, 'Som ny', now() + interval '1 hour')
on conflict (id) do nothing;

-- Bud fra køber på den aktive cykel (≥ 10 % over startpris)
insert into public.bids (id, auktion_id, bruger_id, beløb)
values ('33333333-3333-4333-8333-000000000001',
        '22222222-2222-4222-8222-000000000001',
        '11111111-1111-4111-8111-000000000002', 550)
on conflict (id) do nothing;

-- Bud på LEGO, derefter lukkes auktionen og køber er vinder
insert into public.bids (id, auktion_id, bruger_id, beløb)
values ('33333333-3333-4333-8333-000000000002',
        '22222222-2222-4222-8222-000000000004',
        '11111111-1111-4111-8111-000000000002', 900)
on conflict (id) do nothing;

update public.auctions
   set status = 'afsluttet',
       slutter_kl = now() - interval '1 hour',
       vinder_id = '11111111-1111-4111-8111-000000000002'
 where id = '22222222-2222-4222-8222-000000000004'
   and status = 'aktiv';

-- ---------------------------------------------------------
-- Handel: sælger skal sende pakken
-- ---------------------------------------------------------
insert into public.trades (id, auction_id, seller_id, buyer_id, amount, status)
values ('44444444-4444-4444-8444-000000000001',
        '22222222-2222-4222-8222-000000000004',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-000000000002',
        900, 'betaling_modtaget')
on conflict (id) do nothing;

insert into public.messages (id, trade_id, sender_id, content)
values ('55555555-5555-4555-8555-000000000001',
        '44444444-4444-4444-8444-000000000001',
        '11111111-1111-4111-8111-000000000002',
        'Hej! Glæder mig til sættet. Hvornår sender du?')
on conflict (id) do nothing;
