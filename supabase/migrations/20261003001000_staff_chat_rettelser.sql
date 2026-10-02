-- Rettelser til staff-chat (20261003000000_staff_chat.sql) efter review.
--
-- 1. Ingen kan udgive sig for BidHamr i koeber/saelger-chatten: beskeder,
--    der starter med "Besked fra BidHamr", afvises for alle andre end
--    service_role/postgres. UI maa KUN bruge messages.fra_bidhamr til at
--    vise en besked som fra BidHamr - aldrig teksten.
-- 2. Faellesbeskeder afsloerer ikke laengere, hvilken admin der skrev:
--    messages.sender_id er nu en fast systembruger "BidHamr". Den rigtige
--    admin staar i moderation_log (handling 'faellesbesked').
-- 4. staff_chat_aabn: findes samtalen allerede, og er der en besked, saettes
--    beskeden ind i den eksisterende samtale (samme laas/tjek som send).
-- 5. staff_chat_send returnerer om_sag, saa serveren kan sende 'sag'
--    (paakraevet) for samtaler om en sag/handel.
-- 7. staff_chat_svar: advisory lock pr. bruger foer rate-limit-optaellingen,
--    saa samtidige svar ikke smutter forbi graensen.
--
-- Idempotent: create or replace / drop ... if exists / on conflict do nothing.

-- ============================================================ Systembruger

-- Fast id. Spejlet i src/lib/staffChat.ts (BIDHAMR_SYSTEM_ID).
create or replace function public.bidhamr_system_id()
returns uuid
language sql
immutable
set search_path = public
as $fn$
  select '00000000-0000-4000-8000-0000000b1d00'::uuid;
$fn$;

revoke all on function public.bidhamr_system_id() from public, anon;
grant execute on function public.bidhamr_system_id() to authenticated, service_role;

-- public.users.id har FK til auth.users(id), saa systembrugeren kraever en
-- auth-raekke. Den kan aldrig logge ind:
--   - ingen adgangskode (encrypted_password = '') og ingen auth.identities
--   - e-mail er ikke bekraeftet
--   - e-mailen er paa det reserverede .invalid-domaene (RFC 2606), saa
--     magic link/OTP/nulstilling aldrig kan leveres
--   - banned_until langt ude i fremtiden
-- Token-kolonnerne saettes til '' (ikke null), ellers fejler GoTrue/
-- dashboardet, naar det laeser brugerlisten.
do $$
declare
  v_id constant uuid := '00000000-0000-4000-8000-0000000b1d00';
  v_email constant text := 'system@bidhamr.invalid';
  v_ukendte text;
begin
  -- Sikkerhedsnet: opret kun auth-raekken, hvis det eneste, der reagerer paa
  -- nye auth-brugere, er vores egen on_auth_user_created (handle_new_user,
  -- 20260622000000). Findes der andre triggere (fx noget, der sender mails
  -- eller opretter Stripe-kunder), afbrydes migrationen, saa det kan
  -- vurderes foerst.
  if not exists (select 1 from auth.users where id = v_id) then
    select string_agg(t.tgname, ', ') into v_ukendte
      from pg_trigger t
     where t.tgrelid = 'auth.users'::regclass
       and not t.tgisinternal
       and t.tgname <> 'on_auth_user_created';
    if v_ukendte is not null then
      raise exception 'Systembrugeren oprettes ikke: ukendte triggere paa auth.users (%). Gennemgaa dem foerst.', v_ukendte;
    end if;

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, banned_until, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      v_email, '',
      null, '2999-12-31 00:00:00+00',
      '{"provider":"email","providers":["email"],"bidhamr_system":true}'::jsonb,
      '{"navn":"BidHamr"}'::jsonb,
      now(), now(), '', '', '', ''
    ) on conflict (id) do nothing;
  end if;

  -- Normalt oprettet af on_auth_user_created; her for en sikkerheds skyld.
  insert into public.users (id, navn, email)
  values (v_id, 'BidHamr', v_email)
  on conflict (id) do nothing;

  -- Altid almindelig bruger, aldrig staff.
  update public.users
     set navn = 'BidHamr', rolle = 'bruger'
   where id = v_id
     and (navn is distinct from 'BidHamr' or rolle is distinct from 'bruger');
end $$;

