-- Automatiske fakturaer på BidHamrs egne ydelser i Dinero (ROADMAP fase 1).
-- Se docs/FAKTURA.md.
--
-- Ved hvert salg laver BidHamr (Bidhamr ApS, CVR 46836219):
--   * en faktura til KØBEREN på købergebyr + fragt + evt. BidHamr Beskyttelse
--   * en faktura til SÆLGEREN på sælgergebyret
-- Alle beløb er inkl. 25 % moms (Dinero udskiller momsen). Ingen faktura på
-- selve varen (privatsalg; faktura på varen ved firmasalg venter på revisor,
-- jura/noter-til-advokat.md nr. 95).
--
-- Tidspunkt (chefens valg - Filip kan ændre, se docs/FAKTURA.md afsnit 2):
-- fakturaen dateres og bogføres på BETALINGSDAGEN (når BidHamrs gebyr er
-- trukket hos Stripe og spejlet, stripe_application_fee_id), og en refusion
-- giver en kreditnota for det, BidHamr faktisk har givet tilbage
-- (refusion_gebyr_oere). Momsen forfalder ved forudbetaling, når betalingen
-- modtages (momsloven § 23, stk. 3) - en faktura først ved frigivelse kunne
-- lande i en senere momsperiode.
--
-- Erhvervsabonnementet (Stripe Billing) har allerede en faktura fra Stripe.
-- Den bogføres som et finansbilag i Dinero (kassekladde med Stripe-fakturaen
-- som bilag) - IKKE som en ny faktura til firmaet, så firmaet aldrig får to
-- fakturaer med moms for samme ydelse (chefens valg, docs/FAKTURA.md 5).
--
-- Kø: fakturaer er både spejl og kø. faktura_planlaeg() opretter rækkerne ud
-- fra betalinger/firma_regninger (idempotent - unikke indeks), betalings-
-- cron'en (src/lib/faktura/koe.ts) behandler dem med lås, spredte forsøg
-- (5, 10, 20, 40 min) og "opgivet" + drift-alarm efter 5 fejl. Dinero-
-- dokumentets guid = fakturaer.id, så et genforsøg aldrig laver en dublet
-- (Dinero svarer 409 på samme guid).
--
-- Fakturaer og kreditnotaer slettes aldrig (bogføringsloven).
--
-- Idempotent: kan køres flere gange.

-- ============================================================ 1. tabeller

create table if not exists public.faktura_kontakter (
  bruger_id             uuid not null references public.users(id) on delete restrict,
  -- Dinero-organisationen (testmiljø og live har hver sine kontakter).
  dinero_org            text not null check (dinero_org ~ '^[0-9]{1,12}$'),
  dinero_guid           uuid not null unique default gen_random_uuid(),
  er_firma              boolean not null default false,
  -- Sat, når kontakten findes i Dinero (oprettet eller fundet ved genforsøg).
  oprettet_i_dinero_kl  timestamptz,
  -- Hash af de oplysninger, kontakten sidst blev sendt med (navn, e-mail,
  -- CVR, adresse). Ændres de, opdateres kontakten før næste faktura.
  kontakt_hash          text,
  oprettet_kl           timestamptz not null default now(),
  opdateret_kl          timestamptz not null default now(),
  primary key (bruger_id, dinero_org)
);

comment on table public.faktura_kontakter is
  'Én Dinero-kontakt pr. bruger og Dinero-organisation (oprettes første gang og genbruges). Kun service role. Slettes aldrig.';

