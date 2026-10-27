-- TILBAGERULNING af 20261102060000_sikkerhed_stramning.sql.
-- IKKE en migration. Gendanner tilstanden fra før migrationen, så koden fra
-- før migrationen (main uden visningsnavn/mit_navn) virker igen. Brugt på
-- testdatabasen 27. okt. 2026, fordi test.bidhamr.dk kører main-koden, mens
-- den nye kode ventede på at blive pushet.
--
-- Rettighederne er dem, testdatabasen havde lige før migrationen (aflæst 27.
-- okt. 2026). Nye objekter fjernes (visningsnavn, mit_navn, loft-triggeren,
-- dublet-triggeren, brugt_kl). Idempotent. Kør derefter migrationen igen,
-- når den nye kode er ude. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

-- H2: navn læsbar igen; visningsnavn og mit_navn væk.
grant select (navn) on public.users to anon, authenticated;
-- fornavn/efternavn var aldrig læsbare før migrationen.
revoke select (fornavn, efternavn) on public.users from anon, authenticated;
drop trigger if exists users_zz_visningsnavn on public.users;
drop function if exists public.users_saet_visningsnavn();
alter table public.users drop column if exists visningsnavn;
drop function if exists public.mit_navn();

create or replace function public.mine_blokeringer()
returns table (id uuid, bruger_id uuid, navn text, avatar_url text, auktion_id uuid, auktion_titel text, oprettet_kl timestamptz)
language sql stable security definer set search_path = public
as $fn$
  select b.id,
         case when b.kilde_auktion_id is null then b.blokeret_id end,
         case when b.kilde_auktion_id is null then u.navn end,
         case when b.kilde_auktion_id is null then u.avatar_url end,
         b.kilde_auktion_id,
         a.titel,
         b.oprettet_kl
    from public.brugerblokeringer b
    join public.users u on u.id = b.blokeret_id
    left join public.auctions a on a.id = b.kilde_auktion_id
   where b.blokerer_id = auth.uid()
   order by b.oprettet_kl desc;
$fn$;

create or replace function public.mine_fulgte_saelgere()
returns table (saelger_id uuid, navn text, avatar_url text, aktive_auktioner integer, fulgt_siden timestamptz)
language sql stable security definer set search_path = ''
as $fn$
  select u.id, u.navn, u.avatar_url,
         (select count(*)::integer from public.auctions a
           where a.bruger_id = u.id and a.status = 'aktiv'
             and not coalesce(a.skjult, false) and a.slutter_kl > now()),
         f.created_at
    from public.seller_follows f
    join public.users u on u.id = f.seller_id
   where f.follower_id = auth.uid()
     and u.konto_lukket_kl is null
   order by f.created_at desc;
$fn$;

drop function if exists public.visningsnavn_beregn(text, text, timestamptz);

-- M1/L4/L6: de gamle grants.
do $do$
declare
  v_maintain boolean := current_setting('server_version_num')::integer >= 170000;
  m text;
begin
  m := case when v_maintain then ', maintain' else '' end;

  execute 'grant insert, update, delete' || m || ' on public.users to anon, authenticated';
  execute 'grant delete' || m || ' on public.auctions to anon';
  execute 'grant insert, update, delete' || m || ' on public.auctions to authenticated';
  grant select (idempotens_noegle, forbudt_bekraeftet) on public.auctions to anon, authenticated;
  execute 'grant insert' || m || ' on public.bids to anon';
  execute 'grant insert, select' || m || ' on public.bids to authenticated';
  execute 'grant select' || m || ' on public.messages to anon';
  execute 'grant insert, select' || m || ' on public.messages to authenticated';
  execute 'grant select, insert, update, delete' || m || ' on public.favorites, public.saved_auctions, public.push_tokens, public.auction_templates to anon, authenticated';
  execute 'grant select, insert, update, delete' || m || ' on public.moderation_log, public.employee_complaints to authenticated';
  grant select, insert, delete on public.seller_follows to authenticated;
  grant delete on public.brugerblokeringer to authenticated;
  if v_maintain then
    grant maintain on public.betalinger, public.betalingsprofiler, public.transactions to authenticated;
    grant maintain on public.ratings, public.reports to anon, authenticated;
  end if;
  -- Kolonne-grants fra migrationen (overflødige ved siden af tabel-grants)
  -- fjernes; før migrationen fandtes kun afhentning_mulig (20261013020000).
  revoke update (navn, fornavn, efternavn, telefon, adresse, avatar_url) on public.users from authenticated;
  revoke insert (bruger_id, titel, beskrivelse, billeder, startpris, kategori, stand, producent,
    sikkerhedsoplysninger, postnummer, lokation, lat, lng, forsendelse_mulig, pakkestoerrelse,
    vaegt_gram, spoergsmaal_aktiv, forbudt_bekraeftet, kunst_bekraeftet, varighed_dage,
    slutter_kl, idempotens_noegle) on public.auctions from authenticated;
  grant insert (afhentning_mulig), update (afhentning_mulig) on public.auctions to authenticated;
  grant select, update, usage on sequence public.penge_afstemning_koersler_id_seq, public.penge_saldo_snapshot_id_seq to anon, authenticated;
end;
$do$;

-- A-3 (tilføjet 27. okt. 2026): migrationens slut-tjek ændrer intet på en
-- database som test (ingen tabel-select på users/auctions). Har den lavet en
-- tabel-select om til kolonne-grants (NOTICE "lavet om til kolonne-grants"),
-- gendannes den IKKE her - det var et hul, ikke en tilstand at vende tilbage
-- til.

-- M2: loft-triggeren væk (også service role-delen fra 27. okt. 2026).
drop trigger if exists auctions_a0_loft on public.auctions;
drop function if exists public.auctions_oprettelse_loft();

-- L5: den gamle avatar-sletning.
drop policy if exists avatarer_delete_own on storage.objects;
create policy avatarer_delete_own on storage.objects
  for delete
  using (bucket_id = 'avatarer' and (auth.uid())::text = (storage.foldername(name))[1]);

-- L2 og L3.
alter table if exists public.firma_velkomst_billetter drop column if exists brugt_kl;
do $do$
begin
  if to_regclass('public.forsendelse_haendelser') is not null then
    drop trigger if exists forsendelse_haendelser_dublet on public.forsendelse_haendelser;
  end if;
end;
$do$;
drop function if exists public.forsendelse_haendelser_dublet();

notify pgrst, 'reload schema';
