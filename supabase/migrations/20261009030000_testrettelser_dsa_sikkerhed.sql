-- Rettelser efter test af DSA og sikkerhedsrettelserne (okt. 2026).
--
-- Idempotent: kan koeres flere gange. Skal koeres i baade test og produktion.
--
--  1. Storage: stoerrelses- og filtypegraenser paa auktion-billeder og
--     avatarer. Produktion havde allerede graenser sat i dashboardet
--     (auktion-billeder 5 MB, avatarer 2 MB, samme filtyper) - testdatabasen
--     havde ingen. Nu ens begge steder: avatarer 2 MB, auktion-billeder 10 MB
--     (som sag-billeder og pakke-billeder, saa appen kan uploade fotos fra
--     telefonen). Hjemmesiden genkoder alle billeder som JPEG (hoejst 2000 px)
--     foer upload. Kun billedtyper - aldrig svg/html. Graenserne gaelder kun
--     nye uploads; tjekket i produktion 2026-10-06: alle eksisterende filer er
--     jpeg/png og under graenserne.
--     Tilbagerulning: update storage.buckets set file_size_limit = null,
--     allowed_mime_types = null where id in ('auktion-billeder', 'avatarer').
--  2. dsa_regler(): henvisningen for forbudte varer havde dobbelt parentes,
--     naar den blev vist som "navn (henvisning)". Gamle afgoerelser beholder
--     deres oejebliksbillede (regel_tekst) uaendret.
--  3. Rate limit kun for MISLYKKEDE logins: rate_limit_status (tjek uden at
--     taelle op) og rate_limit_nulstil (nulstil e-mail+IP efter et
--     gennemfoert login). Kun service_role (src/lib/rateLimit.ts).

set lock_timeout = '5s';

-- =====================================================================
-- 1. Storage-graenser
-- =====================================================================
update storage.buckets
   set file_size_limit = 2097152,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
 where id = 'avatarer';

update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
 where id = 'auktion-billeder';

-- =====================================================================
-- 2. dsa_regler(): ingen dobbelt parentes
-- =====================================================================
-- Spejles i src/lib/dsa/regler.ts.
create or replace function public.dsa_regler()
returns table (kode text, navn text, grundlag text, henvisning text)
language sql
immutable
set search_path = ''
as $fn$
  select * from (values
    ('forbudt_vare',            'Varen må ikke sælges på BidHamr',                    'vilkaar', 'BidHamrs regler om forbudte varer, se bidhamr.dk/forbudte-varer'),
    ('ulovlig_vare',            'Varen er ulovlig at sælge',                          'lov',     'Dansk lovgivning, fx våbenloven, lov om euforiserende stoffer og dyrevelfærdsloven'),
    ('falsk_vare',              'Kopivare eller krænkelse af et varemærke',           'lov',     'Varemærkeloven'),
    ('ophavsret',               'Krænkelse af ophavsret (fx kopierede billeder)',     'lov',     'Ophavsretsloven'),
    ('svindel',                 'Svindel eller vildledning',                          'lov',     'Straffeloven § 279 og BidHamrs regler'),
    ('personoplysninger',       'Deling af andres personoplysninger',                 'lov',     'Databeskyttelsesforordningen (GDPR)'),
    ('hadefuld_tale',           'Hadefuld eller truende tale',                        'lov',     'Straffeloven §§ 266 og 266 b'),
    ('misbrug_boern',           'Seksuelt misbrug af børn',                           'lov',     'Straffeloven § 235'),
    ('chikane',                 'Grove ord eller chikane',                            'vilkaar', 'BidHamrs regler for god opførsel'),
    ('kontaktinfo',             'Kontaktoplysninger eller handel uden om BidHamr',    'vilkaar', 'BidHamrs regler for handel på BidHamr'),
    ('ikke_relateret',          'Indholdet handler ikke om handlen',                  'vilkaar', 'BidHamrs regler for bedømmelser og spørgsmål'),
    ('spam',                    'Spam eller reklame',                                 'vilkaar', 'BidHamrs regler for god opførsel'),
    ('gentagne_overtraedelser', 'Gentagne overtrædelser (3 advarsler)',               'vilkaar', 'BidHamrs regler om advarsler'),
    ('andet',                   'Andet brud på BidHamrs regler',                      'vilkaar', 'BidHamrs regler')
  ) as r(kode, navn, grundlag, henvisning);
$fn$;

revoke all on function public.dsa_regler() from public, anon, authenticated;
grant execute on function public.dsa_regler() to service_role;

-- =====================================================================
-- 3. Rate limit: tjek uden at taelle op, og nulstil
-- =====================================================================
-- Samme faste tidsvindue som rate_limit_tjek. true = der er forsoeg tilbage.
create or replace function public.rate_limit_status(p_noegle text, p_maks integer, p_vindue_sek integer)
returns boolean
language plpgsql
stable
set search_path = ''
as $fn$
declare
  start timestamptz;
  n integer;
begin
  if p_noegle is null or length(p_noegle) > 400 or p_maks < 1 or p_vindue_sek < 1 then
    raise exception 'Ugyldige parametre';
  end if;
  start := to_timestamp(floor(extract(epoch from now()) / p_vindue_sek) * p_vindue_sek);
  select r.antal into n from public.rate_limits r where r.noegle = p_noegle and r.vindue_start = start;
  return coalesce(n, 0) < p_maks;
end;
$fn$;

create or replace function public.rate_limit_nulstil(p_noegle text)
returns void
language sql
set search_path = ''
as $fn$
  delete from public.rate_limits where noegle = p_noegle;
$fn$;

revoke all on function public.rate_limit_status(text, integer, integer) from public, anon, authenticated;
revoke all on function public.rate_limit_nulstil(text) from public, anon, authenticated;
grant execute on function public.rate_limit_status(text, integer, integer) to service_role;
grant execute on function public.rate_limit_nulstil(text) to service_role;
