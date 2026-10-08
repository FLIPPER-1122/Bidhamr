-- Erhvervsabonnement: rettelser efter gen-review (8. okt. 2026).
--
--  1. Kun ÉT pakkeskift pr. firma ad gangen (dobbeltklik / to faner / app +
--     hjemmeside). firma_skift_pakke_server sætter en "i gang"-markering
--     (firmaer.pakkeskift_i_gang_kl + pakkeskift_laas) i SAMME transaktion
--     som skiftet. Serveren rydder den, når Stripe-delen er færdig eller rullet
--     tilbage (firma_pakkeskift_laas_frigiv / firma_pakkeskift_rul_tilbage).
--     Markeringen udløber efter 5 minutter (fx hvis serveren går ned midt i).
--     Et nyt skift, mens markeringen gælder, afvises (BHE07, dansk besked).
--  2. firma_skift_pakke_server afviser slettede, lukkede og suspenderede
--     brugere (BHE06) og en nedgradering, mens abonnementet er opsagt (BHE08).
--  3. Opsigelse fjerner en planlagt nedgradering - nu også i databasen
--     (firma_pakkeskift_annuller_planlagt). firma_pakkeskift_rul_tilbage
--     gendanner aldrig en planlagt nedgradering, når abonnementet er opsagt.
--
-- Kun service role. Idempotent.

set local lock_timeout = '5s';

alter table public.firmaer add column if not exists pakkeskift_i_gang_kl timestamptz;
alter table public.firmaer add column if not exists pakkeskift_laas uuid;

comment on column public.firmaer.pakkeskift_i_gang_kl is
  'Et pakkeskift er i gang (sat af firma_skift_pakke_server, ryddes når Stripe-delen er færdig). Udløber efter 5 minutter. Kun service role.';
comment on column public.firmaer.pakkeskift_laas is
  'Id for det pakkeskift, der er i gang (kun den, der satte markeringen, kan rydde den). Kun service role.';