create table if not exists public.fakturaer (
  -- = Dinero-dokumentets guid (faktura/kreditnota) eller kassekladde-id
  -- (abonnement). Sat af databasen FØR Dinero kaldes, så et genforsøg
  -- aldrig laver en dublet.
  id                   uuid primary key default gen_random_uuid(),
  dokument             text not null check (dokument in ('faktura', 'kreditnota', 'abonnement', 'abonnement_retur')),
  part                 text not null check (part in ('koeber', 'saelger', 'firma')),
  bruger_id            uuid not null references public.users(id) on delete restrict,
  betaling_id          uuid references public.betalinger(id) on delete restrict,
  trade_id             uuid references public.trades(id) on delete restrict,
  firma_regning_id     uuid references public.firma_regninger(id) on delete restrict,
  -- Kreditnota/abonnement_retur: det dokument, der krediteres.
  krediterer_id        uuid references public.fakturaer(id) on delete restrict,
  -- Låste linjer: [{kode, tekst, beloeb_oere}] - beløb i øre INKL. moms.
  -- kode: koebergebyr | fragt | beskyttelse | saelgergebyr | abonnement.
  linjer               jsonb not null check (jsonb_typeof(linjer) = 'array'),
  beloeb_oere          bigint not null check (beloeb_oere >= 0),
  -- Beregnet moms (sum pr. linje: beløb - round(beløb * 4/5)). Dineros egen
  -- moms gemmes i dinero_moms_oere efter bogføring.
  moms_oere            bigint not null check (moms_oere >= 0),
  -- Betalingens/refusionens dag (dansk tid) = fakturadato og betalingsdato.
  betalt_dato          date not null,
  -- Stripe-id, betalingen registreres med i Dinero (ch_/pi_/re_/in_).
  stripe_reference     text,
  status               text not null default 'venter' check (status in (
                         'venter',             -- ikke sendt til Dinero
                         'kladde',             -- kassekladde sendt til bogføring (abonnement)
                         'bogfoert',           -- bogført i Dinero, betaling ikke registreret
                         'faerdig',            -- bogført + betaling registreret
                         'kraever_handling',   -- stoppet: staff skal se på den
                         'haandteret_manuelt'  -- staff har klaret den i Dinero
                       )),
  -- true = oprettet med et problem, der ikke kan løses ved at prøve igen
  -- (fx gebyret passer ikke). Kan kun markeres som håndteret manuelt.
  manuel               boolean not null default false,
  dinero_org           text check (dinero_org is null or dinero_org ~ '^[0-9]{1,12}$'),
  dinero_kontakt_guid  uuid,
  dinero_nummer        bigint,
  dinero_moms_oere     bigint,
  dinero_fil_guid      text,
  pdf_sti              text,
  forsoeg              integer not null default 0,
  naeste_forsoeg_kl    timestamptz,
  opgivet              boolean not null default false,
  sidste_fejl          text,
  laas_til             timestamptz,
  laas_noegle          uuid,
  alarm_kl             timestamptz,
  haandteret_af        uuid references public.users(id),
  haandteret_kl        timestamptz,
  haandteret_note      text check (haandteret_note is null or char_length(haandteret_note) <= 1000),
  oprettet_kl          timestamptz not null default now(),
  opdateret_kl         timestamptz not null default now(),
  faerdig_kl           timestamptz,
  constraint fakturaer_beloeb_positivt check (beloeb_oere > 0 or status in ('kraever_handling', 'haandteret_manuelt')),
  constraint fakturaer_kilde check (
    (dokument in ('faktura', 'kreditnota') and betaling_id is not null and firma_regning_id is null and part in ('koeber', 'saelger'))
    or (dokument in ('abonnement', 'abonnement_retur') and firma_regning_id is not null and betaling_id is null and part = 'firma')),
  constraint fakturaer_kredit_har_moder check (
    (dokument in ('kreditnota', 'abonnement_retur')) = (krediterer_id is not null))
);

create unique index if not exists fakturaer_handel_part
  on public.fakturaer (betaling_id, part, dokument) where betaling_id is not null;
create unique index if not exists fakturaer_regning
  on public.fakturaer (firma_regning_id, dokument) where firma_regning_id is not null;
create unique index if not exists fakturaer_kredit
  on public.fakturaer (krediterer_id) where krediterer_id is not null;
create index if not exists fakturaer_bruger_idx on public.fakturaer (bruger_id, oprettet_kl desc);
create index if not exists fakturaer_trade_idx on public.fakturaer (trade_id) where trade_id is not null;
create index if not exists fakturaer_koe_idx
  on public.fakturaer (oprettet_kl) where status in ('venter', 'kladde', 'bogfoert') and not opgivet;

comment on table public.fakturaer is
  'BidHamrs fakturaer/kreditnotaer i Dinero (gebyrer, fragt, BidHamr Beskyttelse) og bogførte abonnementsfakturaer. Spejl + kø (faktura_planlaeg / faktura_claim). Brugeren ser egne fakturaer og kreditnotaer. Slettes aldrig (bogføringsloven).';

-- Ingen sletning - heller ikke af service role ved en fejl.
create or replace function public.fakturaer_ingen_sletning()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'Fakturaer slettes aldrig (bogføringsloven)';
end
$fn$;

drop trigger if exists fakturaer_ingen_sletning on public.fakturaer;
create trigger fakturaer_ingen_sletning before delete on public.fakturaer
  for each row execute function public.fakturaer_ingen_sletning();
drop trigger if exists faktura_kontakter_ingen_sletning on public.faktura_kontakter;
create trigger faktura_kontakter_ingen_sletning before delete on public.faktura_kontakter
  for each row execute function public.fakturaer_ingen_sletning();

