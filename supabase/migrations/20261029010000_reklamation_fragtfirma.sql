-- Reklamation hos fragtfirma ved transportskade (ROADMAP fase 2;
-- ROADMAP-BESLUTNINGER afsnit 4, "Transportskade - hvem bærer tabet", Filip
-- 7. okt. 2026, og "Reklamation - BidHamr anmelder, chefen udbetaler",
-- Filip 22. okt. 2026).
--
-- Model (Filip, 22. okt. 2026 - erstatter "sælger anmelder selv" fra 21.
-- okt.): DAO (Allan, 22. okt. 2026) - sælgeren må ikke få adgang til
-- omdeling.info, og erstatningen udbetales altid til BidHamr. Derfor:
-- reklamationen oprettes automatisk og lander hos STAFF; staff anmelder hos
-- fragtfirmaet (DAO: omdeling.info, GLS: deres vej) med den færdige
-- reklamationspakke og registrerer fragtfirmaets sagsnummer og svar. KUN
-- CHEFEN udbetaler: når erstatningen er modtaget fra fragtfirmaet, bekræfter
-- chefen det og trykker "Udbetal til sælger" - hele det godkendte beløb
-- sendes som en Stripe Transfer fra BidHamrs platformssaldo til sælgerens
-- Connect-konto og derfra som en udbetaling (payout) til sælgerens bank.
-- BidHamr beholder intet. Afviser fragtfirmaet, er det sælgerens tab. Dårlig
-- indpakning -> ingen reklamation (advarselssystemet, indpakning_vurder).
-- Sælgeren ser kun status (mine_fragt_reklamationer) - aldrig pakken,
-- billederne eller omdeling.info. Ingen saldo/wallet til brugere.
--
--   1. fragt_transportoer_erstatning: maks. erstatning pr. pakke pr.
--      transportør. DAO = 2.500 kr. (DAO's svar 20. okt. 2026). GLS = null =
--      ukendt (vi venter på svar) -> kravbeløbet er varens værdi. Ændres med
--      en ny migration, når GLS svarer.
--   2. indpakning_ordentlig: staffs POSITIVE vurdering af indpakningen i en
--      sag (indpakning_vurder registrerer kun dårlig indpakning). Én række pr.
--      sag; kan fortrydes, så længe skaden ikke er anmeldt. Dårlig og
--      ordentlig udelukker hinanden (begge veje).
--   3. fragt_reklamationer: én pr. sag. Status:
--        afventer_bidhamr -> anmeldt (staff: sagsnummer påkrævet)
--        anmeldt -> godkendt (beløb <= kravbeløbet) | afvist (grund til sælgeren)
--        godkendt -> udbetalt (KUN chefen: erstatningen er modtaget -> Stripe)
--        afventer_bidhamr/anmeldt/godkendt -> annulleret (staff med grund,
--                                                       eller systemet)
--      Staff kan rette status (fragt_reklamation_ret_status, kræver
--      begrundelse) - aldrig fra eller til 'udbetalt', og ikke mens en
--      udbetaling er i gang. Slettes aldrig. Pengefelterne (transfer,
--      udbetalt) kan ikke ændres, når de er sat (fragt_reklamationer_beskyt).
--   4. AUTOMATISK OPRETTELSE (fragt_reklamation_synkroniser): kaldes af en
--      trigger på sager (status, afviklet_kl, penge_handling), af
--      indpakning_ordentlig/-_fortryd OG af cron'en
--      (fragt_reklamationer_synkroniser_alle, hvert 5. minut via
--      notifikations-cron'en), fordi refusionen bekræftes på betalinger
--      (webhook) og ankefristen udløber af sig selv.
--      Betingelserne (fragt_reklamation_betingelser - fælles for
--      synkroniseringen, staffs anmeld/ret_status og chefens udbetaling):
--      type 'skadet', ordentlig indpakning (ikke fortrudt), ikke afhentning,
--      en udgående forsendelse med DAO eller GLS, OG sagen er ENDELIG til
--      købers fordel:
--        - køberen HAR fået pengene tilbage (betalinger.status 'refunderet'
--          med refunderet_kl, eller tabt indsigelse - banken har givet
--          køberen pengene), og SÆLGEREN beholder ikke salgsbeløbet
--          (ingen transfer/udbetaling; ved tabt indsigelse i destination-
--          modellen er hele udbetaling_oere hentet tilbage fra sælgerens
--          Connect-konto - aarsag 'saelger_beholder' ellers), og
--        - 'afgjort_koeber' afviklet med refusion (afviklet_kl), ingen anke
--          venter, og ankefristen (afgjort_kl + 4 dage) er udløbet eller
--          anken er afgjort; eller
--        - 'lukket' af systemet med refusion ("Afsluttet ved refusion" /
--          tabt indsigelse: penge_handling null, afviklet_kl sat) - kan ikke
--          ankes.
--      'afventer_retur' er ALDRIG nok (køberen er ikke refunderet endnu).
--      Ophører betingelserne (refusionen fejler, sagen ændres, vurderingen
--      fortrydes), annulleres en reklamation i 'afventer_bidhamr'
--      automatisk (annulleret_auto; sælgeren får besked, hvis han fik
--      "oprettet") - og genopstår, hvis betingelserne kommer igen (ny
--      besked). Er skaden allerede anmeldt/godkendt, røres status ikke, men
--      sag_aendret_kl sættes: staff får en rød lampe, og "godkendt" og
--      chefens udbetaling er spærret, indtil staff kvitterer
--      (fragt_reklamation_kvitter_sag_aendret, ret_status eller annullér).
--      Staff kan kun kvittere, når betingelserne er opfyldt, eller årsagen er
--      midlertidig (anke_venter, ankefrist) - ellers betingelser_ikke_opfyldt.
--      Bliver betingelserne opfyldt igen af sig selv, kvitterer systemet;
--      ændres sagen igen efter en kvittering, markeres den på ny. Chefen kan
--      kun udbetale, når betingelserne er HELT opfyldt (ikke midlertidigt).
--      Uventede fejl i synkroniseringen fanges (..._sikker) og logges som
--      drift-fejl, så en sagsafgørelse aldrig fejler pga. reklamationen;
--      cron'en retter op bagefter.
--   5. Sælgeren (authenticated, sælgeren = auth.uid()): KUN
--      mine_fragt_reklamationer (offentlige felter: status, transportør,
--      kravbeløb, godkendt beløb, afvisnings-/annulleringsgrund, udbetalt).
--      Ingen handlinger, ingen pakke. Køberen ser intet (køberen er
--      refunderet). Den første udgaves sælger-funktioner
--      (mit_fragt_reklamation_*, min_reklamationspakke_adgang) droppes.
--   6. Staff-funktioner (authenticated, auth.uid() + er_staff() = rolle OG
--      aal2 - migration B, 20261027020000; inhabil afvises): anmeld, godkend,
--      afvis, annullér, ret status, kvittér for ændret sag, note, indpakning
--      ordentlig / fortryd. Alt logges i moderation_log (maal_type 'sag').
--   7. Chefens udbetaling (fragt_reklamation_udbetal_claim - authenticated,
--      er_staff() + rollen 'chef' + aal2, ikke inhabil): kræver bekræftelse
--      af, at erstatningen er modtaget fra fragtfirmaet (gemmes med hvem og
--      hvornår), at "sag ændret" ikke er ukvitteret, at betingelserne er
--      opfyldt, intet nødstop for udbetalinger og at sælgeren ikke er
--      frosset, og at sælgerens Connect-konto er den samme som på
--      betalingen. Serveren laver derefter Stripe-kaldene (transfer, så
--      payout - src/lib/reklamation/udbetaling.ts) og spejler resultatet med
--      service-role-funktionerne fragt_reklamation_udbetal_registrer /
--      _udbetal_afvist og fragt_reklamation_bank_start / _bank_spejl /
--      _bank_fejl.
--   8. fragt_reklamationer_antal(): tællere til admin-lamperne.
--   9. moderation_log_handling_check flettes med de nye handlinger.
--
-- Beskeder til sælgeren (notifikation + mail: oprettet, anmeldt, godkendt,
-- afvist, udbetalt, sendt til banken, udbetaling til banken fejlet,
-- annulleret af staff eller systemet) sendes fra serveren
-- (src/lib/reklamation/notifikationer.ts) ud fra tidsstemplerne - samme
-- mønster som advarsler. Ingen omtale af omdeling.info.
--
-- Ingen funktioner fra andre migrationer ændres. Nye triggere på sager (AFTER
-- UPDATE OF status, afviklet_kl, penge_handling), advarsler og paamindelser
-- (BEFORE INSERT, kun grund 'daarlig_indpakning').
-- Idempotent (kan køres igen - også oven på den første udgave af denne fil
-- på testdatabasen: status afventer_saelger -> afventer_bidhamr, fravalgt ->
-- annulleret, sælger-funktionerne droppes). KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.sager') is null or to_regclass('public.forsendelser') is null
     or to_regclass('public.paamindelser') is null or to_regclass('public.betalinger') is null then
    raise exception 'Forudsætning mangler: sager, forsendelser, paamindelser og betalinger';
  end if;
  if to_regprocedure('public.er_staff()') is null
     or to_regprocedure('public.penge_inhabil(uuid,uuid,uuid)') is null
     or to_regprocedure('public.staff_aal2_ok(integer)') is null then
    raise exception 'Forudsætning mangler: er_staff, penge_inhabil, staff_aal2_ok (20261027020000)';
  end if;
  if to_regprocedure('public.udbetalinger_stoppet()') is null
     or to_regprocedure('public.staff_chat_har_rolle(uuid,text)') is null
     or to_regprocedure('public.bidhamr_system_id()') is null
     or to_regprocedure('public.drift_fejl_log(text,text,text,text,uuid)') is null
     or to_regclass('public.betalingsprofiler') is null then
    raise exception 'Forudsætning mangler: udbetalinger_stoppet (20261019010000), staff_chat_har_rolle, bidhamr_system_id, drift_fejl_log, betalingsprofiler';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'betalingsprofiler'
                    and column_name = 'udbetaling_frosset_kl') then
    raise exception 'Forudsætning mangler: betalingsprofiler.udbetaling_frosset_kl (20261019010000)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Maks. erstatning pr. transportør
-- ===========================================================================
create table if not exists public.fragt_transportoer_erstatning (
  transportoer  text primary key check (transportoer in ('dao', 'gls')),
  -- null = ukendt: kravbeløbet er varens værdi.
  maks_oere     bigint check (maks_oere is null or maks_oere > 0),
  kilde         text,
  opdateret_kl  timestamptz not null default now()
);

comment on table public.fragt_transportoer_erstatning is
  'Maks. erstatning pr. pakke ved reklamation (20261029010000). null = ukendt '
  '(kravbeløbet er varens værdi). Ændres kun med en migration.';

insert into public.fragt_transportoer_erstatning (transportoer, maks_oere, kilde) values
  ('dao', 250000, 'DAO (Allan), 20. okt. 2026: maks. 2.500 kr. pr. pakke, intet tilkøb'),
  ('gls', null,   'Ukendt - venter på svar fra GLS')
on conflict (transportoer) do nothing;

alter table public.fragt_transportoer_erstatning enable row level security;
revoke all on public.fragt_transportoer_erstatning from public, anon, authenticated;
grant select on public.fragt_transportoer_erstatning to authenticated, service_role;
drop policy if exists fragt_transportoer_erstatning_select_staff on public.fragt_transportoer_erstatning;
create policy fragt_transportoer_erstatning_select_staff on public.fragt_transportoer_erstatning
  for select to authenticated using ((select public.er_staff()));

-- ===========================================================================
-- 2. Ordentlig indpakning
-- ===========================================================================
create table if not exists public.indpakning_ordentlig (
  sag_id             uuid primary key references public.sager(id) on delete restrict,
  trade_id           uuid not null references public.trades(id) on delete restrict,
  vurderet_af        uuid not null references public.users(id) on delete restrict,
  vurderet_kl        timestamptz not null default now(),
  intern_note        text check (intern_note is null or char_length(intern_note) <= 2000),
  -- Fortrudt (fx fejlklik). Kan sættes igen af indpakning_ordentlig.
  tilbagekaldt_kl    timestamptz,
  tilbagekaldt_af    uuid references public.users(id) on delete restrict,
  tilbagekaldt_grund text check (tilbagekaldt_grund is null or char_length(tilbagekaldt_grund) <= 1000),
  constraint indpakning_ordentlig_tilbagekaldt_par check (
    (tilbagekaldt_kl is null) = (tilbagekaldt_af is null))
);

comment on table public.indpakning_ordentlig is
  'Staff har vurderet sælgerens indpakning som ordentlig i en sag (20261029010000). '
  'Forudsætning for reklamation hos fragtfirmaet. Slettes aldrig. Kun staff.';

alter table public.indpakning_ordentlig enable row level security;
revoke all on public.indpakning_ordentlig from public, anon, authenticated;
grant select on public.indpakning_ordentlig to authenticated, service_role;
drop policy if exists indpakning_ordentlig_select_staff on public.indpakning_ordentlig;
create policy indpakning_ordentlig_select_staff on public.indpakning_ordentlig
  for select to authenticated using ((select public.er_staff()));

create or replace function public.indpakning_ordentlig_beskyt()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Vurderingen af indpakningen kan ikke slettes.' using errcode = '42501';
  end if;
  if new.sag_id is distinct from old.sag_id or new.trade_id is distinct from old.trade_id then
    raise exception 'Vurderingen kan ikke flyttes til en anden sag.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.indpakning_ordentlig_beskyt() from public, anon, authenticated;

drop trigger if exists indpakning_ordentlig_beskyt on public.indpakning_ordentlig;
create trigger indpakning_ordentlig_beskyt
  before update or delete on public.indpakning_ordentlig
  for each row execute function public.indpakning_ordentlig_beskyt();

-- Dårlig indpakning (indpakning_vurder) kan ikke gives på en sag, hvor
-- indpakningen er vurderet ordentlig - fortryd den vurdering først.
create or replace function public.indpakning_daarlig_ikke_ordentlig()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.grund = 'daarlig_indpakning' and new.sag_id is not null
     and exists (select 1 from public.indpakning_ordentlig o
                  where o.sag_id = new.sag_id and o.tilbagekaldt_kl is null) then
    raise exception 'Indpakningen er vurderet ordentlig i denne sag. Fortryd den vurdering først.'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.indpakning_daarlig_ikke_ordentlig() from public, anon, authenticated;

drop trigger if exists advarsler_daarlig_ikke_ordentlig on public.advarsler;
create trigger advarsler_daarlig_ikke_ordentlig
  before insert on public.advarsler
  for each row execute function public.indpakning_daarlig_ikke_ordentlig();

drop trigger if exists paamindelser_daarlig_ikke_ordentlig on public.paamindelser;
create trigger paamindelser_daarlig_ikke_ordentlig
  before insert on public.paamindelser
  for each row execute function public.indpakning_daarlig_ikke_ordentlig();

-- ===========================================================================
-- 3. fragt_reklamationer
-- ===========================================================================
-- De constraints, der er ændret siden første udgave, lægges på nedenfor
-- (drop if exists + add), så filen også kan køres oven på den.
create table if not exists public.fragt_reklamationer (
  id                         uuid primary key default gen_random_uuid(),
  sag_id                     uuid not null unique references public.sager(id) on delete restrict,
  trade_id                   uuid not null references public.trades(id) on delete restrict,
  saelger_id                 uuid not null references public.users(id) on delete restrict,
  forsendelse_id             uuid references public.forsendelser(id) on delete restrict,
  transportoer               text not null check (transportoer in ('dao', 'gls')),
  trackingnummer             text check (trackingnummer is null or char_length(trackingnummer) <= 100),
  -- Varens pris (hammerslag) og transportørens maks. ved oprettelsen.
  varens_vaerdi_oere         bigint not null check (varens_vaerdi_oere > 0),
  maks_erstatning_oere       bigint check (maks_erstatning_oere is null or maks_erstatning_oere > 0),
  -- = least(varens værdi, maks); varens værdi, når maks er ukendt (GLS).
  kravbeloeb_oere            bigint not null,
  status                     text not null default 'afventer_bidhamr',
  -- Fragtfirmaets sagsnummer (staff, påkrævet ved "anmeldt").
  transportoerens_sagsnummer text check (transportoerens_sagsnummer is null
                                         or char_length(transportoerens_sagsnummer) between 1 and 100),
  -- Godkendt af fragtfirmaet (registreret af staff) - udbetales til
  -- sælgeren af chefen, når BidHamr har modtaget det.
  godkendt_beloeb_oere       bigint,
  -- Fra fragtfirmaet (vises for sælgeren).
  afvisningsgrund            text check (afvisningsgrund is null or char_length(afvisningsgrund) between 1 and 1000),
  -- Til sælgeren, når staff annullerer.
  annulleret_grund           text check (annulleret_grund is null or char_length(annulleret_grund) between 1 and 1000),
  -- Annulleret af systemet (sagen ændret) - genopstår, hvis betingelserne kommer igen.
  annulleret_auto            boolean not null default false,
  -- Sagen er ændret (genåbnet/omgjort), efter skaden er anmeldt.
  sag_aendret_kl             timestamptz,
  oprettet_af                uuid not null references public.users(id) on delete restrict,
  oprettet_kl                timestamptz not null default now(),
  -- Hvornår staff fik (eller fik igen) opgaven - rød lampe efter 3 dage.
  aktiv_fra_kl               timestamptz not null default now(),
  -- Seneste fremdrift (oprettet/genopstået, anmeldt, rettet) - grå lampe
  -- efter 30 dage uden svar.
  fremdrift_kl               timestamptz not null default now(),
  anmeldt_kl                 timestamptz,
  afgjort_kl                 timestamptz,
  -- Staff, der registrerede godkendt/afvist (eller rettede status).
  afgjort_af                 uuid references public.users(id) on delete restrict,
  annulleret_af              uuid references public.users(id) on delete restrict,
  annulleret_kl              timestamptz,
  intern_note                text check (intern_note is null or char_length(intern_note) <= 4000),
  opdateret_kl               timestamptz not null default now()
);

-- Staff har kvitteret for, at sagen er ændret efter anmeldelsen.
alter table public.fragt_reklamationer
  add column if not exists sag_aendret_kvitteret_kl timestamptz,
  add column if not exists sag_aendret_kvitteret_af uuid references public.users(id) on delete restrict,
  -- Betingelsernes årsag, da der blev kvitteret (fragt_reklamation_betingelser):
  -- null = betingelserne var opfyldt (systemets kvittering, eller staff
  -- kvitterede efter fx en gennemført refusion); ellers den midlertidige
  -- årsag (fx anke_venter/ankefrist), staff kvitterede under. Bruges af
  -- fragt_reklamation_synkroniser til at afgøre, om en senere ændring skal
  -- markeres igen.
  add column if not exists sag_aendret_kvitteret_aarsag text;

-- Chefens udbetaling (20261029010000, 22. okt. 2026).
alter table public.fragt_reklamationer
  -- Chefens bekræftelse: erstatningen er modtaget fra fragtfirmaet.
  add column if not exists erstatning_modtaget_kl    timestamptz,
  add column if not exists erstatning_modtaget_af    uuid references public.users(id) on delete restrict,
  -- Udbetalingen er sat i gang (claim) - Stripe-kaldet kan være i gang.
  add column if not exists udbetaling_paabegyndt_kl  timestamptz,
  add column if not exists udbetaling_paabegyndt_af  uuid references public.users(id) on delete restrict,
  -- Forsøg nr. (indgår i idempotency-nøglen; tælles kun op, når Stripe med
  -- sikkerhed ikke har lavet en transfer).
  add column if not exists udbetaling_forsoeg        integer not null default 0,
  -- Sælgerens Connect-konto (destination), låst ved claim.
  add column if not exists udbetaling_stripe_konto   text,
  add column if not exists stripe_transfer_id        text,
  add column if not exists udbetalt_kl               timestamptz,
  add column if not exists udbetalt_af               uuid references public.users(id) on delete restrict,
  -- Seneste fejl ved udbetalingen (kun staff).
  add column if not exists udbetaling_fejl           text,
  -- Transferen er (helt eller delvist) tilbageført hos Stripe - BidHamr gør
  -- det aldrig selv; webhook/afstemning registrerer det (drift-alarm).
  add column if not exists transfer_tilbagefoert_kl  timestamptz,
  -- Udbetalingen (payout) fra sælgerens Connect-konto til sælgerens bank.
  --   null      ikke startet (eller Stripe afviste et forsøg - prøves igen)
  --   claimet   payouts.create er (måske) kaldt - afklares før nyt forsøg
  --   oprettet  payout oprettet hos Stripe (pending/in_transit)
  --   paid | failed | canceled  (spejlet fra Stripe)
  add column if not exists bank_status               text,
  add column if not exists bank_payout_id            text,
  add column if not exists bank_forsoeg              integer not null default 0,
  add column if not exists bank_claimet_kl           timestamptz,
  add column if not exists bank_sidst_sendt_kl       timestamptz,
  add column if not exists bank_oprettet_kl          timestamptz,
  add column if not exists bank_betalt_kl            timestamptz,
  add column if not exists bank_fejlet_kl            timestamptz,
  add column if not exists bank_fejlkode             text,
  add column if not exists bank_fejl                 text;

-- Første udgave (sælgeren anmeldte selv): fravalgt, gensendt og
-- afventer_saelger findes ikke længere. Kun testdata (prod har aldrig haft
-- tabellen).
alter table public.fragt_reklamationer drop constraint if exists fragt_reklamationer_status_check;
alter table public.fragt_reklamationer drop constraint if exists fragt_reklamationer_fravalgt_par;
update public.fragt_reklamationer
   set status = 'afventer_bidhamr', fremdrift_kl = now()
 where status = 'afventer_saelger';
update public.fragt_reklamationer
   set status = 'annulleret', annulleret_auto = false,
       annulleret_grund = coalesce(annulleret_grund, 'Sælgeren ønskede ikke at reklamere (første udgave).'),
       annulleret_af = coalesce(annulleret_af, public.bidhamr_system_id()),
       annulleret_kl = coalesce(annulleret_kl, now())
 where status = 'fravalgt';
alter table public.fragt_reklamationer drop column if exists fravalgt_kl;
alter table public.fragt_reklamationer drop column if exists gensendt_kl;
alter table public.fragt_reklamationer drop column if exists gensendt_af;
alter table public.fragt_reklamationer drop column if exists gensendt_antal;
alter table public.fragt_reklamationer alter column status set default 'afventer_bidhamr';

do $do$
declare
  c record;
begin
  for c in
    select * from (values
      ('fragt_reklamationer_status_check',
       $c$check (status in ('afventer_bidhamr', 'anmeldt', 'godkendt', 'afvist', 'udbetalt', 'annulleret'))$c$),
      ('fragt_reklamationer_krav_check',
       $c$check (kravbeloeb_oere > 0 and kravbeloeb_oere <= varens_vaerdi_oere
                and (maks_erstatning_oere is null or kravbeloeb_oere <= maks_erstatning_oere))$c$),
      ('fragt_reklamationer_godkendt_check',
       $c$check ((status in ('godkendt', 'udbetalt')) = (godkendt_beloeb_oere is not null)
                and (godkendt_beloeb_oere is null
                     or (godkendt_beloeb_oere > 0 and godkendt_beloeb_oere <= kravbeloeb_oere)))$c$),
      ('fragt_reklamationer_afgjort_par',
       $c$check (status not in ('godkendt', 'afvist', 'udbetalt') or (afgjort_kl is not null and afgjort_af is not null))$c$),
      -- Anmeldt hos fragtfirmaet = staff har et sagsnummer.
      ('fragt_reklamationer_anmeldt_par',
       $c$check (status not in ('anmeldt', 'godkendt', 'udbetalt')
                or (anmeldt_kl is not null and transportoerens_sagsnummer is not null))$c$),
      ('fragt_reklamationer_afvist_par',
       $c$check (status <> 'afvist' or afvisningsgrund is not null)$c$),
      ('fragt_reklamationer_annulleret_par',
       $c$check (status <> 'annulleret' or (annulleret_grund is not null and annulleret_af is not null and annulleret_kl is not null))$c$),
      ('fragt_reklamationer_kvitteret_par',
       $c$check ((sag_aendret_kvitteret_kl is null) = (sag_aendret_kvitteret_af is null))$c$),
      ('fragt_reklamationer_kvitteret_aarsag',
       $c$check (sag_aendret_kvitteret_aarsag is null or sag_aendret_kvitteret_kl is not null)$c$),
      ('fragt_reklamationer_modtaget_par',
       $c$check ((erstatning_modtaget_kl is null) = (erstatning_modtaget_af is null))$c$),
      ('fragt_reklamationer_paabegyndt_par',
       $c$check ((udbetaling_paabegyndt_kl is null) = (udbetaling_paabegyndt_af is null)
                and (udbetaling_paabegyndt_kl is null
                     or (status in ('godkendt', 'udbetalt') and erstatning_modtaget_kl is not null
                         and udbetaling_stripe_konto is not null)))$c$),
      ('fragt_reklamationer_udbetalt_par',
       $c$check ((status = 'udbetalt') = (udbetalt_kl is not null)
                and (status <> 'udbetalt'
                     or (stripe_transfer_id is not null and udbetalt_af is not null
                         and udbetaling_paabegyndt_kl is not null and erstatning_modtaget_kl is not null)))$c$),
      ('fragt_reklamationer_forsoeg_check',
       $c$check (udbetaling_forsoeg between 0 and 1000 and bank_forsoeg between 0 and 1000)$c$),
      ('fragt_reklamationer_bank_check',
       $c$check ((bank_status is null or bank_status in ('claimet', 'oprettet', 'paid', 'failed', 'canceled'))
                and (bank_status is null or status = 'udbetalt')
                and (bank_status not in ('oprettet', 'paid') or bank_payout_id is not null))$c$),
      ('fragt_reklamationer_tekst_check',
       $c$check (char_length(coalesce(udbetaling_fejl, '')) <= 500 and char_length(coalesce(bank_fejl, '')) <= 500
                and char_length(coalesce(bank_fejlkode, '')) <= 100 and char_length(coalesce(udbetaling_stripe_konto, '')) <= 100
                and char_length(coalesce(stripe_transfer_id, '')) <= 100 and char_length(coalesce(bank_payout_id, '')) <= 100)$c$)
    ) as v(navn, def)
  loop
    execute format('alter table public.fragt_reklamationer drop constraint if exists %I', c.navn);
    execute format('alter table public.fragt_reklamationer add constraint %I %s', c.navn, c.def);
  end loop;
end $do$;

create unique index if not exists fragt_reklamationer_transfer_uq
  on public.fragt_reklamationer (stripe_transfer_id) where stripe_transfer_id is not null;
create unique index if not exists fragt_reklamationer_payout_uq
  on public.fragt_reklamationer (bank_payout_id) where bank_payout_id is not null;

comment on table public.fragt_reklamationer is
  'Reklamation hos fragtfirmaet ved transportskade (20261029010000). Én pr. sag. '
  'Oprettes automatisk (fragt_reklamation_synkroniser). BidHamr (staff) anmelder; '
  'fragtfirmaet udbetaler erstatningen til BidHamr, og KUN chefen udbetaler den til '
  'sælgeren (Stripe Transfer + payout). Slettes aldrig. Staff læser alt; sælger kun '
  'offentlige felter via mine_fragt_reklamationer().';
comment on column public.fragt_reklamationer.intern_note is 'Kun staff. Vises aldrig for sælgeren.';
comment on column public.fragt_reklamationer.stripe_transfer_id is
  'Stripe Transfer fra BidHamrs platformssaldo til sælgerens Connect-konto (metadata type=reklamation). Ikke BidHamrs indtægt - ingen faktura.';
comment on column public.fragt_reklamationer.bank_payout_id is
  'Payout fra sælgerens Connect-konto til sælgerens bank (metadata type=reklamation) - genkendes af webhooken og afstemningen, så den ikke regnes som en fremmed udbetaling.';

create index if not exists fragt_reklamationer_status_idx on public.fragt_reklamationer (status, fremdrift_kl);
create index if not exists fragt_reklamationer_saelger_idx on public.fragt_reklamationer (saelger_id);
create index if not exists fragt_reklamationer_trade_idx on public.fragt_reklamationer (trade_id);
create index if not exists fragt_reklamationer_opdateret_idx on public.fragt_reklamationer (opdateret_kl);
create index if not exists fragt_reklamationer_bank_idx on public.fragt_reklamationer (bank_status)
  where status = 'udbetalt' and (bank_status is null or bank_status in ('claimet', 'oprettet', 'failed'));

alter table public.fragt_reklamationer enable row level security;
revoke all on public.fragt_reklamationer from public, anon, authenticated;
-- Staff (rolle + aal2) må læse alt direkte. Ingen skriverettigheder: alt går
-- gennem funktionerne nedenfor (security definer).
grant select on public.fragt_reklamationer to authenticated, service_role;
drop policy if exists fragt_reklamationer_select_staff on public.fragt_reklamationer;
create policy fragt_reklamationer_select_staff on public.fragt_reklamationer
  for select to authenticated using ((select public.er_staff()));

-- Ingen sletning og faste felter. Statusovergange håndhæves i funktionerne
-- (update ... where status = ...); staff kan rette status bevidst - men
-- pengene er låst: en udbetalt reklamation forbliver udbetalt, og transfer,
-- konto og beløb kan ikke ændres, når udbetalingen er sat i gang.
create or replace function public.fragt_reklamationer_beskyt()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Reklamationer kan ikke slettes.' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.sag_id is distinct from old.sag_id
     or new.trade_id is distinct from old.trade_id or new.saelger_id is distinct from old.saelger_id
     or new.transportoer is distinct from old.transportoer
     or new.varens_vaerdi_oere is distinct from old.varens_vaerdi_oere
     or new.maks_erstatning_oere is distinct from old.maks_erstatning_oere
     or new.kravbeloeb_oere is distinct from old.kravbeloeb_oere
     or new.oprettet_af is distinct from old.oprettet_af or new.oprettet_kl is distinct from old.oprettet_kl then
    raise exception 'Reklamationens faste oplysninger kan ikke ændres.' using errcode = '42501';
  end if;
  if old.status = 'udbetalt' and (new.status <> 'udbetalt'
       or new.udbetalt_kl is distinct from old.udbetalt_kl
       or new.udbetalt_af is distinct from old.udbetalt_af) then
    raise exception 'En udbetalt reklamation kan ikke ændres.' using errcode = '42501';
  end if;
  if old.stripe_transfer_id is not null and new.stripe_transfer_id is distinct from old.stripe_transfer_id then
    raise exception 'Udbetalingens Stripe-transfer kan ikke ændres.' using errcode = '42501';
  end if;
  -- Mens udbetalingen er sat i gang, er beløb, konto og status låst. Claimen
  -- må kun frigøres (fragt_reklamation_udbetal_afvist: paabegyndt og konto
  -- nulstilles, status forbliver godkendt, beløbet er uændret).
  if old.udbetaling_paabegyndt_kl is not null
     and (new.godkendt_beloeb_oere is distinct from old.godkendt_beloeb_oere
          or new.status not in ('godkendt', 'udbetalt')
          or (new.udbetaling_paabegyndt_kl is not null
              and new.udbetaling_stripe_konto is distinct from old.udbetaling_stripe_konto)
          or (new.udbetaling_paabegyndt_kl is null
              and (new.status <> 'godkendt' or new.udbetaling_stripe_konto is not null))) then
    raise exception 'Udbetalingen er sat i gang - beløb, konto og status kan ikke ændres.' using errcode = '42501';
  end if;
  new.opdateret_kl := now();
  return new;
end;
$fn$;

revoke execute on function public.fragt_reklamationer_beskyt() from public, anon, authenticated;

drop trigger if exists fragt_reklamationer_beskyt on public.fragt_reklamationer;
create trigger fragt_reklamationer_beskyt
  before update or delete on public.fragt_reklamationer
  for each row execute function public.fragt_reklamationer_beskyt();

-- ===========================================================================
-- 4. moderation_log: nye handlinger (flettes ind i den nuværende liste)
-- ===========================================================================
do $do$
declare
  v_def  text;
  v_nye  text[] := array[
    'indpakning_ordentlig', 'indpakning_ordentlig_fortrudt',
    'reklamation_oprettet', 'reklamation_genaabnet', 'reklamation_annulleret',
    'reklamation_sag_aendret', 'reklamation_sag_aendret_kvitteret',
    'reklamation_note', 'reklamation_status_rettet',
    'reklamation_anmeldt', 'reklamation_godkendt', 'reklamation_afvist',
    'reklamation_udbetaling_startet', 'reklamation_udbetaling_fejlet', 'reklamation_udbetalt',
    'reklamation_bank_udbetaling'];
  v_gl   text[];
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if v_def is null then
    raise exception 'moderation_log_handling_check findes ikke';
  end if;
  v_gl := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m) s
     where x <> '' order by 1);
  if cardinality(v_gl) = 0 then
    raise exception 'Kunne ikke læse moderation_log_handling_check: %', v_def;
  end if;
  if v_nye <@ v_gl then
    return;
  end if;
  v_vals := array(select distinct x from unnest(v_gl || v_nye) x order by 1);
  alter table public.moderation_log drop constraint moderation_log_handling_check;
  execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', v_vals);

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if not (v_gl <@ array(
            select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
              from regexp_matches(v_def, '''([^'']+)''', 'g') as m)
          and v_nye <@ array(
            select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
              from regexp_matches(v_def, '''([^'']+)''', 'g') as m)) then
    raise exception 'moderation_log_handling_check blev ikke flettet korrekt: %', v_def;
  end if;
