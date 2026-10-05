-- Fase 4C: rettelser efter review af kontosikkerhed/GDPR (20261007030000).
--
-- Indhold:
--   1. Bud: brugeren laeses med FOR SHARE (kaploeb med kontosletning), og
--      slettede konti afvises (handle_new_bid - ellers uaendret).
--   2. public.users kan ikke haardt slettes (bevarer handelsdata,
--      bogfoeringsloven/DAC7) - ogsaa ikke via cascade fra auth.users
--      (dashboardets "Delete user"). Undtagelse til oprydning af testdata:
--        set local bidhamr.tillad_brugersletning = 'ja';
--   3. Slettet konto med et stadig gyldigt access token (op til 1 time) kan
--      ikke oprette favoritter, foelgere, gemte soegninger, push-tokens eller
--      gemte auktioner.
--   4. konto_slet: rydder ogsaa notifikation_afsendelser.
--   5. mine_data: fornavne kun for modparter; skjulte bedoemmelser markeres.
--
-- Koeres EFTER 20261007030000. Idempotent. search_path = ''. Roerer ingen
-- CHECK-lister.

-- ============================================================ 1. Bud

create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_auktion record;
  v_bruger record;
  v_minimum numeric;
begin
  -- FOR SHARE: konto_slet laaser brugeren FOR UPDATE. Enten venter buddet,
  -- til sletningen er faerdig (og afvises herunder), eller sletningen venter
  -- paa buddet (og ser det i konto_sletning_blokeringer).
  select suspenderet, suspenderet_til, konto_slettet_kl into v_bruger
    from public.users where id = new.bruger_id
     for share;

  if v_bruger is null then
    raise exception 'Brugeren findes ikke';
  end if;

  if v_bruger.konto_slettet_kl is not null then
    raise exception 'Kontoen er slettet.' using errcode = '42501';
  end if;

  if v_bruger.suspenderet
     and (v_bruger.suspenderet_til is null or v_bruger.suspenderet_til > now()) then
    raise exception 'Din konto er suspenderet, og du kan ikke byde.'
      using errcode = '42501';
  end if;

  select * into v_auktion from public.auctions where id = new.auktion_id for update;

  if v_auktion is null then
    raise exception 'Auktionen findes ikke';
  end if;

  if v_auktion.skjult then
    raise exception 'Auktionen er ikke tilgængelig';
  end if;

  if v_auktion.status <> 'aktiv' then
    raise exception 'Auktionen er ikke aktiv længere';
  end if;

  if v_auktion.slutter_kl <= now() then
    raise exception 'Auktionen er allerede slut';
  end if;

  -- Saelgeren har blokeret/spaerret byderen.
  if public.er_blokeret(v_auktion.bruger_id, new.bruger_id) then
    raise exception 'Sælgeren har spærret dig fra at byde på sine auktioner.'
      using errcode = '42501';
  end if;

  if new.auktion_redigeret_kl is not null
     and date_trunc('milliseconds', new.auktion_redigeret_kl)
         is distinct from v_auktion.redigeret_kl then
    raise exception 'Sælgeren har lige ændret auktionen. Se den igen, før du byder.';
  end if;

  -- Mindst 1 kr - ogsaa paa gamle auktioner med startpris 0.
  if new."beløb" is null or new."beløb" < 1 then
    raise exception 'minimum_bid: Dit bud skal være mindst 1 kr.';
  end if;

  v_minimum := public.naeste_bud_minimum(v_auktion."nuværende_bud", v_auktion.startpris);
  if new."beløb" < v_minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr.', trim_scale(v_minimum);
  end if;

  update public.auctions
  set
    "nuværende_bud" = new."beløb",
    slutter_kl = case
      when slutter_kl - now() < interval '2 minutes'
        then now() + interval '2 minutes'
      else slutter_kl
    end
  where id = new.auktion_id;

  return new;
end;
$fn$;