-- Systembrugeren maa aldrig slettes: messages.sender_id cascader, saa en
-- sletning (ogsaa via auth.users) ville slette alle faellesbeskeder.
create or replace function public.users_beskyt_systembruger()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  -- Konstanten staar direkte her (ikke bidhamr_system_id()), fordi
  -- triggeren ogsaa koerer som supabase_auth_admin, naar en auth-bruger
  -- slettes, og den rolle ikke har execute paa vores funktioner.
  if old.id = '00000000-0000-4000-8000-0000000b1d00'::uuid then
    raise exception 'Systembrugeren BidHamr kan ikke slettes.' using errcode = '42501';
  end if;
  return old;
end;
$fn$;

revoke execute on function public.users_beskyt_systembruger() from public, anon, authenticated;

drop trigger if exists users_beskyt_systembruger on public.users;
create trigger users_beskyt_systembruger
  before delete on public.users
  for each row execute function public.users_beskyt_systembruger();

-- Eksisterende faellesbeskeder (kun paa testdatabasen - 20261003000000 er
-- ikke koert i produktion endnu) flyttes til systembrugeren. Den rigtige
-- admin staar allerede i moderation_log.
update public.messages
   set sender_id = public.bidhamr_system_id()
 where fra_bidhamr
   and sender_id is distinct from public.bidhamr_system_id();

comment on column public.messages.fra_bidhamr is
  'true = faellesbesked fra BidHamr (admin) til begge parter. sender_id er systembrugeren BidHamr (public.bidhamr_system_id()); den rigtige admin staar i moderation_log. Kan kun saettes af service_role. UI skal bruge denne kolonne - aldrig teksten - til at vise en besked som fra BidHamr.';

-- ============================================================ 1. Udgivelse som BidHamr

-- Kun service_role (og databasens egne roller) maa saette fra_bidhamr og
-- skrive beskeder, der starter med "Besked fra BidHamr". For alle andre
-- tvinges fra_bidhamr til false, og en tekst, der ligner en besked fra
-- BidHamr, afvises.
create or replace function public.messages_beskyt_fra_bidhamr()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_tekst text;
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.fra_bidhamr := false;
  else
    new.fra_bidhamr := old.fra_bidhamr;
  end if;

  -- Fjern usynlige tegn (zero-width, bloed bindestreg, BOM) og goer haarde
  -- mellemrum til almindelige, saa de ikke kan bruges til at snyde tjekket.
  v_tekst := regexp_replace(coalesce(new.content, ''),
                            '[­​-‏⁠-⁤﻿]', '', 'g');
  v_tekst := translate(v_tekst, chr(160) || chr(8199) || chr(8239), '   ');
  -- Tegnsaetning/emoji foran ("** Besked fra BidHamr", en emoji foran osv.)
  -- taeller ogsaa.
  if v_tekst ~* '^[^[:alnum:]]*besked\s+fra\s+bid\s*hamr' then
    raise exception 'Beskeder må ikke starte med "Besked fra BidHamr".'
      using errcode = 'BHM01';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.messages_beskyt_fra_bidhamr() from public, anon, authenticated;

drop trigger if exists messages_beskyt_fra_bidhamr on public.messages;
create trigger messages_beskyt_fra_bidhamr
  before insert or update on public.messages
  for each row execute function public.messages_beskyt_fra_bidhamr();

-- ============================================================ 2. Faellesbesked

-- Som i 20261003000000, men sender_id er systembrugeren. Den rigtige admin
-- logges i moderation_log.
create or replace function public.faellesbesked(
  p_medarbejder uuid,
  p_trade       uuid,
  p_tekst       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_tekst text := btrim(coalesce(p_tekst, ''));
  t       record;
  v_id    uuid;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  -- messages.content maa hoejst vaere 2000 tegn inkl. praefiks.
  if char_length(v_tekst) not between 1 and 1900 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  select id, buyer_id, seller_id, auction_id into t
    from public.trades where id = p_trade;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  insert into public.messages (trade_id, sender_id, content, fra_bidhamr)
  values (t.id, public.bidhamr_system_id(),
          'Besked fra BidHamr:' || chr(10) || v_tekst, true)
  returning id into v_id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'faellesbesked', 'handel', t.id, t.buyer_id,
          left('Besked ' || v_id::text || ': ' || v_tekst, 1000));

  return jsonb_build_object('kode', 'ok', 'besked_id', v_id, 'buyer_id', t.buyer_id,
                            'seller_id', t.seller_id, 'auction_id', t.auction_id);
