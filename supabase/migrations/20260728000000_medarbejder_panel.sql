-- Medarbejderpanel: suspension med varighed + moderationslog.

alter table public.users add column if not exists suspenderet_til timestamptz;
comment on column public.users.suspenderet_til is
  'Udløb for suspension. NULL + suspenderet=true = permanent. Udløbet suspension ignoreres ved login (ryddes ikke automatisk).';

create table public.moderation_log (
  id uuid primary key default gen_random_uuid(),
  medarbejder_id uuid not null references public.users(id),
  handling text not null check (handling in ('slet_auktion','slet_anmeldelse','suspender','ophaev_suspension','advarsel','annuller_auktion')),
  maal_type text not null check (maal_type in ('auktion','anmeldelse','bruger')),
  maal_id uuid not null,
  bruger_id uuid references public.users(id),
  aarsag text not null,
  oprettet_kl timestamptz not null default now()
);

-- Ingen policies: kun service-role-klienten kan læse/skrive (som advarsler).
alter table public.moderation_log enable row level security;
create index moderation_log_bruger_idx on public.moderation_log (bruger_id);
create index moderation_log_maal_idx on public.moderation_log (maal_type, maal_id);
