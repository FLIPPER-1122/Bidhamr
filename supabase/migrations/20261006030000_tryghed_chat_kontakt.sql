-- Tryghed i chat og kontakt (ROADMAP fase 3):
--   1. Blokering af brugere (brugerblokeringer) + saelger kan spaerre bydere
--      fra sine auktioner (handle_new_bid).
--   2. Rapportér en besked/bruger (bruger_rapporter) - vises i admin under
--      Rapporter, fanen "Chat og profiler".
--   3. Automatisk spamfilter i handelschatten (messages): links, e-mails,
--      telefonnumre, MobilePay-numre og gentagne ens beskeder blokeres
--      (gemmes, men vises ikke for modtageren); for mange beskeder pr.
--      minut afvises; "betal udenom" o.l. markeres til staff (rapport).
--      Staff-chatten (staff_beskeder) beroeres IKKE.
--   4. Kontaktformular (kontakt_henvendelser) - /kontakt og /admin/kontakt.
--   5. Adresse/telefon: kun ejeren (mine_kontaktoplysninger) og koeberen ved
--      en betalt afhentningshandel (handel_afhentningsadresse).
--
-- Genskrevet (praecis kopi af seneste definition + aendringen):
--   handle_new_bid (seneste: 20261005021000_startpris_anke_rettelser.sql)
--     NYT: afviser bud fra brugere, saelgeren har blokeret.
--   messages_select_part (policy, seneste: 20260903000000) - skjuler
--     spamblokerede beskeder for modtageren.
--
-- moderation_log_handling_check / maal_type_check roeres IKKE.
-- Idempotent: if not exists / create or replace / drop ... if exists.
-- Ingen eksisterende data aendres. Handelsdata slettes aldrig.

-- ============================================================ 1. Blokering

create table if not exists public.brugerblokeringer (
  id               uuid primary key default gen_random_uuid(),
  blokerer_id      uuid not null references public.users(id) on delete cascade,
  blokeret_id      uuid not null references public.users(id) on delete cascade,
  -- Sat, naar saelgeren har spaerret en anonym byder ("Byder 3") fra en af
  -- sine auktioner. Saelgeren maa aldrig faa byderens identitet at vide, saa
  -- disse raekker vises uden navn og kan ikke slaas op pr. bruger.
  kilde_auktion_id uuid references public.auctions(id) on delete cascade,
  oprettet_kl      timestamptz not null default now(),
  constraint brugerblokeringer_ikke_sig_selv check (blokerer_id <> blokeret_id)
);

comment on table public.brugerblokeringer is
  'blokerer_id har blokeret blokeret_id: blokeret_id kan ikke byde paa '
  'blokerer_id''s auktioner, ikke skrive i chat (undtagen i en handel, der er '
  'i gang) og ikke stille spoergsmaal. kilde_auktion_id sat = anonym '
  'spaerring af en byder fra en auktion (identiteten vises aldrig for '
  'blokerer). Laeses kun via mine_blokeringer()/jeg_har_blokeret().';

-- Én navngiven blokering pr. par, og én anonym pr. par pr. auktion. Uden
-- adskillelsen kunne saelgeren se, at "Byder 3" er samme person som en
-- bruger, han har blokeret ved navn (raekken ville "forsvinde").
create unique index if not exists brugerblokeringer_navngiven_unik
  on public.brugerblokeringer (blokerer_id, blokeret_id)
  where kilde_auktion_id is null;
create unique index if not exists brugerblokeringer_anonym_unik
  on public.brugerblokeringer (blokerer_id, blokeret_id, kilde_auktion_id)
  where kilde_auktion_id is not null;
create index if not exists brugerblokeringer_blokeret_idx
  on public.brugerblokeringer (blokeret_id, blokerer_id);

alter table public.brugerblokeringer enable row level security;
revoke all on public.brugerblokeringer from public, anon, authenticated;
grant all on public.brugerblokeringer to service_role;
-- Kun egne navngivne blokeringer kan laeses direkte (appen). Anonyme
-- spaerringer laeses kun via mine_blokeringer(), som ikke viser byderen.
grant select (id, blokerer_id, blokeret_id, kilde_auktion_id, oprettet_kl)
  on public.brugerblokeringer to authenticated;
