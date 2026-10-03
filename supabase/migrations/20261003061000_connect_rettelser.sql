-- Rettelser efter review af 20261003060000_connect_status.sql (Stripe Connect).
--
--   M1  En frakoblet saelgers penge sad fast: der fandtes ingen vej til en ny
--       udbetalingskonto. Ny admin-RPC udbetalingskonto_nulstil (kun
--       service_role, admin/chef, ikke sig selv) nulstiller Connect-felterne,
--       saa saelgeren kan oprette en ny konto. Den gamle konto-id arkiveres i
--       connect_tidligere_konti (intet slettes). Ventende, frigivne betalinger
--       faar nye overfoerselsforsoeg (betaling_overfoersel_nulstil-moenstret:
--       graensen haeves) og et nyt forsoegsnummer, saa Stripe-idempotency-
--       noeglen til den nye konto aldrig er den samme som til den gamle.
--       Overfoerslen sker, naar account.updated viser, at den nye konto er
--       klar (overfoerVentende), eller ved naeste cron-koersel.
--       connect_nulstillet_antal indgaar i serverens idempotency key til
--       accounts.create og i noeglen til beskeden "Din udbetalingskonto er
--       klar", saa en ny konto faar sin egen.
--       moderation_log: ny handling 'udbetalingskonto_nulstillet'.
--   M2  En konto, som Stripe har afvist (disabled_reason 'rejected.*'), taeller
--       ikke som udbetalingskonto (har_udbetalingskonto) - saelgeren kan ikke
--       saette varer til salg.
--   E1  Saelgeren maa ikke kunne se, om koeberen har koebt BidHamr Beskyttelse.
--       Kolonne-grants paa betalinger gav begge parter adgang til beskyttelse,
--       beskyttelse_oere og total_oere (total minus bud, koebergebyr og fragt =
--       beskyttelsen). De tre kolonner kan ikke laengere laeses med brugerens
--       JWT. Koeberen kan stadig laese dem for sine egne koeb via
--       mine_koebsbetalinger() (security definer, kun auth.uid() som koeber).
--       Hjemmesiden laeser dem allerede med service-role og filtrerer pr. part.
--
-- Idempotent: add column if not exists / create or replace / drop ... if
-- exists / revoke+grant. Aendrer ingen handelsdata.

-- ============================================================ M1 kolonner

alter table public.betalingsprofiler
  add column if not exists connect_nulstillet_antal integer not null default 0,
  add column if not exists connect_tidligere_konti  text[]  not null default '{}';

comment on column public.betalingsprofiler.connect_nulstillet_antal is
  'Antal gange admin har nulstillet udbetalingskontoen (udbetalingskonto_nulstil). '
  'Indgaar i idempotency key til Stripe accounts.create og i beskednoegler.';
comment on column public.betalingsprofiler.connect_tidligere_konti is
  'Tidligere Stripe Connect-konti (acct_...), arkiveret ved nulstilling. Slettes aldrig.';

-- ============================================================ M2 har_udbetalingskonto

create or replace function public.har_udbetalingskonto(p_bruger uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.betalingsprofiler
     where user_id = p_bruger
       and stripe_account_id is not null
       and connect_detaljer_indsendt
       and connect_frakoblet_kl is null
       and coalesce(connect_spaerret_aarsag, '') not like 'rejected.%'
  );
$fn$;

revoke all on function public.har_udbetalingskonto(uuid) from public, anon, authenticated;
grant execute on function public.har_udbetalingskonto(uuid) to service_role;

-- ============================================================ M1 moderation_log

-- Alle vaerdier fra 20261003060000 bevares; kun 'udbetalingskonto_nulstillet' er ny.
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
    'udbetalingskonto_nulstillet'));

-- ============================================================ M1 udbetalingskonto_nulstil

