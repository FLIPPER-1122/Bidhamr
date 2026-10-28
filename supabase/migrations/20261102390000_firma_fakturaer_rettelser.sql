-- Rettelser efter review af fakturakladden fra firma til køber
-- (20261102330000_firma_fakturaer.sql). Idempotent. Kør først på
-- testdatabasen. KØRES IKKE i produktion uden Filips "ja".
--
-- INTET SENDES AUTOMATISK - uændret: firma_faktura_send er stadig den eneste
-- vej til 'sendt', kræver auth.uid() = firmakontoen (åben konto) og kaldes kun
-- fra knappen "Send". Ingen cron, trigger eller service role kan sende.
--
--  1. Linjer ved almindelig moms: enhedspris og beløb ekskl. moms, momssats
--     og beløb inkl. moms pr. linje (momsbekendtgørelsen § 58, stk. 1).
--  2. Rettelse:
--     - firma_faktura_kladde_momsordning: skift momsordning på en KLADDE
--       (kun mens status er 'kladde'). Kreditnotaer arver stadig fakturaens.
--     - Unikhed: én ikke-krediteret faktura pr. handel (krediteret_kl sættes
--       på fakturaen, når dens kreditnota sendes). firma_faktura_ny laver en
--       ny kladde ("Lav ny faktura") efter en sendt kreditnota. Der laves
--       ALDRIG automatisk en ny faktura efter en kreditnota.
--     - Kladder uden eget valg (momsordning_fra_standard) følger firmaets
--       aktuelle standard, til de sendes - også backfill-kladderne.
--  3. Brugtmoms: lovens ordlyd "Fortjenstmargenordning – brugte genstande"
--     (momssystemdirektivets art. 226, nr. 14 / momsbekendtgørelsen § 58) +
--     en kort forklaring. Varens stand står i data (vare_stand), så UI'et kan
--     advare ved brugtmoms på nye varer (blokerer ikke).
--  4. Købers adresse: bruger_adresser, derefter handel_levering. users.adresse
--     bruges ikke mere. Refunderede/annullerede handler: ingen adresse i
--     kladden (og den kan ikke sendes).
--  5. firma_faktura_send tjekker manglerne igen EFTER låsen og ruller tilbage
--     (raise BHF12), så nummeret ikke bruges.
--  7. Log (firma_faktura_log), når firmaet sætter en modtager-e-mail, der
--     afviger fra købers, og når momsordningen skiftes / ny faktura laves.
--  9. Logoets sti i øjebliksbilledet (saelger.logo_sti) og hash
--     (logo_sha256, sættes én gang sammen med PDF-stien).
-- 11. Lukkede firmakonti kan stadig se og eksportere (firma_faktura_mit_firma_laes),
--     men ikke sende, rette eller lave noget nyt. Eksporten er sideopdelt
--     (firma_fakturaer_eksport) uden loft.
-- 12. auctions_momsordning_laas låser også, når der er budt.

set local lock_timeout = '5s';

-- ===========================================================================
-- Kolonner og log
-- ===========================================================================
alter table public.firma_fakturaer add column if not exists krediteret_kl timestamptz;
alter table public.firma_fakturaer add column if not exists momsordning_fra_standard boolean not null default false;
alter table public.firma_fakturaer add column if not exists logo_sha256 text;
alter table public.firma_fakturaer drop constraint if exists firma_fakturaer_logo_sha256;
alter table public.firma_fakturaer add constraint firma_fakturaer_logo_sha256
  check (logo_sha256 is null or logo_sha256 ~ '^[0-9a-f]{64}$');
alter table public.firma_fakturaer drop constraint if exists firma_fakturaer_krediteret;
alter table public.firma_fakturaer add constraint firma_fakturaer_krediteret
  check (krediteret_kl is null or (type = 'faktura' and status = 'sendt'));

-- Log over firmaets ændringer på fakturaer (append-only, slettes aldrig).
create table if not exists public.firma_faktura_log (
  id          uuid primary key default gen_random_uuid(),
  faktura_id  uuid not null references public.firma_fakturaer(id) on delete restrict,
  firma_id    uuid not null references public.firmaer(id),
  bruger_id   uuid references public.users(id),
  handling    text not null,
  gammel      text,
  ny          text,
  detaljer    jsonb,
  oprettet_kl timestamptz not null default now(),
  constraint firma_faktura_log_handling check (handling in ('email_afviger', 'momsordning', 'ny_faktura'))
);
create index if not exists firma_faktura_log_faktura_idx on public.firma_faktura_log (faktura_id, oprettet_kl);
comment on table public.firma_faktura_log is
  'Firmaets ændringer på fakturaer til købere: modtager-e-mail, der afviger fra købers, momsordning og ny faktura efter kreditnota. Kun service role; slettes aldrig. 20261102390000.';
alter table public.firma_faktura_log enable row level security;
revoke all on public.firma_faktura_log from public, anon, authenticated;
grant select, insert on public.firma_faktura_log to service_role;