-- Låste felter: linjer, beløb, part, modtager og kilde kan aldrig ændres,
-- når rækken er oprettet (de er grundlaget for Dinero-dokumentet).
create or replace function public.fakturaer_laaste_felter()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.id <> old.id or new.dokument <> old.dokument or new.part <> old.part
     or new.bruger_id <> old.bruger_id
     or new.betaling_id is distinct from old.betaling_id
     or new.trade_id is distinct from old.trade_id
     or new.firma_regning_id is distinct from old.firma_regning_id
     or new.krediterer_id is distinct from old.krediterer_id
     or new.linjer <> old.linjer or new.beloeb_oere <> old.beloeb_oere
     or new.moms_oere <> old.moms_oere or new.betalt_dato <> old.betalt_dato
     or new.stripe_reference is distinct from old.stripe_reference
     or new.manuel <> old.manuel then
    raise exception 'Fakturaens indhold kan ikke ændres, når den er oprettet';
  end if;
  if old.dinero_org is not null and new.dinero_org is distinct from old.dinero_org then
    raise exception 'Fakturaens Dinero-organisation kan ikke ændres';
  end if;
  if old.status in ('faerdig', 'haandteret_manuelt') and new.status <> old.status then
    raise exception 'En færdig faktura kan ikke ændre status';
  end if;
  new.opdateret_kl := now();
  return new;
end
$fn$;

drop trigger if exists fakturaer_laaste_felter on public.fakturaer;
create trigger fakturaer_laaste_felter before update on public.fakturaer
  for each row execute function public.fakturaer_laaste_felter();

-- RLS: brugeren ser kun egne fakturaer og kreditnotaer (ikke abonnements-
-- bilag - firmaet har Stripes faktura) og kun de viste kolonner. Ingen
-- skrivning fra klienten. Kontakter: kun service role.
alter table public.fakturaer enable row level security;
alter table public.faktura_kontakter enable row level security;

drop policy if exists fakturaer_select_egen on public.fakturaer;
create policy fakturaer_select_egen on public.fakturaer
  for select to authenticated
  using (bruger_id = (select auth.uid()) and dokument in ('faktura', 'kreditnota'));

revoke all on public.fakturaer, public.faktura_kontakter from public, anon, authenticated;
grant select (id, dokument, part, bruger_id, trade_id, krediterer_id, linjer, beloeb_oere, moms_oere,
              dinero_moms_oere, dinero_nummer, betalt_dato, status, oprettet_kl, faerdig_kl)
  on public.fakturaer to authenticated;
grant all on public.fakturaer, public.faktura_kontakter to service_role;

-- PDF'er gemmes privat (kun service role) - serveren tjekker ejerskab og
-- sender filen (src/app/api/faktura/[id]/route.ts).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fakturaer', 'fakturaer', false, 6291456, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================ 2. hjælpere

create or replace function public.faktura_linje(p_kode text, p_tekst text, p_beloeb bigint)
returns jsonb language sql immutable set search_path = '' as $fn$
  select case when p_beloeb is null or p_beloeb <= 0 then null
              else jsonb_build_object('kode', p_kode, 'tekst', p_tekst, 'beloeb_oere', p_beloeb) end
$fn$;

-- Moms af beløb inkl. 25 % moms, pr. linje (som Dinero: netto = round(beløb
-- * 4/5), moms = beløb - netto). 4/5 af et helt antal øre ender aldrig på
-- ,5 - så afrundingen er entydig.
create or replace function public.faktura_moms(p_linjer jsonb)
returns bigint language sql immutable set search_path = '' as $fn$
  select coalesce(sum((l->>'beloeb_oere')::bigint - round((l->>'beloeb_oere')::numeric * 4 / 5)::bigint), 0)::bigint
  from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l
$fn$;

create or replace function public.faktura_sum(p_linjer jsonb)
returns bigint language sql immutable set search_path = '' as $fn$
  select coalesce(sum((l->>'beloeb_oere')::bigint), 0)::bigint
  from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l
$fn$;

-- ============================================================ 3. planlægning

-- Opretter de fakturaer, kreditnotaer og abonnementsbilag, der mangler.
-- Idempotent (unikke indeks + "not exists"). Kaldes af betalings-cron'en før
-- køen behandles. Returnerer antal nye rækker pr. slags.
create or replace function public.faktura_planlaeg(p_graense integer default 200)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_graense  integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura  integer := 0;
  v_kredit   integer := 0;
  v_abon     integer := 0;
  v_retur    integer := 0;
  n          integer;
  rb         record;
  rf         record;
  rr         record;
  v_linjer   jsonb;
  v_status   text;
  v_manuel   boolean;
  v_fejl     text;
  v_dato     date;
  v_tekst    text;
