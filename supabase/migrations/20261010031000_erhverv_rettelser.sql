-- Erhvervskonti - rettelser efter review af 20261010030000_erhverv.sql.
-- Køres EFTER 20261010030000. Idempotent (create or replace / if not exists /
-- cron.schedule med fast navn / flet ind i nuværende definition).
--
--   1. erhverv_firma_opdater: ÆNDRING af pakke, status, firmanavn eller CVR
--      kræver chef (svarer 'kun_chef'). Sælger må kun rette adresse og
--      kontaktoplysninger. En pakke lig den nuværende er "uændret" (sletter
--      ikke længere en planlagt nedgradering).
--   2. GDPR: afviste/arkiverede henvendelser uden firma anonymiseres 12
--      måneder efter sidste behandling (erhverv_henvendelser_anonymiser, cron
--      'erhverv-anonymisering'). Henvendelser fra en indlogget afsender
--      (bruger_id) kommer med i mine_data ('erhverv_henvendelser').
--   3. ip_hash gemmes ikke længere (serveren sender null). Eksisterende
--      værdier nulstilles. Kolonnen bevares.
--   4. erhverv_firma_opret: auth-brugeren skal være en uafsluttet INVITATION
--      (invited_at sat, ingen adgangskode, aldrig logget ind) - en uafsluttet
--      privat signup kan aldrig blive firmakonto.
--      erhverv_tom_konto_ryd: fjerner public.users-rækken for en helt ny, tom
--      invitationskonto (< 5 min, ingen aktivitet), når erhverv_firma_opret
--      fejler; serveren sletter derefter auth-brugeren via admin API.
--   5. Stripe-kroge: firma_abonnement_mislykket ignorerer hændelsen, når
--      betalt_til allerede dækker perioden (ny parameter p_periode_slut) eller
--      fakturaen allerede er betalt. firma_pakkeskift_betalt svarer
--      'betalt_men_ikke_afventende' og logger en drift-alarm (kilde webhook),
--      hvis skiftet ikke længere afventer betaling.
--   6. (rate limit erhverv_alle - kun i src/lib/rateLimit.ts)
--   7. Beskyttelse afvises også på betalinger og andenchance-tilbud for
--      erhvervsauktioner (flettet med kun-afhentning-reglen).
--   8. firma_abonnement_frist_koer køres nu dagligt (cron
--      'erhverv-betalingsfrist') - den var ikke planlagt i 030000.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. erhverv_firma_opdater: chef for pakke/status/firmanavn/CVR
-- ---------------------------------------------------------------------------
create or replace function public.erhverv_firma_opdater(
  p_staff uuid, p_firma uuid, p_pakke uuid default null, p_status text default null,
  p_firmanavn text default null, p_cvr text default null, p_adresse text default null,
  p_postnummer text default null, p_by text default null, p_telefon text default null,
  p_kontakt_email text default null, p_kontaktperson text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.firmaer;
  v_tekst  text[] := '{}';
  v_pakke  uuid;
  v_status text;
  v_navn   text := nullif(btrim(p_firmanavn), '');
  v_cvr    text;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_status is not null and p_status not in ('aktiv', 'pauset', 'opsagt') then
    return jsonb_build_object('kode', 'ugyldig_status');
  end if;
  if p_pakke is not null and not exists (select 1 from public.erhverv_pakker where id = p_pakke) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if p_cvr is not null and p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;

  -- Kun egentlige ændringer tæller (en formular sender ofte alle felter).
  v_pakke  := case when p_pakke is distinct from f.pakke_id then p_pakke end;
  v_status := case when p_status is distinct from f.abonnement_status then p_status end;
  v_cvr    := case when p_cvr is distinct from f.cvr then p_cvr end;
  if v_navn is not distinct from f.firmanavn then
    v_navn := null;
  end if;

  -- Pakke, status, firmanavn og CVR: kun chef. Sælger retter adresse/kontakt.
  if (v_pakke is not null or v_status is not null or v_navn is not null or v_cvr is not null)
     and not public.erhverv_har_adgang(p_staff, true) then
    return jsonb_build_object('kode', 'kun_chef');
  end if;

  begin
    update public.firmaer
       set firmanavn      = coalesce(v_navn, firmanavn),
           cvr            = coalesce(v_cvr, cvr),
           adresse        = coalesce(nullif(btrim(p_adresse), ''), adresse),
           postnummer     = coalesce(nullif(btrim(p_postnummer), ''), postnummer),
           bynavn         = coalesce(nullif(btrim(p_by), ''), bynavn),
           telefon        = coalesce(nullif(btrim(p_telefon), ''), telefon),
           kontakt_email  = coalesce(lower(nullif(btrim(p_kontakt_email), '')), kontakt_email),
           kontaktperson  = coalesce(nullif(btrim(p_kontaktperson), ''), kontaktperson),
           abonnement_status = coalesce(v_status, abonnement_status),
           pauset_aarsag  = case when v_status is null then pauset_aarsag
                                 when v_status = 'pauset' then 'bidhamr' else null end,
           opsagt_kl      = case when v_status = 'opsagt' then coalesce(opsagt_kl, now())
                                 when v_status is not null then null else opsagt_kl end,
           pakke_id       = coalesce(v_pakke, pakke_id),
           naeste_pakke_id  = case when v_pakke is not null then null else naeste_pakke_id end,
           naeste_pakke_fra = case when v_pakke is not null then null else naeste_pakke_fra end,
           opdateret_kl   = now()
     where id = p_firma;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  if v_navn is not null then
    update public.users set navn = left(v_navn, 200) where id = f.bruger_id;
  end if;

  if v_pakke is not null then
    update public.firma_pakkeskift
       set status = case when til_pakke_id = v_pakke and status = 'afventer_betaling' then 'gennemfoert' else 'annulleret' end,
           behandlet_kl = now(),
           note = coalesce(note, 'Afgjort af BidHamr')
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl, note)
    values (f.id, f.pakke_id, v_pakke, 'bidhamr', 'gennemfoert', p_staff, now(), left(p_note, 1000));
    v_tekst := v_tekst || 'Pakke ændret'::text;
  end if;
  if v_status is not null then
    v_tekst := v_tekst || ('Status: ' || f.abonnement_status || ' → ' || v_status);
  end if;
  if coalesce(v_navn, v_cvr, p_adresse, p_postnummer, p_by, p_telefon, p_kontakt_email, p_kontaktperson) is not null then
    v_tekst := v_tekst || 'Firmaoplysninger ændret'::text;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_opdateret', 'firma', f.id, f.bruger_id,
          left(concat_ws('; ', array_to_string(v_tekst, '; '), nullif(btrim(coalesce(p_note, '')), ''),
                         f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));

  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. GDPR: anonymisering af gamle henvendelser + mine_data