create or replace function public.firma_faktura_log_laas()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'Loggen kan ikke ændres eller slettes.' using errcode = '42501';
end;
$fn$;
revoke all on function public.firma_faktura_log_laas() from public, anon, authenticated;
drop trigger if exists firma_faktura_log_laas on public.firma_faktura_log;
create trigger firma_faktura_log_laas
  before update or delete on public.firma_faktura_log
  for each row execute function public.firma_faktura_log_laas();
drop trigger if exists firma_faktura_log_ingen_truncate on public.firma_faktura_log;
create trigger firma_faktura_log_ingen_truncate
  before truncate on public.firma_faktura_log
  for each statement execute function public.firma_faktura_log_laas();

-- ===========================================================================
-- Unikhed: én ikke-krediteret faktura pr. handel
-- ===========================================================================
-- Fakturaer, hvis kreditnota allerede er sendt, markeres som krediteret.
do $do$
begin
  if exists (select 1 from public.firma_fakturaer o
               join public.firma_fakturaer k on k.krediterer_id = o.id and k.type = 'kreditnota' and k.status = 'sendt'
              where o.krediteret_kl is null) then
    alter table public.firma_fakturaer disable trigger firma_fakturaer_laas;
    update public.firma_fakturaer o
       set krediteret_kl = k.sendt_kl
      from public.firma_fakturaer k
     where k.krediterer_id = o.id and k.type = 'kreditnota' and k.status = 'sendt'
       and o.krediteret_kl is null;
    alter table public.firma_fakturaer enable trigger firma_fakturaer_laas;
  end if;
end $do$;

create unique index if not exists firma_fakturaer_trade_aktiv_unik
  on public.firma_fakturaer (trade_id) where type = 'faktura' and krediteret_kl is null;
drop index if exists public.firma_fakturaer_trade_faktura_unik;

-- ===========================================================================
-- Låsning (erstatter 20261102330000)
-- ===========================================================================
create or replace function public.firma_fakturaer_laas()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_tilladt constant text[] := array['pdf_sti', 'logo_sha256', 'krediteret_kl', 'mail_sendt_kl', 'mail_fejl', 'mail_forsoeg', 'opdateret_kl'];
  v_ny  jsonb;
  v_gl  jsonb;
  k     text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Fakturaer kan ikke slettes (bogføringsloven) - lav en kreditnota.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'kladde' or new.krediteret_kl is not null or new.pdf_sti is not null
       or new.logo_sha256 is not null or new.mail_sendt_kl is not null then
      raise exception 'En faktura oprettes altid som kladde.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- Felter, der aldrig ændres. Momsordningen kun på en faktura-kladde
  -- (kreditnotaen arver fakturaens).
  if new.id is distinct from old.id or new.firma_id is distinct from old.firma_id
     or new.saelger_id is distinct from old.saelger_id or new.koeber_id is distinct from old.koeber_id
     or new.trade_id is distinct from old.trade_id or new.type is distinct from old.type
     or new.krediterer_id is distinct from old.krediterer_id
     or new.oprettet_kl is distinct from old.oprettet_kl then
    raise exception 'Fakturaens grundoplysninger kan ikke ændres.' using errcode = '42501';
  end if;
  if (new.momsordning is distinct from old.momsordning
      or new.momsordning_fra_standard is distinct from old.momsordning_fra_standard)
     and not (old.status = 'kladde' and new.status = 'kladde' and old.type = 'faktura') then
    raise exception 'Momsordningen kan kun ændres på en kladde.' using errcode = '42501';
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
    -- PDF-sti og logo-hash sættes én gang.
    if (old.pdf_sti is not null and new.pdf_sti is distinct from old.pdf_sti)
       or (old.logo_sha256 is not null and new.logo_sha256 is distinct from old.logo_sha256) then
      raise exception 'En sendt faktura kan ikke ændres - lav en kreditnota.' using errcode = '42501';
    end if;
    -- "Krediteret" sættes én gang, kun af firma_faktura_send, når
    -- kreditnotaen til netop denne faktura sendes.
    if new.krediteret_kl is distinct from old.krediteret_kl then
      if old.krediteret_kl is not null or new.krediteret_kl is null
         or coalesce(current_setting('bidhamr.firma_faktura_kredit', true), '') <> old.id::text then
        raise exception 'En sendt faktura kan ikke ændres - lav en kreditnota.' using errcode = '42501';
      end if;
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
  elsif new.mail_sendt_kl is not null or new.pdf_sti is not null or new.logo_sha256 is not null then
    raise exception 'En kladde har ingen PDF eller mail.' using errcode = '42501';
  end if;
  if new.krediteret_kl is not null then
    raise exception 'En kladde kan ikke være krediteret.' using errcode = '42501';
  end if;
  new.opdateret_kl := now();
  return new;
end;
$fn$;
revoke all on function public.firma_fakturaer_laas() from public, anon, authenticated;