end $do$;

-- Den første udgaves sælger-funktioner (sælgeren anmeldte selv) og "send
-- oplysningerne igen" findes ikke længere.
drop function if exists public.mit_fragt_reklamation_anmeldt(uuid, text);
drop function if exists public.mit_fragt_reklamation_godkendt(uuid, bigint);
drop function if exists public.mit_fragt_reklamation_afvist(uuid, text);
drop function if exists public.mit_fragt_reklamation_fravaelg(uuid);
drop function if exists public.min_reklamationspakke_adgang(uuid);
drop function if exists public.fragt_reklamation_saelger_tjek(uuid);
drop function if exists public.fragt_reklamation_send_igen(uuid);

-- ===========================================================================
-- 5. Hjælpere (interne - ingen grants til browseren)
-- ===========================================================================
create or replace function public.fragt_reklamation_log(
  p_medarbejder uuid, p_handling text, p_sag uuid, p_saelger uuid, p_tekst text)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, p_handling, 'sag', p_sag, p_saelger, left(p_tekst, 4000));
$fn$;

revoke all on function public.fragt_reklamation_log(uuid, text, uuid, uuid, text) from public, anon, authenticated;

-- Dansk beløb til loggen/tidslinjen: "2.500 kr.", "1.250,50 kr.", "-12,05 kr.".
-- Uafhængig af databasens lc_numeric (punktum som tusindtalsskilletegn,
-- komma som decimaltegn; øre kun, når de ikke er 0).
create or replace function public.fragt_reklamation_kr(p_oere bigint)
returns text
language sql
immutable
set search_path = public
as $fn$
  select case when p_oere is null then '–'
    else case when p_oere < 0 then '-' else '' end
      || regexp_replace((abs(p_oere) / 100)::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
      || case when abs(p_oere) % 100 = 0 then '' else ',' || lpad((abs(p_oere) % 100)::text, 2, '0') end
      || ' kr.'
  end;
$fn$;

revoke all on function public.fragt_reklamation_kr(bigint) from public, anon, authenticated;

-- Er betingelserne for en reklamation opfyldt for sagen? (se toppen, pkt. 4)
-- Fælles for fragt_reklamation_synkroniser og fragt_reklamation_ret_status.
-- ok = true: alle betingelser er opfyldt; ellers aarsag:
--   ikke_skadet, ingen_handel, afhentning, ingen_forsendelse, indpakning,
--   ikke_refunderet, saelger_beholder, ikke_koebers_fordel, anke_venter,
--   ankefrist, ingen_vaerdi.
-- Læser kun (ingen låse).
create or replace function public.fragt_reklamation_betingelser(
  p_sag uuid,
  out ok boolean, out aarsag text, out trade_id uuid, out saelger_id uuid,
  out forsendelse_id uuid, out transportoer text, out sporingsnummer text,
  out vaerdi_oere bigint)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  s record;
  t record;
  b record;
  f record;
begin
  ok := false;
  select * into s from public.sager where id = p_sag;
  if not found or s.type <> 'skadet' then aarsag := 'ikke_skadet'; return; end if;

  select * into t from public.trades where id = s.trade_id;
  if not found or t.seller_id is null then aarsag := 'ingen_handel'; return; end if;
  trade_id := t.id;
  saelger_id := t.seller_id;
  if coalesce(t.afhentning, false) then aarsag := 'afhentning'; return; end if;

  -- Den udgående pakke med DAO eller GLS (den seneste aktive).
  select fo.id, fo.sporingsnummer,
         coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) as transportoer
    into f
    from public.forsendelser fo
   where fo.trade_id = t.id and fo.type = 'udgaaende'
     and fo.status not in ('opretter', 'annulleret', 'fejlet')
     and coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) in ('dao', 'gls')
   order by fo.oprettet_kl desc
   limit 1;
  if not found then aarsag := 'ingen_forsendelse'; return; end if;
  forsendelse_id := f.id;
  transportoer := f.transportoer;
  sporingsnummer := left(nullif(btrim(coalesce(f.sporingsnummer, t.tracking_number, '')), ''), 100);

  if not exists (select 1 from public.indpakning_ordentlig o
                  where o.sag_id = s.id and o.tilbagekaldt_kl is null) then
    aarsag := 'indpakning'; return;
  end if;

  -- Køberen HAR fået pengene tilbage: refunderet (bekræftet af Stripe -
  -- samme regel som admin: status 'refunderet' og refunderet_kl) eller tabt
  -- indsigelse (banken har givet køberen pengene).
  -- OG sælgeren beholder ikke salgsbeløbet (ellers får han erstatning oven i
  -- salgsbeløbet):
  --   - refunderet: intet er givet til sælgeren. Separat: ingen transfer er
  --     sat i gang. Destination: ingen udbetaling til banken, OG hele
  --     sælgerens andel er hentet tilbage fra Connect-kontoen
  --     (refusion_tilbagefoert_kl sat og refusion_fra_saelger_oere =
  --     udbetaling_oere). Ellers (tilbageførslen mangler, eller planen tog
  --     kun en del af sælgerens andel) kan sælgeren have beholdt penge ->
  --     'saelger_beholder'. Ikke-afhentet pakke (S = R < U) rammes også, men
  --     er aldrig en skadet-sag; det fejler den sikre vej.
  --     NB (separat): er en transfer sendt og derefter hentet tilbage af
  --     staff, er stripe_transfer_id/overfoersel_paabegyndt_kl stadig sat, så
  --     handlen giver 'saelger_beholder' (ingen reklamation). Det fejler
  --     bevidst den sikre vej: hellere ingen reklamation end erstatning til
  --     en sælger, der måske har beholdt salgsbeløbet.
  --   - tabt indsigelse: separat - ingen transfer er sat i gang (pengene
  --     blev aldrig sendt til sælgeren); destination - hele udbetaling_oere
  --     er hentet tilbage fra sælgerens Connect-konto (tilbageførslen er
  --     gennemført, ikke i gang/opgivet/delvis). Var handlen udbetalt, bærer
  --     BidHamr tabet (betaling_indsigelse_tilbagefoersel_claim 'udbetalt'),
  --     og sælgeren beholder pengene -> ingen reklamation.
  select * into b from public.betalinger where betalinger.trade_id = t.id;
  if not found then aarsag := 'ikke_refunderet'; return; end if;
  if b.status = 'refunderet' and b.refunderet_kl is not null then
    if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
       or b.overfoersel_paabegyndt_kl is not null
       or (b.pengemodel = 'destination'
           and (b.refusion_tilbagefoert_kl is null
                or b.refusion_fra_saelger_oere is distinct from b.udbetaling_oere)) then
      aarsag := 'saelger_beholder'; return;
    end if;
  elsif coalesce(b.indsigelse_status, '') = 'lost' then
    if not (
         (b.pengemodel = 'separat'
          and b.stripe_transfer_id is null and b.overfoersel_paabegyndt_kl is null)
      or (b.pengemodel = 'destination'
          and b.saelger_udbetaling_id is null and b.stripe_transfer_id is null
          and b.indsigelse_tilbagefoersel_id is not null
          and b.indsigelse_tilbagefoert_kl is not null
          and b.indsigelse_tilbagefoert_oere is not null
          and b.indsigelse_tilbagefoert_oere >= b.udbetaling_oere)) then
      aarsag := 'saelger_beholder'; return;
    end if;
  else
    aarsag := 'ikke_refunderet'; return;
  end if;

  -- Endelig til købers fordel.
  if s.status = 'afgjort_koeber' and s.penge_handling = 'refunder' and s.afviklet_kl is not null then
    if exists (select 1 from public.sag_anker a where a.sag_id = s.id and a.status = 'afventer') then
      aarsag := 'anke_venter'; return;
    end if;
    -- Ankefristen (afgjort_kl + 4 dage) er udløbet - eller anken er afgjort
    -- (endelig). Refunderet hos Stripe før fristen: vent til fristen.
    if not exists (select 1 from public.sag_anker a where a.sag_id = s.id)
       and (s.afgjort_kl is null or s.afgjort_kl > now() - interval '4 days') then
      aarsag := 'ankefrist'; return;
    end if;
  elsif s.status = 'lukket' and s.penge_handling is null and s.afviklet_kl is not null then
    -- Lukket af systemet ved refusion / tabt indsigelse (kan ikke ankes).
    null;
  else
    aarsag := 'ikke_koebers_fordel'; return;
  end if;

  vaerdi_oere := coalesce(b.bud_oere, round(coalesce(t.amount, 0) * 100)::bigint);
  if vaerdi_oere is null or vaerdi_oere <= 0 then aarsag := 'ingen_vaerdi'; return; end if;

  ok := true;
  aarsag := null;
