-- Notifikationssystem (ROADMAP-BESLUTNINGER afsnit 5, udvidet 2. oktober 2026).
--
-- Kanaler: klokke (notifikationer-tabellen), mail og push (Expo, appen).
-- Brugeren vaelger kanal(er) pr. type. Paakraevede typer kan ikke slaas helt
-- fra - mindst een kanal skal vaere til. Uden en raekke i
-- notifikation_indstillinger er alle kanaler til.
--
-- Typerne og paakraevet-flaget findes ogsaa i src/lib/notifikationer/typer.ts.
-- AENDRES DE, SKAL BEGGE STEDER RETTES (check-constraints + notifikation_paakraevet).
--
-- Tabeller:
--   notifikationer             - klokken/indbakken. Slettes ikke.
--   notifikation_indstillinger - kanalvalg pr. (bruger, type).
--   push_tokens                - findes allerede (appen); kun funktioner her.
--   notifikation_afsendelser   - idempotens: en noegle sendes hoejst een gang.
--
-- Skrivning sker KUN via security definer-funktioner (bruger) eller
-- service_role (server). Ingen insert/update/delete-grants til browseren.
-- Undtagelse: push_tokens, som appen selv skriver i via sine RLS-policies.
--
-- Idempotent: if not exists / create or replace / drop policy if exists.

-- ============================================================ Typer

create or replace function public.notifikation_paakraevet(p_type text)
returns boolean
language sql immutable set search_path = public as $fn$
  select p_type = any (array[
    'vundet', 'betalingsfrist', 'betaling_modtaget', 'pakke_sendt',
    'pakke_leveret', 'udbetaling', 'sag', 'advarsel', 'andenchance'
  ]);
$fn$;

create or replace function public.notifikation_kendt_type(p_type text)
returns boolean
language sql immutable set search_path = public as $fn$
  select public.notifikation_paakraevet(p_type) or p_type = any (array[
    'overbudt', 'bud_paa_egen', 'like', 'fulgt_slutter_snart',
    'ny_auktion_fulgt_saelger', 'ny_besked'
  ]);
$fn$;

-- Rene hjaelpere uden dataadgang; maa gerne kaldes af alle.
grant execute on function public.notifikation_paakraevet(text) to anon, authenticated, service_role;
grant execute on function public.notifikation_kendt_type(text) to anon, authenticated, service_role;

-- ============================================================ notifikationer