-- ---------------------------------------------------------------------------
alter table public.erhverv_henvendelser add column if not exists anonymiseret_kl timestamptz;

comment on column public.erhverv_henvendelser.anonymiseret_kl is
  'Sat, når persondata er fjernet (erhverv_henvendelser_anonymiser): afviste/arkiverede henvendelser uden firma, 12 måneder efter sidste behandling. Firmanavn, CVR, status og datoer bevares. Opbevaringstiden afventer Filip/advokat (jura/noter-til-advokat.md nr. 74).';

comment on column public.erhverv_henvendelser.ip_hash is
  'Bruges ikke længere og gemmes ikke (altid null). Kolonnen bevares af hensyn til appen/ældre kode.';

-- ip_hash blev lavet med en servernøgle som HMAC-nøgle - fjern de gamle værdier.
update public.erhverv_henvendelser set ip_hash = null where ip_hash is not null;

-- Kandidater: afvist eller arkiveret, ikke knyttet til et firma, sidste
-- behandling (opdateret_kl, og arkiveret_kl) over 12 måneder siden.
create or replace function public.erhverv_henvendelser_anonymiser()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.erhverv_henvendelser h
     set kontaktperson   = '[anonymiseret]',
         telefon         = '[anonymiseret]',
         email           = '[anonymiseret]',
         adresse         = null,
         postnummer      = null,
         bynavn          = null,
         besked          = null,
         noter           = null,
         ip_hash         = null,
         bruger_id       = null,
         anonymiseret_kl = now()
   where h.id in (
           select x.id
             from public.erhverv_henvendelser x
            where x.anonymiseret_kl is null
              and (x.status = 'afvist' or x.arkiveret_kl is not null)
              and greatest(x.opdateret_kl, coalesce(x.arkiveret_kl, x.opdateret_kl), coalesce(x.behandlet_kl, x.opdateret_kl))
                  < now() - interval '12 months'
              and not exists (select 1 from public.firmaer f where f.henvendelse_id = x.id)
            order by x.oprettet_kl
            limit 5000
              for update skip locked);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.erhverv_henvendelser_anonymiser() from public, anon, authenticated;
