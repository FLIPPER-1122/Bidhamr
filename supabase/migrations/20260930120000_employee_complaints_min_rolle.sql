-- employee_complaints findes kun i produktion (ingen tidligere migration).
-- Dens to policies laeser users.rolle direkte. Efter 20260930100000 har
-- authenticated ikke laengere select paa den kolonne, saa policyerne ville
-- fejle med "permission denied". De skrives om til min_rolle() (security
-- definer, udleder brugeren af auth.uid()). Logikken er uaendret: kun chef.

do $$
begin
  if to_regclass('public.employee_complaints') is not null then
    drop policy if exists employee_complaints_select_chef on public.employee_complaints;
    drop policy if exists employee_complaints_update_chef on public.employee_complaints;

    create policy employee_complaints_select_chef on public.employee_complaints
      for select using (public.min_rolle() = 'chef');

    create policy employee_complaints_update_chef on public.employee_complaints
      for update using (public.min_rolle() = 'chef');
  end if;
end
$$;
