-- Tilbagebetaling (refusion) til koeber: "Proev tilbagebetaling igen" for
-- admin/chef, en laas om Stripe-kaldet, og markeringer der forsvinder af sig
-- selv, naar Stripe bekraefter pengene.
--
--  1. betalinger.refusion_graense / refusion_opbrugt (som overfoersel_graense /
--     overfoersel_opbrugt): cron proever en claimet refusion, saa laenge
--     refusion_forsoeg < refusion_graense. Tidligere var graensen 5 fast i
--     koden - standardvaerdien er derfor 5.
--  2. betalinger.refusion_laas_til / refusion_laas_noegle: kort laas (lease)
--     om refunderBetaling's Stripe-kald. Saa kan et admin-forsoeg (ny
--     idempotency key) aldrig koere samtidig med et cron-forsoeg (gammel key) -
--     to forskellige keys samtidig kunne ellers give to refusioner.
--     betaling_refusion_laas / betaling_refusion_frigiv.
--  3. betaling_refusion_proev_igen(p_medarbejder, p_betaling, p_gammel_refund):
--     admin/chef giver en fejlet refusion et nyt forsoeg (refusion_forsoeg + 1
--     = ny idempotency key, graensen haeves med 3) og logger
--     'refusion_proevet_igen'. Rolle og inhabilitet tjekkes her. Serveren
--     kalder derefter refunderBetaling én gang.
--  4. betaling_registrer_refunderet: naar refusionen er gennemfoert hos Stripe,
--     fjernes en markering, der KUN skyldes en fejlet refusion, og det logges
--     som systembrugeren ('betaling_loest').
--  5. betaling_overfoersel_loest_auto: samme for en overfoersel til saelger, der
--     lykkes efter en fejl (kaldes af serveren, naar stripe_transfer_id er sat).
--  6. Engangsoprydning: allerede refunderede/overfoerte betalinger, der stadig
--     er markeret alene pga. en tidligere fejl, loeses paa samme maade.
--
-- Markeringer, der skyldes andet (indsigelse, afhentning, ikke afsluttet,
-- delvis refusion i Stripe Dashboard, refunderet efter overfoersel osv.),
-- roeres ikke. sidste_fejl kan bestaa af flere dele adskilt af ' · ' - ALLE
-- dele skal vaere refusions- (hhv. overfoersels-)fejl.
--
-- Idempotent: add column if not exists, drop/add constraint, create or replace.

-- ============================================================ 1+2 kolonner

alter table public.betalinger
  add column if not exists refusion_graense     integer not null default 5,
  add column if not exists refusion_laas_til    timestamptz,
  add column if not exists refusion_laas_noegle uuid;

alter table public.betalinger
  add column if not exists refusion_opbrugt boolean
    generated always as (refusion_forsoeg >= refusion_graense) stored;

comment on column public.betalinger.refusion_graense is
  'Cron prøver en claimet refusion, så længe refusion_forsoeg < refusion_graense. '
  'Admin giver nye forsøg ved at hæve grænsen (betaling_refusion_proev_igen) - '
  'tælleren nulstilles aldrig, da den indgår i Stripes idempotency key.';
comment on column public.betalinger.refusion_laas_til is
  'Lås om Stripe-kaldet i refunderBetaling (udløber af sig selv). Mens den '
  'gælder, laves ingen anden refusion eller nyt forsøg for betalingen.';

-- ============================================================ hjaelpere

-- Er hele sidste_fejl en fejlet refusion? (Alle dele adskilt af ' · '.)
-- Teksterne kommer fra refunderBetaling ("Refusion fejlede: <kode>",
-- "Refusion failed|canceled hos Stripe"), spejlRefusionsfejl ("Refusion
-- fejlede|blev annulleret hos Stripe ...") og betaling_refusion_fejlet
-- ("Refusion fejlede hos Stripe – prøves igen").
create or replace function public.betaling_fejl_er_refusion(p_fejl text)
returns boolean
language sql immutable set search_path = public as $fn$
  select nullif(btrim(coalesce(p_fejl, '')), '') is not null
     and not exists (
       select 1
         from regexp_split_to_table(p_fejl, ' · ') as del
        where btrim(del) !~ '^Refusion (fejlede|failed|canceled|blev annulleret)'
     );
$fn$;

revoke all on function public.betaling_fejl_er_refusion(text) from public, anon, authenticated;
grant execute on function public.betaling_fejl_er_refusion(text) to service_role;

-- Er hele sidste_fejl en fejlet/ventende overfoersel til saelger?
-- Teksterne kommer fra registrerOverfoerselsfejl / betaling_overfoersel_fejlet,
-- paamindSaelgerkonto, markerFrakobletBetaling og udbetalingskonto_nulstil.
create or replace function public.betaling_fejl_er_overfoersel(p_fejl text)
returns boolean
language sql immutable set search_path = public as $fn$
  select nullif(btrim(coalesce(p_fejl, '')), '') is not null
     and not exists (
       select 1
         from regexp_split_to_table(p_fejl, ' · ') as del
        where btrim(del) !~ ('^(Overførsel til sælger (afvist|usikker)'
                             || '|Overførsel opgivet efter'
                             || '|Sælger har ikke oprettet udbetalingskonto'
                             || '|Sælgers udbetalingskonto er (lukket|nulstillet))')
     );
$fn$;

revoke all on function public.betaling_fejl_er_overfoersel(text) from public, anon, authenticated;
grant execute on function public.betaling_fejl_er_overfoersel(text) to service_role;

-- ============================================================ moderation_log

-- Bevarer ALLE vaerdier fra 20261005070000_admin_se_chat.sql (seneste
-- definition, 35 vaerdier) og tilfoejer 'refusion_proevet_igen'.
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
    'chat_laest',
    'refusion_proevet_igen'));

