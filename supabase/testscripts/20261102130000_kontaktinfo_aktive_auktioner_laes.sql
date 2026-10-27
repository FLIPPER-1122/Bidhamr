-- KUN LÆSNING. Aktive auktioner, som reglen i 20261102130000 ville afvise,
-- hvis titel/beskrivelse blev oprettet i dag. Virker før migrationen (bruger
-- kun besked_spam_grund og besked_normaliser).
with a as (
  select a.id, coalesce(u.konto_type = 'erhverv', false) as erhverv, a.titel, a.beskrivelse
    from public.auctions a
    join public.users u on u.id = a.bruger_id
   where a.status = 'aktiv' and a.slutter_kl > now()
), g as (
  select a.*, public.besked_spam_grund(a.titel) as gt, public.besked_spam_grund(a.beskrivelse) as gb from a
), f as (
  select g.id, g.erhverv,
         case when g.gt = 'link' and g.erhverv then public.besked_spam_grund(regexp_replace(public.besked_normaliser(g.titel),
           '(https?://|www\.)[a-z0-9.-]+(/[a-z0-9/_.?=&%#+~-]*)?|([a-z0-9-]+\.)+(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)\M(/[a-z0-9/_.?=&%#+~-]*)?',
           ' ', 'g')) else g.gt end as grund_titel,
         case when g.gb = 'link' and g.erhverv then public.besked_spam_grund(regexp_replace(public.besked_normaliser(g.beskrivelse),
           '(https?://|www\.)[a-z0-9.-]+(/[a-z0-9/_.?=&%#+~-]*)?|([a-z0-9-]+\.)+(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)\M(/[a-z0-9/_.?=&%#+~-]*)?',
           ' ', 'g')) else g.gb end as grund_beskrivelse
    from g
)
select case when erhverv then 'firma' else 'privat' end as konto,
       coalesce(grund_titel, grund_beskrivelse) as grund,
       count(*) as antal
  from f
 where grund_titel is not null or grund_beskrivelse is not null
 group by grouping sets ((1, 2), ())
 order by 1 nulls last, 2;