begin
  -- 1) Fakturaer: betalte destination-betalinger, hvor BidHamrs gebyr er
  --    trukket og spejlet fra Stripe.
  for rb in
    select x.*
      from public.betalinger x
     where x.pengemodel = 'destination'
       and x.betalt_kl is not null
       and x.application_fee_oere is not null
       and x.stripe_application_fee_id is not null
       and ((x.koebergebyr_oere + x.fragt_oere + x.beskyttelse_oere > 0
             and not exists (select 1 from public.fakturaer f
                              where f.betaling_id = x.id and f.part = 'koeber' and f.dokument = 'faktura'))
         or (x.saelgergebyr_oere > 0
             and not exists (select 1 from public.fakturaer f
                              where f.betaling_id = x.id and f.part = 'saelger' and f.dokument = 'faktura')))
     order by x.betalt_kl
     limit v_graense
  loop
    v_dato := (rb.betalt_kl at time zone 'Europe/Copenhagen')::date;
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rb.application_fee_oere <> rb.koebergebyr_oere + rb.saelgergebyr_oere + rb.fragt_oere + rb.beskyttelse_oere then
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'BidHamrs gebyr hos Stripe passer ikke med handlens købergebyr, sælgergebyr, fragt og BidHamr Beskyttelse - lav fakturaen manuelt i Dinero.';
    end if;

    -- Køberen: købergebyr + fragt + BidHamr Beskyttelse.
    select coalesce(jsonb_agg(v.l order by v.o), '[]'::jsonb) into v_linjer
      from (values (1, public.faktura_linje('koebergebyr', 'Købergebyr (5 %)', rb.koebergebyr_oere)),
                   (2, public.faktura_linje('fragt', 'Fragt', rb.fragt_oere)),
                   (3, public.faktura_linje('beskyttelse', 'BidHamr Beskyttelse', rb.beskyttelse_oere))) v(o, l)
     where v.l is not null;
    if jsonb_array_length(v_linjer) > 0 then
      insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                    moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl)
      values ('faktura', 'koeber', rb.buyer_id, rb.id, rb.trade_id, v_linjer, public.faktura_sum(v_linjer),
              public.faktura_moms(v_linjer), v_dato, coalesce(rb.stripe_charge_id, rb.stripe_payment_intent_id),
              v_status, v_manuel, v_fejl)
      on conflict (betaling_id, part, dokument) where betaling_id is not null do nothing;
      get diagnostics n = row_count;
      v_faktura := v_faktura + n;
    end if;

    -- Sælgeren: sælgergebyret.
    if rb.saelgergebyr_oere > 0 then
      v_linjer := jsonb_build_array(public.faktura_linje('saelgergebyr', 'Sælgergebyr (5 %)', rb.saelgergebyr_oere));
      insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                    moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl)
      values ('faktura', 'saelger', rb.seller_id, rb.id, rb.trade_id, v_linjer, public.faktura_sum(v_linjer),
              public.faktura_moms(v_linjer), v_dato, coalesce(rb.stripe_charge_id, rb.stripe_payment_intent_id),
              v_status, v_manuel, v_fejl)
      on conflict (betaling_id, part, dokument) where betaling_id is not null do nothing;
      get diagnostics n = row_count;
      v_faktura := v_faktura + n;
    end if;
  end loop;

  -- 2) Kreditnotaer: betalingen er refunderet. Krediteret = det, BidHamr
  --    faktisk har givet tilbage af sit gebyr (refusion_gebyr_oere, trin 4):
  --      hele gebyret              -> alle linjer (køber og sælger)
  --      gebyret - Beskyttelse     -> alt undtagen BidHamr Beskyttelse
  --                                   (sag med medhold - BidHamr beholder den)
  --      andet / ikke registreret  -> kræver handling (laves manuelt)
  for rf in
    select fa.id, fa.part, fa.bruger_id, fa.betaling_id, fa.trade_id, fa.linjer,
           x.refunderet_kl, x.gebyr_refunderet_kl, x.refusion_gebyr_oere, x.application_fee_oere,
           x.beskyttelse_oere, x.stripe_refund_id
      from public.fakturaer fa
      join public.betalinger x on x.id = fa.betaling_id
     where fa.dokument = 'faktura'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k where k.krediterer_id = fa.id)
     order by x.refunderet_kl
     limit v_graense
  loop
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rf.gebyr_refunderet_kl is null or rf.refusion_gebyr_oere is null then
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Betalingen er refunderet, men BidHamrs gebyr-refusion er ikke registreret - kontrollér refusionen hos Stripe og lav kreditnotaen manuelt i Dinero.';
    elsif rf.refusion_gebyr_oere = rf.application_fee_oere then
      v_linjer := rf.linjer;
    elsif rf.beskyttelse_oere > 0 and rf.refusion_gebyr_oere = rf.application_fee_oere - rf.beskyttelse_oere then
      select coalesce(jsonb_agg(l), '[]'::jsonb) into v_linjer
        from jsonb_array_elements(rf.linjer) l
       where l->>'kode' <> 'beskyttelse';
    else
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Den refunderede del af BidHamrs gebyr passer ikke med en fuld refusion eller en refusion uden BidHamr Beskyttelse - lav kreditnotaen manuelt i Dinero.';
    end if;
    if jsonb_array_length(v_linjer) = 0 then
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Intet at kreditere på fakturaen - kontrollér refusionen.';
    end if;

    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('kreditnota', rf.part, rf.bruger_id, rf.betaling_id, rf.trade_id, rf.id, v_linjer,
            public.faktura_sum(v_linjer), public.faktura_moms(v_linjer),
            (rf.refunderet_kl at time zone 'Europe/Copenhagen')::date, rf.stripe_refund_id,
            v_status, v_manuel, v_fejl)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  -- 3) Erhvervsabonnement: betalte Stripe-fakturaer bogføres som finansbilag.
  for rr in
    select rg.*, fm.bruger_id
      from public.firma_regninger rg
      join public.firmaer fm on fm.id = rg.firma_id
     where rg.betalt_kl is not null
       and rg.status in ('betalt', 'krediteret')
       and rg.beloeb_oere > 0
       and not exists (select 1 from public.fakturaer f
                        where f.firma_regning_id = rg.id and f.dokument = 'abonnement')
     order by rg.betalt_kl
     limit v_graense
  loop
    v_tekst := case rr.type when 'opgradering' then 'Opgradering af erhvervsabonnement'
                           when 'andet' then 'BidHamr erhverv'
                           else 'Erhvervsabonnement' end
               || coalesce(' - Stripe-faktura ' || rr.nummer, '');
    v_linjer := jsonb_build_array(jsonb_build_object('kode', 'abonnement', 'tekst', left(v_tekst, 200),
                                                     'beloeb_oere', rr.beloeb_oere));
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rr.moms_oere is not null and rr.moms_oere <> public.faktura_moms(v_linjer) then
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Momsen på Stripe-fakturaen er ikke 25 % af beløbet - bogfør den manuelt i Dinero.';
    end if;
    insert into public.fakturaer (dokument, part, bruger_id, firma_regning_id, linjer, beloeb_oere, moms_oere,
                                  betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('abonnement', 'firma', rr.bruger_id, rr.id, v_linjer, rr.beloeb_oere,
            coalesce(rr.moms_oere, public.faktura_moms(v_linjer)),
            (rr.betalt_kl at time zone 'Europe/Copenhagen')::date, rr.stripe_invoice_id,
            v_status, v_manuel, v_fejl)
    on conflict (firma_regning_id, dokument) where firma_regning_id is not null do nothing;
    get diagnostics n = row_count;
    v_abon := v_abon + n;
  end loop;

  -- 3b) Refunderet abonnementsfaktura (krediteret efter betaling): modpostering.
  for rf in
    select fa.id, fa.bruger_id, fa.firma_regning_id, fa.linjer, fa.beloeb_oere, fa.moms_oere, fa.stripe_reference
      from public.fakturaer fa
      join public.firma_regninger rg on rg.id = fa.firma_regning_id
     where fa.dokument = 'abonnement'
       and rg.status = 'krediteret'
       and not exists (select 1 from public.fakturaer k where k.krediterer_id = fa.id)
     limit v_graense
  loop
    insert into public.fakturaer (dokument, part, bruger_id, firma_regning_id, krediterer_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status)
    values ('abonnement_retur', 'firma', rf.bruger_id, rf.firma_regning_id, rf.id, rf.linjer, rf.beloeb_oere,
            rf.moms_oere, (now() at time zone 'Europe/Copenhagen')::date, rf.stripe_reference, 'venter')
    on conflict do nothing;
    get diagnostics n = row_count;
    v_retur := v_retur + n;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit,
                            'abonnement', v_abon, 'abonnement_retur', v_retur);