grant execute on function public.erhverv_henvendelser_anonymiser() to service_role;

select cron.schedule('erhverv-anonymisering', '41 3 * * *', $$select public.erhverv_henvendelser_anonymiser();$$);

-- Firmaets/afsenderens egne henvendelser (indsendt som indlogget bruger).
-- Uden staffs interne noter og ip_hash (som mine_firmadata).
create or replace function public.mine_erhverv_henvendelser()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'firmanavn', h.firmanavn, 'cvr', h.cvr, 'kontaktperson', h.kontaktperson,
      'telefon', h.telefon, 'email', h.email, 'adresse', h.adresse, 'postnummer', h.postnummer,
      'by', h.bynavn, 'hvad_saelger_i', h.hvad_saelger_i, 'antal_varer_ca', h.antal_varer_ca,
      'besked', h.besked, 'status', h.status, 'sendt', h.oprettet_kl,
      'arkiveret', h.arkiveret_kl) order by h.oprettet_kl), '[]'::jsonb)
    from public.erhverv_henvendelser h
   where auth.uid() is not null and h.bruger_id = auth.uid();
$$;

revoke all on function public.mine_erhverv_henvendelser() from public, anon, authenticated;

do $$
declare
  v_def text := pg_get_functiondef('public.mine_data()'::regprocedure);
  v_gl  text := '''firmakonto'', public.mine_firmadata());';
  v_ny  text := '''firmakonto'', public.mine_firmadata(), ''erhverv_henvendelser'', public.mine_erhverv_henvendelser());';
begin
  if position('public.mine_erhverv_henvendelser()' in v_def) > 0 then
    return; -- allerede flettet
  end if;
  if position(v_gl in v_def) = 0 then
    raise exception 'mine_data har ikke den forventede slutning - flet erhverv_henvendelser ind manuelt';
  end if;
  execute replace(v_def, v_gl, v_ny);
end $$;