-- ---------------------------------------------------------------------------
-- firma_skift_pakke_server: som i 20261010050000 + markering, kontotjek og
-- opsagt-tjek. Svaret har desuden 'laas' (gives til firma_pakkeskift_laas_frigiv).
-- ---------------------------------------------------------------------------
create or replace function public.firma_skift_pakke_server(p_bruger uuid, p_pakke uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f       public.firmaer;
  nu      public.erhverv_pakker;
  ny      public.erhverv_pakker;
  u       record;
  v_fra   timestamptz;
  v_id    uuid;
  v_snap  jsonb;
  v_laas  uuid := gen_random_uuid();
begin
  if p_bruger is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select suspenderet, suspenderet_til, konto_lukket_kl, konto_slettet_kl into u
    from public.users where id = p_bruger;
  if not found or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now())) then
    raise exception 'erhverv_konto_spaerret: Din konto er spærret, så du kan ikke skifte pakke. Skriv til erhverv@bidhamr.dk.'
      using errcode = 'BHE06';
  end if;
  select * into f from public.firmaer where bruger_id = p_bruger for update;
  if f.id is null then
    raise exception 'erhverv_intet_abonnement: Kun firmakonti har et abonnement.' using errcode = 'BHE02';
  end if;
  if f.pakkeskift_i_gang_kl is not null and f.pakkeskift_i_gang_kl > now() - interval '5 minutes' then
    raise exception 'erhverv_skift_i_gang: Vi er ved at skifte din pakke. Vent et øjeblik, og opdater siden.'
      using errcode = 'BHE07';
  end if;
  if not public.rate_limit_tjek('firma_skift_pakke:' || p_bruger::text, 10, 3600) then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.' using errcode = 'BHR01';
  end if;
  if f.abonnement_status <> 'aktiv' then
    raise exception 'erhverv_intet_abonnement: Abonnementet er ikke aktivt. Kontakt BidHamr på erhverv@bidhamr.dk.'
      using errcode = 'BHE02';
  end if;

  perform public.firma_anvend_planlagt(f.id);
  select * into f from public.firmaer where id = f.id;

  v_snap := jsonb_build_object(
    'naeste_pakke_id', f.naeste_pakke_id,
    'naeste_pakke_fra', f.naeste_pakke_fra,
    'planlagt', (select s.id from public.firma_pakkeskift s where s.firma_id = f.id and s.status = 'planlagt'),
    'afventer', (select s.id from public.firma_pakkeskift s where s.firma_id = f.id and s.status = 'afventer_betaling'));

  select * into ny from public.erhverv_pakker where id = p_pakke and aktiv;
  if ny.id is null then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  select * into nu from public.erhverv_pakker where id = f.pakke_id;

  if ny.id = nu.id then
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now(),
           pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
     where id = f.id;
    return jsonb_build_object('kode', 'uaendret', 'tilbagerul', v_snap, 'laas', v_laas);
  end if;

  if ny.auktioner_pr_uge > nu.auktioner_pr_uge then
    update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
     where firma_id = f.id and status = 'afventer_betaling';
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status = 'planlagt';
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now(),
           pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
     where id = f.id;
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af)
    values (f.id, nu.id, ny.id, 'opgradering', 'afventer_betaling', p_bruger)
    returning id into v_id;
    return jsonb_build_object('kode', 'opgradering_afventer_betaling', 'skift_id', v_id,
                              'pakke', public.erhverv_pakke_json(ny.id), 'tilbagerul', v_snap, 'laas', v_laas);
  end if;

  -- Nedgradering, mens abonnementet er opsagt: giver ingen mening (det
  -- stopper ved periodens slut) - og Stripe-planen ville genstarte det.
  if f.opsiges_fra is not null then
    raise exception 'erhverv_opsagt: Dit abonnement er opsagt og stopper %. Du kan ikke skifte til en mindre pakke. Skriv til erhverv@bidhamr.dk, hvis du vil fortsætte.',
      to_char(f.opsiges_fra at time zone 'Europe/Copenhagen', 'DD.MM.YYYY')
      using errcode = 'BHE08';
  end if;

  v_fra := coalesce(f.periode_slut, f.betalt_til, public.firma_naeste_periode(f.abonnement_start));
  update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
   where firma_id = f.id and status = 'planlagt';
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = f.id and status = 'afventer_betaling';
  update public.firmaer set naeste_pakke_id = ny.id, naeste_pakke_fra = v_fra, opdateret_kl = now(),
         pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
   where id = f.id;
  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, gaelder_fra, anmodet_af)
  values (f.id, nu.id, ny.id, 'nedgradering', 'planlagt', v_fra, p_bruger)
  returning id into v_id;
  return jsonb_build_object('kode', 'nedgradering_planlagt', 'skift_id', v_id, 'gaelder_fra', v_fra,
                            'pakke', public.erhverv_pakke_json(ny.id), 'tilbagerul', v_snap, 'laas', v_laas);
end $$;

revoke all on function public.firma_skift_pakke_server(uuid, uuid) from public, anon, authenticated;
grant execute on function public.firma_skift_pakke_server(uuid, uuid) to service_role;