end;
$fn$;

revoke all on function public.faellesbesked(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.faellesbesked(uuid, uuid, text) to service_role;

-- ============================================================ 5. staff_chat_send

-- Som i 20261003000000 + om_sag (samtalen handler om en sag eller handel ->
-- serveren sender notifikationstypen 'sag' i stedet for 'ny_besked').
-- Returnerer {"kode": "ok", "besked_id", "bruger_id", "forrige_ulaest_kl",
-- "om_sag"} eller ingen_adgang, ikke_fundet, lukket, ugyldig_tekst.
create or replace function public.staff_chat_send(
  p_medarbejder uuid,
  p_samtale     uuid,
  p_tekst       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_tekst text := btrim(coalesce(p_tekst, ''));
  s       public.staff_samtaler%rowtype;
  v_id    uuid;
  v_forrige timestamptz;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(v_tekst) not between 1 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  -- Laas samtalen, saa en samtidig lukning ikke smutter forbi.
  select * into s from public.staff_samtaler where id = p_samtale for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if s.lukket_kl is not null then return jsonb_build_object('kode', 'lukket'); end if;

  select max(b.oprettet_kl) into v_forrige
    from public.staff_beskeder b
   where b.samtale_id = s.id
     and b.fra_staff
     and (s.bruger_laest_kl is null or b.oprettet_kl > s.bruger_laest_kl);

  insert into public.staff_beskeder (samtale_id, afsender_id, fra_staff, tekst)
  values (s.id, p_medarbejder, true, v_tekst)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'besked_id', v_id, 'bruger_id', s.bruger_id,
                            'forrige_ulaest_kl', v_forrige,
                            'om_sag', (s.sag_type is not null or s.trade_id is not null));
end;
$fn$;

revoke all on function public.staff_chat_send(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.staff_chat_send(uuid, uuid, text) to service_role;

-- ============================================================ 4. staff_chat_aabn

-- Aabner en samtale. Findes der allerede en aaben samtale med brugeren om
-- samme sag (eller en aaben generel samtale), bruges den (dobbeltklik giver
-- ikke to samtaler); er p_besked givet, saettes beskeden ind i den via
-- staff_chat_send (samme laas og lukket-tjek).
-- Returnerer {"kode": "ok", "samtale_id", "besked_id"?} eller
-- {"kode": "findes", "samtale_id", "besked_id"?, "forrige_ulaest_kl"?, "om_sag"?}
-- eller en fejlkode: ingen_adgang, ugyldig_bruger, sig_selv, ugyldigt_emne,
-- ugyldig_sag, ugyldig_handel, ugyldig_tekst, lukket, proev_igen.
create or replace function public.staff_chat_aabn(
  p_medarbejder uuid,
  p_bruger      uuid,
  p_emne        text,
  p_trade       uuid,
  p_sag_type    text,
  p_sag_id      uuid,
  p_besked      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_emne      text := btrim(coalesce(p_emne, ''));
  v_besked    text := nullif(btrim(coalesce(p_besked, '')), '');
  v_samtale   uuid;
  v_besked_id uuid;
  v_send      jsonb;
  v_forsoeg   integer := 0;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_bruger is null
     or p_bruger = public.bidhamr_system_id()
     or not exists (select 1 from public.users where id = p_bruger) then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_medarbejder then
    return jsonb_build_object('kode', 'sig_selv');
  end if;
  if char_length(v_emne) not between 1 and 200 then
    return jsonb_build_object('kode', 'ugyldigt_emne');
  end if;
  if (p_sag_type is null) <> (p_sag_id is null)
     or (p_sag_type is not null and p_sag_type !~ '^[a-z_]{1,40}$') then
    return jsonb_build_object('kode', 'ugyldig_sag');
  end if;
  if p_trade is not null and not exists (
    select 1 from public.trades t
     where t.id = p_trade and (t.buyer_id = p_bruger or t.seller_id = p_bruger)
  ) then
    return jsonb_build_object('kode', 'ugyldig_handel');
  end if;
  if v_besked is not null and char_length(v_besked) > 4000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  -- Hoejst tre runder: en samtidig lukning eller et samtidigt dobbeltklik kan
  -- hver koste en runde.
  loop
    v_forsoeg := v_forsoeg + 1;

    select s.id into v_samtale
      from public.staff_samtaler s
     where s.bruger_id = p_bruger
       and s.lukket_kl is null
       and s.sag_type is not distinct from p_sag_type
       and s.sag_id is not distinct from p_sag_id;

    if v_samtale is not null then
      if v_besked is null then
        return jsonb_build_object('kode', 'findes', 'samtale_id', v_samtale);
      end if;
      v_send := public.staff_chat_send(p_medarbejder, v_samtale, v_besked);
      if v_send->>'kode' = 'ok' then
        return jsonb_build_object('kode', 'findes', 'samtale_id', v_samtale,
                                  'besked_id', v_send->'besked_id',
                                  'forrige_ulaest_kl', v_send->'forrige_ulaest_kl',
                                  'om_sag', v_send->'om_sag');
      end if;
      -- Lukket i mellemtiden: proev igen (saa oprettes en ny samtale).
      if v_send->>'kode' <> 'lukket' or v_forsoeg >= 3 then
        return v_send;
      end if;
      continue;
    end if;

    begin
      insert into public.staff_samtaler (bruger_id, aabnet_af, emne, sag_type, sag_id, trade_id)
      values (p_bruger, p_medarbejder, v_emne, p_sag_type, p_sag_id, p_trade)
      returning id into v_samtale;
    exception when unique_violation then
      -- Samtidigt dobbeltklik: den anden vandt. Brug dens samtale.
      v_samtale := null;
      if v_forsoeg >= 3 then
        return jsonb_build_object('kode', 'proev_igen');
      end if;
      continue;
    end;

    exit;
  end loop;

  if v_besked is not null then
    insert into public.staff_beskeder (samtale_id, afsender_id, fra_staff, tekst)
    values (v_samtale, p_medarbejder, true, v_besked)
    returning id into v_besked_id;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'chat_aabnet', 'samtale', v_samtale, p_bruger,
          'Emne: ' || v_emne
          || coalesce(' | Sag: ' || p_sag_type || ' ' || p_sag_id::text, '')
          || coalesce(' | Handel: ' || p_trade::text, ''));

  return jsonb_build_object('kode', 'ok', 'samtale_id', v_samtale, 'besked_id', v_besked_id);
end;
$fn$;

revoke all on function public.staff_chat_aabn(uuid, uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_chat_aabn(uuid, uuid, text, uuid, text, uuid, text)
  to service_role;

-- ============================================================ 7. staff_chat_svar

-- Som i 20261003000000 + advisory lock pr. bruger, saa samtidige svar (ogsaa
-- i forskellige samtaler) taelles i raekkefoelge og ikke kan snyde
-- rate limit'en (hoejst 20 svar pr. 10 minutter).
-- Laasen tages foer samtalelaasen, saa raekkefoelgen altid er den samme.
create or replace function public.staff_chat_svar(p_samtale uuid, p_tekst text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid := auth.uid();
  v_tekst  text := btrim(coalesce(p_tekst, ''));
  v_lukket timestamptz;
  v_antal  integer;
  v_id     uuid;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if char_length(v_tekst) not between 1 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  perform pg_advisory_xact_lock(hashtext('staff_chat_svar:' || v_bruger::text));

  -- Laas samtalen: lukker staff samtidig, venter vi og ser lukningen.
  select s.lukket_kl into v_lukket
    from public.staff_samtaler s
   where s.id = p_samtale and s.bruger_id = v_bruger
   for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_lukket is not null then return jsonb_build_object('kode', 'lukket'); end if;

  select count(*) into v_antal
    from public.staff_beskeder b
   where b.afsender_id = v_bruger
     and not b.fra_staff
     and b.oprettet_kl > now() - interval '10 minutes';
  if v_antal >= 20 then return jsonb_build_object('kode', 'for_mange'); end if;

  insert into public.staff_beskeder (samtale_id, afsender_id, fra_staff, tekst)
  values (p_samtale, v_bruger, false, v_tekst)
  returning id into v_id;

  -- Har brugeren skrevet, har han ogsaa laest samtalen.
  update public.staff_samtaler set bruger_laest_kl = now() where id = p_samtale;

  return jsonb_build_object('kode', 'ok', 'besked_id', v_id);
end;
$fn$;

revoke all on function public.staff_chat_svar(uuid, text) from public, anon;
grant execute on function public.staff_chat_svar(uuid, text) to authenticated;