-- ---------------------------------------------------------------------------
-- 4. erhverv_firma_opret: kun en uafsluttet invitation + oprydning ved fejl
-- ---------------------------------------------------------------------------
create or replace function public.erhverv_firma_opret(
  p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text,
  p_by text, p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid,
  p_henvendelse uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  u    record;
  h    public.erhverv_henvendelser;
  v_id uuid;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;

  select * into u from public.users where id = p_bruger for update;
  if u.id is null then
    return jsonb_build_object('kode', 'bruger_findes_ikke');
  end if;
  -- Kun en helt ny konto: aldrig en eksisterende privat konto.
  if u.konto_type <> 'privat' or u.rolle <> 'bruger'
     or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or u.oprettet < now() - interval '1 hour'
     or exists (select 1 from public.auctions a where a.bruger_id = p_bruger)
     or exists (select 1 from public.bids b where b.bruger_id = p_bruger)
     or exists (select 1 from public.trades t where t.buyer_id = p_bruger or t.seller_id = p_bruger)
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;
  -- Og kun en uafsluttet INVITATION (generateLink 'invite' fra serveren):
  -- invited_at sat, ingen adgangskode, aldrig logget ind. En privat signup,
  -- der endnu ikke har indtastet sin kode, har en adgangskode og ingen
  -- invited_at - den kan aldrig blive firmakonto.
  if not exists (select 1 from auth.users au
                  where au.id = p_bruger
                    and au.invited_at is not null
                    and au.last_sign_in_at is null
                    and coalesce(au.encrypted_password, '') = ''
                    and au.created_at > now() - interval '1 hour') then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;

  if p_cvr is null or p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;
  if exists (select 1 from public.firmaer f where f.cvr = p_cvr and f.abonnement_status <> 'opsagt') then
    return jsonb_build_object('kode', 'cvr_findes');
  end if;
  if not exists (select 1 from public.erhverv_pakker p where p.id = p_pakke) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if p_henvendelse is not null then
    select * into h from public.erhverv_henvendelser where id = p_henvendelse for update;
    if h.id is null then
      return jsonb_build_object('kode', 'henvendelse_findes_ikke');
    end if;
    if exists (select 1 from public.firmaer f where f.henvendelse_id = p_henvendelse) then
      return jsonb_build_object('kode', 'henvendelse_brugt');
    end if;
  end if;

  begin
    insert into public.firmaer (bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon,
                                kontakt_email, kontaktperson, henvendelse_id, pakke_id, oprettet_af)
    values (p_bruger, btrim(p_firmanavn), p_cvr, btrim(p_adresse), btrim(p_postnummer), btrim(p_by),
            btrim(p_telefon), lower(btrim(p_kontakt_email)), btrim(p_kontaktperson), p_henvendelse,
            p_pakke, p_staff)
    returning id into v_id;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  update public.users
     set konto_type = 'erhverv',
         navn = left(btrim(p_firmanavn), 200),
         fornavn = null,
         efternavn = null,
         telefon = btrim(p_telefon)
   where id = p_bruger;

  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl)
  values (v_id, null, p_pakke, 'start', 'gennemfoert', p_staff, now());

  if p_henvendelse is not null then
    update public.erhverv_henvendelser
       set status = 'godkendt', behandlet_af = p_staff, behandlet_kl = now(), opdateret_kl = now()
     where id = p_henvendelse;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_oprettet', 'firma', v_id, p_bruger,
          left(btrim(p_firmanavn) || ' (CVR ' || p_cvr || ')', 1000));

  return jsonb_build_object('kode', 'ok', 'firma_id', v_id);
end $$;

revoke all on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid) to service_role;

