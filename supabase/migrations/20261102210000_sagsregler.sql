-- Nyt sagsflow - de 8 regelændringer (Filip, 27. okt. 2026; ROADMAP-
-- BESLUTNINGER afsnit 4, "Oprettelse af en sag ... godkendt"). Showcase:
-- showcase/opret-sag-showcase.html. Kun backend og pengedelen - selve det nye
-- flow bygges af frontend bagefter.
--
--   1. BILLEDER: ét billede af pakken med labelen tæller som både pakke og
--      label. Kræves (pakken er modtaget, ikke "ikke kommet frem"): et billede
--      af pakken ('pakke_label' - ny kategori - eller 'pakke') OG et af
--      indholdet ('indhold'). 'label' alene er ikke nok (den viser ikke
--      pakken). Gamle klienter, der sender pakke + label + indhold, virker
--      som før. "Ikke kommet frem" efter leveringsmelding kræver stadig ingen
--      billeder.
--   2. PAKKEN ER SMIDT UD: sag_opret(..., p_pakke_smidt_ud => true,
--      p_smidt_ud_begrundelse => tekst på 20-2000 tegn) opretter sagen uden
--      pakkebillede (indholdet kræves stadig). sager.pakke_smidt_ud markerer
--      sagen til staffs vurdering (admin viser den).
--   3. SÆLGERENS SVAR: sag_svar_send(p_sag, p_tekst, p_billeder) - sælgeren
--      svarer ÉN gang med tekst (10-4000 tegn, ingen kontaktinfo) og op til
--      10 billeder inden for 48 timer fra oprettelsen, mens sagen er åben.
--      Billederne uploades til 'sag-billeder' under <sælger-id>/<handel-id>/
--      (storage-policyen tillader det kun i svarvinduet). Tabellerne sag_svar
--      og sag_svar_billeder kan læses af køber, sælger og staff (RLS) og kan
--      aldrig ændres eller slettes (bevis). Efter fristen kan sælgeren ikke
--      svare - staff kan stadig åbne en chat. sag_svar_paamind_kandidater()
--      giver serveren sagerne til påmindelsen 12 timer før fristen.
--   4. "ANDET" som rigtig sagstype ('andet', kræver BidHamr Beskyttelse som
--      "ikke som beskrevet"). Staff retter typen med sag_ret_type (logget i
--      moderation_log 'sag_type_rettet'; den oprindelige type gemmes i
--      sager.oprindelig_type). Køberen kan ikke få medhold i en 'andet'-sag,
--      før typen er rettet (kode 'vaelg_type'): refusion og retur afhænger
--      af typen.
--   5. PÅMINDELSE 6 TIMER FØR FRISTEN: handel_problem_frist_paamind_kandidater()
--      giver serveren handlerne (cron sender notifikation/push/mail).
--   6. BORTKOMMET PAKKE: medhold = HELE beløbet tilbage (bud + gebyr + fragt
--      = total_oere). public.sag_refusion_oere(prismodel, bud, total,
--      beskyttelse, TYPE) - ny 5-parameter-udgave; den gamle (4 parametre)
--      bevares uændret for gammel kode. Pengene: sag_claim_refusion låser R =
--      total; betaling_refusionsplan (uændret) giver S = hele sælgerens del
--      (U) tilbageført fra sælgerens Connect-konto og G = R - U = hele
--      application fee refunderet (Stripe-refusion med refund_application_fee
--      for hele gebyret - koden i stripeBetaling.ts er uændret). Ingen saldo.
--      Fakturaerne: G = application_fee -> begge fakturaer krediteres helt
--      (faktura_planlaeg er uændret). Reklamationen hos fragtfirmaet
--      (fragt_reklamation_betingelser) omfatter nu også 'bortkommet' (uden
--      krav om vurderet indpakning).
--   7. TRANSPORTSKADE MED MEDHOLD: køberen får hele beløbet (som 6) og betaler
--      ikke returfragten. Staff vælger i afgørelsen (sag_afgoer /
--      sag_anke_afgoer, ny parameter p_returfragt_betaler):
--        'saelger' (dårlig indpakning): BidHamr laver returkoden uden betaling
--          fra køberen. Når returpakken er registreret afleveret
--          (sag_retur_afleveret), oprettes en regning til sælgeren i den
--          eksisterende model for ekstra fragt (ekstra_fragt_regninger,
--          slags 'returfragt_sag'): betalingsknap, 14 dages frist, spærring
--          (BHX01), faktura, bankindsigelse - aldrig automatisk træk.
--          Kræver, at indpakningen ikke er vurderet ordentlig.
--        'bidhamr' (god indpakning): BidHamr betaler returfragten, og
--          indpakningen registreres som ordentlig (indpakning_ordentlig), så
--          den eksisterende reklamation hos fragtfirmaet oprettes, når
--          køberen er refunderet. Kræver, at der ikke er givet påmindelse/
--          advarsel for dårlig indpakning i sagen.
--      Returfragten: returfragt_start opretter for 'saelger'/'bidhamr' en
--      dækket række (returfragt_betalinger.betaler, status 'betalt' uden
--      PaymentIntent - kode 'daekket'), så returkoden laves som efter en
--      betaling. En dækket række refunderes aldrig hos Stripe (den er ikke
--      betalt af køberen) og faktureres ikke køberen
--      (faktura_planlaeg_returfragt). Kan returkoden ikke laves, annulleres
--      den dækkede række (returfragt_daekket_annuller).
--      "Ikke som beskrevet" følger stadig den gamle regel (Filip, 3. okt.
--      2026): køberen betaler selv returfragten og får kun buddet tilbage
--      (ny prismodel). Svindel: kun buddet (ingen ændring - regel 6 gælder kun
--      bortkommet).
--   8. FRISTEN FOR AT MELDE ET PROBLEM ER 72 TIMER efter levering (før 48), og
--      den automatiske frigivelse følger med. trades.problem_frist_kl sættes
--      af triggeren trades_problem_frist, når received_at sættes (= received_at
--      + 72 timer, sag_problem_frist_timer()). Handler, der allerede er
--      modtaget, får deres gamle frist (received_at + 48 timer) skrevet ind
--      (backfill) og beholder den. sag_opret, handel_auto_frigiv,
--      handel_leveret_melding_ny og admin_penge_holdes læser fristen herfra.
--      Betalingsfristen på 48 timer for vinderen er IKKE ændret.
--
-- OVERGANG (gammel kode på test.bidhamr.dk): alt eksisterende virker videre
-- (nye parametre har standardværdier; gamle klienter sender 3 billeder).
-- Men: (a) en transportskade kan ikke få medhold fra den gamle admin (den
-- sender ikke p_returfragt_betaler -> 'vaelg_returfragt_betaler'), (b) en
-- dækket returfragt kan ikke startes fra den gamle hjemmeside (kode
-- 'daekket' er ukendt), og (c) den gamle kode viser 48 timer i tekster og
-- skjuler knappen efter 48 timer, selvom databasen tillader 72. Migration og
-- kode bør derfor ud samtidig.
--
-- Funktioner fra tidligere migrationer rettes med md5-drift-tjek (mønstret
-- fra 20261031010000): "gammel" = testdatabasen før denne migration (hentet
-- 27. okt. 2026), "ny" = efter. Afviger kroppen fra begge, afbrydes
-- migrationen (alle tjek står samlet FØR noget ændres). Tre funktioner får ny
-- signatur (sag_opret, sag_afgoer, sag_anke_afgoer): den nye laves, og den
-- gamle droppes i samme transaktion (navngivne kald fra gammel kode rammer den
-- nye, fordi de nye parametre har standardværdier).
-- Idempotent (kan køres igen). Én transaktion. KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.sager') is null or to_regclass('public.sag_billeder') is null
     or to_regclass('public.sag_anker') is null or to_regclass('public.trades') is null
     or to_regclass('public.betalinger') is null or to_regclass('public.returfragt_betalinger') is null
     or to_regclass('public.ekstra_fragt_regninger') is null or to_regclass('public.fragt_reklamationer') is null
     or to_regclass('public.indpakning_ordentlig') is null or to_regclass('public.moderation_log') is null
     or to_regclass('public.forsendelser') is null then
    raise exception 'Forudsætning mangler: sager, anke, returfragt (20261022010000), reklamation (20261029010000) og ekstra fragt (20261029020000)';
  end if;
  if to_regprocedure('public.sag_refusion_oere(text,bigint,bigint,bigint)') is null
     or to_regprocedure('public.staff_chat_har_rolle(uuid,text)') is null
     or to_regprocedure('public.penge_inhabil(uuid,uuid,uuid)') is null
     or to_regprocedure('public.er_staff()') is null
     or to_regprocedure('public.bidhamr_system_id()') is null
     or to_regprocedure('public.indeholder_kontaktinfo(text)') is null
     or to_regprocedure('public.ekstra_fragt_log(uuid,text,uuid,uuid,text)') is null
     or to_regprocedure('public.fragt_reklamation_log(uuid,text,uuid,uuid,text)') is null
     or to_regprocedure('public.handel_leveret_melding_ny(uuid)') is null then
    raise exception 'Forudsætning mangler: kør 20261030010000, 20261031010000 og 20261102140000 først';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'trades' and column_name = 'modtaget_kilde') then
    raise exception 'Forudsætning mangler: trades.modtaget_kilde (20261030010000)';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session) - som i 20261102140000
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Erstatter tekststykker i den nuværende definition (antal forekomster
-- tjekkes) og kører den. p_ny_fn: den nye signatur, hvis den ændres (så
-- droppes den gamle bagefter).
create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb, p_ny_fn text default null)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  v_mal text := coalesce(p_ny_fn, p_fn);
  h     text;