end
$fn$;

-- ============================================================ 4. kø

-- Claimer op til p_antal dokumenter, der skal behandles (lås 10 min).
-- En kreditnota venter, til den faktura, den krediterer, er færdig.
create or replace function public.faktura_claim(p_antal integer default 8)
returns setof public.fakturaer
language plpgsql security definer set search_path = '' as $fn$
begin
  return query
  with valgt as (
    select f.id
      from public.fakturaer f
     where f.status in ('venter', 'kladde', 'bogfoert')
       and not f.opgivet
       and not f.manuel
       and (f.naeste_forsoeg_kl is null or f.naeste_forsoeg_kl <= now())
       and (f.laas_til is null or f.laas_til < now())
       and (f.krediterer_id is null
            or exists (select 1 from public.fakturaer p where p.id = f.krediterer_id and p.status = 'faerdig'))
     order by f.oprettet_kl, f.id
     limit least(greatest(coalesce(p_antal, 8), 1), 50)
       for update of f skip locked
  )
  update public.fakturaer f
     set laas_til = now() + interval '10 minutes',
         laas_noegle = gen_random_uuid()
    from valgt
   where f.id = valgt.id
  returning f.*;
end
$fn$;

-- Registrerer fremskridt under låsen. Status kan kun gå frem
-- (venter -> kladde -> bogfoert -> faerdig) eller til kraever_handling.
-- null = uændret. p_frigiv: slip låsen (fx venter på Dineros bogføring eller
-- kaldegrænse) uden at bruge et forsøg. Returnerer false, hvis låsen er tabt
-- eller organisationen ikke passer.
create or replace function public.faktura_registrer(
  p_id          uuid,
  p_noegle      uuid,
  p_status      text default null,
  p_dinero_org  text default null,
  p_kontakt     uuid default null,
  p_nummer      bigint default null,
  p_moms        bigint default null,
  p_pdf_sti     text default null,
  p_fil         text default null,
  p_fejl        text default null,
  p_frigiv      boolean default false)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare
  f public.fakturaer%rowtype;
  v_ny  integer;
  v_gl  integer;
