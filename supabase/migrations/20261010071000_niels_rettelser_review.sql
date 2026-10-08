-- Rettelser efter review af Niels-rettelserne (8. okt. 2026).
--
--  1. firma_pakkeskift_rul_tilbage får p_laas: låsen ("i gang"-markeringen)
--     og naeste_pakke_* røres kun, når firmaets pakkeskift_laas er p_laas
--     (eller ingen lås). Har et nyere pakkeskift taget låsen (fx efter de 5
--     minutter), rulles intet tilbage ('laas_overtaget') - det nye skift
--     gælder. Den gamle version uden p_laas fjernes.
--  2. firma_pakkeskift_laas_tag: chefens opsigelse og pakkeskift i admin
--     tager samme lås som firmaets pakkeskift, så de aldrig kører samtidig
--     (opsigelse midt i en nedgradering ville ellers kunne genstarte
--     abonnementet via Stripe-planen). Afvises, mens et skift er i gang.
--  3. betaling_refusion_fejl_uden_laas (F05): en lovet refusion, der fejlede
--     FØR Stripe-kaldet (fx "Intet modtaget at refundere", ugyldigt beløb,
--     Stripe svarer ikke), tæller nu som et forsøg - så den når
--     refusion_graense og opgives med én alarm i stedet for at give en ny
--     alarm hver 6. time for evigt. Tæller kun, hvis forsøget ikke allerede
--     er talt under låsen (refusion_forsoeg uændret = p_forsoeg).
--  4. betaling_indsigelse_tabt_luk: en åben sag på handlen (eller en afgørelse,
--     der venter på at flytte pengene) lukkes samtidig. Pengene kan ikke
--     flyttes efter en tabt indsigelse, så sagen ville ellers stå åben for
--     evigt (og holde handlen frosset). Sagen lukkes med en begrundelse til
--     køber og sælger og logges som 'sag_lukket'.
--
-- Kun service role (ingen nye rettigheder til anon/authenticated). Idempotent.

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. firma_pakkeskift_rul_tilbage med lås
-- ===========================================================================
drop function if exists public.firma_pakkeskift_rul_tilbage(uuid, uuid, jsonb, boolean, boolean, text);

create or replace function public.firma_pakkeskift_rul_tilbage(
  p_firma uuid, p_skift uuid, p_tilbagerul jsonb, p_gendan_planlagt boolean, p_gendan_afventende boolean,
  p_note text default null, p_laas uuid default null)
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
  -- Et nyere pakkeskift (eller chefen) har låsen: det gælder, og intet af
  -- dets tilstand må røres herfra.
  if f.pakkeskift_laas is not null and f.pakkeskift_laas is distinct from p_laas then
    return jsonb_build_object('kode', 'laas_overtaget');
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

