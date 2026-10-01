-- push_tokens (lavet direkte i Supabase til appen): eksplicit WITH CHECK paa
-- update-policyen. Koert i produktion og test 1. oktober 2026 med Filips ja.
-- (Uden WITH CHECK bruger Postgres USING til begge, saa det var ikke et hul,
-- men reglen er nu tydelig.)
do $$
begin
  if to_regclass('public.push_tokens') is not null then
    alter policy push_tokens_update_own on public.push_tokens
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
