-- Fase 4: Kontosikkerhed og GDPR (bekraeftelse af e-mail, slet konto,
-- download data, to-trins-login, kendte enheder).
--
-- Regler (ROADMAP-BESLUTNINGER.md, afsnittet "Konto og GDPR"):
-- - Handelsdata slettes ALDRIG (bogfoeringsloven/DAC7): trades, betalinger,
--   gebyrer, sager, anker, moderation_log, beskeder, bedoemmelser bevares.
-- - Persondata anonymiseres: navn -> "Slettet bruger", e-mail, telefon,
--   adresse, avatar, push-tokens og gemte kortreferencer fjernes.
-- - Sletning sker kun via serveren (service_role) efter tjek af auth.uid()
--   og adgangskode. Auth-brugeren soft-slettes bagefter via admin-API'et.
--
-- Indhold:
--   1. users.konto_slettet_kl
--   2. handle_new_user: fornavn/efternavn fra signup-metadata, aldrig e-mail som navn
--   3. kendte_enheder + registrer_login / mine_enheder / fjern_min_enhed
--   4. (flyttet til 20261007032000 - koeres foerst, naar appen har to-trin)
--   5. moderation_log_handling_check + 'konto_slettet' (FLETTES)
--   6. konto_sletning_blokeringer / min_konto_sletning_status / konto_slet
--   7. mine_data (GDPR-udtraek, 1 gang i timen)
--
-- Koeres EFTER 20261007010000 (gemte_soegninger) og 20261007020000
-- (bedoemmelse_svar), som konto_slet og mine_data bruger.
--
-- Idempotent. Roerer ikke andre CHECK-lister end moderation_log_handling_check.

-- ============================================================ 1. users.konto_slettet_kl

alter table public.users add column if not exists konto_slettet_kl timestamptz;

comment on column public.users.konto_slettet_kl is
  'Sat, naar brugeren selv har slettet sin konto (konto_slet). Persondata er '
  'anonymiseret; handelsdata er bevaret.';

-- authenticated har UPDATE paa hele tabellen (beskyttet af triggere), saa
-- kolonnen skal ogsaa beskyttes: kun serveren maa saette den, og en slettet
-- konto kan aldrig "gendannes".
create or replace function public.users_beskyt_slettet_konto()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.konto_slettet_kl is not null
       and not (coalesce(auth.role(), '') = 'service_role'
                or current_user in ('postgres', 'supabase_admin', 'service_role')) then
      new.konto_slettet_kl := null;
    end if;
    return new;
  end if;
  -- En slettet profil kan ikke rettes af brugeren (fx navnet tilbage).
  if old.konto_slettet_kl is not null
     and not (coalesce(auth.role(), '') = 'service_role'
              or current_user in ('postgres', 'supabase_admin', 'service_role')) then
    raise exception 'Kontoen er slettet.' using errcode = '42501';
  end if;
  if new.konto_slettet_kl is distinct from old.konto_slettet_kl then
    if old.konto_slettet_kl is not null then
      raise exception 'Kontoen er slettet og kan ikke gendannes.' using errcode = '42501';
    end if;
    if not (coalesce(auth.role(), '') = 'service_role'
            or current_user in ('postgres', 'supabase_admin', 'service_role')) then
      raise exception 'Du må ikke ændre denne oplysning.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists users_beskyt_slettet_konto on public.users;
create trigger users_beskyt_slettet_konto
  before insert or update on public.users
  for each row execute function public.users_beskyt_slettet_konto();

-- ============================================================ 2. handle_new_user

-- Uaendret adfaerd, bortset fra:
-- - fornavn/efternavn gemmes fra signup-metadata (hjemmesidens /signup)
-- - mangler navn, bruges "Bruger" i stedet for e-mailen (e-mailen maa ikke
--   blive et offentligt navn).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fornavn   text := left(nullif(btrim(new.raw_user_meta_data->>'fornavn'), ''), 100);
  v_efternavn text := left(nullif(btrim(new.raw_user_meta_data->>'efternavn'), ''), 100);
  v_navn      text := left(nullif(btrim(new.raw_user_meta_data->>'navn'), ''), 200);
begin
  if v_navn is null then
    v_navn := nullif(btrim(concat_ws(' ', v_fornavn, v_efternavn)), '');
  end if;
  insert into public.users (id, navn, fornavn, efternavn, email, telefon)
  values (
    new.id,
    coalesce(v_navn, 'Bruger'),
    v_fornavn,
    v_efternavn,
    new.email,
    new.raw_user_meta_data->>'telefon'
  );
  return new;
end;
$fn$;

-- ============================================================ 3. Kendte enheder

