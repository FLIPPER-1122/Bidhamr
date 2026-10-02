// Preview af alle mails med eksempeldata. Kun i dev - i produktion 404.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { mailEksempler } from "./eksempler";

export const metadata: Metadata = { title: "Mail-preview", robots: { index: false } };

export default async function MailPreviewSide({
  searchParams,
}: {
  searchParams: Promise<{ bredde?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { bredde } = await searchParams;
  const mobil = bredde === "mobil";
  const eksempler = mailEksempler();

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-serif text-[26px] font-semibold leading-tight text-tekst sm:text-[32px]">
        Mail-preview
      </h1>
      <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">
        Alle mails med eksempeldata. Siden findes kun i udviklingsmiljøet.
      </p>
      <p className="mt-4 flex flex-wrap gap-2 text-sm">
        <Link
          href="/dev/mails"
          className={`rounded-full px-4 py-2 font-medium ${mobil ? "bg-groen-lys text-groen-mork" : "bg-groen text-white"}`}
        >
          Fuld bredde
        </Link>
        <Link
          href="/dev/mails?bredde=mobil"
          className={`rounded-full px-4 py-2 font-medium ${mobil ? "bg-groen text-white" : "bg-groen-lys text-groen-mork"}`}
        >
          Mobil (375px)
        </Link>
      </p>

      <nav aria-label="Mails" className="mt-6 flex flex-wrap gap-2 text-sm">
        {eksempler.map((e) => (
          <a key={e.id} href={`#${e.id}`} className="rounded-full border border-kant px-3 py-1 text-groen hover:bg-groen-lys">
            {e.navn}
          </a>
        ))}
      </nav>

      <div className="mt-8 space-y-12">
        {eksempler.map((e) => (
          <section key={e.id} id={e.id} className="scroll-mt-6">
            <h2 className="font-serif text-xl font-semibold text-tekst">{e.navn}</h2>
            <p className="mt-1 text-sm text-tekst-daempet">
              Emne: <span className="font-medium text-tekst">{e.mail.subject}</span>
            </p>
            <p className="mt-1 flex gap-4 text-sm">
              <a href={`/dev/mails/${e.id}`} target="_blank" rel="noreferrer" className="font-medium text-groen underline">
                Åbn alene
              </a>
              <a href={`/dev/mails/${e.id}?tekst=1`} target="_blank" rel="noreferrer" className="font-medium text-groen underline">
                Tekstudgave
              </a>
            </p>
            <iframe
              title={e.navn}
              srcDoc={e.mail.html}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              loading="lazy"
              className="mt-3 block h-[960px] max-w-full rounded-[14px] border border-kant"
              style={{ width: mobil ? 375 : "100%" }}
            />
          </section>
        ))}
      </div>
    </main>
  );
}
