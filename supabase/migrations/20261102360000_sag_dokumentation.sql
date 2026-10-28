-- Dokumentation til sælger og til politiet (ROADMAP-BESLUTNINGER, "Dokumentation
-- til politiet (Filip, 27. okt. 2026)").
--
-- Staff laver en PDF med sagens dokumentation på admin-sagssiden. To udgaver:
--   'saelger' - kun det, sælgeren i forvejen har adgang til. Staff
--               (medarbejder/admin/chef), der ikke er inhabile.
--   'politi'  - den fulde udgave (MitID, e-mail, telefon, log). Kun chefen,
--               og kun hvis chefen ikke er inhabil.
-- PDF'en gemmes ikke. Hver udlevering logges her: hvem, hvornår, hvilken
-- udgave og til hvem. Rækkerne kan ikke ændres eller slettes
-- (bogføringsloven/GDPR art. 5, stk. 2 - vi skal kunne vise, hvad der er
-- udleveret til hvem). Kun chefen kan se rækkerne for udgaven 'politi'.
--
-- Indhold:
--   1. Tabellen sag_dokumentation_udlevering (RLS, ingen adgang for
--      anon/authenticated - kun service-role via funktionerne nedenfor).
--   2. Triggere, der afviser update, delete og truncate.
--   3. sag_dokumentation_log(...)   - logger en udlevering (tjekker rolle og
--      inhabilitet igen i databasen). Kun service-role.
--   4. sag_dokumentation_liste(...) - logrækkerne for en sag, filtreret efter
--      rollen (staff ser kun 'saelger', chefen ser alle). Kun service-role.
--
-- Idempotent: create table if not exists / create or replace / drop trigger
-- if exists. Ingen handelsdata ændres.

-- ============================================================ 1. Tabellen

create table if not exists public.sag_dokumentation_udlevering (
  id            uuid primary key default gen_random_uuid(),
  sag_id        uuid not null references public.sager(id),
  trade_id      uuid not null references public.trades(id),
  udgave        text not null,
  givet_til     text not null,
  journalnummer text,
  lavet_af      uuid not null references public.users(id),
  lavet_kl      timestamptz not null default now(),
  constraint sag_dokumentation_udgave check (udgave in ('saelger', 'politi')),
  constraint sag_dokumentation_givet_til check (char_length(btrim(givet_til)) between 2 and 200),
  constraint sag_dokumentation_journalnummer check (journalnummer is null or char_length(btrim(journalnummer)) between 1 and 100)
);

create index if not exists sag_dokumentation_udlevering_sag_idx
  on public.sag_dokumentation_udlevering (sag_id, lavet_kl desc);

comment on table public.sag_dokumentation_udlevering is
  'Log over udleveret sagsdokumentation (PDF til sælger eller politi). Kan ikke ændres eller slettes. '
  'Kun service-role; læses via sag_dokumentation_liste (kun chefen ser udgaven politi). Migration 20261102360000.';

alter table public.sag_dokumentation_udlevering enable row level security;
-- Ingen policies: browseren har ingen adgang. Serveren bruger funktionerne.
revoke all on table public.sag_dokumentation_udlevering from public, anon, authenticated;
-- Selv service-role kan kun indsætte og læse (triggerne nedenfor afviser
-- også ændringer fra ejeren).
revoke update, delete, truncate on table public.sag_dokumentation_udlevering from service_role;
grant select, insert on table public.sag_dokumentation_udlevering to service_role;

-- ============================================================ 2. Kan ikke ændres

create or replace function public.sag_dokumentation_kan_ikke_aendres()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'Udleveringer af sagsdokumentation kan ikke ændres eller slettes'
    using errcode = '42501';
end
$fn$;

revoke execute on function public.sag_dokumentation_kan_ikke_aendres() from public, anon, authenticated;

drop trigger if exists sag_dokumentation_ingen_aendring on public.sag_dokumentation_udlevering;
create trigger sag_dokumentation_ingen_aendring
  before update or delete on public.sag_dokumentation_udlevering
  for each row execute function public.sag_dokumentation_kan_ikke_aendres();

drop trigger if exists sag_dokumentation_ingen_truncate on public.sag_dokumentation_udlevering;
create trigger sag_dokumentation_ingen_truncate
  before truncate on public.sag_dokumentation_udlevering
  for each statement execute function public.sag_dokumentation_kan_ikke_aendres();

-- ============================================================ 3. Log en udlevering

-- Kaldes af serveren (route /admin/sager/[id]/dokumentation), efter PDF'en er
-- lavet og før den sendes. Fejler loggen, sendes PDF'en ikke.
-- p_medarbejder er den indloggede staff, som serveren har tjekket
-- (to-trins-login osv.). Funktionen er kun for service-role, så browseren kan
-- ikke kalde den med en anden brugers id. Rollen og inhabiliteten tjekkes
-- igen her.
-- Returnerer {"kode": "ok", "id", "lavet_kl"} eller en fejlkode:
--   ingen_adgang, ugyldig_udgave, ugyldig_sag, inhabil, ugyldig_tekst.
create or replace function public.sag_dokumentation_log(
  p_medarbejder   uuid,
  p_sag           uuid,
  p_udgave        text,
  p_givet_til     text,
  p_journalnummer text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_givet  text := btrim(coalesce(p_givet_til, ''));
  v_journ  text := nullif(btrim(coalesce(p_journalnummer, '')), '');
  v_trade  uuid;
  v_koeber uuid;
  v_saelg  uuid;
  v_id     uuid;
  v_kl     timestamptz;
begin
  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_udgave is null or p_udgave not in ('saelger', 'politi') then
    return jsonb_build_object('kode', 'ugyldig_udgave');
  end if;
  if p_udgave = 'politi' and not public.staff_chat_har_rolle(p_medarbejder, 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  select s.trade_id, t.buyer_id, t.seller_id
    into v_trade, v_koeber, v_saelg
    from public.sager s
    join public.trades t on t.id = s.trade_id
   where s.id = p_sag;
  if v_trade is null then
    return jsonb_build_object('kode', 'ugyldig_sag');
  end if;

  if public.penge_inhabil(p_medarbejder, v_koeber, v_saelg) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if char_length(v_givet) < 2 or char_length(v_givet) > 200
     or (v_journ is not null and char_length(v_journ) > 100) then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  insert into public.sag_dokumentation_udlevering (sag_id, trade_id, udgave, givet_til, journalnummer, lavet_af)
  values (p_sag, v_trade, p_udgave, v_givet, v_journ, p_medarbejder)
  returning id, lavet_kl into v_id, v_kl;

  return jsonb_build_object('kode', 'ok', 'id', v_id, 'lavet_kl', v_kl);
end
$fn$;

revoke all on function public.sag_dokumentation_log(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sag_dokumentation_log(uuid, uuid, text, text, text) to service_role;

-- ============================================================ 4. Læs loggen

-- Logrækkerne for en sag, nyeste først. Staff ser kun udgaven 'saelger';
-- chefen ser alle. Ikke-staff får ingen rækker.
create or replace function public.sag_dokumentation_liste(p_medarbejder uuid, p_sag uuid)
returns table (
  id            uuid,
  udgave        text,
  givet_til     text,
  journalnummer text,
  lavet_af      uuid,
  lavet_af_navn text,
  lavet_kl      timestamptz
)
language sql
stable
security definer
set search_path = public
as $fn$
  select d.id, d.udgave, d.givet_til, d.journalnummer, d.lavet_af, u.navn, d.lavet_kl
    from public.sag_dokumentation_udlevering d
    left join public.users u on u.id = d.lavet_af
   where d.sag_id = p_sag
     and p_medarbejder is not null
     and public.staff_chat_har_rolle(p_medarbejder, 'medarbejder')
     and (d.udgave = 'saelger' or public.staff_chat_har_rolle(p_medarbejder, 'chef'))
   order by d.lavet_kl desc
   limit 200;
$fn$;

revoke all on function public.sag_dokumentation_liste(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sag_dokumentation_liste(uuid, uuid) to service_role;