-- Enheder/browsere, brugeren har logget ind fra. Enheden kendes paa en
-- tilfaeldig langtidscookie (bh_enhed); kun SHA-256 af cookien gemmes.
-- Ingen IP-adresser. Beskrivelsen er fx "Chrome på Windows".
create table if not exists public.kendte_enheder (
  id            uuid primary key default gen_random_uuid(),
  bruger_id     uuid not null references public.users(id) on delete cascade,
  enhed_hash    text not null check (enhed_hash ~ '^[0-9a-f]{64}$'),
  beskrivelse   text not null check (char_length(beskrivelse) between 1 and 200),
  -- Seneste Supabase-session fra enheden, saa "Fjern" kan logge den ud.
  session_id    uuid,
  foerst_set_kl timestamptz not null default now(),
  sidst_set_kl  timestamptz not null default now(),
  constraint kendte_enheder_unik unique (bruger_id, enhed_hash)
);

create index if not exists kendte_enheder_bruger_idx
  on public.kendte_enheder (bruger_id, sidst_set_kl desc);

alter table public.kendte_enheder enable row level security;
-- Ingen policies: tabellen laeses og skrives kun via funktionerne herunder.
revoke all on public.kendte_enheder from anon, authenticated;
grant all on public.kendte_enheder to service_role;

comment on table public.kendte_enheder is
  'Enheder (browsere), brugeren har logget ind fra. Kun hash af enheds-cookien, '
  'ingen IP. Laeses via mine_enheder(), skrives via registrer_login() (server).';

