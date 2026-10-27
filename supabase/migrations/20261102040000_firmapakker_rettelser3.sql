-- Firmapakker: tredje runde rettelser efter testerens fund (27. okt. 2026).
--
-- Bygger på 20261102020000_firmapakker_rettelser.sql og
-- 20261102030000_firmapakker_rettelser2.sql (rettes ikke - de er kørt på
-- testdatabasen).
--
-- Indhold:
--   1. erhverv_cvr_tidligere_json: "Betalte regninger" i advarslen om et CVR,
--      der har haft et abonnement før, talte også krediterede regninger med
--      (et firma, hvis regninger alle var refunderet, viste fx 15). Nu tælles
--      kun regninger med status 'betalt' og et beløb over 0. Hvilke firmaer
--      der vises (where-delen), er uændret.
--   2. firma_velkomst_billetter: velkomstlinket i mailen til en ny firmakonto
--      virkede kun i 1 time (Supabase-linkets levetid følger projektets "Email
--      OTP expiration", som ikke ændres). Mailen indeholder nu BidHamrs egen
--      billet, der gælder i 24 timer: GET /api/erhverv/velkomst?b=<billet>
--      laver et FRISK Supabase-link (generateLink 'recovery'), hver gang den
--      åbnes, og sender videre til mellemsiden /bekraeft (knappen logger ind).
--      Billetten virker ikke længere, når firmaet har logget ind, når den er
--      udløbet, eller når staff har sendt en ny (den gamle annulleres). Kun
--      hashen (sha256) af billetten gemmes. Kun service role har adgang.
--
-- md5-drift-tjek (mønstret fra 20261102020000/20261102030000): funktionen,
-- der erstattes, skal enten være repoets fra 20261102020000 eller allerede
-- denne migrations. Ellers afbrydes migrationen (intet ændres).
-- Idempotent (kan køres igen). Én transaktion. Kør først på testdatabasen.
-- KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Hjælper og drift-tjek
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

do $do$
declare
  r record;
  h text;
begin
  if to_regclass('public.erhverv_staff_klik') is null
     or to_regprocedure('public.firma_gratis_afstemt(uuid,text)') is null then
    raise exception 'Forudsætning mangler: kør 20261102020000 og 20261102030000 først';
  end if;
  for r in
    select * from (values
      -- (funktion, repoets fra 20261102020000, denne migrations)
      ('public.erhverv_cvr_tidligere_json(text)', '00aab2e14d9a755d85c71fb6f5af37f3', '8ff536b05b05a83ddfe9d953f767df61')
    ) as t(fn, gammel, ny)
  loop
    h := pg_temp.krop_md5(r.fn);
    if h is null then
      raise exception '% findes ikke - kør de tidligere migrationer først', r.fn;
    end if;
    if h <> r.gammel and h <> r.ny then
      raise exception '%: md5 % passer hverken med repoet (%) eller denne migration (%) - kontrollér funktionen, før migrationen køres',
        r.fn, h, r.gammel, r.ny;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 1. Betalte regninger i CVR-advarslen
-- ===========================================================================
-- Tidligere firmakonti med samme CVR, der har haft et abonnement (startet,
-- haft en gratis periode eller betalt en regning). betalte_regninger: kun
-- status 'betalt' med et beløb over 0 (ikke krediterede, ikke 0-kr.-regninger
-- fra en gratis periode).
create or replace function public.erhverv_cvr_tidligere_json(p_cvr text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'firma_id', f.id, 'firmanavn', f.firmanavn, 'abonnement_status', f.abonnement_status,
           'abonnement_start', f.abonnement_start, 'opsagt_kl', f.opsagt_kl,
           'havde_gratis_periode', f.proeve_givet_kl is not null,
           'betalte_regninger', (select count(*) from public.firma_regninger r
                                  where r.firma_id = f.id and r.status = 'betalt' and r.beloeb_oere > 0))
         order by f.oprettet_kl desc), '[]'::jsonb)
    from public.firmaer f
   where f.cvr = p_cvr
     and (f.stripe_subscription_id is not null or f.abonnement_start is not null or f.proeve_givet_kl is not null
          or exists (select 1 from public.firma_regninger r
                      where r.firma_id = f.id and r.status in ('betalt', 'krediteret') and r.beloeb_oere > 0));
$$;
revoke all on function public.erhverv_cvr_tidligere_json(text) from public, anon, authenticated, service_role;
comment on function public.erhverv_cvr_tidligere_json(text) is
  'Tidligere firmakonti med samme CVR, der har haft et abonnement. betalte_regninger = regninger med status betalt og beløb > 0. 20261102040000.';

-- ===========================================================================
-- 2. Velkomstbilletter (24 timer)
-- ===========================================================================
create table if not exists public.firma_velkomst_billetter (
  id               uuid primary key default gen_random_uuid(),
  bruger_id        uuid not null references public.users(id) on delete cascade,
  token_hash       text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  udloeber_kl      timestamptz not null,
  annulleret_kl    timestamptz,
  aabnet_antal     integer not null default 0 check (aabnet_antal >= 0),
  sidst_aabnet_kl  timestamptz,
  oprettet_af      uuid references public.users(id) on delete set null,
  oprettet_kl      timestamptz not null default now(),
  constraint firma_velkomst_billetter_udloeb check (udloeber_kl > oprettet_kl and udloeber_kl <= oprettet_kl + interval '7 days')
);

create index if not exists firma_velkomst_billetter_bruger_idx
  on public.firma_velkomst_billetter (bruger_id) where annulleret_kl is null;

comment on table public.firma_velkomst_billetter is
  'Billetter i velkomstmailen til nye firmakonti (24 timer). Kun sha256-hashen gemmes. GET /api/erhverv/velkomst laver et frisk Supabase-link ved hver åbning (src/lib/erhverv/velkomstBillet.ts). Ugyldig, når firmaet har logget ind, når den er udløbet, eller når en ny er sendt. Kun service role. 20261102040000.';

alter table public.firma_velkomst_billetter enable row level security;
revoke all on public.firma_velkomst_billetter from public, anon, authenticated;
grant select, insert, update on public.firma_velkomst_billetter to service_role;