-- ===========================================================================
-- Momsordning pr. auktion: også låst, når der er budt (punkt 12)
-- ===========================================================================
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
          or old."nuværende_bud" is not null
          or exists (select 1 from public.bids bd where bd.auktion_id = old.id)
          or exists (select 1 from public.trades t where t.auction_id = old.id)) then
    raise exception 'momsordning_laast: Momsordningen kan ikke ændres, når der er budt, eller varen er solgt.'
      using errcode = 'BHM01';
  end if;
  return new;
end;
$fn$;
revoke all on function public.auctions_momsordning_laas() from public, anon, authenticated;

-- ===========================================================================
-- Firmaet (læse): også lukkede konti - opbevaringspligt (punkt 11)
-- ===========================================================================
create or replace function public.firma_faktura_mit_firma_laes()
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
     and u.konto_slettet_kl is null
$fn$;
revoke all on function public.firma_faktura_mit_firma_laes() from public, anon, authenticated;

-- ===========================================================================
-- Standard-momsordningen følger med på kladder uden eget valg (punkt 2)
-- ===========================================================================
create or replace function public.firma_faktura_indst_standard_synk()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.momsordning is distinct from old.momsordning then
    update public.firma_fakturaer f
       set momsordning = new.momsordning
     where f.firma_id = new.firma_id
       and f.type = 'faktura'
       and f.status = 'kladde'
       and f.momsordning_fra_standard
       and f.momsordning is distinct from new.momsordning;
  end if;
  return null;
end;
$fn$;
revoke all on function public.firma_faktura_indst_standard_synk() from public, anon, authenticated;

drop trigger if exists firma_faktura_indst_standard_synk on public.firma_faktura_indstillinger;
create trigger firma_faktura_indst_standard_synk
  after update of momsordning on public.firma_faktura_indstillinger
  for each row execute function public.firma_faktura_indst_standard_synk();

-- ===========================================================================
-- Oprettelse af kladder (erstatter 20261102330000)
-- ===========================================================================
-- Laver kun en kladde, hvis handlen slet ingen faktura har. Efter en
-- kreditnota laves den nye faktura KUN med firmaets tryk (firma_faktura_ny).
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
  insert into public.firma_fakturaer (firma_id, saelger_id, koeber_id, trade_id, type, status, momsordning, momsordning_fra_standard)
  select fm.id, t.seller_id, t.buyer_id, t.id, 'faktura', 'kladde',
         coalesce(a.momsordning, i.momsordning), a.momsordning is null
    from public.firmaer fm
    join public.firma_faktura_indstillinger i on i.firma_id = fm.id
    join public.trades t on t.seller_id = fm.bruger_id
    join public.betalinger b on b.trade_id = t.id and b.betalt_kl is not null
    left join public.auctions a on a.id = t.auction_id
   where fm.id = p_firma
     and t.buyer_id is not null
     and (p_trade is null or t.id = p_trade)
     and not exists (select 1 from public.firma_fakturaer x where x.trade_id = t.id and x.type = 'faktura')
  on conflict (trade_id) where type = 'faktura' and krediteret_kl is null do nothing;
  get diagnostics v_antal = row_count;
  return v_antal;
end;
$fn$;
revoke all on function public.firma_faktura_opret_kladder(uuid, uuid) from public, anon, authenticated;

-- Backfill-kladder (og andre kladder uden eget valg på auktionen) følger
-- firmaets AKTUELLE standard. Firmaet kan rette den på kladden.
update public.firma_fakturaer f
   set momsordning = i.momsordning, momsordning_fra_standard = true
  from public.firma_faktura_indstillinger i, public.trades t
  left join public.auctions a on a.id = t.auction_id
 where i.firma_id = f.firma_id
   and t.id = f.trade_id
   and f.type = 'faktura'
   and f.status = 'kladde'
   and a.momsordning is null
   and not f.momsordning_fra_standard
   and not exists (select 1 from public.firma_faktura_log l
                    where l.faktura_id = f.id and l.handling = 'momsordning');

-- ===========================================================================
-- Er handlen refunderet eller annulleret? (punkt 4)
-- ===========================================================================
create or replace function public.firma_faktura_handel_lukket(p_trade uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((select t.status = 'annulleret' from public.trades t where t.id = p_trade), false)
      or exists (select 1 from public.betalinger b
                  where b.trade_id = p_trade
                    and (b.refunderet_kl is not null or b.status in ('refunderet', 'annulleret')))
$fn$;
revoke all on function public.firma_faktura_handel_lukket(uuid) from public, anon, authenticated;

-- ===========================================================================
-- Købers oplysninger - ÉT sted (erstatter 20261102330000)
-- ===========================================================================
-- Adressen: 1) public.bruger_adresser (kontoen), 2) handel_levering
-- (levering til døren). users.adresse bruges IKKE (fri tekst, ukendt
-- formål). Refunderet/annulleret handel: ingen adresse.
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
  v_lukket boolean;
