-- Saetter en brugers saldo til et praecist beloeb ved at bogfoere forskellen
-- som en justering. Saldoen aendres altsaa aldrig uden om hovedbogen, saa
-- afstemningen sum(wallet_entries) = wallets.balance bliver ved med at holde.
--
-- Bruges af admin til at laegge testpenge ind, mens platformen koeres i
-- testtilstand, og til fejlrettelser i drift.
--
-- Laaser raekken foerst, saa to samtidige justeringer ikke kan laese den
-- samme udgangssaldo og overskrive hinanden.
create or replace function public.wallet_saet_saldo(
  p_user uuid,
  p_ny_saldo numeric,
  p_note text
) returns numeric
language plpgsql security definer set search_path = public as $fn$
declare
  nuvaerende numeric(12,2);
  reserveret numeric(12,2);
  forskel    numeric(12,2);
begin
  if p_ny_saldo < 0 then
    raise exception 'negativ_saldo';
  end if;

  select balance, reserved into nuvaerende, reserveret
    from public.wallets where user_id = p_user for update;

  if not found then
    raise exception 'wallet_mangler';
  end if;

  -- Reserverede midler er bundet i aktive bud og kan ikke fjernes under
  -- foedderne paa en igangvaerende auktion.
  if p_ny_saldo < reserveret then
    raise exception 'under_reserveret: % kr er bundet i aktive bud', reserveret;
  end if;

  forskel := round(p_ny_saldo, 2) - nuvaerende;

  if forskel = 0 then
    return nuvaerende;
  end if;

  return public.wallet_bogfoer(
    p_user, forskel, 'justering', null, p_note, null);
end;
$fn$;
