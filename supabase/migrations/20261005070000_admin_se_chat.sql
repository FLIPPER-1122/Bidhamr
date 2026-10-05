-- Admin: staff kan laese chatten mellem koeber og saelger paa en handel
-- (/admin/handler/<id>/chat, medarbejder og op). Siden henter beskederne med
-- service-role-klienten efter assertRole() paa serveren; selve laesningen
-- kraever derfor ingen ny RLS.
--
-- Laesning af en privat chat logges i moderation_log med den nye handling
-- 'chat_laest' (maal_type 'handel', maal_id = trade id):
--
--   admin_log_chat_laest(p_medarbejder, p_trade)
--       Skriver hoejst én raekke pr. medarbejder pr. handel pr. 10 minutter
--       (dedup). Kun service_role - serveren kalder den med det id, den selv
--       har udledt af sessionen (assertRole). Funktionen tjekker rollen igen.
--       Returnerer {"kode": "ok" | "dedup" | "ikke_staff" | "ikke_fundet"}.
--
-- Idempotent: drop/add constraint + create or replace. Kan koeres flere gange.

-- ============================================================ moderation_log

-- Bevarer ALLE vaerdier fra 20261004050000_anke.sql (seneste definition) og
-- tilfoejer 'chat_laest'.
alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
    'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest',
    'chat_aabnet','chat_lukket','faellesbesked',
    'sag_afgjort_koeber','sag_afgjort_saelger','sag_retur_afleveret',
    'sag_genaabnet','konto_lukket','sag_afviklet',
    'indpakning_paamindelse','konto_lukning_foreslaaet','konto_lukning_afvist',
    'udbetalingskonto_loest',
    'udbetalingskonto_nulstillet',
    'rapport_behandlet',
    'sag_anke_indgivet','sag_anke_stadfaestet','sag_anke_omgjort',
    'chat_laest'));

-- Dedup-opslaget: seneste post for (medarbejder, handling, maal).
create index if not exists moderation_log_medarbejder_maal_idx
  on public.moderation_log (medarbejder_id, handling, maal_id, oprettet_kl desc);

-- ============================================================ admin_log_chat_laest

create or replace function public.admin_log_chat_laest(p_medarbejder uuid, p_trade uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rolle text;
begin
  if p_medarbejder is null or p_trade is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select u.rolle into v_rolle from public.users u where u.id = p_medarbejder;
  if v_rolle is null or v_rolle not in ('medarbejder', 'admin', 'chef') then
    return jsonb_build_object('kode', 'ikke_staff');
  end if;

  if not exists (select 1 from public.trades t where t.id = p_trade) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Serialiserer samtidige kald for samme medarbejder+handel (fx to faner),
  -- saa dedup-tjekket og insert ikke kan overhale hinanden.
  perform pg_advisory_xact_lock(
    hashtextextended('chat_laest:' || p_medarbejder::text || ':' || p_trade::text, 0));

  if exists (
    select 1 from public.moderation_log m
     where m.medarbejder_id = p_medarbejder
       and m.handling = 'chat_laest'
       and m.maal_type = 'handel'
       and m.maal_id = p_trade
       and m.oprettet_kl > now() - interval '10 minutes'
  ) then
    return jsonb_build_object('kode', 'dedup');
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'chat_laest', 'handel', p_trade, null,
          'Læste chatten mellem køber og sælger');

  return jsonb_build_object('kode', 'ok');
end;
$$;

revoke all on function public.admin_log_chat_laest(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_log_chat_laest(uuid, uuid) to service_role;
