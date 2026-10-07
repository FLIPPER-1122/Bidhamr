import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { TJEK_EMAIL_COOKIE } from "@/lib/tilmelding";
import KodeForm from "./KodeForm";

export const metadata: Metadata = { title: "Indtast koden", robots: { index: false, follow: false } };

function BrevIkon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 text-groen-mork" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m3 7 9 6 9-6" />
    </svg>
  );
}

// Efter oprettelse (og ved login med en ubekræftet e-mail) indtastes den
// 6-cifrede kode fra bekræftelsesmailen her. E-mailen kommer fra en
// httpOnly cookie (sat af opretKonto/logInd/gensendBekraeftelse) - aldrig
// fra URL'en. ?fejl= kommer fra gamle bekræftelseslinks via /auth/callback.
export default async function IndtastKodeSide({
  searchParams,
}: {
  searchParams: Promise<{ fejl?: string; fra?: string }>;
}) {
  const { fejl, fra } = await searchParams;
  const email = (await cookies()).get(TJEK_EMAIL_COOKIE)?.value ?? null;
  const linkFejl = fejl === "link_udloebet" || fejl === "link_ugyldigt" ? fejl : null;
  const fraLogin = fra === "login";

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md rounded-[14px] border border-kant bg-white p-5 shadow-kort sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-groen-lys">
          <BrevIkon />
        </div>

        <h1 className="mt-4 text-center text-[26px] leading-tight sm:text-[32px]">Indtast koden</h1>

        {linkFejl && (
          <p role="alert" className="mt-4 rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-sm text-advarsel-tekst">
            {linkFejl === "link_udloebet"
              ? "Linket er udløbet. Vi bruger nu en kode i stedet – få en ny kode herunder."
              : "Linket virker ikke. Er din e-mail allerede bekræftet, kan du bare logge ind. Ellers kan du få en ny kode herunder."}
          </p>
        )}

        {fraLogin && !linkFejl && (
          <p role="status" className="mt-4 rounded-xl border border-info-kant bg-info-bg p-4 text-sm text-info-tekst">
            Du mangler at bekræfte din e-mail. Indtast koden fra den mail, vi sendte dig, eller få en ny kode.
          </p>
        )}

        {email ? (
          <p className="mt-2 text-center text-[15px] text-tekst-daempet">
            Vi har sendt en kode til{" "}
            <span className="font-semibold break-all text-tekst">{email}</span>. Indtast den herunder for at
            bekræfte din e-mail.
          </p>
        ) : (
          <p className="mt-2 text-center text-[15px] text-tekst-daempet">
            Indtast din e-mail og koden fra den mail, vi sendte dig.
          </p>
        )}

        <div className="mt-6">
          <KodeForm kendtEmail={email} startVentetid={!!email && !fraLogin && !linkFejl} />
        </div>

        <div className="mt-6 rounded-xl bg-groen-lys p-4 text-sm text-groen-mork">
          <p className="font-semibold">Kan du ikke finde mailen?</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>Vent et par minutter – nogle gange tager det lidt tid.</li>
            <li>Kig i din spam- eller reklamemappe.</li>
            <li>Mailen kommer fra noreply@bidhamr.dk.</li>
          </ul>
        </div>

        <p className="mt-6 text-center text-sm text-tekst-svag">
          Forkert e-mail?{" "}
          <Link href="/signup" className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
            Opret kontoen igen
          </Link>
        </p>
        <p className="mt-3 text-center text-sm text-tekst-svag">
          Har du allerede bekræftet?{" "}
          <Link href="/login" className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
            Log ind
          </Link>
        </p>
      </div>
    </main>
  );
}