begin
  -- Genkørsel: den nye findes allerede med den rigtige krop.
  if pg_temp.krop_md5(v_mal) = p_ny then
    if p_ny_fn is not null and to_regprocedure(p_fn) is not null then
      raise exception '%: både gammel og ny signatur findes', p_fn;
    end if;
    return 'allerede';
  end if;
  if p_ny_fn is not null and to_regprocedure(p_ny_fn) is not null then
    raise exception '%: findes med md5 % (forventet %) - kontrollér funktionen', p_ny_fn, pg_temp.krop_md5(p_ny_fn), p_ny;
  end if;
  h := pg_temp.krop_md5(p_fn);
  if h is null then
    raise exception '%: funktionen findes ikke', p_fn;
  end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(v_mal);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', v_mal, h, p_ny;
  end if;
  if p_ny_fn is not null then
    execute format('drop function %s', p_fn::regprocedure);
  end if;
  return 'rettet';
end
$f$;

-- Drift-tjek før en hel funktion erstattes: 'gammel', 'allerede' (genkørsel)
-- - ellers afbrydes migrationen. p_ny_fn: den nye signatur (ændres den).
create or replace function pg_temp.kraev_md5(p_fn text, p_gammel text, p_ny text, p_ny_fn text default null)
returns text language plpgsql as $f$
declare
  h text;
begin
  if pg_temp.krop_md5(coalesce(p_ny_fn, p_fn)) = p_ny
     and (p_ny_fn is null or to_regprocedure(p_fn) is null) then
    return 'allerede';
  end if;
  h := pg_temp.krop_md5(p_fn);
  if h is null then raise exception '%: funktionen findes ikke', p_fn; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  if p_ny_fn is not null and to_regprocedure(p_ny_fn) is not null then
    raise exception '%: den nye signatur findes allerede med en anden krop', p_ny_fn;
  end if;
  return 'gammel';
end
$f$;

create or replace function pg_temp.kraev_efter(p_fn text, p_ny text)
returns void language plpgsql as $f$
begin
  if pg_temp.krop_md5(p_fn) is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, pg_temp.krop_md5(p_fn), p_ny;
  end if;
end
$f$;

-- Alle drift-tjek FØR noget ændres.
do $do$
begin
  perform pg_temp.kraev_md5('public.sag_opret(uuid,text,text,jsonb)',
    'a1d9ea08a7f349d523c2e2a8775aa5f8', '28ded2d3ab96a1db4e5b8a8b29cdfc53', 'public.sag_opret(uuid,text,text,jsonb,boolean,text)');
  perform pg_temp.kraev_md5('public.sag_afgoer(uuid,uuid,text,text,text,boolean)',
    'ea0cd85a0d3c06f363650778ceb414cb', '6def5cbb98c58e7fefcd899fa1d22141', 'public.sag_afgoer(uuid,uuid,text,text,text,boolean,text)');
  perform pg_temp.kraev_md5('public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean)',
    '4f00919bdf83d3000f4769431906c5cc', '0af19871caa67f0136bd9403271081be', 'public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean,text)');
  perform pg_temp.kraev_md5('public.sag_valider_billeder(uuid,uuid,jsonb)',
    'd298ce4d26b61876759ab35c52129755', 'e4593487d8e74f2954a24c0de9b0987e');
  perform pg_temp.kraev_md5('public.sag_billede_maa_uploade(text)',
    '3ff2a50ca373980ea1a7ec3e0602e43e', 'e3073a3e6469e98424c29c9f500ec301');
  perform pg_temp.kraev_md5('public.sag_billede_maa_laese(text)',
    '9f4ee9b149ecc5ebbb71696178764a6b', '0468827305999f81d8453386f4c1b9d0');
  perform pg_temp.kraev_md5('public.sager_beskyt()',
    'd296e8127be8d10feddb49f6b8015789', 'ad094742c4b72d32edb12bc07301cd0b');
  perform pg_temp.kraev_md5('public.sag_claim_refusion(uuid)',
    'c17fb96d5867012ac791ea7863cbc0d7', '579ea60d84f6d6790f300081b3bd84df');
  perform pg_temp.kraev_md5('public.betaling_bidhamr_daekker_claim(uuid,uuid,text,uuid)',
    '12bd75266e2ba5b81a586c858586a18e', '5919889648e58595fb8a756e826c5295');
  perform pg_temp.kraev_md5('public.handel_auto_frigiv()',
    'a8da0c29700cd1aca4be80724084e3d3', 'bfa8b5e0500b6df15645b805ceb51a5e');
  perform pg_temp.kraev_md5('public.handel_leveret_melding_ny(uuid)',
    '11fc30b8ccc0f836ee9532436e131c93', '1a20eb795162f2ad110dae9a4f16eddc');
  perform pg_temp.kraev_md5('public.admin_penge_holdes(integer)',
    '61b21b8c00f3b8740a287ed61b8c02bd', '7251185c153ea5e0d490488c161f7f92');
  perform pg_temp.kraev_md5('public.returfragt_start(uuid,uuid)',
    'bc3a83ee3b3b62baeb34ae2292450717', '14f5e42c1087f803c8704e3aed93fd45');
  perform pg_temp.kraev_md5('public.returfragt_refusion_claim(uuid,text)',
    '6b9372e438aa614859134d0f078a5b17', 'b7f120b809618ec05188c83392baa442');
  perform pg_temp.kraev_md5('public.faktura_planlaeg_returfragt(integer)',
    'c0ac0fbe71bda1f5a4d35af706f9b24a', 'e354e39754e8ffbaf6c28cb45a3f2906');
  perform pg_temp.kraev_md5('public.sag_retur_afleveret(uuid,uuid,text)',
    '8440027ecc71d638bdbf5f8376dc6cb1', '46c9a06b83f8e8cd0dc87afcf94b93ca');
  perform pg_temp.kraev_md5('public.ekstra_fragt_lav_faktura(uuid)',
    '66ff99e11ee26579e0951d84797ead02', 'd75f657a4a9e67261256cad42a38b0f3');
  perform pg_temp.kraev_md5('public.fragt_reklamation_betingelser(uuid)',
    '6a647069eb5996647c89212a6818bff3', '6d4df588c245e7479c89be4664e609a9');
end $do$;

-- ===========================================================================
-- 1. Konstanter
-- ===========================================================================
-- Fristen for at melde et problem efter levering (regel 8). Ændres den, gælder
-- den nye værdi kun handler, der modtages derefter (trades.problem_frist_kl
-- er låst pr. handel).
create or replace function public.sag_problem_frist_timer()
returns integer language sql immutable parallel safe set search_path = '' as $f$ select 72 $f$;

-- Sælgerens frist for at svare på en sag (regel 3), regnet fra oprettelsen.
create or replace function public.sag_svar_frist_timer()
returns integer language sql immutable parallel safe set search_path = '' as $f$ select 48 $f$;

grant execute on function public.sag_problem_frist_timer() to authenticated, service_role;
grant execute on function public.sag_svar_frist_timer() to authenticated, service_role;

-- ===========================================================================
-- 2. Kolonner og constraints
-- ===========================================================================

-- 2a. sager: "andet", pakken er smidt ud, rettet type, sælger betaler returfragt.
alter table public.sager
  add column if not exists pakke_smidt_ud              boolean not null default false,
  add column if not exists pakke_smidt_ud_begrundelse  text,
  add column if not exists oprindelig_type             text,
  add column if not exists type_rettet_kl              timestamptz,
  add column if not exists type_rettet_af              uuid references public.users(id) on delete restrict;