revoke all on function public.firma_pakkeskift_rul_tilbage(uuid, uuid, jsonb, boolean, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_rul_tilbage(uuid, uuid, jsonb, boolean, boolean, text, uuid) to service_role;

-- ===========================================================================
-- 2. Lås til chefens opsigelse / pakkeskift
-- ===========================================================================
-- Svarer med en ny lås (frigives med firma_pakkeskift_laas_frigiv), eller
-- null, hvis et pakkeskift er i gang (markeringen er yngre end 5 minutter).
create or replace function public.firma_pakkeskift_laas_tag(p_firma uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_laas uuid := gen_random_uuid();
begin
  update public.firmaer
     set pakkeskift_i_gang_kl = now(), pakkeskift_laas = v_laas
   where id = p_firma
     and (pakkeskift_i_gang_kl is null or pakkeskift_i_gang_kl <= now() - interval '5 minutes');
  if not found then
    return null;
  end if;
  return v_laas;
end $$;

revoke all on function public.firma_pakkeskift_laas_tag(uuid) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_laas_tag(uuid) to service_role;

-- ===========================================================================
-- 3. F05: fejl før Stripe-kaldet tæller som forsøg
-- ===========================================================================
-- Kaldes af cron (refunderLoveteVentende) efter en fejl. Tæller kun op, når
-- forsøget ikke allerede er talt (refusion_forsoeg = p_forsoeg, læst før
-- forsøget), ingen holder låsen, og refusionen stadig er lovet. Giver
-- backoff og markering. Svarer med det nye forsøgsnummer, -1 ellers.
create or replace function public.betaling_refusion_fejl_uden_laas(p_betaling uuid, p_forsoeg integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.betalinger
     set refusion_forsoeg = refusion_forsoeg + 1,
         refusion_naeste_forsoeg_kl = now() + public.betaling_refusion_backoff(refusion_forsoeg + 1),
         sidste_fejl = public.betaling_fejl_tilfoej(sidste_fejl, 'Refusion fejlede før Stripe-kaldet - prøves igen', kraever_opmaerksomhed),
         kraever_opmaerksomhed = true,
         opdateret = now()
   where id = p_betaling
     and status = 'betalt'
     and refusion_anmodet_kl is not null
     and stripe_transfer_id is null
     and refusion_forsoeg = p_forsoeg
     and (refusion_laas_til is null or refusion_laas_til <= now())
  returning refusion_forsoeg into n;
  return coalesce(n, -1);
end $$;

revoke all on function public.betaling_refusion_fejl_uden_laas(uuid, integer) from public, anon, authenticated;
grant execute on function public.betaling_refusion_fejl_uden_laas(uuid, integer) to service_role;

-- ===========================================================================
-- 4. Tabt indsigelse lukker også en åben sag
-- ===========================================================================
create or replace function public.betaling_indsigelse_tabt_luk(
  p_medarbejder uuid, p_betaling uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b        record;
  s        record;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_handel text := 'uaendret';
  v_sager  integer := 0;
begin
  if not exists (select 1 from public.users where id = p_medarbejder and rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_note is null then return jsonb_build_object('kode', 'note_mangler'); end if;
  if char_length(v_note) > 2000 then return jsonb_build_object('kode', 'note_for_lang'); end if;

  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if coalesce(b.indsigelse_status, '') <> 'lost' then
    return jsonb_build_object('kode', 'ikke_tabt');
  end if;
  if b.indsigelse_lukket_kl is not null then
    return jsonb_build_object('kode', 'allerede_lukket');
  end if;

  update public.betalinger
     set indsigelse_lukket_kl = now(), indsigelse_lukket_af = p_medarbejder,
         kraever_opmaerksomhed = false,
         -- Cron skal ikke markere den igen som "ikke afsluttet".
         ikke_afsluttet_markeret_kl = coalesce(ikke_afsluttet_markeret_kl, now()),
         opdateret = now()
   where id = b.id;

  -- Sager på handlen, der stadig holder pengene (åben, afventer retur, eller
  -- afgjort men ikke afviklet), lukkes: pengene kan ikke flyttes efter en
  -- tabt indsigelse (køberens bank har afgjort betalingen).
  perform 1 from public.trades where id = b.trade_id for update;
  for s in
    select * from public.sager
     where trade_id = b.trade_id
       and (status in ('aaben', 'afventer_retur')
            or (penge_handling is not null and afviklet_kl is null))
     for update
  loop
    if s.status in ('aaben', 'afventer_retur') then
      update public.sager
         set status = 'lukket',
             afgjort_af = p_medarbejder,
             afgjort_kl = now(),
             begrundelse = 'Sagen er lukket, fordi køberens bank har afgjort betalingen. BidHamr flytter ikke flere penge på handlen.',
             retur_kraeves = false, returfragt_betaler = null,
             penge_handling = null, penge_flyttes_efter_kl = null,
             afviklet_kl = now(), penge_fejl = null,
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Lukket ved tabt indsigelse (dispute lost): ' || v_note, 4000)
       where id = s.id;
    else
      update public.sager
         set afviklet_kl = now(),
             penge_fejl = 'indsigelse_tabt',
             intern_note = left(coalesce(intern_note || chr(10), '')
                                || 'Afgørelsen er ikke gennemført: indsigelsen er tabt, og pengene flyttes ikke. ' || v_note, 4000)
       where id = s.id;
    end if;
    v_sager := v_sager + 1;
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'sag_lukket', 'sag', s.id, b.buyer_id,
            'Lukket ved tabt indsigelse - pengene flyttes ikke');
  end loop;
  if v_sager > 0 then
    update public.trades set sag_aaben = false where id = b.trade_id and sag_aaben;
  end if;

  -- Intet overført til sælger: handlen annulleres (sælgeren får ikke
  -- udbetalt; køberens bank har givet køberen pengene). Er der overført,
  -- bærer BidHamr tabet, og handlen står, som den er.
  if b.stripe_transfer_id is null and b.overfoersel_paabegyndt_kl is null then
    update public.trades set status = 'annulleret', sag_aaben = false
     where id = b.trade_id and status <> 'annulleret';
    if found then v_handel := 'annulleret'; end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'betaling_loest', 'handel', b.trade_id, b.buyer_id,
          left('Tabt indsigelse lukket' ||
               case when v_handel = 'annulleret' then ' (handlen annulleret)' else '' end ||
               case when v_sager > 0 then ' (sag lukket)' else '' end ||
               ': ' || v_note, 2000));

  return jsonb_build_object('kode', 'ok', 'handel', v_handel, 'trade_id', b.trade_id,
                            'overfoert', b.stripe_transfer_id is not null, 'sager_lukket', v_sager);
end $$;

revoke all on function public.betaling_indsigelse_tabt_luk(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_indsigelse_tabt_luk(uuid, uuid, text) to service_role;