-- ============================================================ 2 laas

-- Tager laasen om refunderBetaling's Stripe-kald. Kun naar betalingen stadig
-- er i den tilstand, serveren har laest (samme forsoeg og refund-id), refusionen
-- er claimet, ikke gennemfoert, og intet er overfoert til saelger. Returnerer
-- true, hvis laasen er taget. Laasen udloeber efter 5 minutter (fx hvis
-- serveren doer midt i kaldet) - naeste forsoeg slaar saa eksisterende
-- refusioner op hos Stripe, foer en ny oprettes.
create or replace function public.betaling_refusion_laas(
  p_betaling uuid,
  p_noegle   uuid,
  p_forsoeg  integer,
  p_refund   text)
returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  if p_betaling is null or p_noegle is null then return false; end if;
  update public.betalinger
     set refusion_laas_til = now() + interval '5 minutes',
         refusion_laas_noegle = p_noegle
   where id = p_betaling
     and (refusion_laas_til is null or refusion_laas_til < now())
     and refusion_forsoeg = p_forsoeg
     and stripe_refund_id is not distinct from p_refund
     and refusion_anmodet_kl is not null
     and status <> 'refunderet'
     and stripe_transfer_id is null
     and overfoersel_paabegyndt_kl is null;
  return found;
end;
$fn$;