begin
  select tr.id, tr.buyer_id into t from public.trades tr where tr.id = p_trade;
  if not found then
    return null;
  end if;
  select * into hl from public.handel_levering l where l.trade_id = p_trade;
  select uu.* into u from public.users uu where uu.id = t.buyer_id;
  v_lukket := public.firma_faktura_handel_lukket(p_trade);

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

  if not v_lukket then
    -- 1. Kontoens adresse (public.bruger_adresser, 20261102340000).
    if to_regclass('public.bruger_adresser') is not null then
      execute $q$select nullif(btrim(ba.adresse), ''), nullif(btrim(ba.postnummer), ''), nullif(btrim(ba.bynavn), '')
                   from public.bruger_adresser ba where ba.bruger_id = $1$q$
        into v_adr, v_post, v_by
        using t.buyer_id;
      if v_adr is not null and v_post is not null and v_by is not null then
        v_kilde := 'konto';
      else
        v_adr := null; v_post := null; v_by := null;
      end if;
    end if;

    -- 2. Adressen fra checkout (levering til døren).
    if v_kilde is null and hl.maade = 'doer'
       and nullif(btrim(hl.modtager_adresse), '') is not null then
      v_adr := btrim(hl.modtager_adresse); v_post := nullif(btrim(hl.modtager_postnummer), '');
      v_by := nullif(btrim(hl.modtager_by), '');
      v_kilde := 'checkout';
    end if;
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
    'adresse_kilde', case when v_lukket then 'skjult' else v_kilde end);
end;
$fn$;
revoke all on function public.firma_faktura_koeber_auto(uuid) from public, anon, authenticated;
grant execute on function public.firma_faktura_koeber_auto(uuid) to service_role;

-- ===========================================================================
-- Fakturaens indhold (erstatter 20261102330000)
-- ===========================================================================
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
  v_stand text;
  v_logo text;
  v_lukket boolean := false;
  v_moms boolean;
