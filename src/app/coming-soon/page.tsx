import Link from "next/link";
import WaitlistForm from "@/components/landing/WaitlistForm";
import AuthHashRedirect from "@/components/landing/AuthHashRedirect";

export default function ComingSoonPage() {
  return (
    <div className="flex flex-1 flex-col bg-white text-neutral-900">
      {/* Fanger auth-tokens der lander her som hash-fragment */}
      <AuthHashRedirect />
      {/* Let header – ingen adgang til resten af appen, kun et diskret login-link */}
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Link href="/coming-soon" className="text-2xl font-extrabold tracking-tight text-brand">
          BidHamr
        </Link>

        <div className="flex items-center gap-5">
          <a
            href="#top"
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#c62832]"
          >
            Tilmeld venteliste
          </a>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section id="top" className="relative overflow-hidden px-4 py-12 sm:px-8 sm:py-20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse 70% 50% at 80% 10%, rgba(230,57,70,0.12), transparent 60%)",
            }}
          />

          <div className="relative mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-brand/15 bg-[#FDECEE] px-3.5 py-1.5 text-[13px] font-semibold text-[#c62832]">
                <svg viewBox="0 0 20 20" width={16} height={16} fill="currentColor" aria-hidden>
                  <path d="M11.5 2.5a1 1 0 0 1 1.73-.73l5.5 9.5a1 1 0 0 1-.87 1.5H5.64a1 1 0 0 1-.87-1.5l5.5-9.5A1 1 0 0 1 11.5 2.5z" />
                  <path d="M6 14h8v1.5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 6 15.5V14z" />
                </svg>
                Kommer snart til Danmark
              </span>

              <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-6xl">
                Danmarks nye <span className="text-brand">lokale</span>{" "}
                auktionsplatform.
              </h1>

              <p className="mt-5 max-w-lg text-[17px] leading-relaxed text-neutral-500">
                BidHamr er en app og hjemmeside, hvor du sælger dine ting på
                auktion til folk i nærheden. Upload det du vil af med, sæt en
                startpris — eller start fra 0 — og lad folk byde. Vinderen
                henter det hos dig.
              </p>

              <WaitlistForm />

              <ul className="mt-8 flex flex-col gap-2.5 text-sm font-medium text-neutral-500">
                {[
                  "Gratis at oprette auktion",
                  "Sikker betaling via BidHamr Escrow",
                ].map((punkt) => (
                  <li key={punkt} className="flex items-center gap-2">
                    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-brand" fill="currentColor" aria-hidden>
                      <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4L8.6 12l6.7-6.7a1 1 0 0 1 1.4 0z" />
                    </svg>
                    {punkt}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative flex justify-center" aria-hidden>
              <div className="w-full max-w-[300px] rounded-[2rem] bg-neutral-900 p-3 shadow-[0_20px_50px_rgba(17,24,39,0.1)]">
                <div className="rounded-[1.5rem] bg-neutral-50 p-4">
                  <div className="mb-3.5 flex items-center justify-between text-sm font-bold text-brand">
                    <span>BidHamr</span>
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  </div>

                  <div className="mb-2 flex gap-3 rounded-[10px] border border-brand/25 bg-white p-2.5 shadow-sm">
                    <div className="h-14 w-14 shrink-0 rounded-lg bg-gradient-to-br from-[#e8ddd4] to-[#c4a88a]" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[10px] font-bold tracking-wide text-brand uppercase">
                        Slutter om 2t
                      </span>
                      <strong className="text-[13px] font-semibold">
                        Designstol · København
                      </strong>
                      <span className="text-[11px] text-neutral-500">
                        Aktuelt bud <em className="font-semibold text-neutral-900 not-italic">450 kr</em>
                      </span>
                    </div>
                  </div>

                  <div className="mb-2 flex gap-3 rounded-[10px] border border-neutral-200 bg-white p-2.5">
                    <div className="h-14 w-14 shrink-0 rounded-lg bg-gradient-to-br from-[#d4e8f0] to-[#8ab4c4]" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <strong className="text-[13px] font-semibold">
                        Børnecykel 20&quot;
                      </strong>
                      <span className="text-[11px] text-neutral-500">Fra 0 kr</span>
                    </div>
                  </div>

                  <div className="flex gap-3 rounded-[10px] border border-neutral-200 bg-white p-2.5">
                    <div className="h-14 w-14 shrink-0 rounded-lg bg-gradient-to-br from-[#e0e0e8] to-[#9898b0]" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <strong className="text-[13px] font-semibold">
                        PlayStation 5
                      </strong>
                      <span className="text-[11px] text-neutral-500">
                        Aktuelt bud <em className="font-semibold text-neutral-900 not-italic">2.100 kr</em>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="absolute top-[10%] -left-2 hidden items-center gap-2 rounded-full border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold shadow-md sm:flex">
                <svg viewBox="0 0 24 24" width={18} height={18} className="text-brand" fill="currentColor" aria-hidden>
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z" />
                </svg>
                5 km radius
              </div>
              <div className="absolute bottom-[12%] -right-2 hidden items-center gap-2 rounded-full border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold shadow-md sm:flex">
                <svg viewBox="0 0 24 24" width={18} height={18} className="text-brand" fill="currentColor" aria-hidden>
                  <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 15l-4-4 1.41-1.41L11 13.17l6.59-6.59L19 8l-8 8z" />
                </svg>
                Escrow sikret
              </div>
            </div>
          </div>
        </section>

        {/* Sådan virker det */}
        <section id="saadan" className="px-4 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-12 max-w-xl">
              <p className="mb-2.5 text-xs font-bold tracking-[0.1em] text-brand uppercase">
                Sådan virker det
              </p>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Tre trin til dit første salg
              </h2>
              <p className="mt-3 text-[17px] text-neutral-500">
                Enkel proces — fra upload til betaling. Ingen komplicerede
                opsætninger.
              </p>
            </div>

            <ol className="grid gap-5 sm:grid-cols-3">
              {[
                {
                  ikon: (
                    <path d="M4 7h4l2-3h4l2 3h4v12H4V7z M12 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
                  ),
                  num: "01",
                  titel: "Opret en auktion",
                  tekst:
                    "Tag billeder af det du vil sælge og sæt en startpris — eller start fra 0 kr. Vælg om du tilbyder forsendelse eller kun afhentning.",
                },
                {
                  ikon: <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />,
                  num: "02",
                  titel: "Købere byder",
                  tekst:
                    "Købere sætter selv deres søgeradius og finder auktioner nær dem. De byder mod hinanden — og prisen stiger automatisk.",
                },
                {
                  ikon: <path d="M8 12l3 3 5-6 M3 4h18v16H3z" />,
                  num: "03",
                  titel: "Handel i hus",
                  tekst:
                    "Vinderen afhenter hos dig — eller får varen sendt, hvis du tilbyder det. Betaling sker sikkert via BidHamr, uanset hvad.",
                },
              ].map((trin) => (
                <li
                  key={trin.num}
                  className="rounded-2xl border border-neutral-200 p-7 transition-shadow hover:shadow-[0_8px_30px_rgba(17,24,39,0.08)]"
                >
                  <div className="mb-5 grid h-12 w-12 place-items-center rounded-xl bg-[#FDECEE] text-brand">
                    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.5}>
                      {trin.ikon}
                    </svg>
                  </div>
                  <span className="mb-2 block text-xs font-bold tracking-[0.08em] text-neutral-400">
                    {trin.num}
                  </span>
                  <h3 className="mb-2 text-lg font-semibold">{trin.titel}</h3>
                  <p className="text-[15px] leading-relaxed text-neutral-500">
                    {trin.tekst}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Hvorfor BidHamr */}
        <section id="hvorfor" className="border-y border-neutral-200 bg-neutral-50 px-4 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto mb-12 max-w-2xl text-center">
              <p className="mb-2.5 text-xs font-bold tracking-[0.1em] text-brand uppercase">
                Hvorfor BidHamr
              </p>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Hvad gør BidHamr anderledes?
              </h2>
              <p className="mt-3 text-[17px] text-neutral-500">
                Bygget til det lokale marked — med sikkerhed og tillid i
                centrum.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  titel: "BidHamr Escrow",
                  tekst:
                    "Pengene holdes af platformen, indtil køber godkender varen. Ingen risiko for hverken køber eller sælger.",
                  ikon: <path d="M5 11h14v10H5z M8 11V8a4 4 0 0 1 8 0v3" />,
                },
                {
                  titel: "Du bestemmer din radius",
                  tekst:
                    "Sæt hvor langt du vil køre. Købere filtrerer efter afstand — og du ser kun auktioner inden for din grænse.",
                  ikon: <path d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z M12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />,
                },
                {
                  titel: "Afhentning eller forsendelse",
                  tekst:
                    "Du vælger om fragt er en mulighed. Køberen vælger mellem afhentning eller levering — du har kontrollen.",
                  ikon: <path d="M3 7h11v10H3z M14 10h4l3 3v4h-7V10z M7.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />,
                },
                {
                  titel: "Ingen fast pris nødvendig",
                  tekst:
                    "Ved du ikke hvad det er værd? Start auktionen fra 0 kr og lad markedet finde den rigtige pris.",
                  ikon: <path d="M12 3v18 M7 8h10 M7 12h7 M7 16h10" />,
                },
                {
                  titel: "Ratings og tillid",
                  tekst:
                    "Mutual rating-system for købere og sælgere. Byg din profil og handle trygt med verificerede brugere.",
                  ikon: <path d="M12 2l2.4 4.8 5.3.8-3.8 3.7 1 5.3L12 14.3 6.1 16.6l1-5.3L3.3 7.6l5.3-.8L12 2z" />,
                },
                {
                  titel: "Alt samlet ét sted",
                  tekst:
                    "App og hjemmeside i én platform. Opret auktioner, følg bud og afslut handler — uanset enhed.",
                  ikon: <path d="M4 12h16 M12 4v16" />,
                  accent: true,
                },
              ].map((feature) => (
                <article
                  key={feature.titel}
                  className={`rounded-2xl border p-7 transition-transform hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(17,24,39,0.08)] ${
                    feature.accent
                      ? "border-brand/15 bg-gradient-to-br from-[#FDECEE] to-white"
                      : "border-neutral-200 bg-white"
                  }`}
                >
                  <div
                    className={`mb-4 grid h-11 w-11 place-items-center rounded-[11px] text-brand ${
                      feature.accent ? "bg-white/80" : "bg-neutral-50"
                    }`}
                  >
                    <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth={1.5}>
                      {feature.ikon}
                    </svg>
                  </div>
                  <h3 className="mb-1.5 text-lg font-semibold">{feature.titel}</h3>
                  <p className="text-[15px] leading-relaxed text-neutral-500">
                    {feature.tekst}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section id="venteliste" className="px-4 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-8 rounded-3xl bg-gradient-to-br from-brand to-[#c62832] p-8 text-white shadow-[0_20px_50px_rgba(230,57,70,0.12)] sm:flex-row sm:items-center sm:justify-between sm:p-12">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Auktioner er tilbage — og bedre end nogensinde
              </h2>
            </div>

            <a
              href="#top"
              className="shrink-0 rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-brand hover:bg-[#fef2f2]"
            >
              Vær med fra dag ét
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-neutral-200 px-4 py-8 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <span className="text-lg font-bold text-brand">BidHamr</span>
          <p className="text-[13px] text-neutral-500">
            &copy; 2026 BidHamr. Alle rettigheder forbeholdes.
          </p>
          <nav className="flex gap-6 text-[13px] font-medium text-neutral-500">
            <a href="#saadan" className="hover:text-neutral-900">
              Sådan virker det
            </a>
            <a href="#hvorfor" className="hover:text-neutral-900">
              Hvorfor BidHamr
            </a>
            <a href="#venteliste" className="hover:text-neutral-900">
              Venteliste
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