-- ============================================================ 2. Ingen haard sletning af brugere

create or replace function public.users_ingen_haard_sletning()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if coalesce(current_setting('bidhamr.tillad_brugersletning', true), '') = 'ja' then
    return case when tg_level = 'ROW' then old else null end;
  end if;
  raise exception 'Brugere kan ikke slettes – brug kontosletning (anonymisering)'
    using errcode = '42501',
          hint = 'Kun til oprydning af testdata: set local bidhamr.tillad_brugersletning = ''ja'';';
end;
$fn$;

revoke all on function public.users_ingen_haard_sletning() from public, anon, authenticated;

drop trigger if exists users_ingen_haard_sletning on public.users;
create trigger users_ingen_haard_sletning
  before delete on public.users
  for each row execute function public.users_ingen_haard_sletning();

-- TRUNCATE affyrer ikke raekke-triggere.
drop trigger if exists users_ingen_truncate on public.users;
create trigger users_ingen_truncate
  before truncate on public.users
  for each statement execute function public.users_ingen_haard_sletning();

comment on function public.users_ingen_haard_sletning() is
  'Afviser DELETE/TRUNCATE paa public.users (handelsdata bevares). Undtagelse '
  'til testdata: set local bidhamr.tillad_brugersletning = ''ja''.';

-- ============================================================ 3. Slettet konto opretter intet nyt

-- Faelles trigger: argumenterne er de kolonner, der indeholder bruger-id'er.
-- Er en af brugerne slettet (konto_slettet_kl), afvises raekken.
create or replace function public.afvis_slettet_konto()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_raekke jsonb := to_jsonb(new);
  v_id     uuid;
  i        integer;
begin
  for i in 0 .. tg_nargs - 1 loop
    v_id := nullif(v_raekke->>tg_argv[i], '')::uuid;
    if v_id is not null and exists (
         select 1 from public.users u
          where u.id = v_id and u.konto_slettet_kl is not null) then
      raise exception 'Kontoen er slettet.' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$fn$;

revoke all on function public.afvis_slettet_konto() from public, anon, authenticated;

drop trigger if exists afvis_slettet_konto on public.favorites;
create trigger afvis_slettet_konto
  before insert or update on public.favorites
  for each row execute function public.afvis_slettet_konto('user_id');

drop trigger if exists afvis_slettet_konto on public.saved_auctions;
create trigger afvis_slettet_konto
  before insert or update on public.saved_auctions
  for each row execute function public.afvis_slettet_konto('user_id');

drop trigger if exists afvis_slettet_konto on public.push_tokens;
create trigger afvis_slettet_konto
  before insert or update on public.push_tokens
  for each row execute function public.afvis_slettet_konto('user_id');

drop trigger if exists afvis_slettet_konto on public.gemte_soegninger;
create trigger afvis_slettet_konto
  before insert or update on public.gemte_soegninger
  for each row execute function public.afvis_slettet_konto('bruger_id');

-- Hverken foelgeren eller saelgeren maa vaere slettet.
drop trigger if exists afvis_slettet_konto on public.seller_follows;
create trigger afvis_slettet_konto
  before insert or update on public.seller_follows
  for each row execute function public.afvis_slettet_konto('follower_id', 'seller_id');

-- ============================================================ 4. konto_slet