begin
  select * into f from public.fakturaer where id = p_id for update;
  if not found or f.laas_noegle is distinct from p_noegle or f.laas_til is null or f.laas_til < now() then
    return false;
  end if;
  if p_dinero_org is not null and f.dinero_org is not null and f.dinero_org <> p_dinero_org then
    return false;
  end if;
  if p_status is not null and p_status <> f.status then
    v_gl := case f.status when 'venter' then 0 when 'kladde' then 1 when 'bogfoert' then 2 else 9 end;
    v_ny := case p_status when 'kladde' then 1 when 'bogfoert' then 2 when 'faerdig' then 3
                          when 'kraever_handling' then 8 else -1 end;
    if v_ny < 0 or v_gl = 9 or (v_ny < 8 and v_ny <= v_gl) then
      return false;
    end if;
  end if;

  update public.fakturaer
     set status = coalesce(p_status, status),
         dinero_org = coalesce(dinero_org, p_dinero_org),
         dinero_kontakt_guid = coalesce(p_kontakt, dinero_kontakt_guid),
         dinero_nummer = coalesce(p_nummer, dinero_nummer),
         dinero_moms_oere = coalesce(p_moms, dinero_moms_oere),
         pdf_sti = coalesce(p_pdf_sti, pdf_sti),
         dinero_fil_guid = coalesce(p_fil, dinero_fil_guid),
         forsoeg = case when p_status is not null and p_status <> status and p_status <> 'kraever_handling'
                        then 0 else forsoeg end,
         sidste_fejl = case when p_status = 'kraever_handling' then left(p_fejl, 1000)
                            when p_status is not null then null else sidste_fejl end,
         faerdig_kl = case when p_status = 'faerdig' then now() else faerdig_kl end,
         laas_til = case when p_frigiv or p_status in ('faerdig', 'kraever_handling') then null else laas_til end,
         laas_noegle = case when p_frigiv or p_status in ('faerdig', 'kraever_handling') then null else laas_noegle end
   where id = p_id;
  return true;
end
$fn$;