-- Admin/chef nulstiller en FRAKOBLET udbetalingskonto, saa saelgeren kan
-- oprette en ny hos Stripe. Kun frakoblede konti (account.application.
-- deauthorized): en konto, Stripe har afvist, nulstilles ikke herfra - det
-- ville omgaa Stripes afgoerelse.
--
-- Returnerer {"kode": "ok", "nulstillet_antal": n, "ventende": n} eller
-- {"kode": ...} med ingen_adgang | begrundelse_mangler | begrundelse_for_lang |
-- ikke_fundet | inhabil | ikke_frakoblet.
--
-- Laaserækkefoelge: betalingsprofil, derefter saelgerens betalinger (samme
-- raekkefoelge som ingen anden funktion vender om).
create or replace function public.udbetalingskonto_nulstil(
  p_medarbejder uuid,
  p_bruger      uuid,
  p_begrundelse text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_note     text := btrim(coalesce(p_begrundelse, ''));
  p          record;
  v_antal    integer;
  v_ventende integer;
begin
  if p_medarbejder is null or not exists (
       select 1 from public.users
        where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note = '' then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;
  if p_bruger is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_bruger = p_medarbejder then return jsonb_build_object('kode', 'inhabil'); end if;

  select * into p from public.betalingsprofiler where user_id = p_bruger for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p.connect_frakoblet_kl is null then
    return jsonb_build_object('kode', 'ikke_frakoblet');
  end if;
  -- En konto, Stripe har afvist, nulstilles aldrig - heller ikke hvis den
  -- bagefter er frakoblet. Ellers kunne Stripes afgoerelse omgaas.
  if coalesce(p.connect_spaerret_aarsag, '') like 'rejected.%' then
    return jsonb_build_object('kode', 'afvist_af_stripe');
  end if;

  update public.betalingsprofiler
     set connect_tidligere_konti =
           case when p.stripe_account_id is null
                  or p.stripe_account_id = any(connect_tidligere_konti)
                then connect_tidligere_konti
                else connect_tidligere_konti || p.stripe_account_id end,
         stripe_account_id             = null,
         connect_detaljer_indsendt     = false,
         connect_overfoersler_aktiv    = false,
         connect_udbetalinger_aktiv    = false,
         connect_mangler_nu            = '{}',
         connect_mangler_forfaldne     = '{}',
         connect_spaerret_aarsag       = null,
         connect_mangler_siden         = null,
         connect_klar_kl               = null,
         connect_frakoblet_kl          = null,
         connect_kraever_opmaerksomhed = false,
         connect_opmaerksomhed_aarsag  = null,
         connect_opmaerksomhed_kl      = null,
         connect_nulstillet_antal      = connect_nulstillet_antal + 1,
         opdateret                     = now()
   where user_id = p_bruger
  returning connect_nulstillet_antal into v_antal;

  -- Frigivne, ikke-overfoerte betalinger: nyt forsoegsnummer (ny idempotency
  -- key hos Stripe - den gamle kan vaere brugt mod den gamle konto) og 3 nye
  -- forsoeg (graensen haeves som i betaling_overfoersel_nulstil). Alle andre
  -- vaern (sag, indsigelse, annulleret handel, refusion) tjekkes stadig af
  -- betaling_claim_overfoersel foer hver overfoersel.
  -- kraever_opmaerksomhed roeres ikke: admin markerer betalingen som loest,
  -- naar pengene er overfoert.
  update public.betalinger
     set overfoersel_forsoeg = overfoersel_forsoeg + 1,
         overfoersel_graense = greatest(overfoersel_graense, overfoersel_forsoeg + 1 + 3),
         sidste_fejl = 'Sælgers udbetalingskonto er nulstillet af BidHamr. '
                       || 'Overføres, når sælgerens nye udbetalingskonto er klar.',
         opdateret = now()
   where seller_id = p_bruger
     and status = 'betalt'
     and frigivet_kl is not null
     and stripe_transfer_id is null
     and refusion_anmodet_kl is null;
  get diagnostics v_ventende = row_count;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'udbetalingskonto_nulstillet', 'bruger', p_bruger, p_bruger,
          left(v_note || coalesce(' (tidligere Stripe-konto: ' || p.stripe_account_id || ')', ''), 2200));

  return jsonb_build_object('kode', 'ok', 'nulstillet_antal', v_antal, 'ventende', v_ventende);
end;
$fn$;

revoke all on function public.udbetalingskonto_nulstil(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.udbetalingskonto_nulstil(uuid, uuid, text) to service_role;

-- ============================================================ E1 beskyttelse kun for koeberen

-- Samme kolonneliste som 20261001030000 (T4) minus beskyttelse,
-- beskyttelse_oere og total_oere. RLS-policyen betalinger_select_part er
-- uaendret (koeber, saelger og chef ser raekken).
do $$
begin
  if to_regclass('public.betalinger') is not null then
    execute 'revoke select on public.betalinger from anon, authenticated';
    execute 'grant select (id, trade_id, auction_id, buyer_id, seller_id,
               bud_oere, koebergebyr_oere, fragt_oere,
               valuta, status, betal_senest, betalt_kl,
               frigivet_kl, overfoert_kl, oprettet, opdateret)
             on public.betalinger to authenticated';
  end if;
end;
$$;

-- Koeberens egne koeb med BidHamr Beskyttelse og totalbeloeb. Kun raekker,
-- hvor den indloggede bruger er koeber. p_trade = null giver alle.
create or replace function public.mine_koebsbetalinger(p_trade uuid default null)
returns table (
  trade_id         uuid,
  beskyttelse      boolean,
  beskyttelse_oere bigint,
  total_oere       bigint
)
language sql stable security definer set search_path = public as $fn$
  select b.trade_id, b.beskyttelse, b.beskyttelse_oere::bigint, b.total_oere::bigint
    from public.betalinger b
   where auth.uid() is not null
     and b.buyer_id = auth.uid()
     and (p_trade is null or b.trade_id = p_trade);
$fn$;

revoke all on function public.mine_koebsbetalinger(uuid) from public, anon;
grant execute on function public.mine_koebsbetalinger(uuid) to authenticated, service_role;