end;
$fn$;

revoke all on function public.fragt_reklamation_betingelser(uuid) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_betingelser(uuid) to service_role;

-- Opretter/annullerer/genopliver sagens reklamation ud fra betingelserne
-- (fragt_reklamation_betingelser). Kaldes via fragt_reklamation_synkroniser_sikker
-- af triggeren på sager, af indpakning_ordentlig / -_fortryd og af cron'en.
-- Returnerer hvad der skete:
-- oprettet, genaabnet, annulleret, sag_aendret, sag_aendret_kvitteret,
-- uaendret, ikke_relevant.
create or replace function public.fragt_reklamation_synkroniser(p_sag uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  sys      constant uuid := public.bidhamr_system_id();
  c        record;
  r        record;
  v_findes boolean;
  v_maks   bigint;
  v_krav   bigint;
  v_status text;
begin
  select * into c from public.fragt_reklamation_betingelser(p_sag);

  select * into r from public.fragt_reklamationer where sag_id = p_sag for update;
  v_findes := found;

  if c.ok then
    if not v_findes then
      select e.maks_oere into v_maks from public.fragt_transportoer_erstatning e where e.transportoer = c.transportoer;
      v_krav := least(c.vaerdi_oere, coalesce(v_maks, c.vaerdi_oere));

      insert into public.fragt_reklamationer (
        sag_id, trade_id, saelger_id, forsendelse_id, transportoer, trackingnummer,
        varens_vaerdi_oere, maks_erstatning_oere, kravbeloeb_oere, oprettet_af)
      values (
        p_sag, c.trade_id, c.saelger_id, c.forsendelse_id, c.transportoer, c.sporingsnummer,
        c.vaerdi_oere, v_maks, v_krav, sys)
      on conflict (sag_id) do nothing;
      if not found then return 'uaendret'; end if;

      perform public.fragt_reklamation_log(sys, 'reklamation_oprettet', p_sag, c.saelger_id,
        'Reklamation hos ' || upper(c.transportoer) || ' oprettet automatisk (skadet under fragten, ordentlig '
        || 'indpakning, køberen er refunderet, og afgørelsen er endelig). BidHamr anmelder - kravbeløb '
        || public.fragt_reklamation_kr(v_krav)
        || case when v_maks is null then ' (maks. erstatning ukendt - varens værdi)' else '' end);
      return 'oprettet';
    end if;

    -- Genåbnet inden for 1 time efter den automatiske annullering (fx staff
    -- fortryder "ordentlig" og vurderer igen): aktiv_fra_kl beholdes, så
    -- sælgeren ikke får "Vi reklamerer for dig" igen (samme nøgle), og
    -- "stoppet"-beskeden er heller ikke sendt endnu (den venter 1 time -
    -- AUTO_STOP_VENT i src/lib/reklamation/notifikationer.ts). Senere: ny
    -- aktivering og ny besked.
    if r.status = 'annulleret' and r.annulleret_auto then
      update public.fragt_reklamationer
         set status = 'afventer_bidhamr', annulleret_auto = false, annulleret_grund = null,
             annulleret_af = null, annulleret_kl = null,
             sag_aendret_kl = null, sag_aendret_kvitteret_kl = null, sag_aendret_kvitteret_af = null,
             sag_aendret_kvitteret_aarsag = null,
             aktiv_fra_kl = case when r.annulleret_kl > now() - interval '1 hour' then r.aktiv_fra_kl else now() end,
             fremdrift_kl = now()
       where id = r.id and status = 'annulleret' and annulleret_auto;
      perform public.fragt_reklamation_log(sys, 'reklamation_genaabnet', p_sag, r.saelger_id,
        'Reklamationen er aktiv igen: køberen er refunderet, afgørelsen er endelig, og indpakningen er ordentlig');
      return 'genaabnet';
    end if;

    -- Sagen var markeret ændret, men betingelserne er opfyldt igen (fx
    -- refusionen er gennemført igen): systemet kvitterer.
    if r.sag_aendret_kl is not null and r.sag_aendret_kvitteret_kl is null
       and r.status in ('anmeldt', 'godkendt') then
      update public.fragt_reklamationer
         set sag_aendret_kvitteret_kl = now(), sag_aendret_kvitteret_af = sys,
             sag_aendret_kvitteret_aarsag = null, fremdrift_kl = now()
       where id = r.id and sag_aendret_kl is not null and sag_aendret_kvitteret_kl is null;
      perform public.fragt_reklamation_log(sys, 'reklamation_sag_aendret_kvitteret', p_sag, r.saelger_id,
        'Betingelserne er opfyldt igen (køberen er refunderet, afgørelsen er endelig, indpakningen er '
        || 'ordentlig) - kvitteret automatisk, reklamationen fortsætter (status ' || r.status || ')');
      return 'sag_aendret_kvitteret';
    end if;
    return 'uaendret';
  end if;

  -- Betingelserne er ikke (længere) opfyldt.
  if not v_findes then return 'ikke_relevant'; end if;

  select status into v_status from public.sager where id = p_sag;

  if r.status = 'afventer_bidhamr' then
    update public.fragt_reklamationer
       set status = 'annulleret', annulleret_auto = true, annulleret_af = sys, annulleret_kl = now(),
           annulleret_grund = 'Sagen er ændret (refusionen, afgørelsen eller vurderingen af indpakningen).'
     where id = r.id and status = 'afventer_bidhamr';
    perform public.fragt_reklamation_log(sys, 'reklamation_annulleret', p_sag, r.saelger_id,
      'Reklamationen er annulleret automatisk, før skaden blev anmeldt (' || coalesce(c.aarsag, '?')
      || ', sagens status ' || coalesce(v_status, '?') || ')');
    return 'annulleret';
  end if;

  -- Ny markering, når sagen ikke er markeret, ELLER når den er kvitteret og
  -- er ændret igen bagefter:
  --   - kvitteret under opfyldte betingelser (sag_aendret_kvitteret_aarsag
  --     null - systemets eller staffs kvittering): altid markeres igen.
  --   - kvitteret af staff under en midlertidig årsag (anke_venter /
  --     ankefrist): kun når årsagen nu er en anden end de midlertidige.
  -- En udbetalt reklamation røres ikke (pengene er sendt).
  if r.status in ('anmeldt', 'godkendt')
     and (r.sag_aendret_kl is null
          or (r.sag_aendret_kvitteret_kl is not null
              and (r.sag_aendret_kvitteret_aarsag is null
                   or coalesce(c.aarsag, '') not in ('anke_venter', 'ankefrist')))) then
    update public.fragt_reklamationer
       set sag_aendret_kl = now(), sag_aendret_kvitteret_kl = null, sag_aendret_kvitteret_af = null,
           sag_aendret_kvitteret_aarsag = null
     where id = r.id;
    perform public.fragt_reklamation_log(sys, 'reklamation_sag_aendret', p_sag, r.saelger_id,
      'OBS: sagen er ændret (' || coalesce(c.aarsag, '?') || ', status ' || coalesce(v_status, '?')
      || '), efter skaden er anmeldt hos ' || upper(r.transportoer)
      || '. "Godkendt" og udbetalingen er spærret, til staff har kvitteret.');
    return 'sag_aendret';
  end if;

  return 'uaendret';
end;
$fn$;

revoke all on function public.fragt_reklamation_synkroniser(uuid) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_synkroniser(uuid) to service_role;

-- Som fragt_reklamation_synkroniser, men fejler aldrig: en uventet fejl
-- rulles tilbage (kun reklamationens del), logges som drift-fejl
-- (/admin/drift + alarm-mail) og giver 'fejl'. Deadlock (40P01) er
-- forbigående: kun databasens log, ingen alarm, giver 'deadlock'. Cron'en
-- (fragt_reklamationer_synkroniser_alle) prøver igen hvert 5. minut.
create or replace function public.fragt_reklamation_synkroniser_sikker(p_sag uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  begin
    return public.fragt_reklamation_synkroniser(p_sag);
  exception
    when deadlock_detected then
      raise log 'fragt_reklamation_synkroniser_sikker: deadlock (40P01) for sag % - prøves igen af cron', p_sag;
      return 'deadlock';
    when others then
    begin
      perform public.drift_fejl_log(
        'server', '/admin/reklamationer',
        left('Reklamation hos fragtfirma: automatisk oprettelse/opdatering fejlede for sag '
             || coalesce(p_sag::text, '?') || ' (' || sqlstate || '): ' || sqlerrm
             || '. Prøves igen automatisk hvert 5. minut.', 1000),
        'reklamation_synk_' || sqlstate);
    exception when others then
      raise warning 'fragt_reklamation_synkroniser_sikker: kunne ikke logge fejlen (%)', sqlerrm;
    end;
    return 'fejl';
  end;
end;
$fn$;

revoke all on function public.fragt_reklamation_synkroniser_sikker(uuid) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_synkroniser_sikker(uuid) to service_role;

-- Cron (src/lib/reklamation/notifikationer.ts, før beskederne): synkroniserer
-- sager, hvor betingelserne kan have ændret sig uden en ændring på sagen
-- (refusionen bekræftet/fejlet på betalinger, ankefristen udløbet).
-- To dele med HVER SIN grænse (p_graense hver), så åbne reklamationer altid
-- synkroniseres, uanset hvor mange kandidater der er:
--   1. eksisterende reklamationer: åbne (afventer_bidhamr, anmeldt) først,
--      derefter godkendte og auto-annullerede (højst 180 dage tilbage)
--   2. kandidater uden reklamation: skadet, ordentlig indpakning, afgjort
--      til køber / lukket med refusion (penge_handling ikke 'ingen'),
--      afviklet inden for 180 dage, ikke afhentning, med en DAO/GLS-pakke
-- Svar: {"<resultat>": antal, ...}. Kun service_role.
create or replace function public.fragt_reklamationer_synkroniser_alle(p_graense integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_graense integer := greatest(1, least(coalesce(p_graense, 200), 1000));
  v_sag uuid;
  v_res text;
  v_ud  jsonb := '{}'::jsonb;
begin
  -- 1. Eksisterende reklamationer.
  for v_sag in
    select r.sag_id
      from public.fragt_reklamationer r
     where r.status in ('afventer_bidhamr', 'anmeldt')
        or (r.status = 'godkendt' and r.fremdrift_kl > now() - interval '180 days')
        or (r.status = 'annulleret' and r.annulleret_auto and r.annulleret_kl > now() - interval '180 days')
     order by (r.status in ('afventer_bidhamr', 'anmeldt')) desc, random()
     limit v_graense
  loop
    v_res := public.fragt_reklamation_synkroniser_sikker(v_sag);
    if v_res <> 'uaendret' and v_res <> 'ikke_relevant' then
      v_ud := v_ud || jsonb_build_object(v_res, coalesce((v_ud->>v_res)::integer, 0) + 1);
    end if;
  end loop;

  -- 2. Kandidater uden reklamation.
  for v_sag in
    select o.sag_id
      from public.indpakning_ordentlig o
      join public.sager s on s.id = o.sag_id
      join public.trades t on t.id = s.trade_id
     where o.tilbagekaldt_kl is null and s.type = 'skadet'
       and s.status in ('afgjort_koeber', 'lukket')
       and s.afviklet_kl is not null and s.afviklet_kl > now() - interval '180 days'
       and s.penge_handling is distinct from 'ingen'
       and not coalesce(t.afhentning, false)
       and exists (select 1 from public.forsendelser fo
                    where fo.trade_id = t.id and fo.type = 'udgaaende'
                      and fo.status not in ('opretter', 'annulleret', 'fejlet')
                      and coalesce(fo.transportoer,
                                   case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) in ('dao', 'gls'))
       and not exists (select 1 from public.fragt_reklamationer r where r.sag_id = o.sag_id)
     order by random()
     limit v_graense
  loop
    v_res := public.fragt_reklamation_synkroniser_sikker(v_sag);
    if v_res <> 'uaendret' and v_res <> 'ikke_relevant' then
      v_ud := v_ud || jsonb_build_object(v_res, coalesce((v_ud->>v_res)::integer, 0) + 1);
    end if;
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.fragt_reklamationer_synkroniser_alle(integer) from public, anon, authenticated;
grant execute on function public.fragt_reklamationer_synkroniser_alle(integer) to service_role;

-- Triggeren fejler aldrig (..._sikker): en sagsafgørelse må ikke rulles
-- tilbage pga. reklamationen.
create or replace function public.sager_fragt_reklamation()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.type = 'skadet' then
    perform public.fragt_reklamation_synkroniser_sikker(new.id);
  end if;
  return null;
end;
$fn$;

revoke execute on function public.sager_fragt_reklamation() from public, anon, authenticated;

drop trigger if exists sager_fragt_reklamation on public.sager;
create trigger sager_fragt_reklamation
  after update of status, afviklet_kl, penge_handling on public.sager
  for each row when (new.status is distinct from old.status
                     or new.afviklet_kl is distinct from old.afviklet_kl
                     or new.penge_handling is distinct from old.penge_handling)
  execute function public.sager_fragt_reklamation();

-- Fælles tjek for staff: kalderen (auth.uid()) er staff med aal2,
-- reklamationen findes (låses), og kalderen er ikke inhabil.
-- kode = null ved ok, ellers en fejlkode.
create or replace function public.fragt_reklamation_tjek(p_reklamation uuid, out kode text, out r public.fragt_reklamationer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t record;
begin
  if auth.uid() is null or not public.er_staff() then
    kode := 'ingen_adgang'; return;
  end if;
  select * into r from public.fragt_reklamationer where id = p_reklamation for update;
  if not found then kode := 'ikke_fundet'; return; end if;
  select buyer_id, seller_id into t from public.trades where id = r.trade_id;
  if public.penge_inhabil(auth.uid(), t.buyer_id, t.seller_id) then
    kode := 'inhabil'; return;
  end if;
  kode := null;
end;
$fn$;

revoke all on function public.fragt_reklamation_tjek(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 6. Indpakning: ordentlig / fortryd (staff)
-- ===========================================================================
-- Koder: ok, ingen_adgang, ikke_fundet, inhabil, ikke_skadet, afhentning,
-- allerede_vurderet (+ resultat: ordentlig|paamindelse|advarsel), for_lang_tekst.
-- Svar ved ok: {"kode":"ok","reklamation":"oprettet"|"genaabnet"|"uaendret"|"ikke_relevant"|...}
create or replace function public.indpakning_ordentlig(p_sag uuid, p_intern_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_intern_note, '')), '');
  s      record;
  t      record;
  o      record;
  v_res  text;
begin
  if v_uid is null or not public.er_staff() then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select id, trade_id, type into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select id, buyer_id, seller_id, afhentning into t from public.trades where id = s.trade_id;
  if not found or t.seller_id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if public.penge_inhabil(v_uid, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if s.type <> 'skadet' then return jsonb_build_object('kode', 'ikke_skadet'); end if;
  if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;

  -- Dårlig indpakning blokerer. Påmindelser og advarsler kan ikke
  -- tilbagekaldes i dag (paamindelser er uforanderlige - trigger
  -- paamindelser_uforanderlig; advarsler har hverken tilbagekaldelse eller
  -- sletning), så alle rækker tæller. Får de en tilbagekaldelse senere, skal
  -- den udelades her og i indpakning_daarlig_ikke_ordentlig.
  if exists (select 1 from public.paamindelser where sag_id = s.id and grund = 'daarlig_indpakning') then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'paamindelse');
  end if;
  if exists (select 1 from public.advarsler where sag_id = s.id and grund = 'daarlig_indpakning') then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'advarsel');
  end if;

  select * into o from public.indpakning_ordentlig where sag_id = s.id for update;
  if found and o.tilbagekaldt_kl is null then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'ordentlig');
  end if;

  if found then
    update public.indpakning_ordentlig
       set vurderet_af = v_uid, vurderet_kl = now(), intern_note = v_note,
           tilbagekaldt_kl = null, tilbagekaldt_af = null, tilbagekaldt_grund = null
     where sag_id = s.id and tilbagekaldt_kl is not null;
  else
    insert into public.indpakning_ordentlig (sag_id, trade_id, vurderet_af, intern_note)
    values (s.id, t.id, v_uid, v_note);
  end if;

  perform public.fragt_reklamation_log(v_uid, 'indpakning_ordentlig', s.id, t.seller_id,
    'Indpakningen vurderet ordentlig' || coalesce(' | Intern note: ' || v_note, ''));

  v_res := public.fragt_reklamation_synkroniser_sikker(s.id);
  return jsonb_build_object('kode', 'ok', 'reklamation', v_res);
end;
$fn$;

revoke all on function public.indpakning_ordentlig(uuid, text) from public, anon;
grant execute on function public.indpakning_ordentlig(uuid, text) to authenticated;

-- Fortryd "ordentlig" (fx fejlklik). Kun så længe skaden ikke er anmeldt
-- (en reklamation i 'afventer_bidhamr' annulleres så automatisk).
-- Koder: ok, ingen_adgang, ikke_fundet, inhabil, grund_mangler,
-- for_lang_tekst, ikke_vurderet, reklamation_anmeldt.
create or replace function public.indpakning_ordentlig_fortryd(p_sag uuid, p_grund text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
  s       record;
  t       record;
  v_res   text;
begin
  if v_uid is null or not public.er_staff() then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if v_grund is null then return jsonb_build_object('kode', 'grund_mangler'); end if;
  if char_length(v_grund) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select id, trade_id into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select buyer_id, seller_id into t from public.trades where id = s.trade_id;
  if public.penge_inhabil(v_uid, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if exists (select 1 from public.fragt_reklamationer
              where sag_id = s.id and status in ('anmeldt', 'godkendt', 'afvist', 'udbetalt')) then
    return jsonb_build_object('kode', 'reklamation_anmeldt');
  end if;

  update public.indpakning_ordentlig
     set tilbagekaldt_kl = now(), tilbagekaldt_af = v_uid, tilbagekaldt_grund = v_grund
   where sag_id = s.id and tilbagekaldt_kl is null;
  if not found then return jsonb_build_object('kode', 'ikke_vurderet'); end if;

  perform public.fragt_reklamation_log(v_uid, 'indpakning_ordentlig_fortrudt', s.id, t.seller_id,
    'Vurderingen "ordentlig indpakning" er fortrudt | ' || v_grund);

  v_res := public.fragt_reklamation_synkroniser_sikker(s.id);
  return jsonb_build_object('kode', 'ok', 'reklamation', v_res);
end;
$fn$;

revoke all on function public.indpakning_ordentlig_fortryd(uuid, text) from public, anon;
grant execute on function public.indpakning_ordentlig_fortryd(uuid, text) to authenticated;

-- ===========================================================================
-- 7. Staff-handlinger (én funktion pr. knap)
-- ===========================================================================
-- Fælles koder: ingen_adgang, ikke_fundet, inhabil, forkert_status (+ status).

-- Intern note (erstatter den forrige; tom tekst rydder). Kun staff ser den.
-- Koder: + for_lang_tekst.
create or replace function public.fragt_reklamation_gem_note(p_reklamation uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_note is not null and char_length(v_note) > 4000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).intern_note is not distinct from v_note then
    return jsonb_build_object('kode', 'ok', 'uaendret', true);
  end if;
  update public.fragt_reklamationer set intern_note = v_note where id = (c.r).id;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_note', (c.r).sag_id, (c.r).saelger_id,
    'Intern note: ' || coalesce(v_note, '(ryddet)'));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- "Anmeldt" (staff har anmeldt skaden hos fragtfirmaet) + fragtfirmaets
-- sagsnummer (påkrævet). Fra afventer_bidhamr - kun når betingelserne er
-- opfyldt. Kaldt igen på en anmeldt reklamation rettes kun sagsnummeret.
-- Koder: + sagsnummer_mangler, for_lang_tekst, betingelser_ikke_opfyldt (+ aarsag).
create or replace function public.fragt_reklamation_anmeld(p_reklamation uuid, p_sagsnummer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c    record;
  b    record;
  v_nr text := nullif(btrim(coalesce(p_sagsnummer, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_nr is null then return jsonb_build_object('kode', 'sagsnummer_mangler'); end if;
  if char_length(v_nr) > 100 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  if (c.r).status = 'anmeldt' then
    if v_nr is not distinct from (c.r).transportoerens_sagsnummer then
      return jsonb_build_object('kode', 'ok', 'uaendret', true);
    end if;
    update public.fragt_reklamationer set transportoerens_sagsnummer = v_nr
     where id = (c.r).id and status = 'anmeldt';
    perform public.fragt_reklamation_log(auth.uid(), 'reklamation_anmeldt', (c.r).sag_id, (c.r).saelger_id,
      'Sagsnummer rettet: ' || coalesce((c.r).transportoerens_sagsnummer, '–') || ' -> ' || v_nr);
    return jsonb_build_object('kode', 'ok', 'rettet', true);
  end if;
  if (c.r).status <> 'afventer_bidhamr' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  select * into b from public.fragt_reklamation_betingelser((c.r).sag_id);
  if not b.ok then
    return jsonb_build_object('kode', 'betingelser_ikke_opfyldt', 'aarsag', b.aarsag);
  end if;
  update public.fragt_reklamationer
     set status = 'anmeldt', anmeldt_kl = now(), fremdrift_kl = now(), transportoerens_sagsnummer = v_nr
   where id = (c.r).id and status = 'afventer_bidhamr';
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_anmeldt', (c.r).sag_id, (c.r).saelger_id,
    'Skaden er anmeldt hos ' || upper((c.r).transportoer) || ' | Sagsnummer: ' || v_nr);
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- "Godkendt" (fragtfirmaet har godkendt erstatningen) + beløb (1 øre ..
-- kravbeløbet). Fra anmeldt. Spærret, mens sagen er ændret efter
-- anmeldelsen og ingen har kvitteret. Pengene udbetales først, når chefen
-- har bekræftet, at BidHamr har modtaget dem (fragt_reklamation_udbetal_claim).
-- Koder: + ugyldigt_beloeb (+ maks_oere), sag_aendret.
create or replace function public.fragt_reklamation_godkend(p_reklamation uuid, p_beloeb_oere bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if (c.r).status = 'godkendt' and (c.r).godkendt_beloeb_oere = p_beloeb_oere then
    return jsonb_build_object('kode', 'ok', 'uaendret', true);
  end if;
  if (c.r).status <> 'anmeldt' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if (c.r).sag_aendret_kl is not null and (c.r).sag_aendret_kvitteret_kl is null then
    return jsonb_build_object('kode', 'sag_aendret');
  end if;
  if p_beloeb_oere is null or p_beloeb_oere <= 0 or p_beloeb_oere > (c.r).kravbeloeb_oere then
    return jsonb_build_object('kode', 'ugyldigt_beloeb', 'maks_oere', (c.r).kravbeloeb_oere);
  end if;
  update public.fragt_reklamationer
     set status = 'godkendt', godkendt_beloeb_oere = p_beloeb_oere,
         afgjort_kl = now(), afgjort_af = auth.uid(), fremdrift_kl = now()
   where id = (c.r).id and status = 'anmeldt';
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_godkendt', (c.r).sag_id, (c.r).saelger_id,
    upper((c.r).transportoer) || ' har godkendt erstatningen: ' || public.fragt_reklamation_kr(p_beloeb_oere)
    || ' (sagsnummer ' || coalesce((c.r).transportoerens_sagsnummer, '–')
    || '). Udbetales til sælgeren af chefen, når BidHamr har modtaget pengene');
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- "Afvist" (fragtfirmaet har afvist) + fragtfirmaets grund (påkrævet - vises
-- for sælgeren). Fra anmeldt.
-- Koder: + grund_mangler, for_lang_tekst.
create or replace function public.fragt_reklamation_afvis(p_reklamation uuid, p_grund text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c       record;
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_grund is null then return jsonb_build_object('kode', 'grund_mangler'); end if;
  if char_length(v_grund) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status = 'afvist' and (c.r).afvisningsgrund is not distinct from v_grund then
    return jsonb_build_object('kode', 'ok', 'uaendret', true);
  end if;
  if (c.r).status <> 'anmeldt' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  update public.fragt_reklamationer
     set status = 'afvist', afvisningsgrund = v_grund,
         afgjort_kl = now(), afgjort_af = auth.uid(), fremdrift_kl = now()
   where id = (c.r).id and status = 'anmeldt';
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_afvist', (c.r).sag_id, (c.r).saelger_id,
    upper((c.r).transportoer) || ' har afvist reklamationen | Grund (til sælgeren): ' || v_grund);
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- Annullér med grund (vises for sælgeren). Fra afventer_bidhamr, anmeldt
-- eller godkendt - ikke mens chefens udbetaling er i gang.
-- Koder: + grund_mangler, for_lang_tekst, udbetaling_i_gang.
create or replace function public.fragt_reklamation_annuller(p_reklamation uuid, p_grund text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_grund is null then return jsonb_build_object('kode', 'grund_mangler'); end if;
  if char_length(v_grund) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status not in ('afventer_bidhamr', 'anmeldt', 'godkendt') then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if (c.r).udbetaling_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetaling_i_gang');
  end if;
  -- Annulleringen er også staffs kvittering for en ændret sag.
  update public.fragt_reklamationer
     set status = 'annulleret', annulleret_auto = false, annulleret_grund = v_grund,
         annulleret_af = auth.uid(), annulleret_kl = now(), godkendt_beloeb_oere = null,
         sag_aendret_kvitteret_kl = case when sag_aendret_kl is not null
                                         then coalesce(sag_aendret_kvitteret_kl, now()) end,
         sag_aendret_kvitteret_af = case when sag_aendret_kl is not null
                                         then coalesce(sag_aendret_kvitteret_af, auth.uid()) end,
         sag_aendret_kvitteret_aarsag = case when sag_aendret_kl is not null
                                             and sag_aendret_kvitteret_kl is not null
                                             then sag_aendret_kvitteret_aarsag end
   where id = (c.r).id and status in ('afventer_bidhamr', 'anmeldt', 'godkendt')
     and udbetaling_paabegyndt_kl is null;
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_annulleret', (c.r).sag_id, (c.r).saelger_id,
    'Reklamationen er annulleret (status var ' || (c.r).status
    || case when (c.r).godkendt_beloeb_oere is not null
            then ', godkendt ' || public.fragt_reklamation_kr((c.r).godkendt_beloeb_oere) else '' end
    || ') | Til sælgeren: ' || v_grund);
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- Ret status (fx forkert registreret, eller svaret er kommet på anden vis).
-- p_status: afventer_bidhamr | anmeldt | godkendt (kræver p_beloeb_oere) |
-- afvist (kræver p_grund). p_sagsnummer: påkrævet for anmeldt/godkendt/
-- afvist, hvis der ikke er et i forvejen (bevares ellers).
-- p_begrundelse: intern, påkrævet - logges.
-- Aldrig fra eller til 'udbetalt', og ikke mens chefens udbetaling er i
-- gang. Til afventer_bidhamr/anmeldt/godkendt kun, når betingelserne er
-- opfyldt (samme tjek som synkroniseringen). afvist altid. Rettelsen er også
-- staffs kvittering for en ændret sag.
-- Koder: + ugyldig_status, begrundelse_mangler, for_lang_tekst,
-- ugyldigt_beloeb (+ maks_oere), sagsnummer_mangler, grund_mangler,
-- uaendret, udbetaling_i_gang, betingelser_ikke_opfyldt (+ aarsag).
create or replace function public.fragt_reklamation_ret_status(
  p_reklamation uuid, p_status text, p_beloeb_oere bigint, p_sagsnummer text,
  p_grund text, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c       record;
  b       record;
  v_nr    text := nullif(btrim(coalesce(p_sagsnummer, '')), '');
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
  v_beg   text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_kvit  boolean;
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if p_status is null or p_status not in ('afventer_bidhamr', 'anmeldt', 'godkendt', 'afvist') then
    return jsonb_build_object('kode', 'ugyldig_status');
  end if;
  if (c.r).status = 'udbetalt' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if (c.r).udbetaling_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetaling_i_gang');
  end if;
  if v_beg is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_beg) > 2000 or char_length(coalesce(v_grund, '')) > 1000
     or char_length(coalesce(v_nr, '')) > 100 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;
  if p_status = 'godkendt'
     and (p_beloeb_oere is null or p_beloeb_oere <= 0 or p_beloeb_oere > (c.r).kravbeloeb_oere) then
    return jsonb_build_object('kode', 'ugyldigt_beloeb', 'maks_oere', (c.r).kravbeloeb_oere);
  end if;
  if p_status in ('anmeldt', 'godkendt') and coalesce(v_nr, (c.r).transportoerens_sagsnummer) is null then
    return jsonb_build_object('kode', 'sagsnummer_mangler');
  end if;
  if p_status = 'afvist' and coalesce(v_grund, (c.r).afvisningsgrund) is null then
    return jsonb_build_object('kode', 'grund_mangler');
  end if;
  if (c.r).status = p_status
     and (p_status <> 'godkendt' or (c.r).godkendt_beloeb_oere = p_beloeb_oere)
     and (v_nr is null or v_nr is not distinct from (c.r).transportoerens_sagsnummer)
     and (p_status <> 'afvist' or v_grund is null or v_grund is not distinct from (c.r).afvisningsgrund) then
    return jsonb_build_object('kode', 'uaendret');
  end if;

  if p_status in ('afventer_bidhamr', 'anmeldt', 'godkendt') then
    select * into b from public.fragt_reklamation_betingelser((c.r).sag_id);
    if not b.ok then
      return jsonb_build_object('kode', 'betingelser_ikke_opfyldt', 'aarsag', b.aarsag);
    end if;
  end if;

  v_kvit := (c.r).sag_aendret_kl is not null and (c.r).sag_aendret_kvitteret_kl is null;

  update public.fragt_reklamationer
     set status = p_status,
         transportoerens_sagsnummer = coalesce(v_nr, transportoerens_sagsnummer),
         godkendt_beloeb_oere = case when p_status = 'godkendt' then p_beloeb_oere end,
         afvisningsgrund = case when p_status = 'afvist' then coalesce(v_grund, afvisningsgrund) end,
         anmeldt_kl = case when p_status = 'afventer_bidhamr' then null
                           else coalesce(anmeldt_kl, now()) end,
         afgjort_kl = case when p_status in ('godkendt', 'afvist') then now() end,
         afgjort_af = case when p_status in ('godkendt', 'afvist') then auth.uid() end,
         annulleret_auto = false, annulleret_grund = null, annulleret_af = null, annulleret_kl = null,
         -- En ny godkendelse skal bekræftes af chefen på ny.
         erstatning_modtaget_kl = null, erstatning_modtaget_af = null, udbetaling_fejl = null,
         -- Betingelserne er opfyldt igen (tjekket ovenfor): ingen ændret sag.
         sag_aendret_kl = case when p_status in ('afventer_bidhamr', 'anmeldt', 'godkendt') then null
                               else sag_aendret_kl end,
         sag_aendret_kvitteret_kl = case
           when p_status in ('afventer_bidhamr', 'anmeldt', 'godkendt') then null
           when v_kvit then now() else sag_aendret_kvitteret_kl end,
         sag_aendret_kvitteret_af = case
           when p_status in ('afventer_bidhamr', 'anmeldt', 'godkendt') then null
           when v_kvit then auth.uid() else sag_aendret_kvitteret_af end,
         -- afvist: kvitteringen er ikke givet under en midlertidig årsag
         -- (status er ikke anmeldt/godkendt, så der markeres ikke igen).
         sag_aendret_kvitteret_aarsag = case
           when p_status in ('afventer_bidhamr', 'anmeldt', 'godkendt') then null
           when v_kvit then null else sag_aendret_kvitteret_aarsag end,
         aktiv_fra_kl = case when p_status = 'afventer_bidhamr' then now() else aktiv_fra_kl end,
         fremdrift_kl = now()
   where id = (c.r).id and status = (c.r).status and udbetaling_paabegyndt_kl is null;
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;

  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_status_rettet', (c.r).sag_id, (c.r).saelger_id,
    'Status rettet: ' || (c.r).status || ' -> ' || p_status
    || case when p_status = 'godkendt' then ' (' || public.fragt_reklamation_kr(p_beloeb_oere) || ')' else '' end
    || coalesce(' | Sagsnummer: ' || v_nr, '') || coalesce(' | Grund: ' || v_grund, '')
    || case when v_kvit then ' | Kvitterer for den ændrede sag' else '' end
    || ' | Begrundelse: ' || v_beg);
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- Staff kvitterer for, at sagen er ændret efter anmeldelsen ("set -
-- reklamationen fortsætter"). Status røres ikke; "godkendt" og chefens
-- udbetaling er igen mulige. Vil staff i stedet stoppe reklamationen:
-- annullér eller ret status (det kvitterer også).
-- Kun, når betingelserne er opfyldt, eller årsagen er midlertidig (en anke
-- venter / ankefristen løber) - ellers betingelser_ikke_opfyldt (+ aarsag).
-- Årsagen logges altid. NB: chefens udbetaling kræver HELT opfyldte
-- betingelser - en kvittering under en midlertidig årsag åbner ikke for den.
-- Koder: + begrundelse_mangler, for_lang_tekst, ikke_aendret,
-- betingelser_ikke_opfyldt (+ aarsag).
create or replace function public.fragt_reklamation_kvitter_sag_aendret(p_reklamation uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c     record;
  b     record;
  v_beg text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_beg is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_beg) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).sag_aendret_kl is null or (c.r).sag_aendret_kvitteret_kl is not null
     or (c.r).status not in ('anmeldt', 'godkendt') then
    return jsonb_build_object('kode', 'ikke_aendret');
  end if;
  select * into b from public.fragt_reklamation_betingelser((c.r).sag_id);
  if not b.ok and coalesce(b.aarsag, '') not in ('anke_venter', 'ankefrist') then
    return jsonb_build_object('kode', 'betingelser_ikke_opfyldt', 'aarsag', b.aarsag);
  end if;
  update public.fragt_reklamationer
     set sag_aendret_kvitteret_kl = now(), sag_aendret_kvitteret_af = auth.uid(),
         sag_aendret_kvitteret_aarsag = case when b.ok then null else b.aarsag end,
         fremdrift_kl = now()
   where id = (c.r).id and sag_aendret_kl is not null and sag_aendret_kvitteret_kl is null
     and status in ('anmeldt', 'godkendt');
  if not found then return jsonb_build_object('kode', 'ikke_aendret'); end if;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_sag_aendret_kvitteret', (c.r).sag_id, (c.r).saelger_id,
    'Kvitteret for den ændrede sag - reklamationen fortsætter (status ' || (c.r).status || ') | Betingelser: '
    || case when b.ok then 'opfyldt' else 'ikke opfyldt endnu (' || b.aarsag || ')' end
    || ' | Begrundelse: ' || v_beg);
  return jsonb_build_object('kode', 'ok', 'aarsag', case when b.ok then null else b.aarsag end);
end;
$fn$;

do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.fragt_reklamation_gem_note(uuid,text)',
    'public.fragt_reklamation_anmeld(uuid,text)',
    'public.fragt_reklamation_godkend(uuid,bigint)',
    'public.fragt_reklamation_afvis(uuid,text)',
    'public.fragt_reklamation_annuller(uuid,text)',
    'public.fragt_reklamation_ret_status(uuid,text,bigint,text,text,text)',
    'public.fragt_reklamation_kvitter_sag_aendret(uuid,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $do$;

-- ===========================================================================
-- 8. Chefens udbetaling til sælgeren
-- ===========================================================================
-- Trin 1 (authenticated - chefens egen session): chefen bekræfter, at
-- erstatningen er modtaget fra fragtfirmaet, og udbetalingen sættes i gang
-- (claim). Serveren laver derefter Stripe Transfer'en
-- (src/lib/reklamation/udbetaling.ts) og registrerer den med
-- fragt_reklamation_udbetal_registrer (service_role).
-- Tjek (i rækkefølge): staff + aal2 + ikke inhabil (fragt_reklamation_tjek),
-- rollen 'chef', bekræftelsen, status 'godkendt', "sag ændret" ikke
-- ukvitteret, betingelserne HELT opfyldt, intet nødstop for udbetalinger,
-- sælgeren ikke frosset, sælgerens Connect-konto findes, er tilknyttet og er
-- den samme som på betalingen.
-- Er en tidligere udbetaling sat i gang uden et svar fra Stripe
-- (udbetaling_paabegyndt_kl sat, ingen transfer), gives samme claim igen
-- (genoptag = true) - serveren slår den op hos Stripe, før den prøver igen.
-- Koder: ok (+ beloeb_oere, konto, forsoeg, trade_id, sag_id, saelger_id,
-- sagsnummer, transportoer, genoptag, paabegyndt_kl), ingen_adgang,
-- ikke_fundet, inhabil, kun_chef, bekraeftelse_mangler, allerede_udbetalt,
-- forkert_status (+ status), sag_aendret, betingelser_ikke_opfyldt (+ aarsag),
-- stoppet, frosset, ingen_konto, konto_aendret.
create or replace function public.fragt_reklamation_udbetal_claim(p_reklamation uuid, p_erstatning_modtaget boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c       record;
  b       record;
  p       record;
  bt      record;
  v_konto text;
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if not public.staff_chat_har_rolle(auth.uid(), 'chef') then
    return jsonb_build_object('kode', 'kun_chef');
  end if;
  if p_erstatning_modtaget is not true then
    return jsonb_build_object('kode', 'bekraeftelse_mangler');
  end if;
  if (c.r).status = 'udbetalt' then
    return jsonb_build_object('kode', 'allerede_udbetalt');
  end if;
  if (c.r).status <> 'godkendt' then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if (c.r).sag_aendret_kl is not null and (c.r).sag_aendret_kvitteret_kl is null then
    return jsonb_build_object('kode', 'sag_aendret');
  end if;
  select * into b from public.fragt_reklamation_betingelser((c.r).sag_id);
  if not b.ok then
    return jsonb_build_object('kode', 'betingelser_ikke_opfyldt', 'aarsag', b.aarsag);
  end if;
  if public.udbetalinger_stoppet() then
    return jsonb_build_object('kode', 'stoppet');
  end if;
  select bp.stripe_account_id, bp.connect_frakoblet_kl, bp.udbetaling_frosset_kl into p
    from public.betalingsprofiler bp where bp.user_id = (c.r).saelger_id;
  if found and p.udbetaling_frosset_kl is not null then
    return jsonb_build_object('kode', 'frosset');
  end if;
  if not found or p.stripe_account_id is null or p.connect_frakoblet_kl is not null then
    return jsonb_build_object('kode', 'ingen_konto');
  end if;
  v_konto := p.stripe_account_id;
  -- Destination = sælgerens konto fra betalingen (handlen). Er sælgerens
  -- konto skiftet siden, stoppes der - chefen skal se på det.
  select be.saelger_stripe_konto into bt from public.betalinger be where be.trade_id = (c.r).trade_id;
  if found and bt.saelger_stripe_konto is not null and bt.saelger_stripe_konto <> v_konto then
    return jsonb_build_object('kode', 'konto_aendret');
  end if;

  if (c.r).udbetaling_paabegyndt_kl is not null then
    if (c.r).udbetaling_stripe_konto is distinct from v_konto then
      return jsonb_build_object('kode', 'konto_aendret');
    end if;
    perform public.fragt_reklamation_log(auth.uid(), 'reklamation_udbetaling_startet', (c.r).sag_id, (c.r).saelger_id,
      'Udbetalingen genoptages (forsøg ' || ((c.r).udbetaling_forsoeg + 1) || ') - Stripe slås op først');
  else
    update public.fragt_reklamationer
       set erstatning_modtaget_kl = now(), erstatning_modtaget_af = auth.uid(),
           udbetaling_paabegyndt_kl = now(), udbetaling_paabegyndt_af = auth.uid(),
           udbetaling_stripe_konto = v_konto, udbetaling_fejl = null
     where id = (c.r).id and status = 'godkendt' and udbetaling_paabegyndt_kl is null;
    if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
    perform public.fragt_reklamation_log(auth.uid(), 'reklamation_udbetaling_startet', (c.r).sag_id, (c.r).saelger_id,
      'Chefen bekræfter, at erstatningen er modtaget fra ' || upper((c.r).transportoer)
      || ' (sagsnummer ' || coalesce((c.r).transportoerens_sagsnummer, '–') || '), og udbetaler '
      || public.fragt_reklamation_kr((c.r).godkendt_beloeb_oere) || ' til sælgeren via Stripe');
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'beloeb_oere', (c.r).godkendt_beloeb_oere, 'konto', v_konto,
    'forsoeg', (c.r).udbetaling_forsoeg, 'trade_id', (c.r).trade_id, 'sag_id', (c.r).sag_id,
    'saelger_id', (c.r).saelger_id, 'sagsnummer', (c.r).transportoerens_sagsnummer,
    'transportoer', (c.r).transportoer, 'genoptag', (c.r).udbetaling_paabegyndt_kl is not null,
    'paabegyndt_kl', coalesce((c.r).udbetaling_paabegyndt_kl, now()));
end;
$fn$;

revoke all on function public.fragt_reklamation_udbetal_claim(uuid, boolean) from public, anon;
grant execute on function public.fragt_reklamation_udbetal_claim(uuid, boolean) to authenticated;

-- Trin 2 (service_role): Stripe har lavet transferen. Idempotent.
-- Beløb og konto skal være præcis dem, der blev låst ved claim.
-- Svar: ok | allerede | ikke_fundet | ikke_paabegyndt | afviger.
create or replace function public.fragt_reklamation_udbetal_registrer(
  p_reklamation uuid, p_transfer text, p_beloeb_oere bigint, p_konto text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
begin
  select * into r from public.fragt_reklamationer where id = p_reklamation for update;
  if not found then return 'ikke_fundet'; end if;
  if r.stripe_transfer_id is not null then
    if r.stripe_transfer_id = p_transfer then return 'allerede'; end if;
    raise exception 'fragt_reklamation_anden_transfer: reklamation % har allerede transfer %', r.id, r.stripe_transfer_id;
  end if;
  if r.status <> 'godkendt' or r.udbetaling_paabegyndt_kl is null then return 'ikke_paabegyndt'; end if;
  if p_beloeb_oere is distinct from r.godkendt_beloeb_oere or p_konto is distinct from r.udbetaling_stripe_konto
     or p_transfer is null or p_transfer !~ '^tr_[A-Za-z0-9]+$' then
    return 'afviger';
  end if;
  update public.fragt_reklamationer
     set status = 'udbetalt', stripe_transfer_id = p_transfer,
         udbetalt_kl = now(), udbetalt_af = r.udbetaling_paabegyndt_af,
         udbetaling_fejl = null, fremdrift_kl = now()
   where id = r.id;
  perform public.fragt_reklamation_log(r.udbetaling_paabegyndt_af, 'reklamation_udbetalt', r.sag_id, r.saelger_id,
    'Udbetalt til sælgeren: ' || public.fragt_reklamation_kr(r.godkendt_beloeb_oere)
    || ' (Stripe-transfer ' || p_transfer || ' til sælgerens Stripe-konto). Sendes videre til sælgerens bank');
  return 'ok';
end;
$fn$;

revoke all on function public.fragt_reklamation_udbetal_registrer(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_udbetal_registrer(uuid, text, bigint, text) to service_role;

-- Trin 2b (service_role): Stripe-kaldet fejlede.
--   p_frigiv = true: Stripe har MED SIKKERHED ikke lavet en transfer (fx for
--     lidt på BidHamrs saldo, eller serveren stoppede før kaldet). Claimen
--     frigøres (status forbliver godkendt), og næste forsøg får en ny
--     idempotency-nøgle (udbetaling_forsoeg + 1).
--   p_frigiv = false: usikkert (netværk, 5xx) - claimen beholdes; næste
--     forsøg slår op hos Stripe og bruger samme nøgle.
-- Svar: true, hvis noget blev ændret.
create or replace function public.fragt_reklamation_udbetal_afvist(p_reklamation uuid, p_fejl text, p_frigiv boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
begin
  select * into r from public.fragt_reklamationer where id = p_reklamation for update;
  if not found or r.status <> 'godkendt' or r.udbetaling_paabegyndt_kl is null or r.stripe_transfer_id is not null then
    return false;
  end if;
  if coalesce(p_frigiv, false) then
    update public.fragt_reklamationer
       set udbetaling_paabegyndt_kl = null, udbetaling_paabegyndt_af = null,
           erstatning_modtaget_kl = null, erstatning_modtaget_af = null,
           udbetaling_stripe_konto = null,
           udbetaling_forsoeg = udbetaling_forsoeg + 1,
           udbetaling_fejl = left(coalesce(p_fejl, 'Stripe afviste udbetalingen'), 500)
     where id = r.id;
  else
    update public.fragt_reklamationer
       set udbetaling_fejl = left(coalesce(p_fejl, 'Usikkert svar fra Stripe'), 500)
     where id = r.id;
  end if;
  perform public.fragt_reklamation_log(coalesce(r.udbetaling_paabegyndt_af, public.bidhamr_system_id()),
    'reklamation_udbetaling_fejlet', r.sag_id, r.saelger_id,
    left(case when coalesce(p_frigiv, false) then 'Udbetalingen blev ikke gennemført (ingen penge flyttet): '
              else 'Usikkert svar fra Stripe - slås op før nyt forsøg: ' end
         || coalesce(p_fejl, '?'), 4000));
  return true;
end;
$fn$;

revoke all on function public.fragt_reklamation_udbetal_afvist(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_udbetal_afvist(uuid, text, boolean) to service_role;

-- --- Sælgerens Connect-konto -> sælgerens bank (payout) ----------------------
-- Samme regler som de andre udbetalinger: nødstop, frosset sælger og
-- "venter på bank" (en fejlet udbetaling, sælgeren ikke har rettet)
-- stopper. Samme lås som saelger_udbetaling_claim (pr. sælger).
-- p_ny_noegle: serveren har slået op hos Stripe, at et ældre kald (over 23
-- timer siden) IKKE gav en payout - næste kald får en ny nøgle.
-- Svar: {kode: ok|stoppet|frosset|venter_paa_bank|ikke_udbetalt|faerdig|
-- ikke_fundet, konto, beloeb_oere, forsoeg, saelger_id, trade_id}.
create or replace function public.fragt_reklamation_bank_start(p_reklamation uuid, p_ny_noegle boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
  p record;
begin
  select * into r from public.fragt_reklamationer where id = p_reklamation;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('saelger_udbetaling:' || r.saelger_id::text));
  select * into r from public.fragt_reklamationer where id = p_reklamation for update;
  if r.status <> 'udbetalt' or r.stripe_transfer_id is null then
    return jsonb_build_object('kode', 'ikke_udbetalt');
  end if;
  if r.bank_status in ('oprettet', 'paid', 'canceled') then
    return jsonb_build_object('kode', 'faerdig', 'bank_status', r.bank_status);
  end if;
  if public.udbetalinger_stoppet() then return jsonb_build_object('kode', 'stoppet'); end if;
  select bp.udbetaling_frosset_kl, bp.connect_udbetaling_fejlet_kl into p
    from public.betalingsprofiler bp where bp.user_id = r.saelger_id;
  if found and p.udbetaling_frosset_kl is not null then return jsonb_build_object('kode', 'frosset'); end if;
  if found and p.connect_udbetaling_fejlet_kl is not null then
    return jsonb_build_object('kode', 'venter_paa_bank');
  end if;
  update public.fragt_reklamationer
     set bank_status = 'claimet',
         bank_claimet_kl = case when bank_status = 'claimet' then bank_claimet_kl else now() end,
         bank_forsoeg = bank_forsoeg
                        + case when bank_status = 'failed' or coalesce(p_ny_noegle, false) then 1 else 0 end,
         bank_sidst_sendt_kl = now(),
         bank_fejl = case when bank_status = 'failed' then bank_fejl else null end
   where id = r.id
  returning bank_forsoeg into r.bank_forsoeg;
  return jsonb_build_object('kode', 'ok', 'konto', r.udbetaling_stripe_konto, 'beloeb_oere', r.godkendt_beloeb_oere,
                            'forsoeg', r.bank_forsoeg, 'saelger_id', r.saelger_id, 'trade_id', r.trade_id);
end;
$fn$;

revoke all on function public.fragt_reklamation_bank_start(uuid, boolean) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_bank_start(uuid, boolean) to service_role;

-- Payoutens status fra Stripe (hentet frisk af serveren). p_status: Stripes
-- payout-status (pending/in_transit -> oprettet; paid; failed; canceled).
-- failed: sælgeren "venter på bank" (som saelger_udbetaling_spejl), så
-- ingen nye udbetalinger sendes til den fejlede bankkonto; næste forsøg
-- laver en ny payout (ny nøgle).
-- Svar: {kode: ok|allerede|ikke_fundet|anden_konto|konflikt, fra, til}.
create or replace function public.fragt_reklamation_bank_spejl(
  p_reklamation uuid, p_konto text, p_payout text, p_status text, p_fejlkode text, p_bank text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r     record;
  v_til text := case when p_status in ('pending', 'in_transit') then 'oprettet'
                     when p_status in ('paid', 'failed', 'canceled') then p_status end;
begin
  select * into r from public.fragt_reklamationer where id = p_reklamation for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if r.udbetaling_stripe_konto is distinct from p_konto then return jsonb_build_object('kode', 'anden_konto'); end if;
  if v_til is null or p_payout is null then return jsonb_build_object('kode', 'ukendt_status'); end if;
  if r.status <> 'udbetalt' then return jsonb_build_object('kode', 'konflikt'); end if;
  -- Et nyt forsøg er claimet: bank_payout_id er den ældre, fejlede payout -
  -- et sent event for den må ikke røre claimen (ellers kunne et tredje
  -- forsøg starte, mens det nye kald er i gang).
  if r.bank_status = 'claimet' and r.bank_payout_id = p_payout then
    return jsonb_build_object('kode', 'allerede', 'fra', r.bank_status, 'til', r.bank_status);
  end if;
  -- En anden payout er den aktuelle (en ældre, fejlet): kun historik.
  if r.bank_payout_id is not null and r.bank_payout_id <> p_payout
     and r.bank_status in ('oprettet', 'paid', 'canceled') then
    return jsonb_build_object('kode', 'allerede', 'fra', r.bank_status, 'til', r.bank_status);
  end if;
  if r.bank_payout_id = p_payout and r.bank_status = v_til then
    return jsonb_build_object('kode', 'allerede', 'fra', r.bank_status, 'til', v_til);
  end if;
  -- Aldrig tilbage fra en afgjort status for samme payout.
  if r.bank_payout_id = p_payout and r.bank_status in ('paid', 'failed', 'canceled') and v_til = 'oprettet' then
    return jsonb_build_object('kode', 'allerede', 'fra', r.bank_status, 'til', r.bank_status);
  end if;
  update public.fragt_reklamationer
     set bank_payout_id = p_payout, bank_status = v_til,
         bank_oprettet_kl = coalesce(case when r.bank_payout_id = p_payout then bank_oprettet_kl end, now()),
         bank_betalt_kl = case when v_til = 'paid' then coalesce(bank_betalt_kl, now()) else bank_betalt_kl end,
         bank_fejlet_kl = case when v_til in ('failed', 'canceled') then now() else bank_fejlet_kl end,
         bank_fejlkode = case when v_til in ('failed', 'canceled') then left(p_fejlkode, 100) else bank_fejlkode end,
         bank_fejl = case when v_til in ('failed', 'canceled')
                          then left('Payout ' || v_til || coalesce(' (' || p_fejlkode || ')', ''), 500)
                          when v_til in ('oprettet', 'paid') then null else bank_fejl end
   where id = r.id;
  if v_til = 'failed' then
    update public.betalingsprofiler
       set connect_udbetaling_fejlet_kl = now(),
           connect_udbetaling_fejlet_bank = coalesce(p_bank, connect_udbetaling_fejlet_bank),
           connect_udbetaling_fejlkode = p_fejlkode,
           opdateret = now()
     where user_id = r.saelger_id;
  end if;
  perform public.fragt_reklamation_log(public.bidhamr_system_id(), 'reklamation_bank_udbetaling', r.sag_id, r.saelger_id,
    'Udbetaling af erstatningen til sælgerens bank: ' || coalesce(r.bank_status, 'ny') || ' -> ' || v_til
    || ' (payout ' || p_payout || coalesce(', ' || p_fejlkode, '') || ')');
  return jsonb_build_object('kode', 'ok', 'fra', r.bank_status, 'til', v_til);
end;
$fn$;

revoke all on function public.fragt_reklamation_bank_spejl(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_bank_spejl(uuid, text, text, text, text, text) to service_role;

-- payouts.create fejlede. p_frigiv = true: Stripe afviste med sikkerhed
-- (ingen payout) - bank_status nulstilles, og næste forsøg får en ny nøgle.
-- p_frigiv = false: usikkert - 'claimet' beholdes (opslag før nyt forsøg).
create or replace function public.fragt_reklamation_bank_fejl(p_reklamation uuid, p_fejl text, p_frigiv boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(p_frigiv, false) then
    update public.fragt_reklamationer
       set bank_status = null, bank_forsoeg = bank_forsoeg + 1,
           bank_fejl = left(coalesce(p_fejl, 'Stripe afviste udbetalingen'), 500)
     where id = p_reklamation and status = 'udbetalt' and bank_status = 'claimet';
  else
    update public.fragt_reklamationer
       set bank_fejl = left(coalesce(p_fejl, 'Usikkert svar fra Stripe'), 500)
     where id = p_reklamation and status = 'udbetalt' and bank_status = 'claimet';
  end if;
  return found;
end;
$fn$;

revoke all on function public.fragt_reklamation_bank_fejl(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_bank_fejl(uuid, text, boolean) to service_role;

-- Transferen er tilbageført hos Stripe (webhook transfer.reversed eller
-- afstemningen). BidHamr tilbagefører aldrig selv en erstatning - det er en
-- afvigelse til chefen (drift-alarm fra serveren). Idempotent.
create or replace function public.fragt_reklamation_transfer_tilbagefoert(p_transfer text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
  r    record;
begin
  select * into r from public.fragt_reklamationer where stripe_transfer_id = p_transfer for update;
  if not found then return null; end if;
  if r.transfer_tilbagefoert_kl is null then
    update public.fragt_reklamationer set transfer_tilbagefoert_kl = now() where id = r.id;
    perform public.fragt_reklamation_log(public.bidhamr_system_id(), 'reklamation_udbetaling_fejlet', r.sag_id, r.saelger_id,
      'OBS: Stripe-transferen ' || p_transfer || ' (erstatning til sælgeren) er tilbageført hos Stripe - ikke af BidHamr. Kontrollér i Stripe');
  end if;
  v_id := r.id;
  return v_id;
end;
$fn$;

revoke all on function public.fragt_reklamation_transfer_tilbagefoert(text) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_transfer_tilbagefoert(text) to service_role;

-- ===========================================================================
-- 9. Sælgerens visning og admin-tællere
-- ===========================================================================
-- Kun offentlige felter. Sælgeren udledes af auth.uid(). p_trade = null: alle.
-- sag_aendret: sagen er ændret efter anmeldelsen, og BidHamr har ikke
-- kvitteret endnu (udbetalingen venter). Returtypen er ændret efter første
-- udgave - derfor drop først (genkørsel).
drop function if exists public.mine_fragt_reklamationer(uuid);
create or replace function public.mine_fragt_reklamationer(p_trade uuid default null)
returns table (
  id uuid, sag_id uuid, trade_id uuid, transportoer text, status text,
  kravbeloeb_oere bigint, godkendt_beloeb_oere bigint,
  afvisningsgrund text, annulleret_grund text,
  oprettet_kl timestamptz, anmeldt_kl timestamptz, afgjort_kl timestamptz,
  annulleret_kl timestamptz, udbetalt_kl timestamptz, bank_betalt_kl timestamptz,
  sag_aendret boolean)
language sql
stable
security definer
set search_path = public
as $fn$
  select r.id, r.sag_id, r.trade_id, r.transportoer, r.status,
         r.kravbeloeb_oere, r.godkendt_beloeb_oere,
         r.afvisningsgrund, r.annulleret_grund,
         r.oprettet_kl, r.anmeldt_kl, r.afgjort_kl, r.annulleret_kl, r.udbetalt_kl,
         case when r.bank_status = 'paid' then r.bank_betalt_kl end,
         (r.sag_aendret_kl is not null and r.sag_aendret_kvitteret_kl is null) as sag_aendret
    from public.fragt_reklamationer r
   where auth.uid() is not null
     and r.saelger_id = auth.uid()
     -- En annullering, systemet lavede (sagen ændret), vises ikke for sælgeren.
     and not (r.status = 'annulleret' and r.annulleret_auto)
     and (p_trade is null or r.trade_id = p_trade)
   order by r.oprettet_kl desc;
$fn$;

revoke all on function public.mine_fragt_reklamationer(uuid) from public, anon;
grant execute on function public.mine_fragt_reklamationer(uuid) to authenticated;

-- Admin-lamper (alle staff; venter_udbetaling/udbetaling_fejl er chefens).
-- Ikke-staff: alt 0. Samme regler som src/lib/reklamation/tal.ts.
--   afventer_bidhamr: staff har ikke anmeldt endnu.
--   afventer_roed:    ... i over 3 dage (aktiv_fra_kl) - rød.
--   stille:           anmeldt uden svar fra fragtfirmaet i 30 dage - grå.
--   sag_aendret:      sagen er ændret efter anmeldelsen, ingen har kvitteret - rød.
--   venter_udbetaling: godkendt, venter på chefens udbetaling.
--   udbetaling_fejl:  udbetalingen hænger (transfer uafklaret i over 10
--                     min., eller udbetalingen til banken er fejlet/hænger).
create or replace function public.fragt_reklamationer_antal()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select case when not public.er_staff() then
           jsonb_build_object('afventer_bidhamr', 0, 'afventer_roed', 0, 'stille', 0, 'sag_aendret', 0,
                              'venter_udbetaling', 0, 'udbetaling_fejl', 0)
         else jsonb_build_object(
           'afventer_bidhamr', (select count(*) from public.fragt_reklamationer where status = 'afventer_bidhamr'),
           'afventer_roed', (select count(*) from public.fragt_reklamationer
                              where status = 'afventer_bidhamr' and aktiv_fra_kl < now() - interval '3 days'),
           'stille', (select count(*) from public.fragt_reklamationer
                       where status = 'anmeldt' and fremdrift_kl < now() - interval '30 days'),
           'sag_aendret', (select count(*) from public.fragt_reklamationer
                            where status in ('anmeldt', 'godkendt') and sag_aendret_kl is not null
                              and sag_aendret_kvitteret_kl is null),
           'venter_udbetaling', (select count(*) from public.fragt_reklamationer where status = 'godkendt'),
           'udbetaling_fejl', (select count(*) from public.fragt_reklamationer
                                where (status = 'godkendt' and udbetaling_paabegyndt_kl < now() - interval '10 minutes')
                                   or (status = 'udbetalt'
                                       and (bank_status in ('failed', 'canceled')
                                            or transfer_tilbagefoert_kl is not null
                                            or (bank_status is null and udbetalt_kl < now() - interval '1 hour')
                                            or (bank_status = 'claimet' and bank_claimet_kl < now() - interval '1 hour')
                                            or (bank_status = 'oprettet' and bank_oprettet_kl < now() - interval '7 days')))))
         end;
$fn$;

revoke all on function public.fragt_reklamationer_antal() from public, anon;
grant execute on function public.fragt_reklamationer_antal() to authenticated;

-- Eksisterende sager: en skadet sag, der allerede er afgjort til køber, får
-- først en reklamation, når staff vurderer indpakningen som ordentlig
-- (indpakning_ordentlig er ny, så ingen opfylder betingelserne i dag).
-- Genkørsel oven på en tidligere udgave: reklamationer, der blev oprettet
-- for tidligt, rettes af cron'en (fragt_reklamationer_synkroniser_alle).

select public.fragt_reklamationer_synkroniser_alle(1000);