create or replace function public.konto_slet(p_bruger uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_pladsholder text;
  v_bl          jsonb;
  v_auktioner   integer;
  u             record;
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;

  select * into u from public.users where id = p_bruger for update;
  if not found then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if u.konto_slettet_kl is not null then
    return jsonb_build_object('kode', 'allerede_slettet');
  end if;

  -- Laas egne aktive auktioner, saa et bud ikke kan smutte ind imellem
  -- tjekket og arkiveringen.
  perform 1 from public.auctions where bruger_id = p_bruger and status = 'aktiv' for update;

  v_bl := public.konto_sletning_blokeringer(p_bruger);
  if jsonb_array_length(v_bl) > 0 then
    return jsonb_build_object('kode', 'blokeret', 'blokeringer', v_bl);
  end if;

  v_pladsholder := 'slettet+' || p_bruger::text || '@slettet.invalid';

  -- 1. Aktive auktioner uden bud afsluttes og arkiveres (slettes ikke).
  update public.auctions
     set status = 'annulleret', arkiveret_kl = now()
   where bruger_id = p_bruger and status = 'aktiv';
  get diagnostics v_auktioner = row_count;

  -- 2. Rent personlige data uden handelsvaerdi.
  delete from public.favorites                  where user_id = p_bruger;
  delete from public.saved_auctions             where user_id = p_bruger;
  delete from public.seller_follows             where follower_id = p_bruger or seller_id = p_bruger;
  delete from public.push_tokens                where user_id = p_bruger;
  delete from public.notifikationer             where bruger_id = p_bruger;
  delete from public.notifikation_indstillinger where bruger_id = p_bruger;
  delete from public.brugerblokeringer          where blokerer_id = p_bruger or blokeret_id = p_bruger;
  delete from public.auction_templates          where user_id = p_bruger;
  delete from public.kendte_enheder             where bruger_id = p_bruger;
  -- Gemte soegninger (fase 4A). Saelgers svar paa bedoemmelser (fase 4B)
  -- bevares og vises som fra "Slettet bruger" via users.navn.
  delete from public.gemte_soegninger           where bruger_id = p_bruger;

  -- 3. Gemt kort og automatisk betaling. Stripe-kunde- og kontoreferencerne
  --    bevares, da de hoerer til handelsdata (betalinger, udbetalinger, DAC7).
  update public.betalingsprofiler
     set gemt_betalingsmetode_id = null,
         gemt_kort_maerke = null,
         gemt_kort_sidste4 = null,
         gemt_kort_udloeb = null,
         autobetaling = false,
         opdateret = now()
   where user_id = p_bruger;

  -- 4. E-mail i kontakthenvendelser (henvendelsen selv slettes aldrig).
  update public.kontakt_henvendelser set email = v_pladsholder where bruger_id = p_bruger;

  -- 5. Driftlog: ingen kobling til brugeren.
  update public.drift_fejl set bruger_id = null where bruger_id = p_bruger;

  -- 5b. Afsendelseslog for notifikationer: koblingen til brugeren og evt.
  --     fejltekster (kan indeholde e-mailadressen) fjernes. Noeglen bevares,
  --     saa intet sendes to gange.
  update public.notifikation_afsendelser
     set bruger_id = null, kanaler = null, fejl = null
   where bruger_id = p_bruger;

  -- employee_complaints (klager over BidHamrs medarbejdere) BEVARES: de er
  -- dokumentation for, hvordan staff har behandlet brugere, og raekken peger
  -- kun paa den anonymiserede profil ("Slettet bruger"). Staff kan ikke selv
  -- slette deres konto (blokering 'staff').

  -- 6. Profilen anonymiseres. Spaerret, saa intet nyt kan oprettes i navnet.
  update public.users
     set navn = 'Slettet bruger',
         fornavn = null,
         efternavn = null,
         email = v_pladsholder,
         telefon = null,
         adresse = null,
         avatar_url = null,
         suspenderet = true,
         suspenderet_aarsag = coalesce(suspenderet_aarsag, 'Kontoen er slettet'),
         suspenderet_kl = coalesce(suspenderet_kl, now()),
         suspenderet_til = null,
         konto_slettet_kl = now()
   where id = p_bruger;

  -- 7. Log uden persondata.
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (public.bidhamr_system_id(), 'konto_slettet', 'bruger', p_bruger, p_bruger,
          format('Brugeren slettede selv sin konto. %s aktive auktion(er) uden bud blev arkiveret.',
                 v_auktioner));

  return jsonb_build_object('kode', 'ok', 'auktioner_arkiveret', v_auktioner);
end;
$fn$;

revoke all on function public.konto_slet(uuid) from public, anon, authenticated;
grant execute on function public.konto_slet(uuid) to service_role;

-- ============================================================ 5. mine_data

create or replace function public.mine_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v     jsonb;
begin
  if v_uid is null then
    raise exception 'Ikke logget ind' using errcode = '42501';
  end if;
  if not public.rate_limit_tjek('mine_data:' || v_uid::text, 1, 3600) then
    raise exception 'Du kan hente dine data én gang i timen.' using errcode = 'BHR01';
  end if;

  with
  mine_handler as (
    select t.* from public.trades t where t.buyer_id = v_uid or t.seller_id = v_uid
  ),
  -- Kun de brugere, der optraeder i udtraekket (modparter), slaas op.
  modparter as (
    select case when t.buyer_id = v_uid then t.seller_id else t.buyer_id end as id from mine_handler t
    union
    select m.sender_id from public.messages m join mine_handler t on t.id = m.trade_id
    union
    select r.til_bruger_id from public.ratings r where r.fra_bruger_id = v_uid
    union
    select r.fra_bruger_id from public.ratings r where r.til_bruger_id = v_uid
    union
    select x.seller_id from public.seller_follows x where x.follower_id = v_uid
    union
    select x.blokeret_id from public.brugerblokeringer x where x.blokerer_id = v_uid
  ),
  fornavn as (
    select u.id,
           case when u.konto_slettet_kl is not null then 'Slettet bruger'
                else coalesce(nullif(btrim(u.fornavn), ''), nullif(split_part(btrim(u.navn), ' ', 1), ''), 'Bruger')
           end as navn
      from public.users u
     where u.id in (select p.id from modparter p where p.id is not null and p.id <> v_uid)
  )
  select jsonb_build_object(
    'om_udtraekket', jsonb_build_object(
      'dannet_kl', now(),
      'forklaring', 'Dette er de oplysninger, BidHamr har om dig. Andre brugere står kun med fornavn. Interne noter fra BidHamrs medarbejdere er ikke med. Bedømmelser, som BidHamr har skjult, er med og markeret "skjult af BidHamr".'),

    'profil', (select jsonb_build_object(
        'id', u.id, 'navn', u.navn, 'fornavn', u.fornavn, 'efternavn', u.efternavn,
        'email', u.email, 'telefon', u.telefon, 'adresse', u.adresse,
        'profilbillede', u.avatar_url, 'oprettet', u.oprettet, 'bedoemmelse', u.rating,
        'suspenderet', u.suspenderet, 'suspenderet_til', u.suspenderet_til)
      from public.users u where u.id = v_uid),

    'betalingsindstillinger', (select jsonb_build_object(
        'gemt_kort', case when p.gemt_kort_sidste4 is null then null else jsonb_build_object(
          'maerke', p.gemt_kort_maerke, 'sidste_4', p.gemt_kort_sidste4, 'udloeb', p.gemt_kort_udloeb) end,
        'automatisk_betaling', p.autobetaling,
        'udbetalingskonto_oprettet', p.stripe_account_id is not null,
        'udbetalinger_aktive', p.connect_udbetalinger_aktiv)
      from public.betalingsprofiler p where p.user_id = v_uid),

    'auktioner', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'titel', a.titel, 'beskrivelse', a.beskrivelse, 'kategori', a.kategori,
        'maerke', a.maerke, 'stand', a.stand, 'startpris', a.startpris,
        'nuvaerende_bud', a."nuværende_bud", 'antal_bud', a.antal_bud, 'status', a.status,
        'oprettet', a.oprettet, 'slutter_kl', a.slutter_kl, 'lokation', a.lokation,
        'postnummer', a.postnummer, 'forsendelse_mulig', a.forsendelse_mulig,
        'billeder', a.billeder) order by a.oprettet)
      from public.auctions a where a.bruger_id = v_uid), '[]'::jsonb),

    'bud', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', b.auktion_id, 'auktion', a.titel, 'beloeb', b."beløb",
        'bidhamr_beskyttelse', b.beskyttelse, 'tidspunkt', b.oprettet) order by b.oprettet)
      from public.bids b left join public.auctions a on a.id = b.auktion_id
     where b.bruger_id = v_uid), '[]'::jsonb),

    'handler', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'auktion_id', t.auction_id, 'vare', a.titel,
        'din_rolle', case when t.buyer_id = v_uid then 'køber' else 'sælger' end,
        'modpart_fornavn', (select f.navn from fornavn f
                             where f.id = case when t.buyer_id = v_uid then t.seller_id else t.buyer_id end),
        'beloeb', t.amount, 'status', t.status, 'oprettet', t.created_at,
        'sendt_kl', t.sendt_kl, 'modtaget_kl', t.received_at, 'afhentning', t.afhentning,
        'sporingsnummer', t.tracking_number,
        'betaling', (select case when t.buyer_id = v_uid then jsonb_build_object(
                        'bud_oere', p.bud_oere, 'koebergebyr_oere', p.koebergebyr_oere,
                        'fragt_oere', p.fragt_oere, 'bidhamr_beskyttelse_oere', p.beskyttelse_oere,
                        'total_oere', p.total_oere, 'status', p.status, 'betalt_kl', p.betalt_kl,
                        'refunderet_oere', p.refusion_oere, 'refunderet_kl', p.refunderet_kl)
                      else jsonb_build_object(
                        'bud_oere', p.bud_oere, 'saelgergebyr_oere', p.saelgergebyr_oere,
                        'udbetaling_oere', p.udbetaling_oere, 'status', p.status,
                        'betalt_kl', p.betalt_kl, 'frigivet_kl', p.frigivet_kl,
                        'overfoert_kl', p.overfoert_kl) end
                       from public.betalinger p where p.trade_id = t.id)
        ) order by t.created_at)
      from mine_handler t left join public.auctions a on a.id = t.auction_id), '[]'::jsonb),

    'beskeder_i_handler', coalesce((select jsonb_agg(jsonb_build_object(
        'handel_id', m.trade_id,
        'fra', case when m.fra_bidhamr then 'BidHamr'
                    when m.sender_id = v_uid then 'dig'
                    else (select f.navn from fornavn f where f.id = m.sender_id) end,
        'tekst', m.content, 'sendt_kl', m.created_at) order by m.created_at)
      from public.messages m join mine_handler t on t.id = m.trade_id
     -- Beskeder, spamfilteret skjulte for dig, har du aldrig set.
     where m.sender_id = v_uid or m.blokeret_grund is null), '[]'::jsonb),

    'samtaler_med_bidhamr', coalesce((select jsonb_agg(jsonb_build_object(
        'emne', s.emne, 'aabnet_kl', s.aabnet_kl, 'lukket_kl', s.lukket_kl,
        'beskeder', coalesce((select jsonb_agg(jsonb_build_object(
            'fra', case when b.fra_staff then 'BidHamr' else 'dig' end,
            'tekst', b.tekst, 'sendt_kl', b.oprettet_kl) order by b.oprettet_kl)
          from public.staff_beskeder b where b.samtale_id = s.id), '[]'::jsonb)
        ) order by s.aabnet_kl)
      from public.staff_samtaler s where s.bruger_id = v_uid), '[]'::jsonb),

    'bedoemmelser_givet', coalesce((select jsonb_agg(jsonb_build_object(
        'til_fornavn', (select f.navn from fornavn f where f.id = r.til_bruger_id),
        'auktion', a.titel, 'stjerner', r.stjerner, 'kommentar', r.kommentar,
        'skjult_af_bidhamr', coalesce(r.skjult, false),
        'synlighed', case when r.skjult then 'skjult af BidHamr' else 'synlig' end,
        'tidspunkt', r.oprettet) order by r.oprettet)
      from public.ratings r left join public.auctions a on a.id = r.auktion_id
     where r.fra_bruger_id = v_uid), '[]'::jsonb),

    'bedoemmelser_modtaget', coalesce((select jsonb_agg(jsonb_build_object(
        'fra_fornavn', (select f.navn from fornavn f where f.id = r.fra_bruger_id),
        'auktion', a.titel, 'stjerner', r.stjerner, 'kommentar', r.kommentar,
        'skjult_af_bidhamr', coalesce(r.skjult, false),
        'synlighed', case when r.skjult then 'skjult af BidHamr' else 'synlig' end,
        'tidspunkt', r.oprettet) order by r.oprettet)
      from public.ratings r left join public.auctions a on a.id = r.auktion_id
     where r.til_bruger_id = v_uid), '[]'::jsonb),

    'spoergsmaal_du_har_stillet', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', q.auction_id, 'spoergsmaal', q.question, 'svar', q.answer,
        'stillet_kl', q.asked_at, 'besvaret_kl', q.answered_at) order by q.asked_at)
      from public.auction_questions q where q.asker_id = v_uid), '[]'::jsonb),

    'sager', coalesce((select jsonb_agg(jsonb_build_object(
        'handel_id', s.trade_id, 'type', s.type,
        'oprettet_af_dig', s.oprettet_af = v_uid,
        'beskrivelse', case when s.oprettet_af = v_uid then s.beskrivelse else null end,
        'status', s.status, 'afgoerelse', s.begrundelse,
        'oprettet_kl', s.oprettet_kl, 'afgjort_kl', s.afgjort_kl) order by s.oprettet_kl)
      from public.sager s join mine_handler t on t.id = s.trade_id), '[]'::jsonb),

    'anker', coalesce((select jsonb_agg(jsonb_build_object(
        'handel_id', k.trade_id, 'begrundelse', k.begrundelse, 'status', k.status,
        'afgoerelse', k.afgoerelse_begrundelse, 'indgivet_kl', k.indgivet_kl,
        'behandlet_kl', k.behandlet_kl) order by k.indgivet_kl)
      from public.sag_anker k where k.indgivet_af = v_uid), '[]'::jsonb),

    'advarsler', coalesce((select jsonb_agg(jsonb_build_object(
        'begrundelse', w.begrundelse_bruger, 'tidspunkt', w.oprettet_kl) order by w.oprettet_kl)
      from public.advarsler w where w.bruger_id = v_uid), '[]'::jsonb),

    'paamindelser', coalesce((select jsonb_agg(jsonb_build_object(
        'grund', p.grund, 'begrundelse', p.begrundelse_bruger, 'tidspunkt', p.oprettet_kl)
        order by p.oprettet_kl)
      from public.paamindelser p where p.bruger_id = v_uid), '[]'::jsonb),

    'notifikationsindstillinger', coalesce((select jsonb_agg(jsonb_build_object(
        'type', n.type, 'klokke', n.klokke, 'mail', n.mail, 'push', n.push) order by n.type)
      from public.notifikation_indstillinger n where n.bruger_id = v_uid), '[]'::jsonb),

    'notifikationer', coalesce((select jsonb_agg(jsonb_build_object(
        'type', n.type, 'titel', n.titel, 'tekst', n.tekst, 'tidspunkt', n.oprettet_kl,
        'laest_kl', n.laest_kl) order by n.oprettet_kl)
      from public.notifikationer n where n.bruger_id = v_uid), '[]'::jsonb),

    'favoritter', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', x.auction_id, 'auktion', a.titel, 'tilfoejet_kl', x.created_at)
        order by x.created_at)
      from public.favorites x left join public.auctions a on a.id = x.auction_id
     where x.user_id = v_uid), '[]'::jsonb),

    'gemte_auktioner', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', x.auction_id, 'auktion', a.titel, 'tilfoejet_kl', x.created_at)
        order by x.created_at)
      from public.saved_auctions x left join public.auctions a on a.id = x.auction_id
     where x.user_id = v_uid), '[]'::jsonb),

    'saelgere_du_foelger', coalesce((select jsonb_agg(jsonb_build_object(
        'saelger_fornavn', (select f.navn from fornavn f where f.id = x.seller_id),
        'siden', x.created_at) order by x.created_at)
      from public.seller_follows x where x.follower_id = v_uid), '[]'::jsonb),

    'antal_foelgere', (select count(*) from public.seller_follows x where x.seller_id = v_uid),

    'blokerede_brugere', coalesce((select jsonb_agg(jsonb_build_object(
        'bruger', case when x.kilde_auktion_id is not null then 'Anonym byder'
                       else (select f.navn from fornavn f where f.id = x.blokeret_id) end,
        'siden', x.oprettet_kl) order by x.oprettet_kl)
      from public.brugerblokeringer x where x.blokerer_id = v_uid), '[]'::jsonb),

    'rapporter_om_auktioner', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', r.auction_id, 'kategori', r.category, 'beskrivelse', r.description,
        'status', r.status, 'tidspunkt', r.created_at) order by r.created_at)
      from public.reports r where r.reporter_id = v_uid), '[]'::jsonb),

    'rapporter_om_brugere', coalesce((select jsonb_agg(jsonb_build_object(
        'kategori', r.category, 'beskrivelse', r.description, 'handel_id', r.trade_id,
        'status', r.status, 'tidspunkt', r.created_at) order by r.created_at)
      from public.bruger_rapporter r where r.reporter_id = v_uid), '[]'::jsonb),

    'kontakthenvendelser', coalesce((select jsonb_agg(jsonb_build_object(
        'emne', k.emne, 'besked', k.besked, 'email', k.email, 'status', k.status,
        'tidspunkt', k.oprettet_kl) order by k.oprettet_kl)
      from public.kontakt_henvendelser k where k.bruger_id = v_uid), '[]'::jsonb),

    'enheder', coalesce((select jsonb_agg(jsonb_build_object(
        'enhed', e.beskrivelse, 'foerst_set', e.foerst_set_kl, 'sidst_set', e.sidst_set_kl)
        order by e.sidst_set_kl desc)
      from public.kendte_enheder e where e.bruger_id = v_uid), '[]'::jsonb),

    'gemte_soegninger', coalesce((select jsonb_agg(jsonb_build_object(
        'navn', g.navn, 'soegeord', g.soegeord, 'kategori', g.kategori,
        'postnummer', g.postnummer, 'radius_km', g.radius_km,
        'pris_min', g.pris_min, 'pris_max', g.pris_max, 'besked', g.besked,
        'oprettet', g.oprettet_kl) order by g.oprettet_kl)
      from public.gemte_soegninger g where g.bruger_id = v_uid), '[]'::jsonb),

    'dine_svar_paa_bedoemmelser', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion', a.titel, 'svar', x.tekst, 'oprettet', x.oprettet,
        'rettet_kl', x.rettet_kl, 'slettet_kl', x.slettet_kl, 'skjult', x.skjult)
        order by x.oprettet)
      from public.bedoemmelse_svar x
      left join public.ratings r on r.id = x.rating_id
      left join public.auctions a on a.id = r.auktion_id
     where x.saelger_id = v_uid), '[]'::jsonb),

    'auktionsskabeloner', coalesce((select jsonb_agg(jsonb_build_object(
        'navn', s.name, 'indhold', s.data, 'oprettet', s.created_at) order by s.created_at)
      from public.auction_templates s where s.user_id = v_uid), '[]'::jsonb)
  ) into v;

  return v;
end;
$fn$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated;