begin
  select * into f from public.firma_fakturaer x where x.id = p_id;
  if not found then
    return null;
  end if;
  v_moms := f.momsordning = 'moms';
  select * into fm from public.firmaer x where x.id = f.firma_id;
  perform public.firma_faktura_indstillinger_sikr(f.firma_id);
  select * into i from public.firma_faktura_indstillinger x where x.firma_id = f.firma_id;
  select * into su from public.users x where x.id = f.saelger_id;
  v_logo := case when i.vis_logo then nullif(btrim(su.avatar_url), '') end;

  if f.type = 'kreditnota' then
    -- Kreditnota: samme køber og linjer som den sendte faktura, modsat fortegn.
    select * into o from public.firma_fakturaer x where x.id = f.krediterer_id;
    if o.status is distinct from 'sendt' then
      return null;
    end if;
    v_k := o.data -> 'koeber';
    v_stand := o.data ->> 'vare_stand';
    v_kred := jsonb_build_object('id', o.id, 'fakturanummer', o.fakturanummer, 'udstedt_dato', o.udstedt_dato);
    -- Ældre øjebliksbilleder har ikke enhedspris ekskl. moms: = netto / antal.
    select coalesce(jsonb_agg(l || jsonb_build_object(
             'enhedspris_oere', -((l->>'enhedspris_oere')::bigint),
             'beloeb_oere', -((l->>'beloeb_oere')::bigint),
             'netto_oere', case when v_moms and l->>'netto_oere' is not null then -((l->>'netto_oere')::bigint) end,
             'moms_oere', case when v_moms and l->>'moms_oere' is not null then -((l->>'moms_oere')::bigint) end,
             'enhedspris_ekskl_moms_oere', case when v_moms then
                 -(coalesce((l->>'enhedspris_ekskl_moms_oere')::bigint,
                            round((l->>'netto_oere')::numeric / greatest(coalesce((l->>'antal')::int, 1), 1))::bigint)) end,
             'moms_sats', case when v_moms then 25 end)
             order by n), '[]'::jsonb)
      into v_linjer
      from jsonb_array_elements(o.data -> 'linjer') with ordinality as e(l, n);
    v_lev := (o.data ->> 'leveringsdato')::date;
  else
    select * into t from public.trades x where x.id = f.trade_id;
    select * into b from public.betalinger x where x.trade_id = f.trade_id;
    select * into a from public.auctions x where x.id = t.auction_id;
    v_lukket := public.firma_faktura_handel_lukket(f.trade_id);
    v_auto := public.firma_faktura_koeber_auto(f.trade_id);
    v_k := jsonb_build_object(
      'navn',       coalesce(f.koeber_navn, v_auto->>'navn'),
      'adresse',    case when v_lukket then null else coalesce(f.koeber_adresse, v_auto->>'adresse') end,
      'postnummer', case when v_lukket then null else coalesce(f.koeber_postnummer, v_auto->>'postnummer') end,
      'by',         case when v_lukket then null else coalesce(f.koeber_by, v_auto->>'by') end,
      'email',      coalesce(f.koeber_email, v_auto->>'email'),
      'firmanavn',  f.koeber_firmanavn,
      'cvr',        f.koeber_cvr);

    v_stand := public.stand_normaliser(a.stand);
    -- Varen: buddet inkl. moms. Fragt og BidHamrs gebyrer står ikke her.
    v_inkl := coalesce(b.bud_oere, round(t.amount * 100)::bigint);
    v_tekst := coalesce(f.varetekst,
                        left(concat_ws(' ', nullif(btrim(a.titel), ''),
                                       case when nullif(btrim(a.stand), '') is not null
                                            then '(stand: ' ||
                                                 case v_stand
                                                   when 'ny_med_maerke' then 'ny med mærke'
                                                   when 'som_ny' then 'som ny'
                                                   when 'god' then 'god'
                                                   when 'brugt' then 'brugt'
                                                   when 'defekt' then 'defekt'
                                                   else btrim(a.stand) end || ')' end), 300),
                        'Vare');
    v_netto := public.firma_faktura_netto(v_inkl);
    -- Antal er altid 1 (én auktion = én vare): enhedspris = beløb.
    v_linjer := jsonb_build_array(jsonb_build_object(
      'tekst', v_tekst,
      'antal', 1,
      'enhedspris_oere', v_inkl,
      'beloeb_oere', v_inkl,
      'enhedspris_ekskl_moms_oere', case when v_moms then v_netto end,
      'netto_oere', case when v_moms then v_netto end,
      'moms_sats', case when v_moms then 25 end,
      'moms_oere', case when v_moms then v_inkl - v_netto end));
    v_lev := coalesce(f.leveringsdato,
                      (coalesce(t.received_at, t.sendt_kl, b.betalt_kl) at time zone 'Europe/Copenhagen')::date);

    if b.betalt_kl is null then
      v_mangler := array_append(v_mangler, 'ikke_betalt'::text);
    end if;
    if v_lukket then
      v_mangler := array_append(v_mangler, 'refunderet'::text);
    end if;
    if v_inkl is null or v_inkl <= 0 then
      v_mangler := array_append(v_mangler, 'beloeb'::text);
    end if;
  end if;

  if not v_lukket then
    if nullif(v_k->>'navn', '') is null then v_mangler := array_append(v_mangler, 'koeber_navn'::text); end if;
    if nullif(v_k->>'adresse', '') is null then v_mangler := array_append(v_mangler, 'koeber_adresse'::text); end if;
    if coalesce(v_k->>'postnummer', '') !~ '^[0-9]{4}$' then v_mangler := array_append(v_mangler, 'koeber_postnummer'::text); end if;
    if nullif(v_k->>'by', '') is null then v_mangler := array_append(v_mangler, 'koeber_by'::text); end if;
    if coalesce(v_k->>'email', '') !~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$' then
      v_mangler := array_append(v_mangler, 'koeber_email'::text);
    end if;
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
      'logo_url', v_logo,
      -- Stien i avatar-bucketten (fastholdes i øjebliksbilledet).
      'logo_sti', substring(v_logo from '/storage/v1/object/public/avatarer/([^?#]+)$')),
    'koeber', v_k,
    'linjer', v_linjer,
    'vare_stand', v_stand,
    'momsordning', f.momsordning,
    'moms_sats', case when v_moms then 25 end,
    'beloeb_ekskl_moms_oere', case when v_moms
      then (select sum((l->>'netto_oere')::bigint) from jsonb_array_elements(v_linjer) l) end,
    'moms_oere', case when v_moms
      then (select sum((l->>'moms_oere')::bigint) from jsonb_array_elements(v_linjer) l) end,
    'total_oere', (select coalesce(sum((l->>'beloeb_oere')::bigint), 0) from jsonb_array_elements(v_linjer) l),
    'brugtmoms_tekst', case when not v_moms then 'Fortjenstmargenordning – brugte genstande' end,
    'brugtmoms_forklaring', case when not v_moms then
      'Varen sælges efter brugtmomsordningen. Momsen står ikke på fakturaen og kan ikke trækkes fra.' end,
    'leveringsdato', v_lev,
    'betalingstekst', i.betalingstekst,
    'mangler', to_jsonb(v_mangler));
end;
$fn$;
revoke all on function public.firma_faktura_byg(uuid) from public, anon, authenticated;