grant delete on public.brugerblokeringer to authenticated;

drop policy if exists brugerblokeringer_select_egne on public.brugerblokeringer;
create policy brugerblokeringer_select_egne on public.brugerblokeringer
  for select to authenticated
  using (blokerer_id = auth.uid() and kilde_auktion_id is null);

drop policy if exists brugerblokeringer_delete_egne on public.brugerblokeringer;
create policy brugerblokeringer_delete_egne on public.brugerblokeringer
  for delete to authenticated
  using (blokerer_id = auth.uid());
-- Ingen insert/update-policy: oprettes via bloker_bruger()/bloker_byder().

-- Har p_blokerer blokeret p_blokeret (navngivet eller anonymt)?
-- INTERN: ingen grant til authenticated - ellers kunne en saelger afsloere,
-- hvem en anonymt spaerret byder er. Bruges fra security definer-funktioner
-- og triggere (fx "Spørg sælger": er_blokeret(saelger, spoerger)).
create or replace function public.er_blokeret(p_blokerer uuid, p_blokeret uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.brugerblokeringer b
     where b.blokerer_id = p_blokerer and b.blokeret_id = p_blokeret);
$fn$;

revoke all on function public.er_blokeret(uuid, uuid) from public, anon, authenticated;
grant execute on function public.er_blokeret(uuid, uuid) to service_role;