-- Stripe-delen er færdig: markeringen ryddes (kun med den rigtige lås).
create or replace function public.firma_pakkeskift_laas_frigiv(p_firma uuid, p_laas uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.firmaer set pakkeskift_i_gang_kl = null, pakkeskift_laas = null
   where id = p_firma and pakkeskift_laas = p_laas;
  return jsonb_build_object('kode', case when found then 'ok' else 'ikke_laast' end);
end $$;

revoke all on function public.firma_pakkeskift_laas_frigiv(uuid, uuid) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_laas_frigiv(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- firma_pakkeskift_rul_tilbage: som før, men rydder markeringen, og en
-- planlagt nedgradering gendannes aldrig, når abonnementet er opsagt.
-- ---------------------------------------------------------------------------
create or replace function public.firma_pakkeskift_rul_tilbage(
  p_firma uuid, p_skift uuid, p_tilbagerul jsonb, p_gendan_planlagt boolean, p_gendan_afventende boolean,
  p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f           public.firmaer;
  v_planlagt  uuid := nullif(p_tilbagerul->>'planlagt', '')::uuid;
  v_afventer  uuid := nullif(p_tilbagerul->>'afventer', '')::uuid;
  v_note      text := left(coalesce(nullif(btrim(p_note), ''), 'Rullet tilbage: Stripe-fejl'), 1000);
  v_gendannet text[] := '{}';
begin
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  update public.firmaer set pakkeskift_i_gang_kl = null, pakkeskift_laas = null where id = f.id;
  if p_skift is not null then
    update public.firma_pakkeskift
       set status = 'annulleret', behandlet_kl = now(), note = coalesce(note, v_note)
     where id = p_skift and firma_id = f.id and status in ('planlagt', 'afventer_betaling');
    if not found then
      return jsonb_build_object('kode', 'ikke_aabent');
    end if;
  end if;

  update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
   where id = f.id;

  if coalesce(p_gendan_planlagt, false) and v_planlagt is not null and f.opsiges_fra is null
     and f.abonnement_status = 'aktiv'
     and not exists (select 1 from public.firma_pakkeskift where firma_id = f.id and status = 'planlagt') then
    update public.firma_pakkeskift set status = 'planlagt', behandlet_kl = null
     where id = v_planlagt and firma_id = f.id and status in ('erstattet', 'annulleret')
       and behandlet_kl > now() - interval '15 minutes'
       and note is distinct from 'Abonnementet er opsagt';
    if found then
      update public.firmaer
         set naeste_pakke_id = nullif(p_tilbagerul->>'naeste_pakke_id', '')::uuid,
             naeste_pakke_fra = nullif(p_tilbagerul->>'naeste_pakke_fra', '')::timestamptz
       where id = f.id;
      v_gendannet := v_gendannet || 'planlagt'::text;
    end if;
  end if;

  if coalesce(p_gendan_afventende, false) and v_afventer is not null
     and not exists (select 1 from public.firma_pakkeskift where firma_id = f.id and status = 'afventer_betaling') then
    update public.firma_pakkeskift set status = 'afventer_betaling', behandlet_kl = null
     where id = v_afventer and firma_id = f.id and status in ('erstattet', 'annulleret')
       and behandlet_kl > now() - interval '15 minutes';
    if found then
      v_gendannet := v_gendannet || 'afventer'::text;
    end if;
  end if;

  return jsonb_build_object('kode', 'ok', 'gendannet', to_jsonb(v_gendannet));
end $$;

revoke all on function public.firma_pakkeskift_rul_tilbage(uuid, uuid, jsonb, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_rul_tilbage(uuid, uuid, jsonb, boolean, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- En planlagt nedgradering er fjernet i Stripe (opsigelse, eller chefens
-- pakkeskift fejlede efter at planen var frigivet): den annulleres også i
-- databasen, så den ikke gennemføres ved næste fornyelse. Kun service role.
-- ---------------------------------------------------------------------------
create or replace function public.firma_pakkeskift_annuller_planlagt(p_firma uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_antal int;
begin
  perform 1 from public.firmaer where id = p_firma for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  update public.firma_pakkeskift
     set status = 'annulleret', behandlet_kl = now(),
         note = left(coalesce(nullif(btrim(p_note), ''), 'Planen er fjernet i Stripe'), 1000)
   where firma_id = p_firma and status = 'planlagt';
  get diagnostics v_antal = row_count;
  update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
   where id = p_firma and (naeste_pakke_id is not null or naeste_pakke_fra is not null);
  return jsonb_build_object('kode', 'ok', 'annulleret', v_antal);
end $$;

revoke all on function public.firma_pakkeskift_annuller_planlagt(uuid, text) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_annuller_planlagt(uuid, text) to service_role;
