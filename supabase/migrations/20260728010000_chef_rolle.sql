-- Fire rolleniveauer: bruger < medarbejder < admin < chef.
-- Chef kan alt (økonomi + rollestyring); admin kan moderation men ikke økonomi.

alter table public.users drop constraint if exists users_rolle_check;
alter table public.users add constraint users_rolle_check
  check (rolle in ('bruger', 'medarbejder', 'admin', 'chef'));

update public.users set rolle = 'chef' where email = 'test@t.com';
