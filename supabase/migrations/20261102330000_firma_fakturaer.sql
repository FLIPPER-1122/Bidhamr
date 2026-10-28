-- Fakturakladde fra firma til køber (Filip, 27. okt. 2026 -
-- ROADMAP-BESLUTNINGER "Faktura fra firma til køber - klar til afsendelse").
-- Erstatter "firmaet sender selv fakturaen fra sit eget regnskabsprogram".
-- Det er FIRMAET, der udsteder og sender fakturaen. BidHamr er kun værktøjet.
--
-- INTET SENDES AUTOMATISK. Status 'sendt' kan kun sættes af
-- firma_faktura_send(), som kræver en indlogget bruger (auth.uid()), der er
-- firmakontoen selv. Service role, cron og triggere har intet auth.uid() og
-- kan derfor ikke sende. Triggeren firma_fakturaer_laas afviser alle andre
-- veje til 'sendt'.
--
-- Indhold:
--   1. firma_faktura_indstillinger - præfiks, startnummer/næste nummer, antal
--      cifre, standard-momsordning ('moms' | 'brugtmoms'), betalingstekst
--      ("Betalt via BidHamr"), svar-e-mail og "vis logo" (firmaets
--      profilbillede, users.avatar_url). Præfiks, startnummer og cifre kan kun
--      ændres, før den første faktura er sendt (ellers huller/dubletter i
--      serien). Holdes i takt med firmaer.bruger_brugtmoms (begge veje).
--   2. auctions.momsordning - valgfri pr. erhvervsauktion (null = firmaets
--      standard). Sættes med firma_saet_auktion_momsordning ved oprettelse og
--      redigering. Kan ikke ændres efter salg (trigger, BHM01). Nulstilles på
--      private auktioner.
--   3. firma_fakturaer - én faktura pr. betalt firmahandel + kreditnotaer.
--      Status 'kladde' | 'sendt'. Nummeret tildeles først ved afsendelse,
--      fortløbende pr. firma uden huller (rækkelås på indstillingerne i samme
--      transaktion som statusskiftet + unikt indeks). Øjebliksbillede (data)
--      af alle felter ved afsendelsen. PDF i privat storage (firma-fakturaer).
--      Momsordningen låses på kladden, når den oprettes (ved betalingen).
--   4. Låsning: en sendt faktura kan aldrig ændres (kun PDF-sti én gang og
--      mailstatus) og ingen faktura kan slettes (trigger).
--   5. Kladder oprettes, når køberen har betalt (trigger på betalinger, der
--      aldrig vælter betalingen), og efterfølgende for gamle salg, når firmaet
--      åbner sine fakturaer.
--   6. Købers oplysninger læses ét sted: firma_faktura_koeber_auto(trade).
--      Navn: MitID (når verificeret, Filip 27. okt. 2026 "Oplysninger til
--      fakturaen indsamles ved oprettelse"), ellers navnet til handlen, ellers
--      profilnavnet. Adresse: først kontoens adresse, derefter checkout
--      (levering til døren). Firmaet kan rette/udfylde i kladden; køberen kan
--      selv oplyse firmanavn og CVR. Mangler adressen, kan kladden ikke sendes.
--   7. RPC'er: firma (liste, hent, ret kladde, send, kreditnota, indstillinger),
--      køber (oplys firmanavn/CVR), chef (logget opslag), service role (gem
--      PDF-sti, mailstatus).
--   8. RLS: firmaet ser sine egne, køberen ser de sendte til sig. Chefen via
--      det loggede opslag (som firma_faktura_salg - købers persondata).
--
-- Idempotent (kan køres igen). Kør først på testdatabasen. KØRES IKKE i
-- produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. Indstillinger
-- ===========================================================================
create table if not exists public.firma_faktura_indstillinger (
  firma_id        uuid primary key references public.firmaer(id),
  praefiks        text not null default 'F-',
  naeste_nummer   integer not null default 1,
  cifre           smallint not null default 4,
  momsordning     text not null default 'moms',
  betalingstekst  text not null default 'Betalt via BidHamr',
  svar_email      text,
  vis_logo        boolean not null default true,
  oprettet_kl     timestamptz not null default now(),
  opdateret_kl    timestamptz not null default now(),
  constraint firma_faktura_indst_praefiks check (praefiks ~ '^[A-Za-z0-9ÆØÅæøå/_.-]{0,12}$'),
  constraint firma_faktura_indst_nummer check (naeste_nummer between 1 and 99999999),
  constraint firma_faktura_indst_cifre check (cifre between 1 and 8),
  constraint firma_faktura_indst_moms check (momsordning in ('moms', 'brugtmoms')),
  constraint firma_faktura_indst_tekst check (char_length(btrim(betalingstekst)) between 1 and 200),
  constraint firma_faktura_indst_email check (
    svar_email is null or (char_length(svar_email) between 3 and 254 and svar_email ~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$'))
);

comment on table public.firma_faktura_indstillinger is
  'Firmaets fakturaindstillinger (firma til køber). Kun via RPC. naeste_nummer låses (for update) ved hver afsendelse.';

alter table public.firma_faktura_indstillinger enable row level security;
revoke all on public.firma_faktura_indstillinger from public, anon, authenticated;
grant all on public.firma_faktura_indstillinger to service_role;

-- Opretter rækken med standard fra firmaer.bruger_brugtmoms. Intern.
create or replace function public.firma_faktura_indstillinger_sikr(p_firma uuid)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into public.firma_faktura_indstillinger (firma_id, momsordning)
  select f.id, case when f.bruger_brugtmoms then 'brugtmoms' else 'moms' end
    from public.firmaer f
   where f.id = p_firma
  on conflict (firma_id) do nothing;
$fn$;
revoke all on function public.firma_faktura_indstillinger_sikr(uuid) from public, anon, authenticated;

-- firmaer.bruger_brugtmoms (Firmaoplysninger) -> standard-momsordningen.
create or replace function public.firmaer_brugtmoms_synk()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.bruger_brugtmoms is distinct from old.bruger_brugtmoms then
    update public.firma_faktura_indstillinger i
       set momsordning = case when new.bruger_brugtmoms then 'brugtmoms' else 'moms' end,
           opdateret_kl = now()
     where i.firma_id = new.id
       and i.momsordning is distinct from (case when new.bruger_brugtmoms then 'brugtmoms' else 'moms' end);
  end if;
  return new;
end;
$fn$;
revoke all on function public.firmaer_brugtmoms_synk() from public, anon, authenticated;

drop trigger if exists firmaer_brugtmoms_synk on public.firmaer;
create trigger firmaer_brugtmoms_synk
  after update of bruger_brugtmoms on public.firmaer
  for each row execute function public.firmaer_brugtmoms_synk();

-- ===========================================================================
-- 2. Momsordning pr. auktion
-- ===========================================================================
alter table public.auctions add column if not exists momsordning text;
alter table public.auctions drop constraint if exists auctions_momsordning_check;
alter table public.auctions add constraint auctions_momsordning_check
  check (momsordning is null or momsordning in ('moms', 'brugtmoms'));
-- Kan læses (Redigér auktion viser valget); skrives kun via RPC'en herunder.
grant select (momsordning) on public.auctions to anon, authenticated;

create or replace function public.auctions_momsordning_laas()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  -- Kun erhvervsauktioner har en momsordning.
  if not coalesce(new.erhverv, false) then
    new.momsordning := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.momsordning is distinct from old.momsordning
     and (old.vinder_id is not null
          or old.afsluttet_kl is not null
          or exists (select 1 from public.trades t where t.auction_id = old.id)) then
    raise exception 'momsordning_laast: Momsordningen kan ikke ændres, når varen er solgt.'
      using errcode = 'BHM01';
  end if;
  return new;
end;
$fn$;
revoke all on function public.auctions_momsordning_laas() from public, anon, authenticated;

drop trigger if exists auctions_momsordning_laas on public.auctions;
create trigger auctions_momsordning_laas
  before insert or update of momsordning, erhverv on public.auctions
  for each row execute function public.auctions_momsordning_laas();

-- Firmaet sætter momsordningen på sin egen erhvervsauktion (null = standard).
create or replace function public.firma_saet_auktion_momsordning(p_auktion uuid, p_momsordning text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_ny  text;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if p_momsordning is not null and p_momsordning not in ('moms', 'brugtmoms') then
    raise exception 'Ugyldig momsordning.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.firmaer f
                   join public.users u on u.id = f.bruger_id
                  where f.bruger_id = v_uid
                    and u.konto_lukket_kl is null
                    and u.konto_slettet_kl is null) then
    raise exception 'Kun firmakonti kan ændre dette.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.auctions a
                  where a.id = p_auktion and a.bruger_id = v_uid and a.erhverv) then
    raise exception 'Auktionen findes ikke.' using errcode = '42501';
  end if;
  -- Som resten af auktionen: låst fra første bud (og altid efter salg -
  -- triggeren auctions_momsordning_laas).
  if exists (select 1 from public.auctions a
              where a.id = p_auktion
                and a.momsordning is distinct from p_momsordning
                and (a."nuværende_bud" is not null
                     or exists (select 1 from public.bids bd where bd.auktion_id = a.id))) then
    raise exception 'momsordning_laast: Momsordningen kan ikke ændres, når der er budt.'
      using errcode = 'BHM01';
  end if;
  update public.auctions a
     set momsordning = p_momsordning
   where a.id = p_auktion
     and a.bruger_id = v_uid
     and a.erhverv
  returning a.momsordning into v_ny;
  return v_ny;
end;
$fn$;
revoke all on function public.firma_saet_auktion_momsordning(uuid, text) from public, anon;
grant execute on function public.firma_saet_auktion_momsordning(uuid, text) to authenticated;

-- ===========================================================================
-- 3. firma_fakturaer
-- ===========================================================================
create table if not exists public.firma_fakturaer (
  id                 uuid primary key default gen_random_uuid(),
  firma_id           uuid not null references public.firmaer(id),
  -- Firmakontoen (firmaer.bruger_id) og køberen - til RLS.
  saelger_id         uuid not null references public.users(id),
  koeber_id          uuid not null references public.users(id),
  trade_id           uuid not null references public.trades(id) on delete restrict,
  type               text not null default 'faktura',
  krediterer_id      uuid references public.firma_fakturaer(id) on delete restrict,
  status             text not null default 'kladde',
  -- Låst ved oprettelsen (auktionens momsordning eller firmaets standard).
  momsordning        text not null,
  -- Rettelser i kladden (null = brug oplysningerne fra handlen).
  koeber_navn        text,
  koeber_adresse     text,
  koeber_postnummer  text,
  koeber_by          text,
  koeber_email       text,
  koeber_firmanavn   text,
  koeber_cvr         text,
  leveringsdato      date,
  varetekst          text,
  -- Sættes ved afsendelsen (firma_faktura_send) og ændres aldrig siden.
  nummer             integer,
  fakturanummer      text,
  udstedt_dato       date,
  data               jsonb,
  sendt_kl           timestamptz,
  sendt_af           uuid references public.users(id),
  -- PDF (privat bucket firma-fakturaer) og mailstatus (service role).
  pdf_sti            text,
  mail_sendt_kl      timestamptz,
  mail_fejl          text,
  mail_forsoeg       integer not null default 0,
  oprettet_kl        timestamptz not null default now(),
  opdateret_kl       timestamptz not null default now(),
  constraint firma_fakturaer_type check (type in ('faktura', 'kreditnota')),
  constraint firma_fakturaer_status check (status in ('kladde', 'sendt')),
  constraint firma_fakturaer_moms check (momsordning in ('moms', 'brugtmoms')),
  constraint firma_fakturaer_kredit check ((type = 'kreditnota') = (krediterer_id is not null)),
  constraint firma_fakturaer_sendt check (
    (status = 'kladde' and nummer is null and fakturanummer is null and udstedt_dato is null
                       and data is null and sendt_kl is null and sendt_af is null and pdf_sti is null)
    or (status = 'sendt' and nummer is not null and fakturanummer is not null and udstedt_dato is not null
                         and data is not null and sendt_kl is not null and sendt_af is not null)),
  constraint firma_fakturaer_felter check (
    (koeber_navn is null or char_length(koeber_navn) between 1 and 200)
    and (koeber_adresse is null or char_length(koeber_adresse) between 1 and 200)
    and (koeber_postnummer is null or koeber_postnummer ~ '^[0-9]{4}$')
    and (koeber_by is null or char_length(koeber_by) between 1 and 100)
    and (koeber_email is null or (char_length(koeber_email) between 3 and 254
                                  and koeber_email ~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$'))
    and (koeber_firmanavn is null or char_length(koeber_firmanavn) between 1 and 200)
    and (koeber_cvr is null or koeber_cvr ~ '^[0-9]{8}$')
    and (varetekst is null or char_length(varetekst) between 1 and 300)
    and (mail_fejl is null or char_length(mail_fejl) <= 1000)
    and (pdf_sti is null or char_length(pdf_sti) <= 300))
);

-- Fortløbende uden dubletter pr. firma (rækkelåsen sikrer uden huller).
create unique index if not exists firma_fakturaer_nummer_unik
  on public.firma_fakturaer (firma_id, nummer) where nummer is not null;
-- Én faktura pr. handel, højst én kreditnota pr. faktura (fuld kreditering).
create unique index if not exists firma_fakturaer_trade_faktura_unik
  on public.firma_fakturaer (trade_id) where type = 'faktura';
create unique index if not exists firma_fakturaer_kreditnota_unik
  on public.firma_fakturaer (krediterer_id) where type = 'kreditnota';
create index if not exists firma_fakturaer_saelger_idx on public.firma_fakturaer (saelger_id, oprettet_kl desc);
create index if not exists firma_fakturaer_koeber_idx on public.firma_fakturaer (koeber_id, trade_id);

comment on table public.firma_fakturaer is
  'Fakturaer fra firma til køber (firmaet udsteder; BidHamr er værktøjet). Sendes KUN med firma_faktura_send af firmaets egen bruger. Sendte rækker er låst; intet slettes (bogføringsloven, 5 år).';

-- ===========================================================================
-- 4. Låsning
-- ===========================================================================
create or replace function public.firma_fakturaer_laas()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_tilladt constant text[] := array['pdf_sti', 'mail_sendt_kl', 'mail_fejl', 'mail_forsoeg', 'opdateret_kl'];
  v_ny  jsonb;
  v_gl  jsonb;
  k     text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Fakturaer kan ikke slettes (bogføringsloven) - lav en kreditnota.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'kladde' then
      raise exception 'En faktura oprettes altid som kladde.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- Felter, der aldrig ændres.
  if new.id is distinct from old.id or new.firma_id is distinct from old.firma_id
     or new.saelger_id is distinct from old.saelger_id or new.koeber_id is distinct from old.koeber_id
     or new.trade_id is distinct from old.trade_id or new.type is distinct from old.type
     or new.krediterer_id is distinct from old.krediterer_id or new.momsordning is distinct from old.momsordning
     or new.oprettet_kl is distinct from old.oprettet_kl then
    raise exception 'Fakturaens grundoplysninger kan ikke ændres.' using errcode = '42501';
  end if;

  if old.status = 'sendt' then
    v_ny := to_jsonb(new);
    v_gl := to_jsonb(old);
    foreach k in array v_tilladt loop
      v_ny := v_ny - k;
      v_gl := v_gl - k;
    end loop;
    if v_ny is distinct from v_gl then
      raise exception 'En sendt faktura kan ikke ændres - lav en kreditnota.' using errcode = '42501';
    end if;
    -- PDF-stien sættes én gang.
    if old.pdf_sti is not null and new.pdf_sti is distinct from old.pdf_sti then
      raise exception 'En sendt faktura kan ikke ændres - lav en kreditnota.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- old.status = 'kladde'
  if new.status = 'sendt' then
    -- Kun firma_faktura_send (sætter flaget for netop denne faktura i
    -- transaktionen, efter at have tjekket auth.uid()).
    if coalesce(current_setting('bidhamr.firma_faktura_send', true), '') <> new.id::text
       or auth.uid() is null or new.sendt_af is distinct from auth.uid() then
      raise exception 'En faktura kan kun sendes af firmaet selv (knappen "Send").' using errcode = '42501';
    end if;
  elsif new.mail_sendt_kl is not null or new.pdf_sti is not null then
    raise exception 'En kladde har ingen PDF eller mail.' using errcode = '42501';
  end if;
  new.opdateret_kl := now();
  return new;
end;
$fn$;
revoke all on function public.firma_fakturaer_laas() from public, anon, authenticated;

drop trigger if exists firma_fakturaer_laas on public.firma_fakturaer;
create trigger firma_fakturaer_laas
  before insert or update or delete on public.firma_fakturaer
  for each row execute function public.firma_fakturaer_laas();

create or replace function public.firma_fakturaer_ingen_truncate()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'Fakturaer kan ikke slettes (bogføringsloven).' using errcode = '42501';
end;
$fn$;
revoke all on function public.firma_fakturaer_ingen_truncate() from public, anon, authenticated;

drop trigger if exists firma_fakturaer_ingen_truncate on public.firma_fakturaer;
create trigger firma_fakturaer_ingen_truncate
  before truncate on public.firma_fakturaer
  for each statement execute function public.firma_fakturaer_ingen_truncate();

-- ===========================================================================
-- 5. RLS og grants
-- ===========================================================================
alter table public.firma_fakturaer enable row level security;
revoke all on public.firma_fakturaer from public, anon, authenticated;
grant select on public.firma_fakturaer to authenticated;
grant all on public.firma_fakturaer to service_role;

drop policy if exists firma_fakturaer_select_firma on public.firma_fakturaer;
create policy firma_fakturaer_select_firma on public.firma_fakturaer
  as permissive for select to authenticated
  using (saelger_id = (select auth.uid()));

drop policy if exists firma_fakturaer_select_koeber on public.firma_fakturaer;
create policy firma_fakturaer_select_koeber on public.firma_fakturaer
  as permissive for select to authenticated
  using (koeber_id = (select auth.uid()) and status = 'sendt');

-- Privat bucket: kun service role (serveren tjekker adgang og sender filen).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('firma-fakturaer', 'firma-fakturaer', false, 6291456, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ===========================================================================
-- 6. Oprettelse af kladder
-- ===========================================================================

-- Opretter de manglende kladder for firmaets betalte salg. Intern.
create or replace function public.firma_faktura_opret_kladder(p_firma uuid, p_trade uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_antal integer;
begin
  perform public.firma_faktura_indstillinger_sikr(p_firma);
  insert into public.firma_fakturaer (firma_id, saelger_id, koeber_id, trade_id, type, status, momsordning)
  select fm.id, t.seller_id, t.buyer_id, t.id, 'faktura', 'kladde',
         coalesce(a.momsordning, i.momsordning)
    from public.firmaer fm
    join public.firma_faktura_indstillinger i on i.firma_id = fm.id
    join public.trades t on t.seller_id = fm.bruger_id
    join public.betalinger b on b.trade_id = t.id and b.betalt_kl is not null
    left join public.auctions a on a.id = t.auction_id
   where fm.id = p_firma
     and t.buyer_id is not null
     and (p_trade is null or t.id = p_trade)
     and not exists (select 1 from public.firma_fakturaer x where x.trade_id = t.id and x.type = 'faktura')
  on conflict (trade_id) where type = 'faktura' do nothing;
  get diagnostics v_antal = row_count;
  return v_antal;
end;
$fn$;
revoke all on function public.firma_faktura_opret_kladder(uuid, uuid) from public, anon, authenticated;

-- Når køberen har betalt: lav kladden. Vælter ALDRIG betalingen.
create or replace function public.betalinger_firma_faktura_kladde()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_firma uuid;
begin
  if new.betalt_kl is null or (tg_op = 'UPDATE' and old.betalt_kl is not null) then
    return null;
  end if;
  begin
    select fm.id into v_firma
      from public.trades t
      join public.firmaer fm on fm.bruger_id = t.seller_id
     where t.id = new.trade_id;
    if v_firma is not null then
      perform public.firma_faktura_opret_kladder(v_firma, new.trade_id);
    end if;
  exception when others then
    raise warning 'firma_faktura_kladde fejlede for handel %: %', new.trade_id, sqlerrm;
  end;
  return null;
end;
$fn$;
revoke all on function public.betalinger_firma_faktura_kladde() from public, anon, authenticated;

drop trigger if exists betalinger_firma_faktura_kladde on public.betalinger;
create trigger betalinger_firma_faktura_kladde
  after insert or update of betalt_kl on public.betalinger
  for each row execute function public.betalinger_firma_faktura_kladde();

-- ===========================================================================
-- 7. Købers oplysninger - ÉT sted
-- ===========================================================================
-- Kobles på kontoadressen fra 20261102340000 (bruger_adresse), når den
-- findes: udskift kun blokken "Kontoens adresse" herunder. Indtil da læses
-- users.adresse (fri tekst; "Vej 1, 1234 By" deles op).
create or replace function public.firma_faktura_koeber_auto(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  t        record;
  hl       record;
  u        record;
  v_mitid  text;
  v_navn   text;
  v_email  text;
  v_adr    text;
  v_post   text;
  v_by     text;
  v_kilde  text;
  m        text[];
begin
  select tr.id, tr.buyer_id into t from public.trades tr where tr.id = p_trade;
  if not found then
    return null;
  end if;
  select * into hl from public.handel_levering l where l.trade_id = p_trade;
  select uu.* into u from public.users uu where uu.id = t.buyer_id;

  -- Navn: MitID, når køberen er verificeret (Filip, 27. okt. 2026).
  select nullif(btrim(mv.juridisk_navn), '') into v_mitid
    from public.mitid_verificeringer mv
   where mv.bruger_id = t.buyer_id and mv.status = 'aktiv'
   order by mv.verificeret_kl desc limit 1;
  v_navn := coalesce(v_mitid,
                     nullif(btrim(hl.modtager_navn), ''),
                     nullif(btrim(concat_ws(' ', u.fornavn, u.efternavn)), ''),
                     nullif(btrim(u.navn), ''));

  v_email := coalesce(nullif(btrim(hl.modtager_email), ''),
                      nullif(btrim(u.email), ''),
                      (select au.email::text from auth.users au where au.id = t.buyer_id));
  if v_email is not null and v_email ilike '%@slettet.invalid' then
    v_email := null;
  end if;

  -- Kontoens adresse (først).
  if nullif(btrim(u.adresse), '') is not null then
    m := regexp_match(btrim(u.adresse), '^(.+?)\s*,?\s+([0-9]{4})\s+(.+)$');
    if m is not null then
      v_adr := btrim(m[1], ' ,'); v_post := m[2]; v_by := btrim(m[3]);
      v_kilde := 'konto';
    end if;
  end if;

  -- Ellers adressen fra checkout (levering til døren).
  if v_kilde is null and hl.maade = 'doer'
     and nullif(btrim(hl.modtager_adresse), '') is not null then
    v_adr := btrim(hl.modtager_adresse); v_post := nullif(btrim(hl.modtager_postnummer), '');
    v_by := nullif(btrim(hl.modtager_by), '');
    v_kilde := 'checkout';
  end if;

  -- Ufuldstændig kontoadresse (uden postnummer): vej med, resten mangler.
  if v_kilde is null and nullif(btrim(u.adresse), '') is not null then
    v_adr := left(btrim(u.adresse), 200);
    v_kilde := 'konto_ufuldstaendig';
  end if;

  return jsonb_build_object(
    'navn', left(v_navn, 200),
    'adresse', left(v_adr, 200),
    'postnummer', case when v_post ~ '^[0-9]{4}$' then v_post end,
    'by', left(v_by, 100),
    'email', v_email,
    'firmanavn', null,
    'cvr', null,
    'navn_kilde', case when v_mitid is not null then 'mitid' else 'konto' end,
    'adresse_kilde', v_kilde);
end;
$fn$;
revoke all on function public.firma_faktura_koeber_auto(uuid) from public, anon, authenticated;
-- Serveren (hentKoeberFakturaOplysninger i src/lib/erhverv/koeberFakturaOplysninger.ts).
grant execute on function public.firma_faktura_koeber_auto(uuid) to service_role;

-- ===========================================================================
-- 8. Fakturaens indhold (kladde eller til afsendelse)
-- ===========================================================================
-- Moms af beløb inkl. 25 % moms: netto = round(beløb * 4/5), moms = beløb -
-- netto (samme som public.faktura_moms og src/lib/erhverv/firmaFaktura.ts).
-- round() på numeric runder halv væk fra 0, så kreditnotaer (negative) er
-- præcis det modsatte af fakturaen.
create or replace function public.firma_faktura_netto(p_inkl bigint)
returns bigint
language sql
immutable
set search_path = public
as $fn$
  select round(p_inkl::numeric * 4 / 5)::bigint
$fn$;

create or replace function public.firma_faktura_byg(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  f      record;
  fm     record;
  i      record;
  t      record;
  b      record;
  a      record;
  o      record;
  su     record;
  v_auto jsonb;
  v_k    jsonb;
  v_linjer jsonb;
  v_inkl bigint;
  v_netto bigint;
  v_mangler text[] := array[]::text[];
  v_lev  date;
  v_tekst text;
  v_kred jsonb;
begin
  select * into f from public.firma_fakturaer x where x.id = p_id;
  if not found then
    return null;
  end if;
  select * into fm from public.firmaer x where x.id = f.firma_id;
  perform public.firma_faktura_indstillinger_sikr(f.firma_id);
  select * into i from public.firma_faktura_indstillinger x where x.firma_id = f.firma_id;
  select * into su from public.users x where x.id = f.saelger_id;

  if f.type = 'kreditnota' then
    -- Kreditnota: samme køber og linjer som den sendte faktura, modsat fortegn.
    select * into o from public.firma_fakturaer x where x.id = f.krediterer_id;
    if o.status is distinct from 'sendt' then
      return null;
    end if;
    v_k := o.data -> 'koeber';
    v_kred := jsonb_build_object('id', o.id, 'fakturanummer', o.fakturanummer, 'udstedt_dato', o.udstedt_dato);
    select coalesce(jsonb_agg(l || jsonb_build_object(
             'enhedspris_oere', -((l->>'enhedspris_oere')::bigint),
             'beloeb_oere', -((l->>'beloeb_oere')::bigint),
             'netto_oere', case when l ? 'netto_oere' and l->>'netto_oere' is not null then -((l->>'netto_oere')::bigint) end,
             'moms_oere', case when l ? 'moms_oere' and l->>'moms_oere' is not null then -((l->>'moms_oere')::bigint) end)
             order by n), '[]'::jsonb)
      into v_linjer
      from jsonb_array_elements(o.data -> 'linjer') with ordinality as e(l, n);
    v_lev := (o.data ->> 'leveringsdato')::date;
  else
    select * into t from public.trades x where x.id = f.trade_id;
    select * into b from public.betalinger x where x.trade_id = f.trade_id;
    select * into a from public.auctions x where x.id = t.auction_id;
    v_auto := public.firma_faktura_koeber_auto(f.trade_id);
    v_k := jsonb_build_object(
      'navn',       coalesce(f.koeber_navn, v_auto->>'navn'),
      'adresse',    coalesce(f.koeber_adresse, v_auto->>'adresse'),
      'postnummer', coalesce(f.koeber_postnummer, v_auto->>'postnummer'),
      'by',         coalesce(f.koeber_by, v_auto->>'by'),
      'email',      coalesce(f.koeber_email, v_auto->>'email'),
      'firmanavn',  f.koeber_firmanavn,
      'cvr',        f.koeber_cvr);

    -- Varen: buddet inkl. moms. Fragten betales til BidHamr (application fee)
    -- og går til fragtfirmaet - den er ikke firmaets salg og står ikke her.
    -- BidHamrs gebyrer står heller ikke her (de er BidHamrs egen faktura).
    v_inkl := coalesce(b.bud_oere, round(t.amount * 100)::bigint);
    v_tekst := coalesce(f.varetekst,
                        left(concat_ws(' ', nullif(btrim(a.titel), ''),
                                       case when nullif(btrim(a.stand), '') is not null
                                            then '(stand: ' ||
                                                 case public.stand_normaliser(a.stand)
                                                   when 'ny_med_maerke' then 'ny med mærke'
                                                   when 'som_ny' then 'som ny'
                                                   when 'god' then 'god'
                                                   when 'brugt' then 'brugt'
                                                   when 'defekt' then 'defekt'
                                                   else btrim(a.stand) end || ')' end), 300),
                        'Vare');
    v_netto := public.firma_faktura_netto(v_inkl);
    v_linjer := jsonb_build_array(jsonb_build_object(
      'tekst', v_tekst,
      'antal', 1,
      'enhedspris_oere', v_inkl,
      'beloeb_oere', v_inkl,
      'netto_oere', case when f.momsordning = 'moms' then v_netto end,
      'moms_oere', case when f.momsordning = 'moms' then v_inkl - v_netto end));
    v_lev := coalesce(f.leveringsdato,
                      (coalesce(t.received_at, t.sendt_kl, b.betalt_kl) at time zone 'Europe/Copenhagen')::date);

    if b.betalt_kl is null then
      v_mangler := array_append(v_mangler, 'ikke_betalt'::text);
    end if;
    if b.refunderet_kl is not null then
      v_mangler := array_append(v_mangler, 'refunderet'::text);
    end if;
    if v_inkl is null or v_inkl <= 0 then
      v_mangler := array_append(v_mangler, 'beloeb'::text);
    end if;
  end if;

  if nullif(v_k->>'navn', '') is null then v_mangler := array_append(v_mangler, 'koeber_navn'::text); end if;
  if nullif(v_k->>'adresse', '') is null then v_mangler := array_append(v_mangler, 'koeber_adresse'::text); end if;
  if coalesce(v_k->>'postnummer', '') !~ '^[0-9]{4}$' then v_mangler := array_append(v_mangler, 'koeber_postnummer'::text); end if;
  if nullif(v_k->>'by', '') is null then v_mangler := array_append(v_mangler, 'koeber_by'::text); end if;
  if coalesce(v_k->>'email', '') !~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$' then
    v_mangler := array_append(v_mangler, 'koeber_email'::text);
  end if;

  return jsonb_build_object(
    'id', f.id,
    'type', f.type,
    'status', f.status,
    'trade_id', f.trade_id,
    'fakturanummer', f.fakturanummer,
    'udstedt_dato', f.udstedt_dato,
    'sendt_kl', f.sendt_kl,
    'krediterer', v_kred,
    'saelger', jsonb_build_object(
      'firmanavn', fm.firmanavn,
      'cvr', fm.cvr,
      'adresse', fm.adresse,
      'postnummer', fm.postnummer,
      'by', fm.bynavn,
      'email', coalesce(i.svar_email, fm.kontakt_email),
      'telefon', fm.telefon,
      'logo_url', case when i.vis_logo then nullif(btrim(su.avatar_url), '') end),
    'koeber', v_k,
    'linjer', v_linjer,
    'momsordning', f.momsordning,
    'moms_sats', case when f.momsordning = 'moms' then 25 end,
    'beloeb_ekskl_moms_oere', case when f.momsordning = 'moms'
      then (select sum((l->>'netto_oere')::bigint) from jsonb_array_elements(v_linjer) l) end,
    'moms_oere', case when f.momsordning = 'moms'
      then (select sum((l->>'moms_oere')::bigint) from jsonb_array_elements(v_linjer) l) end,
    'total_oere', (select coalesce(sum((l->>'beloeb_oere')::bigint), 0) from jsonb_array_elements(v_linjer) l),
    'brugtmoms_tekst', case when f.momsordning = 'brugtmoms' then 'Brugtmoms – særordning for brugte varer' end,
    'leveringsdato', v_lev,
    'betalingstekst', i.betalingstekst,
    'mangler', to_jsonb(v_mangler));
end;
$fn$;
revoke all on function public.firma_faktura_byg(uuid) from public, anon, authenticated;
revoke all on function public.firma_faktura_netto(bigint) from public, anon, authenticated;

-- Næste nummer som tekst (præfiks + cifre). Længere tal afkortes aldrig.
create or replace function public.firma_faktura_nummer_tekst(p_praefiks text, p_nummer integer, p_cifre integer)
returns text
language sql
immutable
set search_path = public
as $fn$
  select coalesce(p_praefiks, '') ||
         case when length(p_nummer::text) >= p_cifre then p_nummer::text
              else lpad(p_nummer::text, p_cifre, '0') end
$fn$;
revoke all on function public.firma_faktura_nummer_tekst(text, integer, integer) from public, anon, authenticated;

-- ===========================================================================
-- 9. Firmaets RPC'er (auth.uid() = firmakontoen)
-- ===========================================================================

-- Firmaet (aktiv konto) for den indloggede. Intern.
create or replace function public.firma_faktura_mit_firma()
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select f.id
    from public.firmaer f
    join public.users u on u.id = f.bruger_id
   where f.bruger_id = auth.uid()
     and u.konto_lukket_kl is null
     and u.konto_slettet_kl is null
$fn$;
revoke all on function public.firma_faktura_mit_firma() from public, anon, authenticated;

-- Liste over firmaets fakturaer (opretter manglende kladder først).
create or replace function public.firma_fakturaer_liste()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_firma uuid := public.firma_faktura_mit_firma();
  i       record;
  v_sendt boolean;
begin
  if auth.uid() is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if v_firma is null then
    return null;
  end if;
  perform public.firma_faktura_opret_kladder(v_firma);
  select * into i from public.firma_faktura_indstillinger x where x.firma_id = v_firma;
  v_sendt := exists (select 1 from public.firma_fakturaer x where x.firma_id = v_firma and x.status = 'sendt');

  return jsonb_build_object(
    'indstillinger', jsonb_build_object(
      'praefiks', i.praefiks,
      'naeste_nummer', i.naeste_nummer,
      'cifre', i.cifre,
      'naeste_fakturanummer', public.firma_faktura_nummer_tekst(i.praefiks, i.naeste_nummer, i.cifre),
      'momsordning', i.momsordning,
      'betalingstekst', i.betalingstekst,
      'svar_email', i.svar_email,
      'vis_logo', i.vis_logo,
      'nummer_laast', v_sendt),
    'fakturaer', coalesce((
      select jsonb_agg(r.d order by r.sort desc)
        from (
          select x.oprettet_kl as sort,
                 jsonb_build_object(
                   'id', x.id,
                   'type', x.type,
                   'status', x.status,
                   'trade_id', x.trade_id,
                   'krediterer_id', x.krediterer_id,
                   'kreditnota_id', (select k.id from public.firma_fakturaer k
                                      where k.krediterer_id = x.id and k.type = 'kreditnota'),
                   'kreditnota_status', (select k.status from public.firma_fakturaer k
                                          where k.krediterer_id = x.id and k.type = 'kreditnota'),
                   'fakturanummer', x.fakturanummer,
                   'nummer', x.nummer,
                   'sendt_kl', x.sendt_kl,
                   'mail_sendt_kl', x.mail_sendt_kl,
                   'mail_fejl', x.mail_fejl,
                   'oprettet_kl', x.oprettet_kl,
                   'data', case when x.status = 'sendt' then x.data else public.firma_faktura_byg(x.id) end
                 ) as d
            from public.firma_fakturaer x
           where x.firma_id = v_firma
           order by x.oprettet_kl desc
           limit 5000
        ) r), '[]'::jsonb));
end;
$fn$;
revoke all on function public.firma_fakturaer_liste() from public, anon;
grant execute on function public.firma_fakturaer_liste() to authenticated;

-- Én faktura (firmaet selv): kladdens aktuelle indhold eller det sendte
-- øjebliksbillede.
create or replace function public.firma_faktura_hent(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_firma uuid := public.firma_faktura_mit_firma();
  x       record;
  i       record;
begin
  if auth.uid() is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select * into x from public.firma_fakturaer f where f.id = p_id and f.firma_id = v_firma;
  if not found or v_firma is null then
    return null;
  end if;
  select * into i from public.firma_faktura_indstillinger s where s.firma_id = v_firma;
  return jsonb_build_object(
    'id', x.id,
    'type', x.type,
    'status', x.status,
    'trade_id', x.trade_id,
    'krediterer_id', x.krediterer_id,
    'kreditnota_id', (select k.id from public.firma_fakturaer k where k.krediterer_id = x.id and k.type = 'kreditnota'),
    'fakturanummer', x.fakturanummer,
    'sendt_kl', x.sendt_kl,
    'mail_sendt_kl', x.mail_sendt_kl,
    'mail_fejl', x.mail_fejl,
    'pdf_sti', x.pdf_sti,
    'naeste_fakturanummer', public.firma_faktura_nummer_tekst(i.praefiks, i.naeste_nummer, i.cifre),
    'rettelser', jsonb_build_object(
      'koeber_navn', x.koeber_navn, 'koeber_adresse', x.koeber_adresse,
      'koeber_postnummer', x.koeber_postnummer, 'koeber_by', x.koeber_by,
      'koeber_email', x.koeber_email, 'koeber_firmanavn', x.koeber_firmanavn,
      'koeber_cvr', x.koeber_cvr, 'leveringsdato', x.leveringsdato, 'varetekst', x.varetekst),
    'data', case when x.status = 'sendt' then x.data else public.firma_faktura_byg(x.id) end);
end;
$fn$;
revoke all on function public.firma_faktura_hent(uuid) from public, anon;
grant execute on function public.firma_faktura_hent(uuid) to authenticated;

-- Ret/udfyld kladden. Tom tekst = brug oplysningen fra handlen.
create or replace function public.firma_faktura_kladde_gem(
  p_id              uuid,
  p_koeber_navn     text,
  p_koeber_adresse  text,
  p_koeber_postnummer text,
  p_koeber_by       text,
  p_koeber_email    text,
  p_koeber_firmanavn text,
  p_koeber_cvr      text,
  p_leveringsdato   date,
  p_varetekst       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_firma uuid := public.firma_faktura_mit_firma();
  v_type text;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select f.type into v_type from public.firma_fakturaer f
   where f.id = p_id and f.firma_id = v_firma and f.saelger_id = v_uid;
  if not found or v_firma is null then
    raise exception 'Fakturaen findes ikke.' using errcode = '42501';
  end if;
  if v_type = 'kreditnota' then
    raise exception 'En kreditnota har samme oplysninger som fakturaen.' using errcode = '22023';
  end if;
  if p_leveringsdato is not null and (p_leveringsdato < date '2020-01-01' or p_leveringsdato > current_date + 366) then
    raise exception 'Ugyldig leveringsdato.' using errcode = '22023';
  end if;
  update public.firma_fakturaer f
     set koeber_navn = nullif(btrim(p_koeber_navn), ''),
         koeber_adresse = nullif(btrim(p_koeber_adresse), ''),
         koeber_postnummer = nullif(btrim(p_koeber_postnummer), ''),
         koeber_by = nullif(btrim(p_koeber_by), ''),
         koeber_email = nullif(lower(btrim(p_koeber_email)), ''),
         koeber_firmanavn = nullif(btrim(p_koeber_firmanavn), ''),
         koeber_cvr = nullif(regexp_replace(coalesce(p_koeber_cvr, ''), '[\s-]', '', 'g'), ''),
         leveringsdato = p_leveringsdato,
         varetekst = nullif(btrim(p_varetekst), '')
   where f.id = p_id and f.status = 'kladde';
  if not found then
    raise exception 'Fakturaen er sendt og kan ikke ændres. Lav en kreditnota.' using errcode = 'BHF10';
  end if;
  return public.firma_faktura_byg(p_id);
end;
$fn$;
revoke all on function public.firma_faktura_kladde_gem(uuid, text, text, text, text, text, text, text, date, text) from public, anon;
grant execute on function public.firma_faktura_kladde_gem(uuid, text, text, text, text, text, text, text, date, text) to authenticated;

-- SEND. Den ENESTE vej til status 'sendt'. Kræver firmaets egen bruger.
-- Nummeret tildeles her, i samme transaktion som statusskiftet, med lås på
-- firmaets indstillinger (for update): to samtidige afsendelser venter på
-- hinanden, og et nummer bruges kun, hvis fakturaen faktisk bliver sendt.
-- Idempotent: en allerede sendt faktura giver 'allerede_sendt' (intet nyt
-- nummer).
create or replace function public.firma_faktura_send(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid := public.firma_faktura_mit_firma();
  x       record;
  i       record;
  v_data  jsonb;
  v_nr    integer;
  v_fnr   text;
  v_dato  date := (now() at time zone 'Europe/Copenhagen')::date;
  v_antal integer;
begin
  if v_uid is null or v_firma is null then
    raise exception 'Kun firmaet selv kan sende sine fakturaer.' using errcode = '42501';
  end if;
  -- Lås fakturaen (dobbeltklik venter her).
  select * into x from public.firma_fakturaer f
   where f.id = p_id and f.firma_id = v_firma and f.saelger_id = v_uid
   for update;
  if not found then
    raise exception 'Fakturaen findes ikke.' using errcode = '42501';
  end if;
  if x.status = 'sendt' then
    return jsonb_build_object('kode', 'allerede_sendt', 'id', x.id, 'fakturanummer', x.fakturanummer, 'data', x.data);
  end if;

  v_data := public.firma_faktura_byg(p_id);
  if v_data is null then
    raise exception 'Fakturaen kan ikke sendes endnu.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_data -> 'mangler') > 0 then
    return jsonb_build_object('kode', 'mangler', 'id', x.id, 'mangler', v_data -> 'mangler');
  end if;

  -- Nummerserien: lås firmaets række og tag næste nummer.
  perform public.firma_faktura_indstillinger_sikr(v_firma);
  select * into i from public.firma_faktura_indstillinger s where s.firma_id = v_firma for update;
  v_nr := i.naeste_nummer;
  v_fnr := public.firma_faktura_nummer_tekst(i.praefiks, v_nr, i.cifre);
  update public.firma_faktura_indstillinger s
     set naeste_nummer = v_nr + 1, opdateret_kl = now()
   where s.firma_id = v_firma;

  -- Øjebliksbilledet (byg igen efter låsen, så det er det aktuelle indhold).
  v_data := public.firma_faktura_byg(p_id) || jsonb_build_object(
    'status', 'sendt', 'fakturanummer', v_fnr, 'nummer', v_nr,
    'udstedt_dato', v_dato, 'sendt_kl', now());

  perform set_config('bidhamr.firma_faktura_send', p_id::text, true);
  update public.firma_fakturaer f
     set status = 'sendt', nummer = v_nr, fakturanummer = v_fnr, udstedt_dato = v_dato,
         data = v_data, sendt_kl = now(), sendt_af = v_uid
   where f.id = p_id and f.status = 'kladde';
  get diagnostics v_antal = row_count;
  perform set_config('bidhamr.firma_faktura_send', '', true);
  if v_antal <> 1 then
    raise exception 'Fakturaen blev ikke sendt. Prøv igen.' using errcode = '40001';
  end if;

  return jsonb_build_object('kode', 'sendt', 'id', p_id, 'fakturanummer', v_fnr, 'data', v_data);
end;
$fn$;
revoke all on function public.firma_faktura_send(uuid) from public, anon;
grant execute on function public.firma_faktura_send(uuid) to authenticated;

-- Lav kreditnota (kladde) på en sendt faktura. Idempotent.
create or replace function public.firma_kreditnota_opret(p_faktura uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid := public.firma_faktura_mit_firma();
  x       record;
  v_id    uuid;
begin
  if v_uid is null or v_firma is null then
    raise exception 'Kun firmaet selv kan lave en kreditnota.' using errcode = '42501';
  end if;
  select * into x from public.firma_fakturaer f
   where f.id = p_faktura and f.firma_id = v_firma and f.saelger_id = v_uid;
  if not found then
    raise exception 'Fakturaen findes ikke.' using errcode = '42501';
  end if;
  if x.type <> 'faktura' or x.status <> 'sendt' then
    raise exception 'Der kan kun laves en kreditnota på en sendt faktura.' using errcode = '22023';
  end if;
  insert into public.firma_fakturaer (firma_id, saelger_id, koeber_id, trade_id, type, krediterer_id, status, momsordning)
  values (x.firma_id, x.saelger_id, x.koeber_id, x.trade_id, 'kreditnota', x.id, 'kladde', x.momsordning)
  on conflict (krediterer_id) where type = 'kreditnota' do nothing
  returning id into v_id;
  if v_id is null then
    select k.id into v_id from public.firma_fakturaer k where k.krediterer_id = x.id and k.type = 'kreditnota';
  end if;
  return v_id;
end;
$fn$;
revoke all on function public.firma_kreditnota_opret(uuid) from public, anon;
grant execute on function public.firma_kreditnota_opret(uuid) to authenticated;

-- Indstillinger. Præfiks, startnummer og cifre kun før første afsendelse.
create or replace function public.firma_faktura_indstillinger_gem(
  p_praefiks       text,
  p_startnummer    integer,
  p_cifre          integer,
  p_momsordning    text,
  p_betalingstekst text,
  p_svar_email     text,
  p_vis_logo       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid := public.firma_faktura_mit_firma();
  i       record;
  v_sendt boolean;
begin
  if v_uid is null or v_firma is null then
    raise exception 'Kun firmakonti kan ændre dette.' using errcode = '42501';
  end if;
  if p_momsordning not in ('moms', 'brugtmoms') or p_vis_logo is null then
    raise exception 'Ugyldigt valg.' using errcode = '22023';
  end if;
  perform public.firma_faktura_indstillinger_sikr(v_firma);
  select * into i from public.firma_faktura_indstillinger s where s.firma_id = v_firma for update;
  v_sendt := exists (select 1 from public.firma_fakturaer x where x.firma_id = v_firma and x.status = 'sendt');
  if v_sendt and (coalesce(p_praefiks, '') is distinct from i.praefiks
                  or p_startnummer is distinct from i.naeste_nummer
                  or p_cifre is distinct from i.cifre::integer) then
    raise exception 'nummer_laast: Præfiks og nummer kan ikke ændres, når der er sendt en faktura.' using errcode = 'BHF11';
  end if;
  update public.firma_faktura_indstillinger s
     set praefiks = coalesce(btrim(p_praefiks), ''),
         naeste_nummer = p_startnummer,
         cifre = p_cifre,
         momsordning = p_momsordning,
         betalingstekst = btrim(p_betalingstekst),
         svar_email = nullif(lower(btrim(p_svar_email)), ''),
         vis_logo = p_vis_logo,
         opdateret_kl = now()
   where s.firma_id = v_firma;
  -- Samme valg i Firmaoplysninger ("Vi bruger brugtmomsordningen").
  update public.firmaer f
     set bruger_brugtmoms = (p_momsordning = 'brugtmoms'), opdateret_kl = now()
   where f.id = v_firma and f.bruger_brugtmoms is distinct from (p_momsordning = 'brugtmoms');
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.firma_faktura_indstillinger_gem(text, integer, integer, text, text, text, boolean) from public, anon;
grant execute on function public.firma_faktura_indstillinger_gem(text, integer, integer, text, text, text, boolean) to authenticated;

-- ===========================================================================
-- 10. Køberen
-- ===========================================================================
-- Køberen oplyser selv firmanavn og CVR til sælgers faktura (før den sendes).
-- Tomme værdier fjerner dem.
create or replace function public.koeber_faktura_firma_gem(p_trade uuid, p_firmanavn text, p_cvr text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_cvr text := nullif(regexp_replace(coalesce(p_cvr, ''), '[\s-]', '', 'g'), '');
  v_navn text := nullif(btrim(p_firmanavn), '');
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if (v_cvr is null) <> (v_navn is null) then
    raise exception 'Udfyld både firmanavn og CVR.' using errcode = '22023';
  end if;
  if v_cvr is not null and v_cvr !~ '^[0-9]{8}$' then
    raise exception 'CVR skal være 8 cifre.' using errcode = '22023';
  end if;
  if v_navn is not null and char_length(v_navn) > 200 then
    raise exception 'Firmanavnet er for langt.' using errcode = '22023';
  end if;
  update public.firma_fakturaer f
     set koeber_firmanavn = v_navn, koeber_cvr = v_cvr
   where f.trade_id = p_trade and f.koeber_id = v_uid and f.type = 'faktura' and f.status = 'kladde';
  if not found then
    if exists (select 1 from public.firma_fakturaer f
                where f.trade_id = p_trade and f.koeber_id = v_uid and f.type = 'faktura') then
      return jsonb_build_object('ok', false, 'kode', 'allerede_sendt');
    end if;
    return jsonb_build_object('ok', false, 'kode', 'ingen_faktura');
  end if;
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.koeber_faktura_firma_gem(uuid, text, text) from public, anon;
grant execute on function public.koeber_faktura_firma_gem(uuid, text, text) to authenticated;

-- Køberens fakturaer fra firmaet på en handel (kun sendte) + om hun kan
-- oplyse firmanavn/CVR endnu.
create or replace function public.koeber_firma_fakturaer(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.trades t where t.id = p_trade and t.buyer_id = v_uid) then
    return null;
  end if;
  return jsonb_build_object(
    'kladde', (select jsonb_build_object('firmanavn', f.koeber_firmanavn, 'cvr', f.koeber_cvr)
                 from public.firma_fakturaer f
                where f.trade_id = p_trade and f.koeber_id = v_uid and f.type = 'faktura' and f.status = 'kladde'),
    'fakturaer', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'type', f.type, 'fakturanummer', f.fakturanummer,
               'udstedt_dato', f.udstedt_dato, 'sendt_kl', f.sendt_kl,
               'firmanavn', f.data #>> '{saelger,firmanavn}',
               'total_oere', (f.data ->> 'total_oere')::bigint)
             order by f.sendt_kl)
        from public.firma_fakturaer f
       where f.trade_id = p_trade and f.koeber_id = v_uid and f.status = 'sendt'), '[]'::jsonb));
end;
$fn$;
revoke all on function public.koeber_firma_fakturaer(uuid) from public, anon;
grant execute on function public.koeber_firma_fakturaer(uuid) to authenticated;

-- ===========================================================================
-- 11. Chef (købers persondata - kun chef, logges)
-- ===========================================================================
create or replace function public.admin_firma_fakturaer(p_firma uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  fm    record;
begin
  if v_uid is null or not public.erhverv_har_adgang(v_uid, true) or not public.staff_aal2_ok() then
    raise exception 'Ingen adgang.' using errcode = '42501';
  end if;
  select * into fm from public.firmaer f where f.id = p_firma;
  if not found then
    return null;
  end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (v_uid, 'firma_faktura_opslag', 'firma', fm.id, fm.bruger_id,
          left('Firmaets fakturaer til købere slået op; ' || fm.firmanavn || ' (CVR ' || fm.cvr || ')', 1000));
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id, 'type', x.type, 'status', x.status, 'trade_id', x.trade_id,
             'fakturanummer', x.fakturanummer, 'sendt_kl', x.sendt_kl, 'mail_sendt_kl', x.mail_sendt_kl,
             'data', case when x.status = 'sendt' then x.data else public.firma_faktura_byg(x.id) end)
           order by x.oprettet_kl desc)
      from public.firma_fakturaer x where x.firma_id = p_firma), '[]'::jsonb);
end;
$fn$;
revoke all on function public.admin_firma_fakturaer(uuid) from public, anon;
grant execute on function public.admin_firma_fakturaer(uuid) to authenticated;

-- ===========================================================================
-- 12. Service role (serveren efter afsendelsen) - ændrer ALDRIG status
-- ===========================================================================
create or replace function public.firma_faktura_gem_pdf(p_id uuid, p_sti text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.firma_fakturaer f
     set pdf_sti = p_sti
   where f.id = p_id and f.status = 'sendt' and f.pdf_sti is null;
  return found;
end;
$fn$;
revoke all on function public.firma_faktura_gem_pdf(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_faktura_gem_pdf(uuid, text) to service_role;

create or replace function public.firma_faktura_mail_resultat(p_id uuid, p_ok boolean, p_fejl text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.firma_fakturaer f
     set mail_sendt_kl = case when p_ok then now() else f.mail_sendt_kl end,
         mail_fejl = case when p_ok then null else left(coalesce(p_fejl, 'Ukendt fejl'), 1000) end,
         mail_forsoeg = f.mail_forsoeg + 1
   where f.id = p_id and f.status = 'sendt';
  return found;
end;
$fn$;
revoke all on function public.firma_faktura_mail_resultat(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.firma_faktura_mail_resultat(uuid, boolean, text) to service_role;

-- ===========================================================================
-- 13. Kladder til de salg, der allerede er betalt
-- ===========================================================================
do $do$
declare
  r record;
begin
  for r in select f.id from public.firmaer f loop
    perform public.firma_faktura_opret_kladder(r.id);
  end loop;
end $do$;