revoke all on function public.betaling_refusion_laas(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.betaling_refusion_laas(uuid, uuid, integer, text) to service_role;

create or replace function public.betaling_refusion_frigiv(p_betaling uuid, p_noegle uuid)
returns void
language sql security definer set search_path = public as $fn$
  update public.betalinger
     set refusion_laas_til = null,
         refusion_laas_noegle = null
   where id = p_betaling
     and refusion_laas_noegle = p_noegle;
$fn$;

revoke all on function public.betaling_refusion_frigiv(uuid, uuid) from public, anon, authenticated;
grant execute on function public.betaling_refusion_frigiv(uuid, uuid) to service_role;

-- betaling_refusion_nyt_forsoeg (20261001020000) tager ogsaa laasens noegle:
-- et nyt forsoeg maa kun gives af den, der holder laasen. Den gamle udgave
-- (uden noegle) beholdes uaendret for bagudkompatibilitet, men kaldes ikke
-- laengere af koden.
create or replace function public.betaling_refusion_nyt_forsoeg(
  p_betaling uuid, p_gammel_refund text, p_noegle uuid)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  n integer;
begin
  update public.betalinger
     set stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         opdateret = now()
   where id = p_betaling
     and stripe_refund_id = p_gammel_refund
     and status <> 'refunderet'
     and refusion_laas_noegle = p_noegle
     and refusion_laas_til > now()
  returning refusion_forsoeg into n;
  return coalesce(n, -1);
end;
$fn$;

revoke all on function public.betaling_refusion_nyt_forsoeg(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.betaling_refusion_nyt_forsoeg(uuid, text, uuid) to service_role;

-- ============================================================ 3 proev igen (admin)

-- Admin/chef: giv en fejlet tilbagebetaling et nyt forsoeg. Flytter ingen penge
-- selv - serveren kalder refunderBetaling bagefter (som slaar eksisterende
-- refusioner op hos Stripe, foer en ny oprettes).
--
-- p_gammel_refund: betalingens stripe_refund_id, som serveren har set er
-- endeligt failed/canceled hos Stripe (eller null, hvis der ingen er). Er
-- vaerdien aendret siden, afvises kaldet ('aendret').
--
-- Afvises, medmindre: rollen er admin/chef, medarbejderen er hverken koeber
-- eller saelger, betalingen er betalt, refusionen er anmodet
-- (refusion_anmodet_kl) og ikke gennemfoert, intet er overfoert eller ved at
-- blive overfoert til saelger, der er ingen blokerende indsigelse, refusionen
-- er BidHamrs egen (ikke en delvis refusion lavet i Stripe Dashboard), og
-- ingen refusion er i gang lige nu (laasen).
--
-- Ved ok: stripe_refund_id nulstilles, refusion_forsoeg + 1 (ny idempotency
-- key), refusion_graense = max(graense, nyt forsoeg + 3), og handlingen
-- logges i moderation_log ('refusion_proevet_igen').
-- Returnerer {"kode": ..., "forsoeg": n}.
create or replace function public.betaling_refusion_proev_igen(
  p_medarbejder   uuid,
  p_betaling      uuid,
  p_gammel_refund text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_rolle text;
  b record;
  n integer;
begin
  if p_medarbejder is null or p_betaling is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select u.rolle into v_rolle from public.users u where u.id = p_medarbejder;
  if v_rolle is null or v_rolle not in ('admin', 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if b.status = 'refunderet' then
    return jsonb_build_object('kode', 'allerede_refunderet');
  end if;
  if b.refusion_anmodet_kl is null or b.status <> 'betalt' then
    return jsonb_build_object('kode', 'ikke_anmodet');
  end if;
  if coalesce(b.refusion_aarsag, '') = 'delvis_refusion_stripe' then
    return jsonb_build_object('kode', 'ikke_bidhamr');
  end if;
  if b.stripe_transfer_id is not null or b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'overfoert');
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if b.refusion_laas_til is not null and b.refusion_laas_til >= now() then
    return jsonb_build_object('kode', 'i_gang');
  end if;
  if b.stripe_refund_id is distinct from p_gammel_refund then
    return jsonb_build_object('kode', 'aendret');
  end if;

  update public.betalinger
     set stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         refusion_graense = greatest(refusion_graense, refusion_forsoeg + 1 + 3),
         opdateret = now()
   where id = b.id
  returning refusion_forsoeg into n;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'refusion_proevet_igen', 'handel', b.trade_id, b.buyer_id,
          'Tilbagebetaling til køber prøvet igen (forsøg ' || n || ')');

  return jsonb_build_object('kode', 'ok', 'forsoeg', n);
end;
$fn$;

revoke all on function public.betaling_refusion_proev_igen(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.betaling_refusion_proev_igen(uuid, uuid, text) to service_role;

-- ============================================================ 4 registrer refunderet

-- Som 20261003011000_sager_rettelser.sql, men en markering, der KUN skyldes en
-- fejlet refusion, fjernes, naar Stripe har bekraeftet refusionen (fuld, eller
-- det bestilte beloeb ved en sag). Kun naar intet er overfoert til saelger og
-- der ingen blokerende indsigelse er. Logges som systembrugeren.
-- (spejlRefusion markerer bagefter igen, hvis der er refunderet MERE end
-- bestilt.)
create or replace function public.betaling_registrer_refunderet(
  p_payment_intent text,
  p_refund         text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
  s record;
begin
  update public.betaling_afvigelser
     set refunderet_kl = coalesce(refunderet_kl, now()),
         stripe_refund_id = coalesce(p_refund, stripe_refund_id),
         sidste_fejl = null,
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
  if found then return 'afvigelse_refunderet'; end if;

  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then return 'ukendt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  update public.betalinger
     set status = 'refunderet',
         refunderet_kl = now(),
         stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, 'stripe'),
         kraever_opmaerksomhed = kraever_opmaerksomhed
                                 or stripe_transfer_id is not null
                                 or overfoersel_paabegyndt_kl is not null,
         sidste_fejl = case
           when stripe_transfer_id is not null or overfoersel_paabegyndt_kl is not null
             then 'Refunderet EFTER overfoersel til saelger - kontroller hos Stripe'
           else sidste_fejl end,
         opdateret = now()
   where id = b.id;

  -- Markeringen skyldtes kun en fejlet refusion: den er nu loest.
  if b.kraever_opmaerksomhed
     and b.stripe_transfer_id is null
     and b.overfoersel_paabegyndt_kl is null
     and not public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     and public.betaling_fejl_er_refusion(b.sidste_fejl) then
    update public.betalinger
       set kraever_opmaerksomhed = false,
           sidste_fejl = null
     where id = b.id;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (public.bidhamr_system_id(), 'betaling_loest', 'handel', b.trade_id, b.buyer_id,
            'Løst automatisk: Stripe bekræftede tilbagebetalingen');
  end if;

  -- Sager, der stadig holder pengene (laases efter betaling og handel).
  perform 1 from public.trades where id = b.trade_id for update;
  for s in
    select * from public.sager
     where trade_id = b.trade_id
       and (status in ('aaben', 'afventer_retur')
            or (penge_handling is not null and afviklet_kl is null))
     for update
  loop
    if s.status in ('aaben', 'afventer_retur') then
      update public.sager
         set status = 'lukket',
             afgjort_af = public.bidhamr_system_id(),
             afgjort_kl = now(),
             begrundelse = 'Afsluttet ved refusion',
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = null, penge_flyttes_efter_kl = null,
             afviklet_kl = now(), penge_fejl = null,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Afsluttet automatisk: betalingen er refunderet hos Stripe.', 4000)
       where id = s.id;
    else
      update public.sager
         set afviklet_kl = now(),
             penge_fejl = case when penge_handling = 'refunder' then null
                               else 'refunderet_hos_stripe' end,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Betalingen er refunderet hos Stripe, før ankefristen var udløbet.', 4000)
       where id = s.id;
    end if;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (public.bidhamr_system_id(), 'sag_lukket', 'sag', s.id, b.buyer_id,
            'Afsluttet ved refusion - betalingen er refunderet hos Stripe');
  end loop;

  if coalesce(b.refusion_aarsag, '') <> 'beloeb_afviger' then
    update public.trades
       set status = 'annulleret', sag_aaben = false
     where id = b.trade_id
       and status in ('afventer_betaling','betaling_modtaget','pakke_sendt','modtaget','leveret');
  end if;

  return 'refunderet';
end;
$fn$;

revoke all on function public.betaling_registrer_refunderet(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_refunderet(text, text) to service_role;

-- ============================================================ 5 overfoersel loest

-- Kaldes af serveren, naar overfoerslen til saelger er oprettet hos Stripe
-- (stripe_transfer_id sat). Fjerner en markering, der KUN skyldes en fejlet
-- eller ventende overfoersel, og logger det som systembrugeren. Roerer ikke
-- refunderede betalinger, indsigelser eller andre markeringer.
-- Returnerer true, hvis markeringen blev fjernet.
create or replace function public.betaling_overfoersel_loest_auto(p_betaling uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  update public.betalinger
     set kraever_opmaerksomhed = false,
         sidste_fejl = null,
         opdateret = now()
   where id = p_betaling
     and kraever_opmaerksomhed
     and stripe_transfer_id is not null
     and status = 'betalt'
     and refusion_anmodet_kl is null
     and not public.betaling_indsigelse_blokerer(indsigelse_kl, indsigelse_status)
     and public.betaling_fejl_er_overfoersel(sidste_fejl)
  returning trade_id, seller_id into b;
  if not found then return false; end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (public.bidhamr_system_id(), 'betaling_loest', 'handel', b.trade_id, b.seller_id,
          'Løst automatisk: Stripe bekræftede overførslen til sælgeren');
  return true;
end;
$fn$;

revoke all on function public.betaling_overfoersel_loest_auto(uuid) from public, anon, authenticated;
grant execute on function public.betaling_overfoersel_loest_auto(uuid) to service_role;

-- ============================================================ 6 engangsoprydning

-- Betalinger, der allerede er refunderet (hhv. overfoert), men stadig er
-- markeret alene pga. en tidligere fejl. Idempotent: anden koersel finder
-- ingen raekker.
with loeste as (
  update public.betalinger
     set kraever_opmaerksomhed = false,
         sidste_fejl = null,
         opdateret = now()
   where kraever_opmaerksomhed
     and status = 'refunderet'
     and refunderet_kl is not null
     and stripe_transfer_id is null
     and overfoersel_paabegyndt_kl is null
     and not public.betaling_indsigelse_blokerer(indsigelse_kl, indsigelse_status)
     and public.betaling_fejl_er_refusion(sidste_fejl)
  returning trade_id, buyer_id
)
insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
select public.bidhamr_system_id(), 'betaling_loest', 'handel', trade_id, buyer_id,
       'Løst automatisk: Stripe bekræftede tilbagebetalingen'
  from loeste;

with loeste as (
  update public.betalinger
     set kraever_opmaerksomhed = false,
         sidste_fejl = null,
         opdateret = now()
   where kraever_opmaerksomhed
     and stripe_transfer_id is not null
     and status = 'betalt'
     and refusion_anmodet_kl is null
     and not public.betaling_indsigelse_blokerer(indsigelse_kl, indsigelse_status)
     and public.betaling_fejl_er_overfoersel(sidste_fejl)
  returning trade_id, seller_id
)
insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
select public.bidhamr_system_id(), 'betaling_loest', 'handel', trade_id, seller_id,
       'Løst automatisk: Stripe bekræftede overførslen til sælgeren'
  from loeste;