-- Afviger modtager-e-mailen fra købers egen? (til visning og log)
create or replace function public.firma_faktura_email_afviger(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select f.koeber_email is not null
         and lower(f.koeber_email) is distinct from lower(public.firma_faktura_koeber_auto(f.trade_id)->>'email')
    from public.firma_fakturaer f
   where f.id = p_id and f.type = 'faktura'
$fn$;
revoke all on function public.firma_faktura_email_afviger(uuid) from public, anon, authenticated;

-- ===========================================================================
-- Liste og hent (læse - også lukkede konti)
-- ===========================================================================
create or replace function public.firma_faktura_raekke_json(p_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
           'id', x.id,
           'type', x.type,
           'status', x.status,
           'trade_id', x.trade_id,
           'krediterer_id', x.krediterer_id,
           'kreditnota_id', (select k.id from public.firma_fakturaer k
                              where k.krediterer_id = x.id and k.type = 'kreditnota'),
           'kreditnota_status', (select k.status from public.firma_fakturaer k
                                  where k.krediterer_id = x.id and k.type = 'kreditnota'),
           'krediteret_kl', x.krediteret_kl,
           -- Den nye faktura på handlen (efter kreditnota), hvis den findes.
           'ny_faktura_id', case when x.krediteret_kl is not null then
               (select n.id from public.firma_fakturaer n
                 where n.trade_id = x.trade_id and n.type = 'faktura' and n.krediteret_kl is null) end,
           'kan_lave_ny', x.type = 'faktura' and x.krediteret_kl is not null
               and not exists (select 1 from public.firma_fakturaer n
                                where n.trade_id = x.trade_id and n.type = 'faktura' and n.krediteret_kl is null)
               and not public.firma_faktura_handel_lukket(x.trade_id),
           'momsordning_fra_standard', x.momsordning_fra_standard,
           'email_afviger', coalesce(public.firma_faktura_email_afviger(x.id), false),
           'fakturanummer', x.fakturanummer,
           'nummer', x.nummer,
           'sendt_kl', x.sendt_kl,
           'mail_sendt_kl', x.mail_sendt_kl,
           'mail_fejl', x.mail_fejl,
           'oprettet_kl', x.oprettet_kl,
           'data', case when x.status = 'sendt' then x.data else public.firma_faktura_byg(x.id) end)
    from public.firma_fakturaer x
   where x.id = p_id
$fn$;
revoke all on function public.firma_faktura_raekke_json(uuid) from public, anon, authenticated;

create or replace function public.firma_fakturaer_liste()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_firma uuid := public.firma_faktura_mit_firma_laes();
  v_aaben boolean := public.firma_faktura_mit_firma() is not null;
  i       record;
  v_sendt boolean;
begin
  if auth.uid() is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if v_firma is null then
    return null;
  end if;
  -- Nye kladder kun for åbne konti (en lukket konto kan ikke sende).
  if v_aaben then
    perform public.firma_faktura_opret_kladder(v_firma);
  else
    perform public.firma_faktura_indstillinger_sikr(v_firma);
  end if;
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
      'nummer_laast', v_sendt,
      'kun_laes', not v_aaben),
    'fakturaer', coalesce((
      select jsonb_agg(public.firma_faktura_raekke_json(r.id) order by r.oprettet_kl desc)
        from (select x.id, x.oprettet_kl
                from public.firma_fakturaer x
               where x.firma_id = v_firma
               order by x.oprettet_kl desc
               limit 5000) r), '[]'::jsonb));
end;
$fn$;
revoke all on function public.firma_fakturaer_liste() from public, anon;
grant execute on function public.firma_fakturaer_liste() to authenticated;

create or replace function public.firma_faktura_hent(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_firma uuid := public.firma_faktura_mit_firma_laes();
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
  return public.firma_faktura_raekke_json(x.id) || jsonb_build_object(
    'pdf_sti', x.pdf_sti,
    'kun_laes', public.firma_faktura_mit_firma() is null,
    'standard_momsordning', i.momsordning,
    'naeste_fakturanummer', public.firma_faktura_nummer_tekst(i.praefiks, i.naeste_nummer, i.cifre),
    'rettelser', jsonb_build_object(
      'koeber_navn', x.koeber_navn, 'koeber_adresse', x.koeber_adresse,
      'koeber_postnummer', x.koeber_postnummer, 'koeber_by', x.koeber_by,
      'koeber_email', x.koeber_email, 'koeber_firmanavn', x.koeber_firmanavn,
      'koeber_cvr', x.koeber_cvr, 'leveringsdato', x.leveringsdato, 'varetekst', x.varetekst));
end;
$fn$;
revoke all on function public.firma_faktura_hent(uuid) from public, anon;
grant execute on function public.firma_faktura_hent(uuid) to authenticated;

-- Eksport: sendte fakturaer og kreditnotaer udstedt i perioden, sorteret
-- efter nummer, side for side (p_efter = sidste nummer på forrige side).
-- Intet samlet loft - kalderen henter, til siden er tom.
create or replace function public.firma_fakturaer_eksport(p_fra date, p_til date, p_efter integer default 0, p_antal integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_firma uuid := public.firma_faktura_mit_firma_laes();
begin
  if auth.uid() is null or v_firma is null then
    raise exception 'Ingen adgang.' using errcode = '42501';
  end if;
  if p_fra is null or p_til is null or p_fra > p_til then
    raise exception 'Ugyldig periode.' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'firma_id', x.firma_id, 'saelger_id', x.saelger_id,
                                        'koeber_id', x.koeber_id, 'nummer', x.nummer, 'pdf_sti', x.pdf_sti,
                                        'mail_sendt_kl', x.mail_sendt_kl, 'logo_sha256', x.logo_sha256,
                                        'data', x.data) order by x.nummer)
      from (select * from public.firma_fakturaer f
             where f.firma_id = v_firma and f.status = 'sendt'
               and f.udstedt_dato between p_fra and p_til
               and f.nummer > coalesce(p_efter, 0)
             order by f.nummer
             limit least(greatest(coalesce(p_antal, 500), 1), 1000)) x), '[]'::jsonb);