-- Kaldes af serveren efter hvert gennemfoert login (inkl. to-trins-login).
-- send_mail = true, naar enheden er ny OG brugeren har logget ind foer
-- (foerste login efter oprettelse giver ingen mail).
create or replace function public.registrer_login(
  p_bruger      uuid,
  p_hash        text,
  p_beskrivelse text,
  p_session     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_kendt_foer boolean;
  v_ny         boolean;
begin
  if p_bruger is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Ugyldige parametre' using errcode = '22023';
  end if;

  -- Laas brugeren, saa to samtidige logins ikke begge tror, de er de foerste.
  perform 1 from public.users where id = p_bruger for update;
  if not found then
    raise exception 'Ukendt bruger' using errcode = '22023';
  end if;

  select exists (select 1 from public.kendte_enheder where bruger_id = p_bruger)
    into v_kendt_foer;

  insert into public.kendte_enheder as k (bruger_id, enhed_hash, beskrivelse, session_id)
  values (p_bruger, p_hash,
          left(coalesce(nullif(btrim(p_beskrivelse), ''), 'Ukendt enhed'), 200),
          p_session)
  on conflict (bruger_id, enhed_hash) do update
     set sidst_set_kl = now(),
         beskrivelse  = excluded.beskrivelse,
         session_id   = coalesce(excluded.session_id, k.session_id)
  returning (xmax = 0) into v_ny;

  -- Hoejst 30 enheder pr. bruger: de aeldste ryddes.
  delete from public.kendte_enheder
   where bruger_id = p_bruger
     and id not in (select id from public.kendte_enheder
                     where bruger_id = p_bruger
                     order by sidst_set_kl desc limit 30);

  return jsonb_build_object('ny', v_ny, 'send_mail', v_ny and v_kendt_foer);
end;
$fn$;

revoke all on function public.registrer_login(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.registrer_login(uuid, text, text, uuid) to service_role;

-- Brugerens egne enheder. p_hash = hash af den aktuelle enheds cookie (kan
-- vaere null), saa listen kan markere "Denne enhed".
create or replace function public.mine_enheder(p_hash text default null)
returns table (
  id            uuid,
  beskrivelse   text,
  foerst_set_kl timestamptz,
  sidst_set_kl  timestamptz,
  denne         boolean,
  logget_ind    boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select k.id, k.beskrivelse, k.foerst_set_kl, k.sidst_set_kl,
         (p_hash is not null and k.enhed_hash = p_hash) as denne,
         exists (select 1 from auth.sessions s
                  where s.id = k.session_id
                    and s.user_id = k.bruger_id
                    and (s.not_after is null or s.not_after > now())) as logget_ind
    from public.kendte_enheder k
   where k.bruger_id = auth.uid()
   order by k.sidst_set_kl desc;
$fn$;

revoke all on function public.mine_enheder(text) from public, anon;
grant execute on function public.mine_enheder(text) to authenticated;

-- Fjerner en enhed fra listen og logger dens session ud. Den session, der
-- kalder, kan ikke logges ud herfra (brug "Log ud").
create or replace function public.fjern_min_enhed(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_session uuid;
  v_denne   uuid;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  begin
    v_denne := nullif(auth.jwt()->>'session_id', '')::uuid;
  exception when others then
    v_denne := null;
  end;

  select k.session_id into v_session
    from public.kendte_enheder k
   where k.id = p_id and k.bruger_id = v_uid;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if v_session is not null and v_session = v_denne then
    return jsonb_build_object('kode', 'denne_enhed');
  end if;

  delete from public.kendte_enheder where id = p_id and bruger_id = v_uid;
  if v_session is not null then
    delete from auth.sessions where id = v_session and user_id = v_uid;
  end if;
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.fjern_min_enhed(uuid) from public, anon;
grant execute on function public.fjern_min_enhed(uuid) to authenticated;

-- ============================================================ 4. To-trins-login i databasen

-- FLYTTET til 20261007032000_mfa_database_haandhaevelse.sql, som foerst maa
-- koeres i produktion, naar Expo-appen understoetter to-trins-login. Indtil
-- da haandhaever hjemmesiden to-trin i proxyen og i server actions.

-- ============================================================ 5. moderation_log: 'konto_slettet'

-- FLETTES: alle vaerdier i den nuvaerende constraint bevares (ogsaa fra
-- migrationer, der koeres samtidig), + 'konto_slettet'.
do $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'moderation_log_handling_check'
     and c.conrelid = 'public.moderation_log'::regclass;

  select array_agg(distinct x order by x) into v_vals from (
    -- Constrainten kan staa som ARRAY['a'::text, ...] eller som '{a,b}'::text[].
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union
    select 'konto_slettet'
  ) s;

  alter table public.moderation_log drop constraint if exists moderation_log_handling_check;
  execute format(
    'alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))',
    v_vals);
end $$;

-- ============================================================ 6. Slet konto

-- Det, der forhindrer sletning lige nu. Tom liste = kontoen kan slettes.
-- Hvert element: { type, tekst, link } (link er en intern sti eller null).
create or replace function public.konto_sletning_blokeringer(p_bruger uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(distinct b), '[]'::jsonb) from (
    -- Medarbejdere: en chef skal fjerne rollen foerst.
    select jsonb_build_object('type', 'staff', 'tekst', 'Din medarbejderrolle', 'link', null) as b
      from public.users u
     where u.id = p_bruger and u.rolle in ('medarbejder', 'admin', 'chef')

    union all
    -- Egne auktioner i gang med bud.
    select jsonb_build_object('type', 'auktion_med_bud', 'tekst', a.titel, 'link', '/auktion/' || a.id)
      from public.auctions a
     where a.bruger_id = p_bruger
       and a.status = 'aktiv'
       and (a."nuværende_bud" is not null
            or exists (select 1 from public.bids x where x.auktion_id = a.id))

    union all
    -- Bud paa andres auktioner, der stadig er i gang (bud er bindende).
    select jsonb_build_object('type', 'bud_paa_aktiv', 'tekst', a.titel, 'link', '/auktion/' || a.id)
      from public.auctions a
     where a.status = 'aktiv'
       and a.bruger_id <> p_bruger
       and exists (select 1 from public.bids x
                    where x.auktion_id = a.id and x.bruger_id = p_bruger)

    union all
    -- Handler, der ikke er afsluttet eller annulleret (inkl. manglende betaling).
    select jsonb_build_object(
             'type', case when t.status = 'afventer_betaling' and t.buyer_id = p_bruger
                          then 'mangler_betaling' else 'aaben_handel' end,
             'tekst', coalesce(a.titel, 'Handel'),
             'link', '/mine-handler/' || t.id)
      from public.trades t
      left join public.auctions a on a.id = t.auction_id
     where (t.buyer_id = p_bruger or t.seller_id = p_bruger)
       and t.status not in ('afsluttet', 'annulleret')

    union all
    -- Sager, der er aabne, venter paa retur, eller hvor pengene endnu ikke er flyttet (ankefrist).
    select jsonb_build_object('type', 'aaben_sag', 'tekst', coalesce(a.titel, 'Sag'),
                              'link', '/mine-handler/' || t.id)
      from public.sager s
      join public.trades t on t.id = s.trade_id
      left join public.auctions a on a.id = t.auction_id
     where (t.buyer_id = p_bruger or t.seller_id = p_bruger)
       and (s.status in ('aaben', 'afventer_retur')
            or (s.penge_handling is not null and s.afviklet_kl is null))

    union all
    -- Anker, der venter paa en afgoerelse.
    select jsonb_build_object('type', 'aaben_anke', 'tekst', coalesce(a.titel, 'Anke'),
                              'link', '/mine-handler/' || t.id)
      from public.sag_anker k
      join public.trades t on t.id = k.trade_id
      left join public.auctions a on a.id = t.auction_id
     where (t.buyer_id = p_bruger or t.seller_id = p_bruger)
       and k.status = 'afventer'

    union all
    -- Tilbud til naeste byder, der venter paa svar.
    select jsonb_build_object('type', 'aabent_tilbud', 'tekst', coalesce(a.titel, 'Tilbud'),
                              'link', case when o.byder_id = p_bruger
                                           then '/andenchance/' || o.id
                                           else '/mine-handler/' || o.oprindelig_trade_id end)
      from public.andenchance_tilbud o
      left join public.auctions a on a.id = o.auction_id
     where (o.byder_id = p_bruger or o.seller_id = p_bruger)
       and o.status = 'afventer'

    union all
    -- Penge, der ikke er faerdigbehandlet: betaling i gang, udbetaling til
    -- saelger, tilbagebetaling til koeber eller indsigelse fra banken.
    select jsonb_build_object('type', 'penge_undervejs', 'tekst', coalesce(a.titel, 'Betaling'),
                              'link', '/mine-handler/' || b.trade_id)
      from public.betalinger b
      left join public.auctions a on a.id = b.auction_id
     where (b.buyer_id = p_bruger or b.seller_id = p_bruger)
       and (b.status = 'behandles'
            or (b.seller_id = p_bruger and b.status = 'betalt' and b.frigivet_kl is not null
                and b.stripe_transfer_id is null and b.refunderet_kl is null)
            or (b.buyer_id = p_bruger and b.refusion_anmodet_kl is not null and b.refunderet_kl is null)
            or (b.indsigelse_kl is not null
                and coalesce(b.indsigelse_status, '') not in ('won', 'lost', 'warning_closed', 'prevented')))

    union all
    -- En sag om manglende betaling, som BidHamr endnu ikke har behandlet.
    select jsonb_build_object('type', 'ubetalt_sag', 'tekst', coalesce(a.titel, 'Manglende betaling'),
                              'link', '/mine-handler/' || v.trade_id)
      from public.ubetalte_vindere v
      left join public.auctions a on a.id = v.auction_id
     where v.buyer_id = p_bruger and v.status = 'afventer'
  ) s;
$fn$;

revoke all on function public.konto_sletning_blokeringer(uuid) from public, anon, authenticated;
grant execute on function public.konto_sletning_blokeringer(uuid) to service_role;

-- Til /konto/slet (og appen): kun for brugeren selv.
create or replace function public.min_konto_sletning_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_bl  jsonb;
  v_akt integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  v_bl := public.konto_sletning_blokeringer(v_uid);
  select count(*) into v_akt
    from public.auctions a
   where a.bruger_id = v_uid and a.status = 'aktiv';
  return jsonb_build_object(
    'kode', 'ok',
    'kan_slettes', jsonb_array_length(v_bl) = 0,
    'blokeringer', v_bl,
    'aktive_auktioner_uden_bud', case when jsonb_array_length(v_bl) = 0 then v_akt else null end);
end;
$fn$;

revoke all on function public.min_konto_sletning_status() from public, anon;
grant execute on function public.min_konto_sletning_status() to authenticated;

-- Selve sletningen. KUN service_role: serveren har tjekket auth.uid() og
-- adgangskoden. Tjekker blokeringerne igen under laas.
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

-- ============================================================ 7. Download dine data

-- Alt det, BidHamr har om brugeren, som JSON. Andre brugere optraeder kun med
-- fornavn (modparten i en handel). Ingen interne staff-noter, ingen andres
-- kontaktoplysninger, ingen Stripe-noegler. Hoejst 1 gang i timen.
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
  fornavn as (
    select u.id,
           case when u.konto_slettet_kl is not null then 'Slettet bruger'
                else coalesce(nullif(btrim(u.fornavn), ''), nullif(split_part(btrim(u.navn), ' ', 1), ''), 'Bruger')
           end as navn
      from public.users u
  ),
  mine_handler as (
    select t.* from public.trades t where t.buyer_id = v_uid or t.seller_id = v_uid
  )
  select jsonb_build_object(
    'om_udtraekket', jsonb_build_object(
      'dannet_kl', now(),
      'forklaring', 'Dette er de oplysninger, BidHamr har om dig. Andre brugere står kun med fornavn. Interne noter fra BidHamrs medarbejdere er ikke med.'),

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
        'skjult', r.skjult, 'tidspunkt', r.oprettet) order by r.oprettet)
      from public.ratings r left join public.auctions a on a.id = r.auktion_id
     where r.fra_bruger_id = v_uid), '[]'::jsonb),

    'bedoemmelser_modtaget', coalesce((select jsonb_agg(jsonb_build_object(
        'fra_fornavn', (select f.navn from fornavn f where f.id = r.fra_bruger_id),
        'auktion', a.titel, 'stjerner', r.stjerner, 'kommentar', r.kommentar,
        'skjult', r.skjult, 'tidspunkt', r.oprettet) order by r.oprettet)
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