-- PDF gemt efter behandling (også uden lås - fx når siden henter den første
-- gang). Kun stien sættes, og kun på en færdig faktura/kreditnota.
create or replace function public.faktura_gem_pdf(p_id uuid, p_sti text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare n integer;
begin
  if p_sti is null or p_sti !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$' then return false; end if;
  update public.fakturaer set pdf_sti = p_sti
   where id = p_id and status = 'faerdig' and dokument in ('faktura', 'kreditnota') and pdf_sti is null;
  get diagnostics n = row_count;
  return n > 0;
end
$fn$;

-- Et forsøg fejlede. p_taeller = false (fx Dineros grænse på 60 kald i
-- minuttet): prøv igen om 2 min uden at bruge et forsøg. Ellers spredte
-- forsøg 5, 10, 20, 40 min (højst 6 t) - efter 5 fejl: opgivet (drift-alarm
-- fra serveren, staff kan "Prøv igen"). p_permanent: kræver handling.
create or replace function public.faktura_fejl(
  p_id         uuid,
  p_noegle     uuid,
  p_fejl       text,
  p_permanent  boolean default false,
  p_taeller    boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  f public.fakturaer%rowtype;
begin
  update public.fakturaer
     set forsoeg = forsoeg + case when p_taeller then 1 else 0 end,
         naeste_forsoeg_kl = now() + case
           when not p_taeller then interval '2 minutes'
           else least(interval '5 minutes' * power(2, least(forsoeg, 10))::integer, interval '6 hours') end,
         opgivet = opgivet or (p_taeller and forsoeg + 1 >= 5),
         status = case when p_permanent and status not in ('faerdig', 'haandteret_manuelt')
                       then 'kraever_handling' else status end,
         sidste_fejl = left(coalesce(p_fejl, 'Ukendt fejl'), 1000),
         laas_til = null,
         laas_noegle = null
   where id = p_id and laas_noegle = p_noegle
  returning * into f;
  if not found then
    return jsonb_build_object('kode', 'ikke_laast');
  end if;
  return jsonb_build_object('kode', 'ok', 'forsoeg', f.forsoeg, 'opgivet', f.opgivet, 'status', f.status);
end
$fn$;

-- Drift-alarmen for et opgivet/stoppet dokument gives højst én gang.
create or replace function public.faktura_alarm_claim(p_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare n integer;
begin
  update public.fakturaer set alarm_kl = now()
   where id = p_id and alarm_kl is null and (opgivet or status = 'kraever_handling');
  get diagnostics n = row_count;
  return n > 0;
end
$fn$;

-- ============================================================ 5. kontakter

-- Finder eller reserverer brugerens Dinero-kontakt (guid sat FØR Dinero
-- kaldes, så et genforsøg aldrig laver en ny kontakt).
create or replace function public.faktura_kontakt_reserver(p_bruger uuid, p_dinero_org text, p_er_firma boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  k public.faktura_kontakter%rowtype;
begin
  if p_bruger is null or p_dinero_org is null or p_dinero_org !~ '^[0-9]{1,12}$' then
    raise exception 'faktura_kontakt_reserver: ugyldige parametre';
  end if;
  insert into public.faktura_kontakter (bruger_id, dinero_org, er_firma)
  values (p_bruger, p_dinero_org, coalesce(p_er_firma, false))
  on conflict (bruger_id, dinero_org) do nothing;
  select * into k from public.faktura_kontakter where bruger_id = p_bruger and dinero_org = p_dinero_org;
  return jsonb_build_object('guid', k.dinero_guid, 'oprettet', k.oprettet_i_dinero_kl is not null,
                            'hash', k.kontakt_hash, 'er_firma', k.er_firma);
end
$fn$;

create or replace function public.faktura_kontakt_gemt(p_bruger uuid, p_dinero_org text, p_hash text)
returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.faktura_kontakter
     set oprettet_i_dinero_kl = coalesce(oprettet_i_dinero_kl, now()),
         kontakt_hash = p_hash,
         opdateret_kl = now()
   where bruger_id = p_bruger and dinero_org = p_dinero_org;
end
$fn$;

-- ============================================================ 6. staff (chef)

-- "Prøv igen": et opgivet dokument eller et, der er stoppet under
-- behandlingen (ikke ved oprettelsen - manuel). Kun chef.
create or replace function public.faktura_proev_igen(p_medarbejder uuid, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_rolle text;
  f public.fakturaer%rowtype;
begin
  select u.rolle into v_rolle from public.users u where u.id = p_medarbejder;
  if v_rolle is distinct from 'chef' then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select * into f from public.fakturaer where id = p_id for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if f.manuel then return jsonb_build_object('kode', 'manuel'); end if;
  if f.status in ('faerdig', 'haandteret_manuelt') then return jsonb_build_object('kode', 'faerdig'); end if;
  if not f.opgivet and f.status <> 'kraever_handling' then return jsonb_build_object('kode', 'koerer'); end if;

  update public.fakturaer
     set opgivet = false,
         forsoeg = 0,
         naeste_forsoeg_kl = null,
         alarm_kl = null,
         -- Stoppet under behandlingen: start forfra fra det sted, Dinero er
         -- nået til (serveren tjekker Dineros tilstand før hvert trin).
         status = case when status = 'kraever_handling'
                       then case when dinero_nummer is not null and dokument in ('faktura', 'kreditnota')
                                 then 'bogfoert' else 'venter' end
                       else status end,
         laas_til = null,
         laas_noegle = null
   where id = p_id;
  return jsonb_build_object('kode', 'ok');
end
$fn$;

-- "Markér som håndteret i Dinero": staff har lavet/rettet dokumentet selv.
create or replace function public.faktura_haandteret_manuelt(p_medarbejder uuid, p_id uuid, p_note text)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_rolle text;
  f public.fakturaer%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select u.rolle into v_rolle from public.users u where u.id = p_medarbejder;
  if v_rolle is distinct from 'chef' then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is null then return jsonb_build_object('kode', 'note_mangler'); end if;
  select * into f from public.fakturaer where id = p_id for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if f.status in ('faerdig', 'haandteret_manuelt') then return jsonb_build_object('kode', 'faerdig'); end if;
  if f.laas_til is not null and f.laas_til > now() then return jsonb_build_object('kode', 'koerer'); end if;
  if not f.opgivet and f.status <> 'kraever_handling' then return jsonb_build_object('kode', 'koerer'); end if;

  update public.fakturaer
     set status = 'haandteret_manuelt',
         haandteret_af = p_medarbejder,
         haandteret_kl = now(),
         haandteret_note = left(v_note, 1000),
         laas_til = null,
         laas_noegle = null
   where id = p_id;
  return jsonb_build_object('kode', 'ok');
end
$fn$;

-- ============================================================ 7. brugeren

-- Brugerens egne fakturaer og kreditnotaer (nyeste først). p_trade: kun
-- for én handel. Kun dokumenter, der er færdige i Dinero, har en PDF;
-- undervejs vises de som "Fakturaen er på vej". Udleder brugeren af
-- auth.uid() - man kan aldrig se andres.
create or replace function public.mine_fakturaer(p_trade uuid default null)
returns jsonb
language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(x.j order by x.dato desc, x.oprettet_kl desc), '[]'::jsonb)
    from (
      select f.betalt_dato as dato, f.oprettet_kl,
             jsonb_build_object(
               'id', f.id,
               'dokument', f.dokument,
               'part', f.part,
               'trade_id', f.trade_id,
               'titel', a.titel,
               'nummer', case when f.status = 'faerdig' then f.dinero_nummer end,
               'dato', f.betalt_dato,
               'beloeb_oere', f.beloeb_oere,
               'moms_oere', coalesce(f.dinero_moms_oere, f.moms_oere),
               'linjer', (select coalesce(jsonb_agg(jsonb_build_object('tekst', l->>'tekst',
                                                                        'beloeb_oere', (l->>'beloeb_oere')::bigint)), '[]'::jsonb)
                            from jsonb_array_elements(f.linjer) l),
               'klar', f.status = 'faerdig',
               'krediterer_nummer', (select p.dinero_nummer from public.fakturaer p where p.id = f.krediterer_id)
             ) as j
        from public.fakturaer f
        left join public.trades t on t.id = f.trade_id
        left join public.auctions a on a.id = t.auction_id
       where f.bruger_id = auth.uid()
         and f.dokument in ('faktura', 'kreditnota')
         and f.status not in ('kraever_handling', 'haandteret_manuelt')
         and (p_trade is null or f.trade_id = p_trade)
       order by f.betalt_dato desc, f.oprettet_kl desc
       limit 500
    ) x
$fn$;

-- ============================================================ 8. rettigheder

revoke all on function public.fakturaer_ingen_sletning() from public, anon, authenticated;
revoke all on function public.fakturaer_laaste_felter() from public, anon, authenticated;
revoke all on function public.faktura_linje(text, text, bigint) from public, anon, authenticated;
revoke all on function public.faktura_moms(jsonb) from public, anon, authenticated;
revoke all on function public.faktura_sum(jsonb) from public, anon, authenticated;
revoke all on function public.faktura_planlaeg(integer) from public, anon, authenticated;
revoke all on function public.faktura_claim(integer) from public, anon, authenticated;
revoke all on function public.faktura_registrer(uuid, uuid, text, text, uuid, bigint, bigint, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.faktura_gem_pdf(uuid, text) from public, anon, authenticated;
revoke all on function public.faktura_fejl(uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.faktura_alarm_claim(uuid) from public, anon, authenticated;
revoke all on function public.faktura_kontakt_reserver(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.faktura_kontakt_gemt(uuid, text, text) from public, anon, authenticated;
revoke all on function public.faktura_proev_igen(uuid, uuid) from public, anon, authenticated;
revoke all on function public.faktura_haandteret_manuelt(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.mine_fakturaer(uuid) from public, anon, authenticated;

grant execute on function public.faktura_linje(text, text, bigint) to service_role;
grant execute on function public.faktura_moms(jsonb) to service_role;
grant execute on function public.faktura_sum(jsonb) to service_role;
grant execute on function public.faktura_planlaeg(integer) to service_role;
grant execute on function public.faktura_claim(integer) to service_role;
grant execute on function public.faktura_registrer(uuid, uuid, text, text, uuid, bigint, bigint, text, text, text, boolean) to service_role;
grant execute on function public.faktura_gem_pdf(uuid, text) to service_role;
grant execute on function public.faktura_fejl(uuid, uuid, text, boolean, boolean) to service_role;
grant execute on function public.faktura_alarm_claim(uuid) to service_role;
grant execute on function public.faktura_kontakt_reserver(uuid, text, boolean) to service_role;
grant execute on function public.faktura_kontakt_gemt(uuid, text, text) to service_role;
grant execute on function public.faktura_proev_igen(uuid, uuid) to service_role;
grant execute on function public.faktura_haandteret_manuelt(uuid, uuid, text) to service_role;
grant execute on function public.mine_fakturaer(uuid) to authenticated, service_role;
