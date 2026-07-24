@AGENTS.md

# BidHamr – Auktionsplatform (Next.js)

## Stack
- Next.js App Router + TypeScript (v16, tjek `node_modules/next/dist/docs/` for breaking changes)
- Supabase (database, auth, storage, realtime) via `@supabase/ssr`
- Tailwind CSS v4 – CSS-variabler: `--color-brand`, brug `bg-brand` / `text-brand`
- Stripe (betaling, escrow) – ikke implementeret endnu

## Brand
- Navn: BidHamr
- Primær farve: #E63946 (rød) → CSS-variabel `--color-brand`
- Sprog: Dansk i UI, engelsk i kode
- Email: support@bidhamr.dk

## Forretningsmodel
- 10% gebyr fra sælger
- 5% gebyr fra køber
- Escrow: penge holdes til køber bekræfter modtagelse

## Database tabeller (Supabase)
- `users` – id, navn, email, rolle ('bruger'|'admin'), oprettet_kl, suspenderet
- `auctions` – id, titel, beskrivelse, start_pris, nuvaerende_bud, saelger_id, status ('aktiv'|'afsluttet'|'annulleret'), slutter_kl, billeder[]
- `bids` – id, auktion_id, bruger_id, beloeb, oprettet_kl
- `transactions` – id, auktion_id, koeber_id, saelger_id, beloeb, status, oprettet_kl
- `ratings` – id, fra_bruger_id, til_bruger_id, auktion_id, stjerner (1-5), kommentar, oprettet_kl. Unique: (fra_bruger_id, auktion_id)
- `venteliste` – id, email, navn, oprettet_kl

## Supabase klientopsaetning
- Server: `import { createClient } from "@/lib/supabase/server"` (async)
- Client: `import { createClient } from "@/lib/supabase/client"`

## Admin panel
- Rute: `/admin` – kun tilgaengelig for brugere med `rolle = 'admin'`
- Layout: `src/app/admin/layout.tsx` verificerer rolle og redirecter ellers
- Alle server actions i `src/app/actions/adminActions.ts` verificerer rolle igen
- Undersider: `/admin/brugere`, `/admin/auktioner`, `/admin/transaktioner`, `/admin/bedommelser`, `/admin/venteliste`

## Ratings-system
- Kun muligt naar auktion har `status = 'afsluttet'` og brugeren var involveret (saelger eller vinder)
- Server action: `src/app/actions/submitRating.ts` – haandterer duplikat (fejlkode 23505)
- Formular: `src/components/RatingForm.tsx` – interaktiv stjernelvaelger med `useTransition`

## Profil
- URL-drevet tab-tilstand: `?fane=indstillinger` osv.
- "Rediger profil"-knap navigerer til `?fane=indstillinger`
- 4 tabs: Mine auktioner, Mine bud, Bedoemmelser, Indstillinger

## Vigtige regler
- Brug altid dansk tekst i UI
- Brug #E63946 / `bg-brand` som accent farve
- Mobilvenligt first
- Behold eksisterende funktionalitet ved redesign
- Header har kun: Logo, "Alle auktioner" link, soegefelt, Favoritter, Min profil/Log ind, "Opret auktion"-knap
- Footer viser admin-link KUN hvis bruger har `rolle = 'admin'`

## Noeglefiler
- `src/components/Header.tsx` – navbar
- `src/components/Footer.tsx` – async server component med admin-link
- `src/components/FeaturedCarousel.tsx` – 220px kort, 25s animation
- `src/app/globals.css` – `@keyframes scroll-karussel` med `translateX(-50%)`
- `src/app/(app)/profil/[id]/page.tsx` – henter egneAuktioner, mineBud, ratings, gennemforte
- `src/components/profile/ProfileHeader.tsx` – avatar, stats, "Rediger profil"
- `src/components/profile/ProfileTabs.tsx` – 4 tabs, status-badges
- `src/app/admin/page.tsx` – dashboard med SVG-grafer (ingen eksternt chart-bibliotek)
- `src/components/admin/BarChart.tsx` – viser hver 5. label, roteret -45deg
