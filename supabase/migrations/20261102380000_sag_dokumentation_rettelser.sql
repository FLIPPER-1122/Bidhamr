-- Rettelser efter review af "Dokumentation til sælger og politi"
-- (20261102360000_sag_dokumentation.sql).
--
--   1. (Fravalgt efter genreview 28. okt. 2026: krav om aktivt to-trins-login
--      i databasen blokerede alle staff, så længe ADMIN_VAERT er slået fra.
--      To-trins-login håndhæves af routen via assertRole, som i resten af
--      admin; kravet i databasen kommer med den planlagte aal2-migration.)
--   2. Loftet på højst 30 PDF'er pr. medarbejder pr. time tælles nu her, under
--      en pg_advisory_xact_lock pr. medarbejder, så samtidige forespørgsler
--      ikke kan komme over loftet. Ny fejlkode: for_mange.
--      (Routen tæller stadig først for at spare arbejdet med PDF'en, men det
--      er databasen, der afgør.)
--   4. Indeks til tællingen (lavet_af, lavet_kl).
--
-- Idempotent: create index if not exists / create or replace. Samme
-- signaturer som før, så grants og kald er uændrede. Ingen data ændres.

create index if not exists sag_dokumentation_udlevering_lavet_af_idx
  on public.sag_dokumentation_udlevering (lavet_af, lavet_kl desc);

-- ============================================================ Log en udlevering

-- Kaldes af serveren (route /admin/sager/[id]/dokumentation), efter PDF'en er
-- lavet og før den sendes. Fejler loggen, sendes PDF'en ikke.
-- p_medarbejder er den indloggede staff, som serveren har tjekket. Funktionen
-- er kun for service-role, så browseren kan ikke kalde den med en anden
-- brugers id. Rolle, inhabilitet og loftet tjekkes her.
-- Returnerer {"kode": "ok", "id", "lavet_kl"} eller en fejlkode:
--   ingen_adgang, ugyldig_udgave, ugyldig_sag, inhabil,
--   ugyldig_tekst, for_mange.
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
  v_antal  integer;
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

  -- Én ad gangen pr. medarbejder, til transaktionen slutter: tælling og
  -- indsættelse kan ikke flettes med en samtidig forespørgsel.
  perform pg_advisory_xact_lock(hashtextextended('sag_dokumentation_log:' || p_medarbejder::text, 0));

  select count(*)
    into v_antal
    from public.sag_dokumentation_udlevering d
   where d.lavet_af = p_medarbejder
     and d.lavet_kl > clock_timestamp() - interval '1 hour';
  if v_antal >= 30 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  insert into public.sag_dokumentation_udlevering (sag_id, trade_id, udgave, givet_til, journalnummer, lavet_af)
  values (p_sag, v_trade, p_udgave, v_givet, v_journ, p_medarbejder)
  returning id, lavet_kl into v_id, v_kl;

  return jsonb_build_object('kode', 'ok', 'id', v_id, 'lavet_kl', v_kl);
end
$fn$;

revoke all on function public.sag_dokumentation_log(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sag_dokumentation_log(uuid, uuid, text, text, text) to service_role;

-- ============================================================ Læs loggen

-- Logrækkerne for en sag, nyeste først. Staff ser kun udgaven
-- 'saelger'; chefen ser alle. Alle andre får ingen rækker.
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
