-- Opretter automatisk en række i public.users når en ny bruger signer up via Supabase Auth.
-- navn/telefon hentes fra signUp(options.data), som Supabase lægger i auth.users.raw_user_meta_data.

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, navn, email, telefon)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'navn', new.email),
    new.email,
    new.raw_user_meta_data->>'telefon'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