create table if not exists public.notifikationer (
  id          uuid primary key default gen_random_uuid(),
  bruger_id   uuid not null references public.users(id) on delete cascade,
  type        text not null,
  titel       text not null,
  tekst       text not null,
  link        text,
  data        jsonb not null default '{}'::jsonb,
  laest_kl    timestamptz,
  oprettet_kl timestamptz not null default now(),
  constraint notifikationer_type_gyldig check (public.notifikation_kendt_type(type)),
  constraint notifikationer_titel_laengde check (char_length(titel) between 1 and 200),
  constraint notifikationer_tekst_laengde check (char_length(tekst) <= 2000),
  -- Kun interne stier: starter med '/', men ikke '//' (protokol-relativ URL)
  -- og ingen backslash (browsere tolker '/\' som '//').
  constraint notifikationer_link_intern check (
    link is null or (link like '/%' and link not like '//%'
                     and position(chr(92) in link) = 0
                     and char_length(link) <= 500))
);

create index if not exists notifikationer_bruger_idx
  on public.notifikationer (bruger_id, oprettet_kl desc);
create index if not exists notifikationer_ulaeste_idx
  on public.notifikationer (bruger_id) where laest_kl is null;

alter table public.notifikationer enable row level security;

drop policy if exists notifikationer_select_own on public.notifikationer;
create policy notifikationer_select_own on public.notifikationer
  for select to authenticated using (bruger_id = auth.uid());

revoke all on public.notifikationer from anon, authenticated;
grant select on public.notifikationer to authenticated;
grant all on public.notifikationer to service_role;

-- Markér udvalgte notifikationer som laest. Kun egne; kun laest_kl aendres.
-- Idempotent: allerede laeste roeres ikke. Returnerer antal markerede.
create or replace function public.notifikationer_marker_laest(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  v_antal integer;
begin
  if auth.uid() is null then raise exception 'Du skal være logget ind.'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if cardinality(p_ids) > 500 then raise exception 'For mange notifikationer på én gang.'; end if;
  update public.notifikationer
     set laest_kl = now()
   where bruger_id = auth.uid()
     and id = any (p_ids)
     and laest_kl is null;
  get diagnostics v_antal = row_count;
  return v_antal;
end;
$fn$;

create or replace function public.notifikationer_marker_alle_laest()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  v_antal integer;
begin
  if auth.uid() is null then raise exception 'Du skal være logget ind.'; end if;
  update public.notifikationer
     set laest_kl = now()
   where bruger_id = auth.uid()
     and laest_kl is null;
  get diagnostics v_antal = row_count;
  return v_antal;
end;
$fn$;

create or replace function public.notifikationer_antal_ulaeste()
returns integer
language sql stable security definer set search_path = public as $fn$
  select count(*)::integer from public.notifikationer
   where bruger_id = auth.uid() and laest_kl is null;
$fn$;

revoke all on function public.notifikationer_marker_laest(uuid[]) from public, anon;
revoke all on function public.notifikationer_marker_alle_laest() from public, anon;
revoke all on function public.notifikationer_antal_ulaeste() from public, anon;
grant execute on function public.notifikationer_marker_laest(uuid[]) to authenticated;
grant execute on function public.notifikationer_marker_alle_laest() to authenticated;
grant execute on function public.notifikationer_antal_ulaeste() to authenticated;

-- ============================================================ Indstillinger

create table if not exists public.notifikation_indstillinger (
  bruger_id    uuid not null references public.users(id) on delete cascade,
  type         text not null,
  klokke       boolean not null default true,
  mail         boolean not null default true,
  push         boolean not null default true,
  opdateret_kl timestamptz not null default now(),
  primary key (bruger_id, type),
  constraint notifikation_indstillinger_type_gyldig check (public.notifikation_kendt_type(type)),
  -- Vaern i bunden: en paakraevet type kan aldrig ende med alle kanaler fra.
  constraint notifikation_indstillinger_paakraevet check (
    not public.notifikation_paakraevet(type) or klokke or mail or push)
);

alter table public.notifikation_indstillinger enable row level security;

drop policy if exists notifikation_indstillinger_select_own on public.notifikation_indstillinger;
create policy notifikation_indstillinger_select_own on public.notifikation_indstillinger
  for select to authenticated using (bruger_id = auth.uid());

revoke all on public.notifikation_indstillinger from anon, authenticated;
grant select on public.notifikation_indstillinger to authenticated;
grant all on public.notifikation_indstillinger to service_role;

-- Gem en eller flere indstillinger atomisk for den kaldende bruger.
-- p_indstillinger: [{"type": "overbudt", "klokke": true, "mail": false, "push": true}, ...]
-- Returnerer {"kode": "ok"} eller en fejlkode:
--   ikke_logget_ind, ugyldigt_format, ukendt_type, mindst_en_kanal (+ "type").
-- Valideres helt foer noget gemmes, saa intet gemmes halvt.
create or replace function public.notifikation_gem_indstillinger(p_indstillinger jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_bruger uuid := auth.uid();
  r        jsonb;
  v_type   text;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if p_indstillinger is null or jsonb_typeof(p_indstillinger) <> 'array'
     or jsonb_array_length(p_indstillinger) > 50 then
    return jsonb_build_object('kode', 'ugyldigt_format');
  end if;

  for r in select * from jsonb_array_elements(p_indstillinger) loop
    if jsonb_typeof(r) <> 'object'
       or jsonb_typeof(r->'type') is distinct from 'string'
       or jsonb_typeof(r->'klokke') is distinct from 'boolean'
       or jsonb_typeof(r->'mail') is distinct from 'boolean'
       or jsonb_typeof(r->'push') is distinct from 'boolean' then
      return jsonb_build_object('kode', 'ugyldigt_format');
    end if;
    v_type := r->>'type';
    if not public.notifikation_kendt_type(v_type) then
      return jsonb_build_object('kode', 'ukendt_type', 'type', v_type);
    end if;
    if public.notifikation_paakraevet(v_type)
       and not ((r->>'klokke')::boolean or (r->>'mail')::boolean or (r->>'push')::boolean) then
      return jsonb_build_object('kode', 'mindst_en_kanal', 'type', v_type);
    end if;
  end loop;

  for r in select * from jsonb_array_elements(p_indstillinger) loop
    insert into public.notifikation_indstillinger (bruger_id, type, klokke, mail, push, opdateret_kl)
    values (v_bruger, r->>'type', (r->>'klokke')::boolean, (r->>'mail')::boolean,
            (r->>'push')::boolean, now())
    on conflict (bruger_id, type) do update
      set klokke = excluded.klokke,
          mail = excluded.mail,
          push = excluded.push,
          opdateret_kl = now();
  end loop;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.notifikation_gem_indstillinger(jsonb) from public, anon;
grant execute on function public.notifikation_gem_indstillinger(jsonb) to authenticated;

-- ============================================================ Push tokens

-- public.push_tokens findes allerede (lavet af appen; indfanget i
-- 20260930130000_indfang_prod_drift.sql, with check i
-- 20261001025000_push_tokens_with_check.sql):
--   push_tokens(id, user_id, token unique, platform in ('ios','android','web'),
--               created_at, updated_at)
-- med RLS-policies push_tokens_select_own/insert_own/update_own/delete_own
-- (auth.uid() = user_id). Appen skriver direkte i den, saa tabellen, dens
-- kolonner, policies og grants roeres IKKE her. Der er bevidst ingen
-- format-check paa token: serveren sender kun Expo-push til tokens i
-- Expo-format (src/lib/notifikationer/send.ts) og springer resten over.
--
-- Funktionerne nedenfor er en ekstra, valgfri indgang (bruges af
-- server actions og kan bruges af appen), der ogsaa haandhaever hoejst
-- 10 enheder pr. bruger.

-- Et token hoerer til een enhed. Tilhoerer det allerede en anden bruger,
-- aendres intet (appen fjerner det ved log ud).
-- Returnerer {"kode": "ok"} eller ikke_logget_ind / ugyldigt_token / ugyldig_platform.
create or replace function public.push_token_registrer(p_token text, p_platform text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_bruger uuid := auth.uid();
  v_token  text := btrim(p_token);
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  -- Ingen formatkrav (web-tokens er ikke Expo-tokens), kun fornuftig laengde
  -- og ingen whitespace/kontroltegn.
  if v_token is null or char_length(v_token) not between 1 and 2000
     or v_token ~ '[[:space:][:cntrl:]]' then
    return jsonb_build_object('kode', 'ugyldigt_token');
  end if;
  if p_platform is null or p_platform not in ('ios', 'android', 'web') then
    return jsonb_build_object('kode', 'ugyldig_platform');
  end if;

  insert into public.push_tokens (user_id, token, platform)
  values (v_bruger, v_token, p_platform)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = now()
    -- Et token, der tilhoerer en anden bruger, overtages ikke (ellers kunne
    -- den, der kender tokenet, kapre push-beskeder). Appen fjerner tokenet
    -- ved log ud (push_token_fjern).
    where push_tokens.user_id = v_bruger;

  -- Hoejst 10 enheder pr. bruger: de aeldste (sidst opdateret) fjernes.
  delete from public.push_tokens
   where user_id = v_bruger
     and id not in (select id from public.push_tokens
                     where user_id = v_bruger
                     order by updated_at desc, created_at desc limit 10);

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- Ved log ud. Kun eget token kan fjernes.
create or replace function public.push_token_fjern(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  delete from public.push_tokens where token = btrim(p_token) and user_id = auth.uid();
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.push_token_registrer(text, text) from public, anon;
revoke all on function public.push_token_fjern(text) from public, anon;
grant execute on function public.push_token_registrer(text, text) to authenticated;
grant execute on function public.push_token_fjern(text) to authenticated;

-- ============================================================ Idempotens

-- En noegle (fx 'overbudt:<bud-id>:<bruger-id>') claimes FOER afsendelse, saa
-- samme begivenhed aldrig giver to notifikationer - heller ikke hvis to
-- cron-koersler overlapper. Kun service_role.
create table if not exists public.notifikation_afsendelser (
  noegle      text primary key,
  bruger_id   uuid references public.users(id) on delete cascade,
  type        text not null,
  oprettet_kl timestamptz not null default now(),
  constraint notifikation_afsendelser_noegle_laengde check (char_length(noegle) <= 300)
);

alter table public.notifikation_afsendelser enable row level security;
revoke all on public.notifikation_afsendelser from anon, authenticated;
grant all on public.notifikation_afsendelser to service_role;
