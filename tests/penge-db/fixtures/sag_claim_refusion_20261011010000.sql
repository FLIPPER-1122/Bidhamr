-- sag_claim_refusion, som den ser ud efter 20261011010000 (20261003010000 +
-- mønster "a" i 20261011010000, rekonstrueret fra repoet - md5 b3d540743f7454b9adbadbb9d055b7c7).
-- Bruges af tests/penge-db/nyPrismodel.test.ts.
create or replace function public.sag_claim_refusion(p_betaling uuid, out beloeb bigint, out fejl text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then
    fejl := 'ikke_mulig';
    return;
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    fejl := 'indsigelse';
    return;
  end if;
  if b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then
    fejl := 'ikke_mulig';
    return;
  end if;

  beloeb := b.total_oere - coalesce(b.beskyttelse_oere, 0);
  if beloeb <= 0 or beloeb > b.total_oere then
    beloeb := null;
    fejl := 'ikke_mulig';
    return;
  end if;

  update public.betalinger
     set refusion_anmodet_kl = now(),
         refusion_aarsag = 'sag',
         refusion_oere = beloeb,
         opdateret = now()
   where id = b.id;
end;
$fn$;