-- Blokering i en af retningerne (chat og spoergsmaal). Intern som er_blokeret.
create or replace function public.er_blokeret_mellem(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.er_blokeret(p_a, p_b) or public.er_blokeret(p_b, p_a);
$fn$;

revoke all on function public.er_blokeret_mellem(uuid, uuid) from public, anon, authenticated;
grant execute on function public.er_blokeret_mellem(uuid, uuid) to service_role;

-- Er handlen i gang (betaling, forsendelse, afhentning, sag eller anke)?
-- Saa maa en blokering ikke stoppe chatten - parterne skal kunne gennemfoere
-- handlen og bruge sagsflowet.
create or replace function public.handel_i_gang(p_trade uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
           select 1 from public.trades t
            where t.id = p_trade
              and (t.status in ('afventer_betaling', 'betaling_modtaget', 'pakke_sendt', 'modtaget')
                   or t.sag_aaben))
      or exists (
           select 1 from public.sager s
            where s.trade_id = p_trade
              and (s.status in ('aaben', 'afventer_retur')
                   or (s.penge_handling in ('refunder', 'frigiv') and s.afviklet_kl is null)))
      or exists (
           select 1 from public.sag_anker a
            where a.trade_id = p_trade and a.status = 'afventer');
$fn$;

revoke all on function public.handel_i_gang(uuid) from public, anon, authenticated;
grant execute on function public.handel_i_gang(uuid) to service_role;

-- Blokér en bruger ved navn (profil, chat).
create or replace function public.bloker_bruger(p_bruger uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  n     integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_bruger is null or p_bruger = public.bidhamr_system_id()
     or not exists (select 1 from public.users where id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_bruger = v_uid then
    return jsonb_build_object('kode', 'sig_selv');
  end if;
  -- Loft mod misbrug (fx et script, der blokerer alle).
  select count(*) into n from public.brugerblokeringer
   where blokerer_id = v_uid and oprettet_kl > now() - interval '1 day';
  if n >= 100 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  insert into public.brugerblokeringer (blokerer_id, blokeret_id)
  values (v_uid, p_bruger)
  on conflict (blokerer_id, blokeret_id) where kilde_auktion_id is null do nothing;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.bloker_bruger(uuid) from public, anon;
grant execute on function public.bloker_bruger(uuid) to authenticated;

-- Saelgeren spaerrer en anonym byder fra sine auktioner ud fra et af
-- byderens bud paa saelgerens auktion. Byderens id returneres aldrig, og
-- svaret er det samme, uanset om byderen allerede var blokeret.
-- Byderens afgivne bud er bindende og bliver staaende.
create or replace function public.bloker_byder(p_bud uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_byder  uuid;
  v_auktion uuid;
  n        integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;

  select b.bruger_id, a.id into v_byder, v_auktion
    from public.bids b
    join public.auctions a on a.id = b.auktion_id
   where b.id = p_bud and a.bruger_id = v_uid;
  if v_byder is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if v_byder = v_uid then
    return jsonb_build_object('kode', 'sig_selv');
  end if;

  select count(*) into n from public.brugerblokeringer
   where blokerer_id = v_uid and oprettet_kl > now() - interval '1 day';
  if n >= 100 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  insert into public.brugerblokeringer (blokerer_id, blokeret_id, kilde_auktion_id)
  values (v_uid, v_byder, v_auktion)
  on conflict (blokerer_id, blokeret_id, kilde_auktion_id)
    where kilde_auktion_id is not null do nothing;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.bloker_byder(uuid) from public, anon;
grant execute on function public.bloker_byder(uuid) to authenticated;

-- Fjern en blokering (id fra mine_blokeringer).
create or replace function public.fjern_blokering(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  n     integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  delete from public.brugerblokeringer where id = p_id and blokerer_id = v_uid;
  get diagnostics n = row_count;
  return jsonb_build_object('kode', case when n > 0 then 'ok' else 'ikke_fundet' end);
end;
$fn$;

revoke all on function public.fjern_blokering(uuid) from public, anon;
grant execute on function public.fjern_blokering(uuid) to authenticated;

-- Fjern den navngivne blokering af en bruger (knappen paa profilen).
-- Anonyme spaerringer fra auktioner beroeres ikke (ellers kunne saelgeren
-- se, om brugeren var en af dem).
create or replace function public.fjern_blokering_af_bruger(p_bruger uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  delete from public.brugerblokeringer
   where blokerer_id = v_uid and blokeret_id = p_bruger and kilde_auktion_id is null;
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.fjern_blokering_af_bruger(uuid) from public, anon;
grant execute on function public.fjern_blokering_af_bruger(uuid) to authenticated;

-- Har jeg blokeret brugeren ved navn? (Anonyme spaerringer taeller ikke.)
create or replace function public.jeg_har_blokeret(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.brugerblokeringer b
     where b.blokerer_id = auth.uid() and b.blokeret_id = p_bruger
       and b.kilde_auktion_id is null);
$fn$;

revoke all on function public.jeg_har_blokeret(uuid) from public, anon;
grant execute on function public.jeg_har_blokeret(uuid) to authenticated;

-- Mine blokeringer til listen under Min konto. Anonyme spaerringer vises
-- uden bruger-id, navn og billede - kun auktionen, de kom fra.
create or replace function public.mine_blokeringer()
returns table (
  id            uuid,
  bruger_id     uuid,
  navn          text,
  avatar_url    text,
  auktion_id    uuid,
  auktion_titel text,
  oprettet_kl   timestamptz
)
language sql
stable
security definer
set search_path = public
as $fn$
  select b.id,
         case when b.kilde_auktion_id is null then b.blokeret_id end,
         case when b.kilde_auktion_id is null then u.navn end,
         case when b.kilde_auktion_id is null then u.avatar_url end,
         b.kilde_auktion_id,
         a.titel,
         b.oprettet_kl
    from public.brugerblokeringer b
    join public.users u on u.id = b.blokeret_id
    left join public.auctions a on a.id = b.kilde_auktion_id
   where b.blokerer_id = auth.uid()
   order by b.oprettet_kl desc;
$fn$;

revoke all on function public.mine_blokeringer() from public, anon;
grant execute on function public.mine_blokeringer() to authenticated;

-- ============================================================ 1b. Bud: blokerede bydere

-- Som 20261005021000 + afvisning af bydere, saelgeren har blokeret.
create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_auktion record;
  v_bruger record;
  v_minimum numeric;
begin
  select suspenderet, suspenderet_til into v_bruger
    from public.users where id = new.bruger_id;

  if v_bruger is null then
    raise exception 'Brugeren findes ikke';
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

  -- NYT: saelgeren har blokeret/spaerret byderen.
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
$function$;

revoke execute on function public.handle_new_bid() from public, anon, authenticated;

-- ============================================================ 2. Rapporter af beskeder/brugere

create table if not exists public.bruger_rapporter (
  id           uuid primary key default gen_random_uuid(),
  -- 'bruger': en bruger har rapporteret. 'auto': spamfilteret.
  kilde        text not null default 'bruger',
  reporter_id  uuid references public.users(id) on delete restrict,
  reported_id  uuid not null references public.users(id) on delete restrict,
  message_id   uuid references public.messages(id) on delete restrict,
  trade_id     uuid references public.trades(id) on delete restrict,
  category     text not null,
  description  text,
  status       text not null default 'ny',
  handled_by   uuid references public.users(id) on delete restrict,
  handled_at   timestamptz,
  handled_note text,
  created_at   timestamptz not null default now(),
  constraint bruger_rapporter_kilde_check check (kilde in ('bruger', 'auto')),
  constraint bruger_rapporter_reporter_check check (
    (kilde = 'bruger' and reporter_id is not null) or (kilde = 'auto' and reporter_id is null)),
  constraint bruger_rapporter_category_check check (category in (
    'spam', 'chikane', 'svindel', 'betaling_udenom', 'stoedende', 'andet',
    'auto_mistaenkelig', 'auto_blokeret')),
  constraint bruger_rapporter_status_check check (status in ('ny', 'behandlet')),
  constraint bruger_rapporter_description_laengde check (
    description is null or char_length(description) <= 1000),
  constraint bruger_rapporter_note_laengde check (
    handled_note is null or char_length(handled_note) <= 2000)
);

comment on table public.bruger_rapporter is
  'Rapporter af chatbeskeder og brugerprofiler (fra brugere og fra '
  'spamfilteret). Slettes aldrig (DSA-dokumentation). Oprettes via '
  'rapporter_bruger() og messages-triggeren; staff laeser og behandler via '
  'service-role (/admin/bruger-rapporter).';

create index if not exists bruger_rapporter_status_idx
  on public.bruger_rapporter (status, created_at desc);
create index if not exists bruger_rapporter_reported_idx
  on public.bruger_rapporter (reported_id, created_at desc);
create index if not exists bruger_rapporter_reporter_idx
  on public.bruger_rapporter (reporter_id, created_at desc);
create index if not exists bruger_rapporter_message_idx
  on public.bruger_rapporter (message_id);

alter table public.bruger_rapporter enable row level security;
revoke all on public.bruger_rapporter from public, anon, authenticated;
grant select, insert, update on public.bruger_rapporter to service_role;

create or replace function public.bruger_rapporter_slettes_aldrig()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Rapporter slettes aldrig.' using errcode = '42501';
end;
$fn$;

revoke all on function public.bruger_rapporter_slettes_aldrig() from public, anon, authenticated;

drop trigger if exists bruger_rapporter_slettes_aldrig on public.bruger_rapporter;
create trigger bruger_rapporter_slettes_aldrig
  before delete on public.bruger_rapporter
  for each row execute function public.bruger_rapporter_slettes_aldrig();

-- Rapportér en besked (p_besked) eller en bruger (p_bruger, fx fra profilen).
-- Ved en besked er det beskedens afsender, der rapporteres, og kalderen skal
-- vaere part i handlen.
create or replace function public.rapporter_bruger(
  p_bruger      uuid,
  p_besked      uuid,
  p_kategori    text,
  p_beskrivelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_maal   uuid;
  v_trade  uuid;
  v_beskr  text := nullif(btrim(coalesce(p_beskrivelse, '')), '');
  m        record;
  n        integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_kategori is null or p_kategori not in
     ('spam', 'chikane', 'svindel', 'betaling_udenom', 'stoedende', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_kategori = 'andet' and v_beskr is null then
    return jsonb_build_object('kode', 'beskrivelse_mangler');
  end if;
  if v_beskr is not null and char_length(v_beskr) > 1000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  if p_besked is not null then
    select msg.id, msg.sender_id, msg.trade_id, msg.fra_bidhamr, msg.blokeret_grund,
           t.buyer_id, t.seller_id
      into m
      from public.messages msg
      join public.trades t on t.id = msg.trade_id
     where msg.id = p_besked;
    if not found or v_uid not in (m.buyer_id, m.seller_id)
       or m.fra_bidhamr or m.blokeret_grund is not null then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    if m.sender_id = v_uid then
      return jsonb_build_object('kode', 'sig_selv');
    end if;
    v_maal := m.sender_id;
    v_trade := m.trade_id;
  else
    if p_bruger is null or p_bruger = public.bidhamr_system_id()
       or not exists (select 1 from public.users where id = p_bruger) then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    if p_bruger = v_uid then
      return jsonb_build_object('kode', 'sig_selv');
    end if;
    v_maal := p_bruger;
  end if;

  -- Samme ting rapporteret igen, mens den forrige er aaben.
  if exists (
    select 1 from public.bruger_rapporter r
     where r.reporter_id = v_uid and r.status = 'ny' and r.reported_id = v_maal
       and r.message_id is not distinct from p_besked) then
    return jsonb_build_object('kode', 'findes');
  end if;

  select count(*) into n from public.bruger_rapporter
   where reporter_id = v_uid and created_at > now() - interval '1 day';
  if n >= 20 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  insert into public.bruger_rapporter
    (kilde, reporter_id, reported_id, message_id, trade_id, category, description)
  values ('bruger', v_uid, v_maal, p_besked, v_trade, p_kategori, v_beskr);

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.rapporter_bruger(uuid, uuid, text, text) from public, anon;
grant execute on function public.rapporter_bruger(uuid, uuid, text, text) to authenticated;

-- ============================================================ 3. Spamfilter

-- blokeret_grund sat = beskeden blev stoppet af spamfilteret. Den gemmes
-- (staff kan se den), men vises kun for afsenderen ("Ikke sendt").
alter table public.messages
  add column if not exists blokeret_grund text;

alter table public.messages drop constraint if exists messages_blokeret_grund_check;
alter table public.messages add constraint messages_blokeret_grund_check check (
  blokeret_grund is null or blokeret_grund in ('link', 'email', 'telefon', 'mobilepay', 'gentaget'));

comment on column public.messages.blokeret_grund is
  'Sat af spamfilteret (messages_tryghed): link, email, telefon, mobilepay '
  'eller gentaget. Beskeden vises ikke for modtageren og notificeres ikke. '
  'Kan ikke saettes eller aendres af brugere.';

create index if not exists messages_sender_created_idx
  on public.messages (sender_id, created_at desc);

-- Faelles normalisering: NFKC, smaa bogstaver, usynlige tegn fjernet.
create or replace function public.besked_normaliser(p_tekst text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select regexp_replace(
           lower(normalize(coalesce(p_tekst, ''), NFKC)),
           '[' || chr(173) || chr(8203) || '-' || chr(8207) || chr(8288) || '-' || chr(8292)
               || chr(65279) || ']', '', 'g');
$fn$;

revoke all on function public.besked_normaliser(text) from public, anon;
grant execute on function public.besked_normaliser(text) to authenticated, service_role;

-- Til "gentagne ens beskeder": kun bogstaver og tal.
create or replace function public.besked_sammenlign(p_tekst text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select regexp_replace(public.besked_normaliser(p_tekst), '[^a-z0-9æøå]', '', 'g');
$fn$;

revoke all on function public.besked_sammenlign(text) from public, anon;
grant execute on function public.besked_sammenlign(text) to authenticated, service_role;

-- Kontaktoplysninger, der skal stoppes: 'email', 'link', 'telefon',
-- 'mobilepay' eller null. Links til bidhamr.dk er tilladt.
create or replace function public.besked_spam_grund(p_tekst text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public
as $fn$
declare
  v text := public.besked_normaliser(p_tekst);
  w text;
  d text;
begin
  -- E-mail, ogsaa "navn (at) mail punktum dk" og "snabel-a".
  if v ~ '[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\msnabel-?a\M)\s*[a-z0-9-]+(\.|\s+(punktum|dot)\s+)[a-z]{2,}' then
    return 'email';
  end if;

  -- Links. bidhamr.dk fjernes foerst.
  w := regexp_replace(v, '(https?://)?(www\.)?bidhamr\.dk(/\S*)?', ' ', 'g');
  if w ~ '(https?://|www\.)'
     or w ~ '\m[a-z0-9-]{2,}\.(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app)\M'
     or w ~ '\m[a-z0-9-]{2,}\s+(punktum|dot)\s+(dk|com|net|org)\M' then
    return 'link';
  end if;

  -- Tal: mellemrum mellem cifre fjernes ("12 34 56 78" -> "12345678").
  d := regexp_replace(v, '([0-9])\s+(?=[0-9+])', '\1', 'g');
  d := regexp_replace(d, '(\+)\s+(?=[0-9])', '\1', 'g');

  -- MobilePay-nummer/boks: "mobilepay 1234", "mp: 12345".
  if d ~ '(mobile\s*pay|\mmp\M)[^0-9]{0,25}[0-9]{4,}' then
    return 'mobilepay';
  end if;

  -- Danske telefonnumre (8 cifre, foerste 2-9, evt. +45/0045) og
  -- "12-34-56-78"/"12.34.56.78". Datoer (24-12-2026) har 2-2-4 og fanges ikke.
  if d ~ '(^|[^0-9])(\+45|0045)?[2-9][0-9]{7}($|[^0-9])'
     or v ~ '(^|[^0-9])[2-9][0-9][-.][0-9]{2}[-.][0-9]{2}[-.][0-9]{2}($|[^0-9])' then
    return 'telefon';
  end if;

  return null;
end;
$fn$;

revoke all on function public.besked_spam_grund(text) from public, anon;
grant execute on function public.besked_spam_grund(text) to authenticated, service_role;

-- Mistaenkeligt (forsoeg paa at handle uden om BidHamr). Beskeden sendes,
-- men markeres til staff.
create or replace function public.besked_mistaenkelig(p_tekst text)
returns boolean
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select public.besked_normaliser(p_tekst) ~ (
    'udenom|uden om (bidhamr|bid hamr|siden|appen|platformen|gebyr)'
    || '|uden (gebyr|gebyret|gebyrer)|spar(e|er)? (gebyr|gebyret|gebyrerne)'
    || '|betal(e|er)? (direkte|privat|kontant)|direkte (overf|betaling)'
    || '|bankoverf|overf(ø|o)r(e|er|sel)? (pengene|beløbet|belobet|direkte)'
    || '|\mreg\.?\s*(nr|nummer)\M|kontonummer|kontonr'
    || '|mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M'
    || '|whats\s*app|telegram|snapchat|\msnap\M|messenger'
    || '|ring til mig|sms (til )?mig|skriv (til mig )?på (mail|sms|face|insta|snap)');
$fn$;

revoke all on function public.besked_mistaenkelig(text) from public, anon;
grant execute on function public.besked_mistaenkelig(text) to authenticated, service_role;

-- BEFORE INSERT/UPDATE paa messages: blokering, hastighed og spamfilter.
-- service_role (faellesbeskeder fra BidHamr) og postgres (seed) er undtaget.
create or replace function public.messages_tryghed()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t         record;
  v_modpart uuid;
  v_grund   text;
  v_norm    text;
  n         integer;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null
     and current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Markeringen kan ikke fjernes eller saettes af brugere.
    new.blokeret_grund := old.blokeret_grund;
    return new;
  end if;

  new.blokeret_grund := null;
  if new.fra_bidhamr then
    return new;
  end if;

  select id, buyer_id, seller_id into t from public.trades where id = new.trade_id;
  if not found then
    return new;   -- RLS/fremmednoeglen afviser
  end if;
  v_modpart := case when new.sender_id = t.buyer_id then t.seller_id else t.buyer_id end;

  -- Blokering: kun uden for en handel, der er i gang.
  if public.er_blokeret_mellem(v_modpart, new.sender_id)
     and not public.handel_i_gang(t.id) then
    raise exception 'Du kan ikke skrive til denne bruger.' using errcode = 'BHB01';
  end if;

  -- For mange beskeder: 10 pr. minut og 150 pr. time (alle handler).
  select count(*) into n from public.messages
   where sender_id = new.sender_id and created_at > now() - interval '1 minute';
  if n >= 10 then
    raise exception 'Du sender beskeder for hurtigt.' using errcode = 'BHM03';
  end if;
  select count(*) into n from public.messages
   where sender_id = new.sender_id and created_at > now() - interval '1 hour';
  if n >= 150 then
    raise exception 'Du sender beskeder for hurtigt.' using errcode = 'BHM03';
  end if;

  v_grund := public.besked_spam_grund(new.content);

  -- Gentagne ens beskeder: den tredje ens besked inden for 30 minutter
  -- (i alle handler) stoppes. Korte svar ("ok", "tak") taeller ikke.
  if v_grund is null and char_length(btrim(new.content)) >= 10 then
    v_norm := public.besked_sammenlign(new.content);
    select count(*) into n from public.messages m
     where m.sender_id = new.sender_id
       and m.created_at > now() - interval '30 minutes'
       and public.besked_sammenlign(m.content) = v_norm;
    if n >= 2 then
      v_grund := 'gentaget';
    end if;
  end if;

  new.blokeret_grund := v_grund;
  return new;
end;
$fn$;

revoke all on function public.messages_tryghed() from public, anon, authenticated;

drop trigger if exists messages_tryghed on public.messages;
create trigger messages_tryghed
  before insert or update on public.messages
  for each row execute function public.messages_tryghed();

-- AFTER INSERT: rapport til staff ved mistaenkelige beskeder og gentagne
-- blokerede forsoeg (hoejst én aaben auto-rapport pr. afsender/handel).
create or replace function public.messages_spam_rapport()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  if coalesce(auth.role(), '') = 'service_role' or new.fra_bidhamr then
    return null;
  end if;
  if auth.uid() is null
     and current_user in ('postgres', 'supabase_admin', 'service_role') then
    return null;
  end if;

  if new.blokeret_grund is null then
    if public.besked_mistaenkelig(new.content)
       and not exists (
         select 1 from public.bruger_rapporter r
          where r.kilde = 'auto' and r.status = 'ny'
            and r.category = 'auto_mistaenkelig'
            and r.reported_id = new.sender_id and r.trade_id = new.trade_id) then
      insert into public.bruger_rapporter
        (kilde, reporter_id, reported_id, message_id, trade_id, category, description)
      values ('auto', null, new.sender_id, new.id, new.trade_id, 'auto_mistaenkelig',
              'Spamfilteret har markeret beskeden: mulig handel eller betaling uden om BidHamr.');
    end if;
  else
    select count(*) into n from public.messages
     where sender_id = new.sender_id and blokeret_grund is not null
       and created_at > now() - interval '24 hours';
    if n >= 3 and not exists (
         select 1 from public.bruger_rapporter r
          where r.kilde = 'auto' and r.status = 'ny'
            and r.category = 'auto_blokeret' and r.reported_id = new.sender_id) then
      insert into public.bruger_rapporter
        (kilde, reporter_id, reported_id, message_id, trade_id, category, description)
      values ('auto', null, new.sender_id, new.id, new.trade_id, 'auto_blokeret',
              'Spamfilteret har stoppet ' || n || ' beskeder fra brugeren det seneste døgn '
              || '(seneste grund: ' || new.blokeret_grund || ').');
    end if;
  end if;
  return null;
end;
$fn$;

revoke all on function public.messages_spam_rapport() from public, anon, authenticated;

drop trigger if exists messages_spam_rapport on public.messages;
create trigger messages_spam_rapport
  after insert on public.messages
  for each row execute function public.messages_spam_rapport();

-- Modtageren ser ikke spamblokerede beskeder (heller ikke via realtime, som
-- respekterer RLS). Afsenderen ser sine egne ("Ikke sendt"). Staff ser alt.
-- Som 20260903000000 + betingelsen paa blokeret_grund.
drop policy if exists messages_select_part on public.messages;
create policy messages_select_part on public.messages
  for select using (
    public.er_staff() or exists (
      select 1 from public.trades t
       where t.id = messages.trade_id
         and (auth.uid() = t.buyer_id or auth.uid() = t.seller_id)
         and (messages.blokeret_grund is null or messages.sender_id = auth.uid())
    )
  );

-- ============================================================ 4. Kontaktformular

create table if not exists public.kontakt_henvendelser (
  id           uuid primary key default gen_random_uuid(),
  bruger_id    uuid references public.users(id) on delete set null,
  email        text not null,
  emne         text not null,
  besked       text not null,
  -- Det, brugeren skrev i "Handels-id" (valgfrit). trade_id saettes kun,
  -- naar det er en handel, brugeren selv er part i.
  handels_ref  text,
  trade_id     uuid references public.trades(id) on delete restrict,
  status       text not null default 'ny',
  besvaret_af  uuid references public.users(id) on delete restrict,
  besvaret_kl  timestamptz,
  oprettet_kl  timestamptz not null default now(),
  constraint kontakt_emne_check check (emne in ('generelt', 'handel', 'betaling', 'fejl')),
  constraint kontakt_status_check check (status in ('ny', 'besvaret')),
  constraint kontakt_email_laengde check (char_length(email) between 3 and 254),
  constraint kontakt_besked_laengde check (char_length(btrim(besked)) between 10 and 4000),
  constraint kontakt_ref_laengde check (handels_ref is null or char_length(handels_ref) <= 100)
);

comment on table public.kontakt_henvendelser is
  'Henvendelser fra kontaktformularen (/kontakt). Oprettes af serveren med '
  'service-role efter rate-limit og honeypot. Behandles i /admin/kontakt. '
  'Slettes aldrig.';

create index if not exists kontakt_henvendelser_status_idx
  on public.kontakt_henvendelser (status, oprettet_kl desc);
create index if not exists kontakt_henvendelser_bruger_idx
  on public.kontakt_henvendelser (bruger_id, oprettet_kl desc);

alter table public.kontakt_henvendelser enable row level security;
revoke all on public.kontakt_henvendelser from public, anon, authenticated;
grant select, insert, update on public.kontakt_henvendelser to service_role;

create or replace function public.kontakt_slettes_aldrig()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Henvendelser slettes aldrig.' using errcode = '42501';
end;
$fn$;

revoke all on function public.kontakt_slettes_aldrig() from public, anon, authenticated;

drop trigger if exists kontakt_slettes_aldrig on public.kontakt_henvendelser;
create trigger kontakt_slettes_aldrig
  before delete on public.kontakt_henvendelser
  for each row execute function public.kontakt_slettes_aldrig();

-- ============================================================ 5. Adresse og telefon

-- users.email/telefon/adresse kan ikke laeses af anon/authenticated
-- (kolonne-grants i 20260930100000). Grant-listen gentages her, saa en
-- frisk database og produktion er ens.
revoke select on table public.users from anon, authenticated;
grant select (id, navn, avatar_url, rating, oprettet)
  on table public.users to anon, authenticated;

-- Egne kontaktoplysninger (Min profil -> Indstillinger).
create or replace function public.mine_kontaktoplysninger()
returns table (email text, telefon text, adresse text)
language sql
stable
security definer
set search_path = public
as $fn$
  select u.email, u.telefon, u.adresse from public.users u where u.id = auth.uid();
$fn$;

revoke all on function public.mine_kontaktoplysninger() from public, anon;
grant execute on function public.mine_kontaktoplysninger() to authenticated;

-- Saelgerens afhentningsadresse og telefon til KOEBEREN - kun ved en
-- afhentningshandel, der er betalt og endnu ikke afhentet.
create or replace function public.handel_afhentningsadresse(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  t record;
  u record;
begin
  select id, buyer_id, seller_id, status, afhentning into t
    from public.trades where id = p_trade;
  if not found or auth.uid() is null or t.buyer_id <> auth.uid()
     or not t.afhentning or t.status <> 'betaling_modtaget' then
    return jsonb_build_object('kode', 'ikke_tilgaengelig');
  end if;
  select navn, adresse, telefon into u from public.users where id = t.seller_id;
  return jsonb_build_object(
    'kode', 'ok',
    'navn', u.navn,
    'adresse', nullif(btrim(coalesce(u.adresse, '')), ''),
    'telefon', nullif(btrim(coalesce(u.telefon, '')), ''));
end;
$fn$;

revoke all on function public.handel_afhentningsadresse(uuid) from public, anon;
grant execute on function public.handel_afhentningsadresse(uuid) to authenticated;

-- Adressen bruges kun til afhentning (Min profil -> Indstillinger).
-- NOT VALID: eksisterende raekker tjekkes ikke, kun nye/aendrede.
do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'users_adresse_laengde'
                    and conrelid = 'public.users'::regclass) then
    alter table public.users
      add constraint users_adresse_laengde
      check (adresse is null or char_length(adresse) <= 300) not valid;
  end if;
end $do$;