alter table public.sager drop constraint if exists sager_type_check;
alter table public.sager add constraint sager_type_check check (
  type in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel', 'andet'));
alter table public.sager drop constraint if exists sager_returfragt_check;
alter table public.sager add constraint sager_returfragt_check check (
  returfragt_betaler is null or returfragt_betaler in ('koeber', 'saelger', 'bidhamr'));
alter table public.sager drop constraint if exists sager_smidt_ud_check;
alter table public.sager add constraint sager_smidt_ud_check check (
  (not pakke_smidt_ud and pakke_smidt_ud_begrundelse is null)
  or (pakke_smidt_ud and char_length(btrim(coalesce(pakke_smidt_ud_begrundelse, ''))) between 20 and 2000));
alter table public.sager drop constraint if exists sager_type_rettet_check;
alter table public.sager add constraint sager_type_rettet_check check (
  ((type_rettet_kl is null) = (type_rettet_af is null))
  and ((type_rettet_kl is null) = (oprindelig_type is null))
  and (oprindelig_type is null
       or oprindelig_type in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel', 'andet')));

comment on column public.sager.pakke_smidt_ud is
  'Køberen har smidt pakken ud og oprettet sagen uden pakkebillede, med en forklaring (pakke_smidt_ud_begrundelse, 20-2000 tegn). Staff vurderer forklaringen (20261102210000).';
comment on column public.sager.oprindelig_type is
  'Den type, køberen valgte, når staff har rettet typen (sag_ret_type). null = ikke rettet.';

-- Parterne (RLS: sager_select_parter) og appen kan læse de nye felter.
-- type_rettet_af (medarbejderen) er kun til staff.
grant select (pakke_smidt_ud, pakke_smidt_ud_begrundelse, oprindelig_type, type_rettet_kl)
  on public.sager to authenticated;

-- 2b. Billedkategorien 'pakke_label' (pakken med labelen på ét billede).
alter table public.sag_billeder drop constraint if exists sag_billeder_kategori_check;
alter table public.sag_billeder add constraint sag_billeder_kategori_check check (
  kategori in ('pakke', 'label', 'pakke_label', 'indhold', 'andet'));

-- 2c. trades.problem_frist_kl: fristen for at melde et problem (og den
-- automatiske frigivelse uden sag). Handler, der allerede er modtaget,
-- beholder 48 timer (backfill FØR triggeren laves).
alter table public.trades add column if not exists problem_frist_kl timestamptz;
update public.trades
   set problem_frist_kl = received_at + interval '48 hours'
 where received_at is not null and problem_frist_kl is null;

comment on column public.trades.problem_frist_kl is
  'Fristen for at melde et problem (sag) efter levering - og tidspunktet for den automatiske frigivelse uden sag. Sættes af triggeren trades_problem_frist, når received_at sættes: received_at + sag_problem_frist_timer() (72 t). Handler modtaget før 20261102210000 har received_at + 48 t. Kan ikke sættes udefra.';

create or replace function public.trades_problem_frist()
returns trigger
language plpgsql
set search_path = ''
as $f$
begin
  if new.received_at is null then
    new.problem_frist_kl := null;
  elsif tg_op = 'INSERT' or new.received_at is distinct from old.received_at then
    new.problem_frist_kl := new.received_at + make_interval(hours => public.sag_problem_frist_timer());
  else
    -- Fristen følger received_at og kan ikke rettes for sig selv.
    new.problem_frist_kl := old.problem_frist_kl;
  end if;
  return new;
end;
$f$;
revoke all on function public.trades_problem_frist() from public, anon, authenticated;

drop trigger if exists trades_problem_frist on public.trades;
create trigger trades_problem_frist
  before insert or update of received_at, problem_frist_kl on public.trades
  for each row execute function public.trades_problem_frist();

grant select (problem_frist_kl) on public.trades to authenticated;

create index if not exists trades_problem_frist_modtaget
  on public.trades (problem_frist_kl) where status = 'modtaget';

-- 2d. returfragt_betalinger.betaler: hvem der betaler returfragten.
-- 'koeber' = køberen betaler med Stripe (som før). 'saelger'/'bidhamr' =
-- dækket: rækken er 'betalt' uden PaymentIntent, så returkoden kan laves.
alter table public.returfragt_betalinger
  add column if not exists betaler text not null default 'koeber';
alter table public.returfragt_betalinger drop constraint if exists returfragt_betaler_check;
alter table public.returfragt_betalinger add constraint returfragt_betaler_check check (
  betaler in ('koeber', 'saelger', 'bidhamr')
  and (betaler = 'koeber' or (stripe_payment_intent_id is null and stripe_charge_id is null
                              and stripe_refund_id is null and status in ('betalt', 'annulleret'))));
comment on column public.returfragt_betalinger.betaler is
  'Hvem der betaler returfragten (20261102210000): koeber (Stripe-betaling som før) | saelger (dårlig indpakning - opkræves som ekstra fragt, når returen er afleveret) | bidhamr (god indpakning - reklamation hos fragtfirmaet). En dækket række (saelger/bidhamr) har aldrig en PaymentIntent og faktureres ikke køberen.';

-- Betaleren kan aldrig ændres (returfragt_laaste_felter kender den ikke).
create or replace function public.returfragt_betaler_laast()
returns trigger language plpgsql set search_path = '' as $f$
begin
  if new.betaler is distinct from old.betaler then
    raise exception 'Returfragtens betaler kan ikke ændres' using errcode = '42501';
  end if;
  return new;
end;
$f$;
revoke all on function public.returfragt_betaler_laast() from public, anon, authenticated;
drop trigger if exists returfragt_betaler_laast on public.returfragt_betalinger;
create trigger returfragt_betaler_laast before update on public.returfragt_betalinger
  for each row execute function public.returfragt_betaler_laast();

-- 2e. ekstra_fragt_regninger.slags: 'for_lille_pakke' (som før) eller
-- 'returfragt_sag' (sælgeren betaler returfragten i en transportskade-sag).
alter table public.ekstra_fragt_regninger
  add column if not exists slags  text not null default 'for_lille_pakke',
  add column if not exists sag_id uuid references public.sager(id) on delete restrict;
alter table public.ekstra_fragt_regninger alter column fragtfirma_fakturanummer drop not null;
alter table public.ekstra_fragt_regninger alter column dokumentation_sti drop not null;
alter table public.ekstra_fragt_regninger alter column dokumentation_type drop not null;

alter table public.ekstra_fragt_regninger drop constraint if exists ekstra_fragt_slags_check;
alter table public.ekstra_fragt_regninger add constraint ekstra_fragt_slags_check check (
  (slags = 'for_lille_pakke' and sag_id is null
   and fragtfirma_fakturanummer is not null and dokumentation_sti is not null and dokumentation_type is not null)
  or (slags = 'returfragt_sag' and sag_id is not null));

alter table public.ekstra_fragt_regninger drop constraint if exists ekstra_fragt_stoerrelse_check;
alter table public.ekstra_fragt_regninger add constraint ekstra_fragt_stoerrelse_check check (
  valgt_stoerrelse in ('lille', 'mellem', 'stor')
  and (maalt_stoerrelse is null or maalt_stoerrelse in ('lille', 'mellem', 'stor', 'over_stor'))
  and (maalt_vaegt_gram is null or maalt_vaegt_gram between 1 and 1000000)
  and (slags = 'returfragt_sag' or maalt_stoerrelse is not null or maalt_vaegt_gram is not null));

alter table public.ekstra_fragt_regninger drop constraint if exists ekstra_fragt_dokumentation_check;
alter table public.ekstra_fragt_regninger add constraint ekstra_fragt_dokumentation_check check (
  (dokumentation_sti is null and dokumentation_type is null)
  or (dokumentation_sti ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$'
      and dokumentation_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')));

alter table public.ekstra_fragt_regninger drop constraint if exists ekstra_fragt_tekst_laengde;
alter table public.ekstra_fragt_regninger add constraint ekstra_fragt_tekst_laengde check (
  coalesce(char_length(fragtfirma_fakturanummer), 1) between 1 and 100
  and coalesce(char_length(maalt_maal), 0) <= 100
  and coalesce(char_length(forklaring), 0) <= 1000
  and coalesce(char_length(dokumentation_navn), 0) <= 200
  and coalesce(char_length(indsigelse_tekst), 0) <= 2000
  and coalesce(char_length(afgoerelse_begrundelse), 0) <= 2000
  and coalesce(char_length(frafald_grund), 0) <= 1000
  and coalesce(char_length(sidste_fejl), 0) <= 500
  and coalesce(char_length(opmaerksomhed_tekst), 0) <= 4000
  and coalesce(char_length(intern_note), 0) <= 4000
  and coalesce(char_length(transportoer), 0) <= 20
  and coalesce(char_length(sporingsnummer), 0) <= 100);

-- Højst én (ikke frafaldet) returfragt-regning pr. sag.
create unique index if not exists ekstra_fragt_returfragt_sag
  on public.ekstra_fragt_regninger (sag_id) where slags = 'returfragt_sag' and status <> 'frafaldet';

comment on column public.ekstra_fragt_regninger.slags is
  'for_lille_pakke = fragtfirmaet har opkrævet ekstra (staff registrerer med faktura) | returfragt_sag = sælgeren betaler returfragten i en transportskade-sag med dårlig indpakning (oprettes af sag_retur_afleveret, 20261102210000). Samme betaling, frist, spærring og faktura.';

-- slags og sag_id kan aldrig ændres (ekstra_fragt_beskyt kender dem ikke).
create or replace function public.ekstra_fragt_slags_beskyt()
returns trigger language plpgsql set search_path = '' as $f$
begin
  if new.slags is distinct from old.slags or new.sag_id is distinct from old.sag_id then
    raise exception 'Ekstraregningens slags og sag kan ikke ændres' using errcode = '42501';
  end if;
  return new;
end;
$f$;
revoke all on function public.ekstra_fragt_slags_beskyt() from public, anon, authenticated;
drop trigger if exists ekstra_fragt_slags_beskyt on public.ekstra_fragt_regninger;
create trigger ekstra_fragt_slags_beskyt before update on public.ekstra_fragt_regninger
  for each row execute function public.ekstra_fragt_slags_beskyt();

-- ===========================================================================
-- 3. moderation_log: ny handling (flettes ind i den nuværende liste)
-- ===========================================================================
do $do$
declare
  v_def  text;
  v_gl   text[];
  v_vals text[];
  v_nye  text[] := array['sag_type_rettet'];
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
  if not (v_nye <@ v_gl) then
    v_vals := array(select distinct x from unnest(v_gl || v_nye) x order by 1);
    alter table public.moderation_log drop constraint moderation_log_handling_check;
    execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', v_vals);
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c
     where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
    if not ((v_gl || v_nye) <@ array(
              select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
                from regexp_matches(v_def, '''([^'']+)''', 'g') as m)) then
      raise exception 'moderation_log_handling_check blev ikke flettet korrekt: %', v_def;
    end if;
  end if;
end $do$;

-- ===========================================================================
-- 4. Sælgerens svar (regel 3)
-- ===========================================================================
create table if not exists public.sag_svar (
  id          uuid primary key default gen_random_uuid(),
  sag_id      uuid not null unique references public.sager(id) on delete restrict,
  trade_id    uuid not null references public.trades(id) on delete restrict,
  saelger_id  uuid not null references public.users(id) on delete restrict,
  tekst       text not null,
  oprettet_kl timestamptz not null default now(),
  constraint sag_svar_tekst_laengde check (char_length(btrim(tekst)) between 10 and 4000)
);

create table if not exists public.sag_svar_billeder (
  id          uuid primary key default gen_random_uuid(),
  svar_id     uuid not null references public.sag_svar(id) on delete restrict,
  sag_id      uuid not null references public.sager(id) on delete restrict,
  trade_id    uuid not null references public.trades(id) on delete restrict,
  sti         text not null unique,
  kategori    text not null,
  oprettet_kl timestamptz not null default now(),
  constraint sag_svar_billeder_sti_check check (sti ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'),
  constraint sag_svar_billeder_kategori_check check (kategori in ('pakke', 'label', 'pakke_label', 'indhold', 'andet'))
);
create index if not exists sag_svar_billeder_svar on public.sag_svar_billeder (svar_id);

comment on table public.sag_svar is
  'Sælgerens svar på en sag (regel 3, 20261102210000): én gang, inden for 48 timer fra oprettelsen, mens sagen er åben. Læses af køber, sælger og staff. Bevis - kan aldrig ændres eller slettes. Skrives kun af sag_svar_send.';
comment on table public.sag_svar_billeder is
  'Billeder til sælgerens svar (bucket sag-billeder, <sælger-id>/<handel-id>/<fil>). Som sag_svar.';

-- Bevis: ingen ændring, ingen sletning (heller ikke service role).
create or replace function public.sag_svar_uforanderlig()
returns trigger language plpgsql set search_path = '' as $f$
begin
  raise exception 'Sælgerens svar i en sag kan ikke ændres eller slettes.' using errcode = '42501';
end;
$f$;
revoke all on function public.sag_svar_uforanderlig() from public, anon, authenticated;
drop trigger if exists sag_svar_uforanderlig on public.sag_svar;
create trigger sag_svar_uforanderlig before update or delete on public.sag_svar
  for each row execute function public.sag_svar_uforanderlig();
drop trigger if exists sag_svar_billeder_uforanderlig on public.sag_svar_billeder;
create trigger sag_svar_billeder_uforanderlig before update or delete on public.sag_svar_billeder
  for each row execute function public.sag_svar_uforanderlig();

alter table public.sag_svar enable row level security;
alter table public.sag_svar_billeder enable row level security;
revoke all on public.sag_svar from public, anon, authenticated, service_role;
revoke all on public.sag_svar_billeder from public, anon, authenticated, service_role;
grant select on public.sag_svar to authenticated, service_role;
grant select on public.sag_svar_billeder to authenticated, service_role;

drop policy if exists sag_svar_select on public.sag_svar;
create policy sag_svar_select on public.sag_svar for select to authenticated using (
  (select public.er_staff())
  or exists (select 1 from public.trades t
              where t.id = sag_svar.trade_id
                and (t.buyer_id = (select auth.uid()) or t.seller_id = (select auth.uid()))));
drop policy if exists sag_svar_billeder_select on public.sag_svar_billeder;
create policy sag_svar_billeder_select on public.sag_svar_billeder for select to authenticated using (
  (select public.er_staff())
  or exists (select 1 from public.trades t
              where t.id = sag_svar_billeder.trade_id
                and (t.buyer_id = (select auth.uid()) or t.seller_id = (select auth.uid()))));

-- Kan p_bruger (sælgeren) svare på sagen på handlen lige nu? Bruges af
-- storage-policyen (upload af svarets billeder) og sag_svar_send.
create or replace function public.sag_svar_kan(p_trade uuid, p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $f$
  select p_trade is not null and p_bruger is not null and exists (
    select 1 from public.sager s
      join public.trades t on t.id = s.trade_id
     where s.trade_id = p_trade
       and t.seller_id = p_bruger
       and s.status = 'aaben'
       and now() <= s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer())
       and not exists (select 1 from public.sag_svar v where v.sag_id = s.id));
$f$;
revoke all on function public.sag_svar_kan(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sag_svar_kan(uuid, uuid) to service_role;

-- Sælgeren svarer (authenticated: sælgeren = auth.uid()). p_billeder:
-- [{ sti, kategori }] uploadet først til 'sag-billeder' under <eget id>/<handel-id>/.
-- Koder: ok (+ svar_id) | ikke_logget_ind | ikke_fundet | lukket | for_sent |
-- findes | ugyldig_tekst | kontaktinfo | ugyldige_billeder | for_mange_billeder |
-- billede_mangler
create or replace function public.sag_svar_send(p_sag uuid, p_tekst text, p_billeder jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_bruger   uuid := auth.uid();
  v_tekst    text := btrim(coalesce(p_tekst, ''));
  v_billeder jsonb := coalesce(p_billeder, '[]'::jsonb);
  s          record;
  t          record;
  v_fejl     text;
  v_id       uuid;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if p_sag is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select * into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select id, seller_id into t from public.trades where id = s.trade_id;
  if t.id is null or t.seller_id is distinct from v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if exists (select 1 from public.sag_svar v where v.sag_id = s.id) then
    return jsonb_build_object('kode', 'findes');
  end if;
  if s.status <> 'aaben' then return jsonb_build_object('kode', 'lukket'); end if;
  if now() > s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer()) then
    return jsonb_build_object('kode', 'for_sent',
      'frist_kl', s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer()));
  end if;

  if char_length(v_tekst) not between 10 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;
  -- Svaret læses af køberen: ingen kontaktoplysninger (samme filter som
  -- auktionsbeskrivelsen og beskederne).
  if public.indeholder_kontaktinfo(v_tekst) then
    return jsonb_build_object('kode', 'kontaktinfo');
  end if;

  if jsonb_typeof(v_billeder) <> 'array' then return jsonb_build_object('kode', 'ugyldige_billeder'); end if;
  -- Samme regler som køberens billeder (egen mappe på handlen, filen findes,
  -- ikke brugt før) - og ikke brugt i et andet svar eller en anke.
  v_fejl := public.sag_valider_billeder(v_bruger, t.id, v_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;
  if exists (select 1 from jsonb_array_elements(v_billeder) e
              where exists (select 1 from public.sag_svar_billeder b where b.sti = e->>'sti')
                 or exists (select 1 from public.sag_anke_billeder b where b.sti = e->>'sti')) then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;

  begin
    insert into public.sag_svar (sag_id, trade_id, saelger_id, tekst)
    values (s.id, t.id, v_bruger, v_tekst)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  insert into public.sag_svar_billeder (svar_id, sag_id, trade_id, sti, kategori)
  select v_id, s.id, t.id, e->>'sti', e->>'kategori'
    from jsonb_array_elements(v_billeder) e;

  return jsonb_build_object('kode', 'ok', 'svar_id', v_id);
end;
$f$;
revoke all on function public.sag_svar_send(uuid, text, jsonb) from public, anon;
grant execute on function public.sag_svar_send(uuid, text, jsonb) to authenticated, service_role;

-- Påmindelse til sælgeren 12 timer før svarfristen (serveren sender).
create or replace function public.sag_svar_paamind_kandidater(p_timer integer default 12)
returns table (sag_id uuid, trade_id uuid, saelger_id uuid, auction_id uuid, frist_kl timestamptz)
language sql
stable
security definer
set search_path = ''
as $f$
  select s.id, t.id, t.seller_id, t.auction_id,
         s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer())
    from public.sager s
    join public.trades t on t.id = s.trade_id
   where s.status = 'aaben'
     and s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer()) > now()
     and s.oprettet_kl + make_interval(hours => public.sag_svar_frist_timer())
         <= now() + make_interval(hours => greatest(1, least(coalesce(p_timer, 12), 48)))
     and not exists (select 1 from public.sag_svar v where v.sag_id = s.id)
   order by s.oprettet_kl
   limit 200;
$f$;
revoke all on function public.sag_svar_paamind_kandidater(integer) from public, anon, authenticated;
grant execute on function public.sag_svar_paamind_kandidater(integer) to service_role;

-- Påmindelse til køberen 6 timer før fristen for at melde et problem (regel 5).
create or replace function public.handel_problem_frist_paamind_kandidater(p_timer integer default 6)
returns table (trade_id uuid, buyer_id uuid, auction_id uuid, frist_kl timestamptz)
language sql
stable
security definer
set search_path = ''
as $f$
  select t.id, t.buyer_id, t.auction_id, t.problem_frist_kl
    from public.trades t
    join public.betalinger b on b.trade_id = t.id
   where t.status = 'modtaget'
     and t.problem_frist_kl is not null
     and t.problem_frist_kl > now()
     and t.problem_frist_kl <= now() + make_interval(hours => greatest(1, least(coalesce(p_timer, 6), 72)))
     and not coalesce(t.afhentning, false)
     and not coalesce(t.sag_aaben, false)
     and b.status = 'betalt'
     and b.frigivet_kl is null
     and b.refusion_anmodet_kl is null
     and not exists (select 1 from public.sager s where s.trade_id = t.id)
   order by t.problem_frist_kl
   limit 200;
$f$;
revoke all on function public.handel_problem_frist_paamind_kandidater(integer) from public, anon, authenticated;
grant execute on function public.handel_problem_frist_paamind_kandidater(integer) to service_role;

-- ===========================================================================
-- 5. Refusion ved medhold (regel 6 og 7)
-- ===========================================================================
-- Bortkommet pakke og transportskade: hele beløbet (bud + gebyr + fragt =
-- total_oere) for alle prismodeller. Andre typer som før
-- (sag_refusion_oere med 4 parametre: ny/ny2 = buddet, ellers alt undtagen
-- BidHamr Beskyttelse). TypeScript-spejl: beregn.ts sagRefusionOere.
create or replace function public.sag_refusion_oere(p_prismodel text, p_bud_oere bigint,
  p_total_oere bigint, p_beskyttelse_oere bigint, p_type text)
returns bigint
language sql
immutable
set search_path = ''
as $f$
  select case when p_type in ('bortkommet', 'skadet') then p_total_oere
              else public.sag_refusion_oere(p_prismodel, p_bud_oere, p_total_oere, p_beskyttelse_oere) end;
$f$;
revoke all on function public.sag_refusion_oere(text, bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.sag_refusion_oere(text, bigint, bigint, bigint, text) to service_role;

do $do$
begin
  raise notice 'sag_claim_refusion: %', pg_temp.ps_ret(
    'public.sag_claim_refusion(uuid)',
    'c17fb96d5867012ac791ea7863cbc0d7',
    '579ea60d84f6d6790f300081b3bd84df',
    jsonb_build_array(
      jsonb_build_array(
$g$  beloeb := public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere);$g$,
$n$  -- 20261102210000: bortkommet og transportskade = hele beløbet (sagens type).
  beloeb := public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere,
    (select s.type from public.sager s where s.trade_id = b.trade_id order by s.oprettet_kl desc limit 1));$n$, 1)));

  raise notice 'betaling_bidhamr_daekker_claim: %', pg_temp.ps_ret(
    'public.betaling_bidhamr_daekker_claim(uuid,uuid,text,uuid)',
    '12bd75266e2ba5b81a586c858586a18e',
    '5919889648e58595fb8a756e826c5295',
    jsonb_build_array(
      jsonb_build_array(
$g$        then public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere)$g$,
$n$        -- 20261102210000: efter sagens type (bortkommet/skadet = hele beløbet).
        then public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere,
               (select s.type from public.sager s
                 where s.trade_id = b.trade_id and s.penge_handling = 'refunder' and s.afviklet_kl is null
                 order by s.oprettet_kl desc limit 1))$n$, 1)));
end $do$;

-- ===========================================================================
-- 6. Billeder: 'pakke_label' og sælgerens svar i storage
-- ===========================================================================
do $do$
begin
  raise notice 'sag_valider_billeder: %', pg_temp.ps_ret(
    'public.sag_valider_billeder(uuid,uuid,jsonb)',
    'd298ce4d26b61876759ab35c52129755',
    'e4593487d8e74f2954a24c0de9b0987e',
    jsonb_build_array(
      jsonb_build_array(
$g$       or v_kat not in ('pakke', 'label', 'indhold', 'andet') then$g$,
$n$       or v_kat not in ('pakke', 'label', 'pakke_label', 'indhold', 'andet') then$n$, 1)));

  -- Upload: også sælgeren i svarvinduet (sag_svar_kan).
  raise notice 'sag_billede_maa_uploade: %', pg_temp.ps_ret(
    'public.sag_billede_maa_uploade(text)',
    '3ff2a50ca373980ea1a7ec3e0602e43e',
    'e3073a3e6469e98424c29c9f500ec301',
    jsonb_build_array(
      jsonb_build_array(
$g$       and public.sag_anke_vurder(s.id, v_bruger)->>'kode' = 'kan_anke'
  ) then$g$,
$n$       and public.sag_anke_vurder(s.id, v_bruger)->>'kode' = 'kan_anke'
  ) and not public.sag_svar_kan(v_trade, v_bruger) then$n$, 1)));

  -- Læs: også billeder i sælgerens svar (køber og sælger på handlen).
  raise notice 'sag_billede_maa_laese: %', pg_temp.ps_ret(
    'public.sag_billede_maa_laese(text)',
    '9f4ee9b149ecc5ebbb71696178764a6b',
    '0468827305999f81d8453386f4c1b9d0',
    jsonb_build_array(
      jsonb_build_array(
$g$            and (t.seller_id = auth.uid() or t.buyer_id = auth.uid()))
  );$g$,
$n$            and (t.seller_id = auth.uid() or t.buyer_id = auth.uid()))
    or exists (
         select 1 from public.sag_svar_billeder sb
           join public.trades t on t.id = sb.trade_id
          where sb.sti = p_sti
            and (t.seller_id = auth.uid() or t.buyer_id = auth.uid()))
  );$n$, 1)));
