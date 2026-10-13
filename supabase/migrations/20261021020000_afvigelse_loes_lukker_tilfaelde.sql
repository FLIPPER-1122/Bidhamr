-- Når chefen markerer en afvigelse fra pengeafstemningen løst
-- (admin_penge_afvigelse_loes, 20261019020000_pengeafstemning.sql), lukkes nu
-- også drift-alarm-tilfældet for den (drift_tilfaelde, 20261011050000):
--   'afstemning:' || noegle                       (afstemningens egen alarm)
--   ukendt_betaling       -> 'ukendt-pi:' || stripe_id
--   ukendt_indsigelse     -> 'indsigelse-ukendt:' || stripe_id
--   abonnement_indsigelse -> 'indsigelse-abonnement:' || stripe_id
--                                                  (webhookens alarmnøgler)
-- Før stod tilfældet åbent, så samme tilfælde aldrig kunne give en ny alarm,
-- hvis det opstod igen. Intet slettes (drift_tilfaelde_luk sætter loest_kl).
--
-- 20261019020000 er kørt i produktionen, så funktionen rettes her.
-- Drift-tjek: funktionens krop skal have md5 "gammel" (som i 20261019020000 -
-- set i produktionen og på testdatabasen 13. okt. 2026) eller "ny" (allerede
-- kørt). Ellers afbrydes migrationen. Idempotent. Én transaktion: ingen egen
-- begin/commit, som de øvrige migrationer (CLI'en og prod-koersel-filerne
-- kører den samlet).

set local lock_timeout = '5s';

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

do $vagt$
declare
  h text := pg_temp.krop_md5('public.admin_penge_afvigelse_loes(uuid,uuid,text)');
begin
  if h is null then
    raise exception 'admin_penge_afvigelse_loes findes ikke - kør 20261019020000_pengeafstemning.sql først';
  end if;
  if to_regprocedure('public.drift_tilfaelde_luk(text)') is null then
    raise exception 'drift_tilfaelde_luk findes ikke - kør 20261011050000_betalingsmodel_oprydning.sql først';
  end if;
  if h not in ('461287aa26df9975951c5c49316fb897', '98f7f35f4f1d4cebd4fc635c5d9d20e0') then
    raise exception 'admin_penge_afvigelse_loes: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', h;
  end if;
end $vagt$;

-- Chefen markerer en afvigelse løst (note kræves). Kun chef.
create or replace function public.admin_penge_afvigelse_loes(p_chef uuid, p_id uuid, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_noegle text;
  v_type text;
  v_stripe text;
begin
  if p_chef is null or not public.staff_chat_har_rolle(p_chef, 'chef') then return 'ingen_adgang'; end if;
  if v_note is null then return 'note_mangler'; end if;
  if char_length(v_note) > 1000 then return 'for_lang'; end if;
  update public.penge_afstemning_afvigelser
     set loest_kl = now(), loest_af = p_chef, loest_note = v_note,
         -- Beløbene nu: genåbnes kun, hvis de ændrer sig (penge_afvigelse_registrer).
         loest_beloeb_stripe_oere = beloeb_stripe_oere,
         loest_beloeb_db_oere = beloeb_db_oere,
         loest_tilstand = tilstand
   where id = p_id and loest_kl is null
  returning noegle, type, stripe_id into v_noegle, v_type, v_stripe;
  if v_noegle is null then return 'ikke_fundet'; end if;
  -- Drift-alarm-tilfældet lukkes også, så en ny forekomst giver en ny alarm.
  perform public.drift_tilfaelde_luk(left('afstemning:' || v_noegle, 200));
  if v_stripe is not null then
    if v_type = 'ukendt_betaling' then
      perform public.drift_tilfaelde_luk(left('ukendt-pi:' || v_stripe, 200));
    elsif v_type = 'ukendt_indsigelse' then
      perform public.drift_tilfaelde_luk(left('indsigelse-ukendt:' || v_stripe, 200));
    elsif v_type = 'abonnement_indsigelse' then
      perform public.drift_tilfaelde_luk(left('indsigelse-abonnement:' || v_stripe, 200));
    end if;
  end if;
  -- Hvem og hvorfor står på rækken (loest_af, loest_note).
  return 'ok';
end;
$fn$;

revoke all on function public.admin_penge_afvigelse_loes(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_penge_afvigelse_loes(uuid, uuid, text) to service_role;

drop function pg_temp.krop_md5(text);
