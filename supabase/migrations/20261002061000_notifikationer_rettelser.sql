-- Rettelser til notifikationssystemet (reviewer-fund paa 20261002060000_notifikationer.sql).
--
-- M1: idempotensnoeglen gemmes ikke laengere i notifikationer.data (en
--     like-noegle indeholdt likerens bruger-id, som saelgeren kunne laese).
--     Eksisterende raekker renses.
-- M3: push_token_registrer: sidste registrering vinder igen.
-- M4: notifikation_system.start_kl - cron sender aldrig for haendelser foer
--     systemet blev slaaet til (ellers ville gamle likes/beskeder/bud blive
--     sendt paa een gang ved foerste koersel).
--
-- Idempotent: if not exists / create or replace / on conflict do nothing.

-- ============================================================ M1

update public.notifikationer
   set data = data - 'noegle'
 where data ? 'noegle';

-- ============================================================ M3

-- Et token hoerer til een enhed. Logger en anden bruger ind paa enheden,
-- overtager den nye bruger tokenet (sidste registrering vinder), saa push
-- gaar til den, der er logget ind nu - ikke til den forrige bruger.
-- At "kapre" et token kraever, at man kender det; det er en enhedshemmelighed
-- fra Expo, og den, der har det, kan i forvejen kun aendre, hvor enhedens
-- egen push lander. Appen fjerner tokenet ved log ud (push_token_fjern).
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
        updated_at = now();

  -- Hoejst 10 enheder pr. bruger: de aeldste (sidst opdateret) fjernes.
  delete from public.push_tokens
   where user_id = v_bruger
     and id not in (select id from public.push_tokens
                     where user_id = v_bruger
                     order by updated_at desc, created_at desc limit 10);

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.push_token_registrer(text, text) from public, anon;
grant execute on function public.push_token_registrer(text, text) to authenticated;

-- ============================================================ M4

-- Een raekke (id = 1). start_kl saettes, naar migrationen koeres, og aendres
-- ikke ved gentagen koersel. Kun service_role (cron) laeser den.
create table if not exists public.notifikation_system (
  id       integer primary key default 1,
  start_kl timestamptz not null default now(),
  constraint notifikation_system_en_raekke check (id = 1)
);

insert into public.notifikation_system (id, start_kl)
values (1, now())
on conflict (id) do nothing;

alter table public.notifikation_system enable row level security;
revoke all on public.notifikation_system from public, anon, authenticated;
grant all on public.notifikation_system to service_role;

-- Cron'en henter nye bud paa tvaers af auktioner efter tidspunkt.
create index if not exists bids_oprettet_idx on public.bids (oprettet desc);
-- ... og nye beskeder paa tvaers af handler.
create index if not exists messages_created_at_idx on public.messages (created_at desc);