end $do$;

-- ===========================================================================
-- 7. Staff retter sagstypen (regel 4)
-- ===========================================================================
-- sager_beskyt: typen (og tjek_sporing) må kun ændres af sag_ret_type, som
-- sætter en transaktionslokal markering. Brugere har ingen skriveadgang til
-- sager og kan ikke kalde set_config via API'et.
do $do$
begin
  raise notice 'sager_beskyt: %', pg_temp.ps_ret(
    'public.sager_beskyt()',
    'd296e8127be8d10feddb49f6b8015789',
    'ad094742c4b72d32edb12bc07301cd0b',
    jsonb_build_array(
      jsonb_build_array(
$g$  or new.type                         is distinct from old.type$g$,
$n$  -- 20261102210000: typen kun via sag_ret_type (staff, logget).
  or (new.type is distinct from old.type
      and coalesce(current_setting('bidhamr.sag_ret_type', true), '') <> 'ja')$n$, 1),
      jsonb_build_array(
$g$  or new.tjek_sporing                 is distinct from old.tjek_sporing$g$,
$n$  or (new.tjek_sporing is distinct from old.tjek_sporing
      and coalesce(current_setting('bidhamr.sag_ret_type', true), '') <> 'ja')$n$, 1)));
end $do$;

-- Koder: ok (+ gammel_type, ny_type) | ingen_adgang | ugyldig_type |
-- begrundelse_mangler | for_lang_tekst | ikke_fundet | inhabil | uaendret |
-- afviklet | forkert_status | kraever_beskyttelse
create or replace function public.sag_ret_type(p_medarbejder uuid, p_sag uuid, p_type text, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_trade uuid;
  b       record;
  t       record;
  s       record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_type is null or p_type not in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select trade_id into v_trade from public.sager where id = p_sag;
  if v_trade is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Låserækkefølge: betaling, handel, sag.
  select * into b from public.betalinger where trade_id = v_trade for update;
  select * into t from public.trades where id = v_trade for update;
  select * into s from public.sager where id = p_sag for update;

  if public.penge_inhabil(p_medarbejder, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if s.type = p_type then return jsonb_build_object('kode', 'uaendret'); end if;
  if s.afviklet_kl is not null then return jsonb_build_object('kode', 'afviklet'); end if;
  -- Før afgørelsen - eller mens en anke venter (typen bruges ved omgørelse).
  if s.status <> 'aaben'
     and not exists (select 1 from public.sag_anker a where a.sag_id = s.id and a.status = 'afventer') then
    return jsonb_build_object('kode', 'forkert_status');
  end if;
  -- Retur ved skade/"ikke som beskrevet" kræver BidHamr Beskyttelse - typen
  -- må ikke give køberen en ret, han ikke har.
  if p_type in ('skadet', 'ikke_som_beskrevet', 'andet') and not coalesce(s.beskyttelse, false) then
    return jsonb_build_object('kode', 'kraever_beskyttelse');
  end if;

  perform set_config('bidhamr.sag_ret_type', 'ja', true);
  update public.sager
     set type = p_type,
         oprindelig_type = coalesce(oprindelig_type, s.type),
         type_rettet_kl = now(),
         type_rettet_af = p_medarbejder,
         -- Bortkommet: staff tjekker sporingen.
         tjek_sporing = tjek_sporing or p_type = 'bortkommet'
   where id = s.id;
  perform set_config('bidhamr.sag_ret_type', '', true);

  update public.trades
     set sag_note = 'Sag fra køberen: ' || case p_type
                      when 'bortkommet' then 'pakken er ikke kommet frem'
                      when 'skadet' then 'varen er skadet'
                      when 'ikke_som_beskrevet' then 'varen er ikke som beskrevet'
                      when 'andet' then 'andet problem'
                      else 'svindel' end
   where id = t.id and coalesce(sag_aaben, false);

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_type_rettet', 'sag', s.id, t.buyer_id,
          left('Sagstypen er rettet fra ' || s.type || ' til ' || p_type || ' | Begrundelse: ' || v_grund, 4000));

  return jsonb_build_object('kode', 'ok', 'gammel_type', s.type, 'ny_type', p_type, 'trade_id', t.id);
end;
$f$;
revoke all on function public.sag_ret_type(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.sag_ret_type(uuid, uuid, text, text) to service_role;

-- ===========================================================================
-- 8. sag_opret (regel 1, 2, 4 og 8) - ny signatur
-- ===========================================================================
create or replace function public.sag_opret(p_trade uuid, p_type text, p_beskrivelse text, p_billeder jsonb,
  p_pakke_smidt_ud boolean default false, p_smidt_ud_begrundelse text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bruger   uuid := auth.uid();
  v_beskr    text := btrim(coalesce(p_beskrivelse, ''));
  v_billeder jsonb := coalesce(p_billeder, '[]'::jsonb);
  v_smidt    boolean := coalesce(p_pakke_smidt_ud, false);
  v_smidt_gr text := nullif(btrim(coalesce(p_smidt_ud_begrundelse, '')), '');
  b          record;
  t          record;
  v_sendt    timestamptz;
  v_frist    timestamptz;
  v_fejl     text;
  v_sag      uuid;
  v_pakke    boolean;
begin
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  -- 20261102210000: 'andet' er en rigtig type (staff kan rette den).
  if p_type is null or p_type not in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if char_length(v_beskr) not between 10 and 4000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;

  if not exists (select 1 from public.trades
                  where id = p_trade and buyer_id = v_bruger) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select * into b from public.betalinger where trade_id = p_trade for update;
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or t.buyer_id <> v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if exists (select 1 from public.sager s where s.trade_id = p_trade) then
    return jsonb_build_object('kode', 'findes');
  end if;

  if b.id is null
     or b.status <> 'betalt'
     or b.frigivet_kl is not null
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then
    return jsonb_build_object('kode', 'ikke_betalt');
  end if;

  if p_type in ('skadet', 'ikke_som_beskrevet', 'andet') and not b.beskyttelse then
    return jsonb_build_object('kode', 'kraever_beskyttelse');
  end if;

  if t.status = 'modtaget' then
    -- 20261030010000: bortkommet også, når fragtfirmaets leveringsmelding
    -- startede uret (køberen har ikke selv kvitteret) - inden for fristen.
    if p_type = 'bortkommet' and t.modtaget_kilde is distinct from 'fragt' then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    -- 20261102210000: fristen er låst på handlen (72 t; 48 t for handler
    -- modtaget før migrationen).
    v_frist := coalesce(t.problem_frist_kl, t.received_at + interval '48 hours');
    if t.received_at is null or v_frist is null or v_frist < now() then
      return jsonb_build_object('kode', 'for_sent');
    end if;
  elsif t.status = 'pakke_sendt' then
    if p_type not in ('bortkommet', 'svindel') then
      return jsonb_build_object('kode', 'forkert_trin');
    end if;
    v_sendt := coalesce(t.sendt_kl, b.betalt_kl);
    if v_sendt is null or v_sendt > now() - interval '7 days' then
      return jsonb_build_object('kode', 'for_tidligt');
    end if;
  else
    return jsonb_build_object('kode', 'forkert_trin');
  end if;

  -- Pakken er smidt ud (regel 2): kun hvor pakkebilledet ellers kræves, og
  -- kun med en forklaring på mindst 20 tegn.
  if v_smidt then
    if not (t.status = 'modtaget' and p_type <> 'bortkommet') then
      return jsonb_build_object('kode', 'smidt_ud_ikke_mulig');
    end if;
    if v_smidt_gr is null or char_length(v_smidt_gr) not between 20 and 2000 then
      return jsonb_build_object('kode', 'smidt_ud_begrundelse');
    end if;
  else
    v_smidt_gr := null;
  end if;

  v_fejl := public.sag_valider_billeder(v_bruger, p_trade, v_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  -- Regel 1: pakken (med labelen) + indholdet. 'pakke_label' eller 'pakke'
  -- tæller som pakken; ved "smidt ud" kræves kun indholdet.
  if t.status = 'modtaget' and p_type <> 'bortkommet' then
    v_pakke := v_smidt or exists (select 1 from jsonb_array_elements(v_billeder) e
                                   where e->>'kategori' in ('pakke_label', 'pakke'));
    if not v_pakke
       or not exists (select 1 from jsonb_array_elements(v_billeder) e where e->>'kategori' = 'indhold') then
      return jsonb_build_object('kode', 'billeder_kraeves');
    end if;
  end if;

  begin
    insert into public.sager (trade_id, oprettet_af, type, beskrivelse, beskyttelse,
                              handel_status_ved_oprettelse, tjek_sporing,
                              pakke_smidt_ud, pakke_smidt_ud_begrundelse)
    values (p_trade, v_bruger, p_type, v_beskr, b.beskyttelse, t.status,
            t.status = 'pakke_sendt' or p_type = 'bortkommet',
            v_smidt, v_smidt_gr)
    returning id into v_sag;
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  insert into public.sag_billeder (sag_id, sti, kategori)
  select v_sag, e->>'sti', e->>'kategori'
    from jsonb_array_elements(v_billeder) e;

  update public.trades
     set sag_aaben = true,
         sag_note = 'Sag fra køberen: ' || case p_type
                      when 'bortkommet' then 'pakken er ikke kommet frem'
                      when 'skadet' then 'varen er skadet'
                      when 'ikke_som_beskrevet' then 'varen er ikke som beskrevet'
                      when 'andet' then 'andet problem'
                      else 'svindel' end
                    || case when v_smidt then ' (pakken er smidt ud - vurdér forklaringen)' else '' end,
         sag_aabnet_af = v_bruger,
         sag_aabnet_at = now()
   where id = p_trade;

  return jsonb_build_object('kode', 'ok', 'sag_id', v_sag);
end;
$function$;

drop function if exists public.sag_opret(uuid, text, text, jsonb);
revoke all on function public.sag_opret(uuid, text, text, jsonb, boolean, text) from public, anon;
grant execute on function public.sag_opret(uuid, text, text, jsonb, boolean, text) to authenticated, service_role;

-- ===========================================================================
-- 9. Afgørelse: hvem betaler returfragten (regel 7) og "andet" (regel 4)
-- ===========================================================================
-- Indpakningen ved afgørelsen af en transportskade:
--   'bidhamr' -> indpakningen registreres som ordentlig (reklamationen hos
--               fragtfirmaet oprettes, når køberen er refunderet). Afvises,
--               hvis der er givet påmindelse/advarsel for dårlig indpakning.
--   'saelger' -> afvises, hvis indpakningen er vurderet ordentlig.
-- Intern (kaldes af sag_afgoer og sag_anke_afgoer under deres låse).
create or replace function public.sag_indpakning_ved_afgoerelse(
  p_medarbejder uuid, p_sag uuid, p_trade uuid, p_saelger uuid, p_betaler text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $f$
declare
  o record;
begin
  if p_betaler = 'bidhamr' then
    if exists (select 1 from public.paamindelser where sag_id = p_sag and grund = 'daarlig_indpakning')
       or exists (select 1 from public.advarsler where sag_id = p_sag and grund = 'daarlig_indpakning') then
      return jsonb_build_object('kode', 'indpakning_daarlig');
    end if;
    select * into o from public.indpakning_ordentlig where sag_id = p_sag for update;
    if found and o.tilbagekaldt_kl is null then
      return jsonb_build_object('kode', 'ok');
    end if;
    if found then
      update public.indpakning_ordentlig
         set vurderet_af = p_medarbejder, vurderet_kl = now(),
             intern_note = 'Afgørelse: BidHamr betaler returfragten (god indpakning)',
             tilbagekaldt_kl = null, tilbagekaldt_af = null, tilbagekaldt_grund = null
       where sag_id = p_sag;
    else
      insert into public.indpakning_ordentlig (sag_id, trade_id, vurderet_af, intern_note)
      values (p_sag, p_trade, p_medarbejder, 'Afgørelse: BidHamr betaler returfragten (god indpakning)');
    end if;
    perform public.fragt_reklamation_log(p_medarbejder, 'indpakning_ordentlig', p_sag, p_saelger,
      'Indpakningen vurderet ordentlig ved afgørelsen - BidHamr betaler returfragten og reklamerer hos fragtfirmaet');
    return jsonb_build_object('kode', 'ok');
  elsif p_betaler = 'saelger' then
    if exists (select 1 from public.indpakning_ordentlig o2
                where o2.sag_id = p_sag and o2.tilbagekaldt_kl is null) then
      return jsonb_build_object('kode', 'indpakning_ordentlig');
    end if;
    return jsonb_build_object('kode', 'ok');
  end if;
  return jsonb_build_object('kode', 'ugyldig_returfragt_betaler');
end;
$f$;
revoke all on function public.sag_indpakning_ved_afgoerelse(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

do $do$
begin
  raise notice 'sag_afgoer: %', pg_temp.ps_ret(
    'public.sag_afgoer(uuid,uuid,text,text,text,boolean)',
    'ea0cd85a0d3c06f363650778ceb414cb',
    '6def5cbb98c58e7fefcd899fa1d22141',
    jsonb_build_array(
      jsonb_build_array(
$g$p_retur_ikke_sendt boolean DEFAULT false)$g$,
$n$p_retur_ikke_sendt boolean DEFAULT false, p_returfragt_betaler text DEFAULT NULL::text)$n$, 1),
      jsonb_build_array(
$g$  v_retur_frist    timestamptz;
begin$g$,
$n$  v_retur_frist    timestamptz;
  -- 20261102210000: hvem betaler returfragten ved transportskade.
  v_rf_betaler     text := nullif(btrim(coalesce(p_returfragt_betaler, '')), '');
begin$n$, 1),
      jsonb_build_array(
$g$    if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
      -- Svindel/bortkommet refunderes uden retur.$g$,
$n$    -- 20261102210000: "andet" skal have en rigtig type, før køberen får
    -- medhold (refusionen og returen afhænger af typen).
    if s.type = 'andet' then
      return jsonb_build_object('kode', 'vaelg_type');
    end if;
    -- Transportskade med retur: staff vælger, hvem der betaler returfragten
    -- (sælgeren ved dårlig indpakning, ellers BidHamr). Andre typer: køberen.
    if s.type = 'skadet' and s.retur_afleveret_kl is null then
      if v_rf_betaler is null or v_rf_betaler not in ('saelger', 'bidhamr') then
        return jsonb_build_object('kode', 'vaelg_returfragt_betaler');
      end if;
      v_res := public.sag_indpakning_ved_afgoerelse(p_medarbejder, s.id, t.id, t.seller_id, v_rf_betaler);
      if v_res->>'kode' <> 'ok' then return v_res; end if;
      v_res := null;
    elsif v_rf_betaler is not null and (s.type <> 'skadet' and v_rf_betaler <> 'koeber') then
      return jsonb_build_object('kode', 'ugyldig_returfragt_betaler');
    end if;

    if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
      -- Svindel/bortkommet refunderes uden retur.$n$, 1),
      jsonb_build_array(
$g$             returfragt_betaler = case when s.retur_afleveret_kl is not null
                                       then 'koeber' end,$g$,
$n$             returfragt_betaler = case when s.retur_afleveret_kl is not null
                                       then coalesce(case when s.type = 'skadet'
                                                          and v_rf_betaler in ('saelger', 'bidhamr')
                                                          then v_rf_betaler end, 'koeber') end,$n$, 1),
      jsonb_build_array(
$g$      v_log := 'Medhold til køber - refusion (alt undtagen BidHamr Beskyttelse) efter ankefristen på 4 dage';$g$,
$n$      v_log := 'Medhold til køber - refusion efter ankefristen på 4 dage ('
               || case when s.type in ('bortkommet', 'skadet') then 'hele beløbet: bud, gebyr og fragt'
                       else 'efter prismodellen' end || ')';$n$, 1),
      jsonb_build_array(
$g$             returfragt_betaler = 'koeber',
$g$,
$n$             returfragt_betaler = case when s.type = 'skadet' then v_rf_betaler else 'koeber' end,
$n$, 1),
      jsonb_build_array(
$g$      v_log := 'Medhold til køber - varen sendes retur (køberen betaler selv returfragten), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';$g$,
$n$      v_log := 'Medhold til køber - varen sendes retur ('
               || case when s.type <> 'skadet' then 'køberen betaler selv returfragten'
                       when v_rf_betaler = 'saelger' then 'sælgeren betaler returfragten - dårlig indpakning'
                       else 'BidHamr betaler returfragten og reklamerer hos fragtfirmaet - god indpakning' end
               || '), refusion når returpakken er afleveret og ankefristen på 4 dage er udløbet';$n$, 1)),
    'public.sag_afgoer(uuid,uuid,text,text,text,boolean,text)');

  raise notice 'sag_anke_afgoer: %', pg_temp.ps_ret(
    'public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean)',
    '4f00919bdf83d3000f4769431906c5cc',
    '0af19871caa67f0136bd9403271081be',
    jsonb_build_array(
      jsonb_build_array(
$g$p_retur_ikke_sendt boolean DEFAULT false)$g$,
$n$p_retur_ikke_sendt boolean DEFAULT false, p_returfragt_betaler text DEFAULT NULL::text)$n$, 1),
      jsonb_build_array(
$g$  v_retur    boolean := false;
begin$g$,
$n$  v_retur    boolean := false;
  -- 20261102210000: hvem betaler returfragten ved transportskade.
  v_rf_betaler text := nullif(btrim(coalesce(p_returfragt_betaler, '')), '');
begin$n$, 1),
      jsonb_build_array(
$g$      if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
        update public.sager$g$,
$n$      -- 20261102210000: som sag_afgoer - "andet" skal have en rigtig type,
      -- og ved transportskade vælger behandleren, hvem der betaler returfragten.
      if s.type = 'andet' then
        return jsonb_build_object('kode', 'vaelg_type');
      end if;
      if s.type = 'skadet' and s.retur_afleveret_kl is null then
        if v_rf_betaler is null or v_rf_betaler not in ('saelger', 'bidhamr') then
          return jsonb_build_object('kode', 'vaelg_returfragt_betaler');
        end if;
        v_res := public.sag_indpakning_ved_afgoerelse(p_medarbejder, s.id, t.id, t.seller_id, v_rf_betaler);
        if v_res->>'kode' <> 'ok' then return v_res; end if;
        v_res := null;
      elsif v_rf_betaler is not null and (s.type <> 'skadet' and v_rf_betaler <> 'koeber') then
        return jsonb_build_object('kode', 'ugyldig_returfragt_betaler');
      end if;
      if s.type in ('svindel', 'bortkommet') or s.retur_afleveret_kl is not null then
        update public.sager$n$, 1),
      jsonb_build_array(
$g$               retur_kraeves = true, returfragt_betaler = 'koeber',$g$,
$n$               retur_kraeves = true,
               returfragt_betaler = case when s.type = 'skadet' then v_rf_betaler else 'koeber' end,$n$, 1)),
    'public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean,text)');
end $do$;

revoke all on function public.sag_afgoer(uuid, uuid, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.sag_afgoer(uuid, uuid, text, text, text, boolean, text) to service_role;
revoke all on function public.sag_anke_afgoer(uuid, uuid, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.sag_anke_afgoer(uuid, uuid, text, text, text, boolean, text) to service_role;

-- ===========================================================================
-- 10. 72 timer (regel 8)
-- ===========================================================================
do $do$
begin
  raise notice 'handel_auto_frigiv: %', pg_temp.ps_ret(
    'public.handel_auto_frigiv()',
    'a8da0c29700cd1aca4be80724084e3d3',
    'bfa8b5e0500b6df15645b805ceb51a5e',
    jsonb_build_array(
      jsonb_build_array(
$g$       and ((tr.status = 'modtaget' and tr.received_at < now() - interval '48 hours')$g$,
$n$       -- 20261102210000: fristen er låst på handlen (72 t; 48 t for ældre).
       and ((tr.status = 'modtaget'
             and coalesce(tr.problem_frist_kl, tr.received_at + interval '48 hours') < now())$n$, 1),
      jsonb_build_array(
$g$      if t.status = 'modtaget' and t.received_at < now() - interval '48 hours' then$g$,
$n$      if t.status = 'modtaget'
         and coalesce(t.problem_frist_kl, t.received_at + interval '48 hours') < now() then$n$, 1)));

  -- 14-dages-grenen venter, til en leveringsmelding er mindst fristen gammel.
  raise notice 'handel_leveret_melding_ny: %', pg_temp.ps_ret(
    'public.handel_leveret_melding_ny(uuid)',
    '11fc30b8ccc0f836ee9532436e131c93',
    '1a20eb795162f2ad110dae9a4f16eddc',
    jsonb_build_array(
      jsonb_build_array(
$g$>= now() - interval '48 hours'$g$,
$n$>= now() - make_interval(hours => public.sag_problem_frist_timer())$n$, 1)));

  raise notice 'admin_penge_holdes: %', pg_temp.ps_ret(
    'public.admin_penge_holdes(integer)',
    '61b21b8c00f3b8740a287ed61b8c02bd',
    '7251185c153ea5e0d490488c161f7f92',
    jsonb_build_array(
      jsonb_build_array(
$g$             when t.status = 'modtaget' then t.received_at + interval '48 hours'$g$,
$n$             when t.status = 'modtaget' then coalesce(t.problem_frist_kl, t.received_at + interval '48 hours')$n$, 1)));
end $do$;

comment on function public.handel_leveret_melding_ny(uuid) is
  'true = handlen har en leveringsmelding (der må frigive penge), som er yngre end fristen for at melde et problem (sag_problem_frist_timer, 72 t - seneste af fragtfirmaets tidspunkt og registreringen hos BidHamr). handel_auto_frigiv frigiver ikke efter 14 dage før da (20261030010000, 20261102210000).';

-- ===========================================================================
-- 11. Returfragt, som køberen ikke betaler (regel 7)
-- ===========================================================================
do $do$
begin
  raise notice 'returfragt_start: %', pg_temp.ps_ret(
    'public.returfragt_start(uuid,uuid)',
    'bc3a83ee3b3b62baeb34ae2292450717',
    '14f5e42c1087f803c8704e3aed93fd45',
    jsonb_build_array(
      jsonb_build_array(
$g$  v_id     uuid;
begin$g$,
$n$  v_id     uuid;
  v_betaler text;
begin$n$, 1),
      jsonb_build_array(
$g$  select r.id, r.status, r.beloeb_oere, r.stripe_payment_intent_id, r.pi_forsoeg into rf$g$,
$n$  select r.id, r.status, r.beloeb_oere, r.stripe_payment_intent_id, r.pi_forsoeg, r.betaler into rf$n$, 1),
      jsonb_build_array(
$g$    if rf.status in ('betalt', 'refunderes') then$g$,
$n$    -- 20261102210000: dækket af sælgeren/BidHamr - køberen betaler intet.
    if rf.status = 'betalt' and rf.betaler <> 'koeber' then
      return jsonb_build_object('kode', 'daekket', 'id', rf.id, 'beloeb_oere', rf.beloeb_oere, 'betaler', rf.betaler);
    end if;
    if rf.status in ('betalt', 'refunderes') then$n$, 1),
      jsonb_build_array(
$g$  insert into public.returfragt_betalinger (trade_id, sag_id, koeber_id, betaling_id, beloeb_oere, pakkestoerrelse)$g$,
$n$  -- 20261102210000: transportskade med medhold - sælgeren eller BidHamr
  -- betaler returfragten. Rækken er "betalt" (dækket) uden PaymentIntent, så
  -- returkoden laves som efter en betaling. Køberen betaler intet.
  select s.returfragt_betaler into v_betaler from public.sager s where s.id = (v_sag->>'sag_id')::uuid;
  if v_betaler in ('saelger', 'bidhamr') then
    insert into public.returfragt_betalinger (trade_id, sag_id, koeber_id, betaling_id, beloeb_oere, pakkestoerrelse,
                                              betaler, status, betalt_kl)
    values (p_trade, (v_sag->>'sag_id')::uuid, p_koeber, v_bet, v_pris, v_stoerrelse, v_betaler, 'betalt', now())
    returning id into v_id;
    return jsonb_build_object('kode', 'daekket', 'id', v_id, 'beloeb_oere', v_pris, 'betaler', v_betaler);
  end if;

  insert into public.returfragt_betalinger (trade_id, sag_id, koeber_id, betaling_id, beloeb_oere, pakkestoerrelse)$n$, 1)));

  -- En dækket række refunderes aldrig hos Stripe (returfragt_daekket_annuller
  -- i stedet).
  raise notice 'returfragt_refusion_claim: %', pg_temp.ps_ret(
    'public.returfragt_refusion_claim(uuid,text)',
    '6b9372e438aa614859134d0f078a5b17',
    'b7f120b809618ec05188c83392baa442',
    jsonb_build_array(
      jsonb_build_array(
$g$  select r.id, r.status, r.label_klar_kl, r.forsendelse_id, r.label_annulleret_bekraeftet_kl into rf
    from public.returfragt_betalinger r where r.id = p_id for update;
  if rf.id is null or rf.status <> 'betalt' then return 'forkert_status'; end if;$g$,
$n$  select r.id, r.status, r.label_klar_kl, r.forsendelse_id, r.label_annulleret_bekraeftet_kl, r.betaler into rf
    from public.returfragt_betalinger r where r.id = p_id for update;
  if rf.id is null or rf.status <> 'betalt' then return 'forkert_status'; end if;
  -- 20261102210000: dækket af sælgeren/BidHamr - intet at refundere.
  if rf.betaler is distinct from 'koeber' then return 'daekket'; end if;$n$, 1)));

  -- Kun køberens egne betalinger faktureres køberen.
  raise notice 'faktura_planlaeg_returfragt: %', pg_temp.ps_ret(
    'public.faktura_planlaeg_returfragt(integer)',
    'c0ac0fbe71bda1f5a4d35af706f9b24a',
    'e354e39754e8ffbaf6c28cb45a3f2906',
    jsonb_build_array(
      jsonb_build_array(
$g$     where x.betalt_kl is not null
       and x.status in ('betalt', 'refunderes', 'refunderet')$g$,
$n$     where x.betalt_kl is not null
       and x.betaler = 'koeber'
       and x.status in ('betalt', 'refunderes', 'refunderet')$n$, 1)));
end $do$;

-- En dækket returfragt, hvor returkoden ikke kan laves (5 fejl, 48 timer),
-- eller sagen ikke længere kræver retur: rækken annulleres (der er intet at
-- refundere), og staff markeres. Køberen kan starte en ny returkode, hvis
-- sagen stadig kræver retur. Samme label-tjek som returfragt_refusion_claim.
-- Koder: ok | ikke_fundet | ikke_daekket | forkert_status | label_findes |
-- staff_afgoer | i_gang | ugyldig
create or replace function public.returfragt_daekket_annuller(p_id uuid, p_aarsag text)
returns text
language plpgsql
security definer
set search_path = ''
as $f$
declare
  rf record;
  f  record;
begin
  if p_aarsag is null or p_aarsag not in ('label_umulig', 'ikke_noedvendig', 'staff') then return 'ugyldig'; end if;
  select r.id, r.status, r.betaler, r.label_klar_kl, r.forsendelse_id, r.label_annulleret_bekraeftet_kl into rf
    from public.returfragt_betalinger r where r.id = p_id for update;
  if rf.id is null then return 'ikke_fundet'; end if;
  if rf.betaler = 'koeber' then return 'ikke_daekket'; end if;
  if rf.status <> 'betalt' then return 'forkert_status'; end if;
  if rf.forsendelse_id is not null then
    select fo.id, fo.status, fo.forsoegt_kl, fo.oprettet_kl, fo.ukendt_udfald_kl into f
      from public.forsendelser fo where fo.id = rf.forsendelse_id for update;
    if f.status = 'annulleret' and rf.label_annulleret_bekraeftet_kl is null and p_aarsag <> 'staff' then
      return 'staff_afgoer';
    end if;
    if f.status not in ('opretter', 'fejlet', 'annulleret') then return 'label_findes'; end if;
    if f.status = 'opretter' then
      if f.ukendt_udfald_kl is null and coalesce(f.forsoegt_kl, f.oprettet_kl) > now() - interval '10 minutes' then
        return 'i_gang';
      end if;
      update public.forsendelser
         set status = 'fejlet', fejl = left(concat_ws(' - ', fejl, 'Returkoden er opgivet'), 500)
       where id = f.id;
    end if;
  elsif rf.label_klar_kl is not null then
    return 'label_findes';
  end if;
  update public.returfragt_betalinger
     set status = 'annulleret', annulleret_kl = now(),
         kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = left(case p_aarsag
           when 'ikke_noedvendig' then 'Sagen kræver ikke længere retur - den dækkede returfragt er annulleret.'
           when 'staff' then 'Staff har annulleret den dækkede returfragt.'
           else 'Returkoden kunne ikke laves - den dækkede returfragt er annulleret. Hjælp køberen med returen i sagen (køberen kan starte en ny returkode).' end, 4000),
         opdateret = now()
   where id = rf.id;
  return 'ok';
end;
$f$;
revoke all on function public.returfragt_daekket_annuller(uuid, text) from public, anon, authenticated;
grant execute on function public.returfragt_daekket_annuller(uuid, text) to service_role;

-- ===========================================================================
-- 12. Sælgeren betaler returfragten: regning som ekstra fragt (regel 7)
-- ===========================================================================
-- Oprettes, når returpakken er registreret afleveret (BidHamr har så betalt
-- fragtfirmaet). Beløbet = den dækkede returfragt (= fragten ud, som
-- køberen betalte). Idempotent: højst én (ikke frafaldet) pr. sag.
-- Svar: { kode: ok (+ id) | ikke_saelger | findes | ingen_forsendelse |
--         ingen_betaling | ugyldigt_beloeb | ikke_fundet }
create or replace function public.sag_returfragt_regning(p_sag uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $f$
declare
  s        record;
  t        record;
  rf       record;
  v_bet    uuid;
  v_fragt  bigint;
  v_fo     uuid;
  v_str    text;
  v_trans  text;
  v_spor   text;
  v_beloeb bigint;
  v_id     uuid;
begin
  select * into s from public.sager where id = p_sag;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if s.returfragt_betaler is distinct from 'saelger' then return jsonb_build_object('kode', 'ikke_saelger'); end if;
  if exists (select 1 from public.ekstra_fragt_regninger x
              where x.sag_id = s.id and x.slags = 'returfragt_sag' and x.status <> 'frafaldet') then
    return jsonb_build_object('kode', 'findes');
  end if;
  select tr.id, tr.seller_id, tr.auction_id into t from public.trades tr where tr.id = s.trade_id;
  if t.id is null or t.seller_id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  select b.id, b.fragt_oere into v_bet, v_fragt from public.betalinger b
   where b.trade_id = t.id and b.betalt_kl is not null order by b.betalt_kl desc limit 1;
  if v_bet is null then return jsonb_build_object('kode', 'ingen_betaling'); end if;

  -- Den dækkede returfragt (returkoden via BidHamr).
  select r.id, r.beloeb_oere, r.forsendelse_id, r.pakkestoerrelse into rf
    from public.returfragt_betalinger r
   where r.sag_id = s.id and r.betaler = 'saelger' and r.status = 'betalt'
   order by r.oprettet_kl desc limit 1;
  v_beloeb := coalesce(rf.beloeb_oere, v_fragt);
  if v_beloeb is null or v_beloeb < 300 or v_beloeb > 1000000 then
    return jsonb_build_object('kode', 'ugyldigt_beloeb');
  end if;

  -- Forsendelsen: returpakken - ellers den udgående pakke.
  select fo.id, fo.pakkestoerrelse,
         coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end),
         fo.sporingsnummer
    into v_fo, v_str, v_trans, v_spor
    from public.forsendelser fo
   where fo.trade_id = t.id
     and (fo.id = rf.forsendelse_id
          or (rf.forsendelse_id is null and fo.type = 'udgaaende'
              and fo.status not in ('opretter', 'fejlet', 'annulleret')))
   order by (fo.id = rf.forsendelse_id) desc nulls last, fo.oprettet_kl desc
   limit 1;
  if v_fo is null then return jsonb_build_object('kode', 'ingen_forsendelse'); end if;
  v_str := coalesce(v_str, rf.pakkestoerrelse, (select a.pakkestoerrelse from public.auctions a where a.id = t.auction_id), 'mellem');
  if v_str not in ('lille', 'mellem', 'stor') then v_str := 'mellem'; end if;

  insert into public.ekstra_fragt_regninger (
    trade_id, forsendelse_id, saelger_id, betaling_id, transportoer, sporingsnummer,
    valgt_stoerrelse, beloeb_oere, forklaring, frist, oprettet_af, slags, sag_id)
  values (
    t.id, v_fo, t.seller_id, v_bet, left(v_trans, 20), left(v_spor, 100),
    v_str, v_beloeb,
    'Returfragt i sagen: varen blev skadet under fragten, og billederne viser, at den ikke var pakket forsvarligt. Køberen har sendt varen retur til dig.',
    now() + interval '14 days', public.bidhamr_system_id(), 'returfragt_sag', s.id)
  returning id into v_id;

  perform public.ekstra_fragt_log(public.bidhamr_system_id(), 'ekstra_fragt_oprettet', t.id, t.seller_id,
    'Returfragt i sag ' || s.id::text || ' opkræves hos sælgeren (dårlig indpakning): '
    || public.ekstra_fragt_kr(v_beloeb));
  return jsonb_build_object('kode', 'ok', 'id', v_id);
end;
$f$;
revoke all on function public.sag_returfragt_regning(uuid) from public, anon, authenticated;
grant execute on function public.sag_returfragt_regning(uuid) to service_role;

do $do$
begin
  raise notice 'sag_retur_afleveret: %', pg_temp.ps_ret(
    'public.sag_retur_afleveret(uuid,uuid,text)',
    '8440027ecc71d638bdbf5f8376dc6cb1',
    '46c9a06b83f8e8cd0dc87afcf94b93ca',
    jsonb_build_array(
      jsonb_build_array(
$g$  v_handling text;
begin$g$,
$n$  v_handling text;
  v_regning  jsonb;
begin$n$, 1),
      jsonb_build_array(
$g$  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_retur_afleveret',$g$,
$n$  -- 20261102210000: sælgeren betaler returfragten (dårlig indpakning) - en
  -- regning som ekstra fragt, nu hvor BidHamr har betalt fragtfirmaet.
  if s.returfragt_betaler = 'saelger' then
    v_regning := public.sag_returfragt_regning(s.id);
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'sag_retur_afleveret',$n$, 1),
      jsonb_build_array(
$g$    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal);$g$,
$n$    'auction_id', t.auction_id, 'type', s.type, 'version', s.genaabnet_antal,
    'returfragt_regning', v_regning);$n$, 1)));

  raise notice 'ekstra_fragt_lav_faktura: %', pg_temp.ps_ret(
    'public.ekstra_fragt_lav_faktura(uuid)',
    '66ff99e11ee26579e0951d84797ead02',
    'd75f657a4a9e67261256cad42a38b0f3',
    jsonb_build_array(
      jsonb_build_array(
$g$         x.stripe_charge_id, x.stripe_payment_intent_id, x.fragtfirma_fakturanummer$g$,
$n$         x.stripe_charge_id, x.stripe_payment_intent_id, x.fragtfirma_fakturanummer, x.slags$n$, 1),
      jsonb_build_array(
$g$    left('Ekstra fragt - pakken var større/tungere end den valgte størrelse (fragtfirmaets faktura ' || r.fragtfirma_fakturanummer || ')', 250),$g$,
$n$    -- 20261102210000: returfragt i en sag (sælgeren betaler - dårlig indpakning).
    case when r.slags = 'returfragt_sag'
         then 'Returfragt (retur i sag - varen var ikke pakket forsvarligt)'
         else left('Ekstra fragt - pakken var større/tungere end den valgte størrelse (fragtfirmaets faktura ' || r.fragtfirma_fakturanummer || ')', 250) end,$n$, 1)));
end $do$;

-- ===========================================================================
-- 13. Reklamation hos fragtfirmaet også ved bortkommet pakke (regel 6)
-- ===========================================================================
do $do$
begin
  raise notice 'fragt_reklamation_betingelser: %', pg_temp.ps_ret(
    'public.fragt_reklamation_betingelser(uuid)',
    '6a647069eb5996647c89212a6818bff3',
    '6d4df588c245e7479c89be4664e609a9',
    jsonb_build_array(
      jsonb_build_array(
$g$  if not found or s.type <> 'skadet' then aarsag := 'ikke_skadet'; return; end if;$g$,
$n$  -- 20261102210000: også bortkommet pakke (BidHamr får erstatningen via
  -- reklamationen - køberen har fået hele beløbet tilbage).
  if not found or s.type not in ('skadet', 'bortkommet') then aarsag := 'ikke_skadet'; return; end if;$n$, 1),
      jsonb_build_array(
$g$  if not exists (select 1 from public.indpakning_ordentlig o$g$,
$n$  -- Indpakningen vurderes kun ved skade (en bortkommet pakke har ingen).
  if s.type = 'skadet' and not exists (select 1 from public.indpakning_ordentlig o$n$, 1)));
end $do$;

-- ===========================================================================
-- 14. Kontrol efter migrationen
-- ===========================================================================
do $do$
begin
  perform pg_temp.kraev_efter('public.sag_opret(uuid,text,text,jsonb,boolean,text)', '28ded2d3ab96a1db4e5b8a8b29cdfc53');
  if to_regprocedure('public.sag_opret(uuid,text,text,jsonb)') is not null
     or to_regprocedure('public.sag_afgoer(uuid,uuid,text,text,text,boolean)') is not null
     or to_regprocedure('public.sag_anke_afgoer(uuid,uuid,text,text,text,boolean)') is not null then
    raise exception 'En gammel signatur findes stadig';
  end if;
  if exists (select 1 from public.trades where received_at is not null and problem_frist_kl is null) then
    raise exception 'trades.problem_frist_kl mangler på modtagne handler';
  end if;
end $do$;