end;
$fn$;
revoke all on function public.firma_fakturaer_eksport(date, date, integer, integer) from public, anon;
grant execute on function public.firma_fakturaer_eksport(date, date, integer, integer) to authenticated;

-- ===========================================================================
-- Ret kladden: log, når modtager-e-mailen afviger fra købers (punkt 7)
-- ===========================================================================
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
  x       record;
  v_email text := nullif(lower(btrim(p_koeber_email)), '');
  v_auto  text;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select * into x from public.firma_fakturaer f
   where f.id = p_id and f.firma_id = v_firma and f.saelger_id = v_uid;
  if not found or v_firma is null then
    raise exception 'Fakturaen findes ikke.' using errcode = '42501';
  end if;
  if x.type = 'kreditnota' then
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
         koeber_email = v_email,
         koeber_firmanavn = nullif(btrim(p_koeber_firmanavn), ''),
         koeber_cvr = nullif(regexp_replace(coalesce(p_koeber_cvr, ''), '[\s-]', '', 'g'), ''),
         leveringsdato = p_leveringsdato,
         varetekst = nullif(btrim(p_varetekst), '')
   where f.id = p_id and f.status = 'kladde';
  if not found then
    raise exception 'Fakturaen er sendt og kan ikke ændres. Lav en kreditnota.' using errcode = 'BHF10';
  end if;
  if v_email is distinct from x.koeber_email and v_email is not null then
    v_auto := public.firma_faktura_koeber_auto(x.trade_id)->>'email';
    if v_email is distinct from lower(v_auto) then
      insert into public.firma_faktura_log (faktura_id, firma_id, bruger_id, handling, gammel, ny)
      values (p_id, v_firma, v_uid, 'email_afviger', v_auto, v_email);
    end if;
  end if;
  return public.firma_faktura_byg(p_id);
end;
$fn$;
revoke all on function public.firma_faktura_kladde_gem(uuid, text, text, text, text, text, text, text, date, text) from public, anon;
grant execute on function public.firma_faktura_kladde_gem(uuid, text, text, text, text, text, text, text, date, text) to authenticated;