-- Fejler erhverv_firma_opret efter generateLink, ligger der en tom konto.
-- Denne funktion fjerner public.users-rækken, men KUN for en helt ny, tom
-- invitationskonto: auth-brugeren er under 5 minutter gammel, inviteret,
-- uden adgangskode og har aldrig logget ind, og der er ingen aktivitet.
-- Serveren sletter derefter auth-brugeren via admin API (opretFirmakonto).
-- Svar: ok | findes_ikke (ingen auth-bruger) | ikke_tom.
create or replace function public.erhverv_tom_konto_ryd(p_staff uuid, p_bruger uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  au record;
  u  public.users;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;

  select a.id, a.created_at, a.invited_at, a.last_sign_in_at, a.encrypted_password
    into au from auth.users a where a.id = p_bruger;
  if au.id is null then
    return jsonb_build_object('kode', 'findes_ikke');
  end if;
  if au.created_at < now() - interval '5 minutes'
     or au.invited_at is null
     or au.last_sign_in_at is not null
     or coalesce(au.encrypted_password, '') <> '' then
    return jsonb_build_object('kode', 'ikke_tom');
  end if;

  select * into u from public.users where id = p_bruger for update;
  if u.id is null then
    return jsonb_build_object('kode', 'ok');
  end if;
  if u.konto_type <> 'privat' or u.rolle <> 'bruger'
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger)
     or exists (select 1 from public.auctions a where a.bruger_id = p_bruger)
     or exists (select 1 from public.bids b where b.bruger_id = p_bruger)
     or exists (select 1 from public.bud_maksimum m where m.bruger_id = p_bruger)
     or exists (select 1 from public.trades t where t.buyer_id = p_bruger or t.seller_id = p_bruger)
     or exists (select 1 from public.betalinger b where b.buyer_id = p_bruger or b.seller_id = p_bruger)
     or exists (select 1 from public.messages m where m.sender_id = p_bruger)
     or exists (select 1 from public.erhverv_henvendelser h where h.bruger_id = p_bruger)
     or exists (select 1 from public.moderation_log l where l.bruger_id = p_bruger or l.medarbejder_id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_tom');
  end if;

  perform set_config('bidhamr.tillad_brugersletning', 'ja', true);
  delete from public.users where id = p_bruger;
  perform set_config('bidhamr.tillad_brugersletning', '', true);
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.erhverv_tom_konto_ryd(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_tom_konto_ryd(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Stripe-kroge
-- ---------------------------------------------------------------------------

-- Opgradering betalt. Afventer skiftet ikke længere (fx har staff allerede
-- skiftet pakken manuelt, eller skiftet er annulleret), aktiveres intet:
-- svaret er 'betalt_men_ikke_afventende', og der logges en drift-alarm
-- (kilde 'webhook'), så Stripe-koden/staff refunderer eller undersøger.
create or replace function public.firma_pakkeskift_betalt(
  p_skift uuid, p_stripe_reference text, p_beloeb_oere bigint, p_stripe_invoice_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.firma_pakkeskift;
begin
  if p_stripe_reference is null or btrim(p_stripe_reference) = '' then
    raise exception 'Mangler Stripe-reference';
  end if;
  select * into s from public.firma_pakkeskift where id = p_skift for update;
  if s.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.status = 'gennemfoert' and s.stripe_reference = p_stripe_reference then
    return jsonb_build_object('kode', 'allerede_registreret');
  end if;
  if s.status <> 'afventer_betaling' then
    perform public.drift_fejl_log(
      'webhook', 'firma_pakkeskift_betalt',
      left(format('Opgradering betalt, men pakkeskiftet afventer ikke længere (status %s) - '
                  || 'refundér eller undersøg i Stripe. Skift %s, firma %s, reference %s, faktura %s, beløb %s øre.',
                  s.status, s.id, s.firma_id, p_stripe_reference, coalesce(p_stripe_invoice_id, '-'),
                  coalesce(p_beloeb_oere::text, '-')), 1000),
      'pakkeskift_betalt:' || s.id::text || ':' || p_stripe_reference,
      null);
    return jsonb_build_object('kode', 'betalt_men_ikke_afventende', 'status', s.status,
                              'firma_id', s.firma_id, 'skal_undersoeges', true);
  end if;

  perform 1 from public.firmaer where id = s.firma_id for update;

  update public.firma_pakkeskift
     set status = 'gennemfoert', behandlet_kl = now(), stripe_reference = p_stripe_reference
   where id = s.id;
  update public.firmaer
     set pakke_id = s.til_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
   where id = s.firma_id;
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = s.firma_id and status = 'planlagt';

  insert into public.firma_regninger (firma_id, type, periode_fra, beloeb_oere, status,
                                      stripe_invoice_id, stripe_reference, betalt_kl)
  values (s.firma_id, 'opgradering', (now() at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), 'betalt', p_stripe_invoice_id,
          'skift:' || p_stripe_reference, now())
  on conflict do nothing;

  return jsonb_build_object('kode', 'ok', 'firma_id', s.firma_id);
end $$;

revoke all on function public.firma_pakkeskift_betalt(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_betalt(uuid, text, bigint, text) to service_role;

-- Mislykket abonnementsbetaling. Ny parameter p_periode_slut (slutningen af
-- den periode, fakturaen gælder - Stripe: invoice.lines.data[0].period.end).
-- Hændelsen ignoreres ('allerede_betalt'), hvis betalt_til allerede dækker
-- perioden, eller fakturaen allerede er registreret som betalt - fx når et
-- forsinket payment_failed kommer efter et vellykket nyt forsøg.
drop function if exists public.firma_abonnement_mislykket(uuid, text, bigint, text);

create or replace function public.firma_abonnement_mislykket(
  p_firma uuid, p_stripe_reference text, p_beloeb_oere bigint default null,
  p_stripe_invoice_id text default null, p_periode_slut timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.firmaer;
begin
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if (p_periode_slut is not null and f.betalt_til is not null and f.betalt_til >= p_periode_slut)
     or (p_stripe_invoice_id is not null and exists (
           select 1 from public.firma_regninger r
            where r.firma_id = f.id and r.stripe_invoice_id = p_stripe_invoice_id and r.status = 'betalt')) then
    return jsonb_build_object('kode', 'allerede_betalt', 'betalt_til', f.betalt_til);
  end if;
  update public.firmaer
     set betaling_mislykket_kl = coalesce(betaling_mislykket_kl, now()), opdateret_kl = now()
   where id = f.id;
  if p_stripe_reference is not null then
    insert into public.firma_regninger (firma_id, type, beloeb_oere, status, stripe_invoice_id, stripe_reference)
    values (f.id, 'abonnement', greatest(coalesce(p_beloeb_oere, 0), 0), 'mislykket', p_stripe_invoice_id,
            'fejl:' || p_stripe_reference)
    on conflict do nothing;
  end if;
  return jsonb_build_object('kode', 'ok', 'pause_fra', coalesce(f.betaling_mislykket_kl, now()) + interval '7 days');
end $$;

revoke all on function public.firma_abonnement_mislykket(uuid, text, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.firma_abonnement_mislykket(uuid, text, bigint, text, timestamptz) to service_role;

-- 8. Pausen efter 7 dage uden betaling skal også ske (var ikke planlagt).
select cron.schedule('erhverv-betalingsfrist', '7 4 * * *', $$select public.firma_abonnement_frist_koer();$$);

-- ---------------------------------------------------------------------------
-- 7. Ingen BidHamr Beskyttelse på erhvervsauktioner - også på betalinger og
--    andenchance-tilbud (værn i dybden; flettet med kun-afhentning-reglen).
-- ---------------------------------------------------------------------------
create or replace function public.betalinger_beskyttelse_kun_afhentning()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if (new.beskyttelse or new.beskyttelse_oere <> 0)
     and (
       (new.fragt_oere = 0
        and exists (select 1 from public.trades t
                     where t.id = new.trade_id and t.afhentning))
       -- Køb fra erhverv: fortrydelses- og reklamationsret i stedet.
       or exists (select 1 from public.auctions a
                   where a.erhverv
                     and a.id = coalesce(new.auction_id,
                                         (select t.auction_id from public.trades t where t.id = new.trade_id)))
     ) then
    new.total_oere       := new.total_oere - new.beskyttelse_oere;
    new.beskyttelse      := false;
    new.beskyttelse_oere := 0;
  end if;
  return new;
end;
$function$;

create or replace function public.andenchance_beskyttelse_kun_afhentning()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(new.beskyttelse, false)
     and (
       not exists (select 1 from public.auctions a
                    where a.id = new.auction_id
                      and coalesce(a.forsendelse_mulig, false))
       -- Køb fra erhverv: fortrydelses- og reklamationsret i stedet.
       or exists (select 1 from public.auctions a
                   where a.id = new.auction_id and a.erhverv)
     ) then
    new.beskyttelse := false;
  end if;
  return new;
end;
$function$;