-- ===========================================================================
-- Skift momsordning på en KLADDE (punkt 2)
-- ===========================================================================
create or replace function public.firma_faktura_kladde_momsordning(p_id uuid, p_momsordning text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid := public.firma_faktura_mit_firma();
  x       record;
begin
  if v_uid is null or v_firma is null then
    raise exception 'Kun firmaet selv kan ændre sine fakturaer.' using errcode = '42501';
  end if;
  if p_momsordning is null or p_momsordning not in ('moms', 'brugtmoms') then
    raise exception 'Ugyldig momsordning.' using errcode = '22023';
  end if;
  select * into x from public.firma_fakturaer f
   where f.id = p_id and f.firma_id = v_firma and f.saelger_id = v_uid
   for update;
  if not found then
    raise exception 'Fakturaen findes ikke.' using errcode = '42501';
  end if;
  if x.type <> 'faktura' then
    raise exception 'En kreditnota har samme momsordning som fakturaen.' using errcode = '22023';
  end if;
  update public.firma_fakturaer f
     set momsordning = p_momsordning, momsordning_fra_standard = false
   where f.id = p_id and f.status = 'kladde';
  if not found then
    raise exception 'Fakturaen er sendt og kan ikke ændres. Lav en kreditnota.' using errcode = 'BHF10';
  end if;
  if x.momsordning is distinct from p_momsordning then
    insert into public.firma_faktura_log (faktura_id, firma_id, bruger_id, handling, gammel, ny)
    values (p_id, v_firma, v_uid, 'momsordning', x.momsordning, p_momsordning);
  end if;
  return public.firma_faktura_byg(p_id);
end;
$fn$;
revoke all on function public.firma_faktura_kladde_momsordning(uuid, text) from public, anon;
grant execute on function public.firma_faktura_kladde_momsordning(uuid, text) to authenticated;

-- ===========================================================================
-- "Lav ny faktura" efter en sendt kreditnota (punkt 2). Kun firmaets tryk.
-- Idempotent: findes der allerede en ikke-krediteret faktura på handlen,
-- gives dens id.
-- ===========================================================================
create or replace function public.firma_faktura_ny(p_trade uuid, p_momsordning text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid := public.firma_faktura_mit_firma();
  o       record;
  a       record;
  i       record;
  v_id    uuid;
  v_moms  text;
  v_status text;
begin
  if v_uid is null or v_firma is null then
    raise exception 'Kun firmaet selv kan lave en faktura.' using errcode = '42501';
  end if;
  if p_momsordning is not null and p_momsordning not in ('moms', 'brugtmoms') then
    raise exception 'Ugyldig momsordning.' using errcode = '22023';
  end if;
  -- Den seneste krediterede faktura på handlen (firmaets egen).
  select * into o from public.firma_fakturaer f
   where f.trade_id = p_trade and f.firma_id = v_firma and f.saelger_id = v_uid and f.type = 'faktura'
   order by f.oprettet_kl desc limit 1;
  if not found then
    raise exception 'Fakturaen findes ikke.' using errcode = '42501';
  end if;
  select f.id, f.status into v_id, v_status from public.firma_fakturaer f
   where f.trade_id = p_trade and f.type = 'faktura' and f.krediteret_kl is null;
  if v_id is not null then
    if v_status = 'kladde' then
      return v_id;
    end if;
    -- Den sendte faktura er ikke krediteret endnu (kreditnotaen er ikke sendt).
    raise exception 'kreditnota_mangler: Send en kreditnota på fakturaen først.' using errcode = '22023';
  end if;
  if public.firma_faktura_handel_lukket(p_trade) then
    raise exception 'Købet er betalt tilbage eller annulleret. Der skal ikke laves en ny faktura.' using errcode = '22023';
  end if;
  perform public.firma_faktura_indstillinger_sikr(v_firma);
  select * into i from public.firma_faktura_indstillinger s where s.firma_id = v_firma;
  select au.* into a from public.trades t left join public.auctions au on au.id = t.auction_id where t.id = p_trade;
  v_moms := coalesce(p_momsordning, a.momsordning, i.momsordning);
  insert into public.firma_fakturaer (firma_id, saelger_id, koeber_id, trade_id, type, status, momsordning, momsordning_fra_standard)
  values (o.firma_id, o.saelger_id, o.koeber_id, o.trade_id, 'faktura', 'kladde', v_moms,
          p_momsordning is null and a.momsordning is null)
  on conflict (trade_id) where type = 'faktura' and krediteret_kl is null do nothing
  returning id into v_id;
  if v_id is null then
    select f.id into v_id from public.firma_fakturaer f
     where f.trade_id = p_trade and f.type = 'faktura' and f.krediteret_kl is null;
  else
    insert into public.firma_faktura_log (faktura_id, firma_id, bruger_id, handling, gammel, ny, detaljer)
    values (v_id, v_firma, v_uid, 'ny_faktura', o.fakturanummer, v_moms, jsonb_build_object('krediteret_faktura', o.id));
  end if;
  return v_id;
end;
$fn$;
revoke all on function public.firma_faktura_ny(uuid, text) from public, anon;
grant execute on function public.firma_faktura_ny(uuid, text) to authenticated;

-- ===========================================================================
-- SEND (erstatter 20261102330000). Den ENESTE vej til status 'sendt'.
-- Manglerne tjekkes igen EFTER låsen; er der nogen, rulles alt tilbage
-- (raise), så nummeret ikke bruges. Sendes en kreditnota, markeres
-- fakturaen som krediteret i samme transaktion.
-- ===========================================================================
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
  v_data := public.firma_faktura_byg(p_id);
  if v_data is null or jsonb_array_length(v_data -> 'mangler') > 0 then
    -- Noget ændrede sig, mens vi ventede på låsen: rul alt tilbage (også
    -- nummeret).
    raise exception 'mangler_efter_laas: %', coalesce((v_data -> 'mangler')::text, '[]')
      using errcode = 'BHF12';
  end if;
  v_data := v_data || jsonb_build_object(
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

  if x.type = 'kreditnota' then
    perform set_config('bidhamr.firma_faktura_kredit', x.krediterer_id::text, true);
    update public.firma_fakturaer o
       set krediteret_kl = now()
     where o.id = x.krediterer_id and o.krediteret_kl is null;
    perform set_config('bidhamr.firma_faktura_kredit', '', true);
  end if;

  return jsonb_build_object('kode', 'sendt', 'id', p_id, 'fakturanummer', v_fnr, 'data', v_data);
end;
$fn$;
revoke all on function public.firma_faktura_send(uuid) from public, anon;
grant execute on function public.firma_faktura_send(uuid) to authenticated;

-- ===========================================================================
-- Service role: PDF-sti og logo-hash én gang (punkt 9)
-- ===========================================================================
drop function if exists public.firma_faktura_gem_pdf(uuid, text);
create or replace function public.firma_faktura_gem_pdf(p_id uuid, p_sti text, p_logo_sha256 text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.firma_fakturaer f
     set pdf_sti = p_sti,
         logo_sha256 = coalesce(f.logo_sha256, p_logo_sha256)
   where f.id = p_id and f.status = 'sendt' and f.pdf_sti is null;
  return found;
end;
$fn$;
revoke all on function public.firma_faktura_gem_pdf(uuid, text, text) from public, anon, authenticated;
grant execute on function public.firma_faktura_gem_pdf(uuid, text, text) to service_role;
