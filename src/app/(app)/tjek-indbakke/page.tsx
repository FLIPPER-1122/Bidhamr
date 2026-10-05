import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { TJEK_EMAIL_COOKIE } from "@/lib/tilmelding";
import GensendBekraeftelse from "@/components/konto/GensendBekraeftelse";
import NyBekraeftelse from "./NyBekraeftelse";

export const metadata: Metadata = { title: "Tjek din indbakke", robots: { index: false, follow: false } };

function BrevIkon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 text-groen-mork" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m3 7 9 6 9-6" />
    </svg>
  );
}

export default async function TjekIndbakkeSide({
  searchParams,
}: {
  searchParams: Promise<{ fejl?: string }>;
}) {
  const { fejl } = await searchParams;
  const email = (await cookies()).get(TJEK_EMAIL_COOKIE)?.value ?? null;
  const linkFejl = fejl === "link_udloebet" || fejl === "link_ugyldigt" ? fejl : null;

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md rounded-[14px] border border-kant bg-white p-5 shadow-kort sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-groen-lys">
          <BrevIkon />
        </div>

        {linkFejl ? (
          <>
            <h1 className="mt-4 text-center text-[26px] leading-tight sm:text-[32px]">
              {linkFejl === "link_udloebet" ? "Linket er udløbet" : "Linket virker ikke"}
            </h1>
            <p className="mt-2 text-center text-[15px] text-tekst-daempet">
              {linkFejl === "link_udloebet"
                ? "Bekræftelseslinket virker kun i en begrænset tid. Få en ny mail herunder."
                : "Linket er allerede brugt eller ikke helt korrekt. Er din e-mail allerede bekræftet, kan du bare logge ind."}
            </p>
            <div className="mt-6">
              <NyBekraeftelse startEmail={email ?? ""} />
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-4 text-center text-[26px] leading-tight sm:text-[32px]">
              Tjek din indbakke
            </h1>
            {email ? (
              <p className="mt-2 text-center text-[15px] text-tekst-daempet">
                Vi har sendt en mail til{" "}
                <span className="font-semibold break-all text-tekst">{email}</span>. Klik på linket i
                mailen for at bekræfte din e-mail og komme i gang.
              </p>
            ) : (
              <p className="mt-2 text-center text-[15px] text-tekst-daempet">
                Vi har sendt dig en mail. Klik på linket i mailen for at bekræfte din e-mail og komme i gang.
              </p>
            )}

            <div className="mt-6 rounded-xl bg-groen-lys p-4 text-sm text-groen-mork">
              <p className="font-semibold">Kan du ikke finde mailen?</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li>Vent et par minutter – nogle gange tager det lidt tid.</li>
                <li>Kig i din spam- eller reklamemappe.</li>
                <li>Mailen kommer fra noreply@bidhamr.dk.</li>
              </ul>
            </div>

            <div className="mt-6 flex flex-col items-center">
              {email ? <GensendBekraeftelse startVentetid /> : <NyBekraeftelse startEmail="" />}
            </div>

            <p className="mt-6 text-center text-sm text-tekst-svag">
              Forkert e-mail?{" "}
              <Link href="/signup" className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
                Opret kontoen igen
              </Link>
            </p>
          </>
        )}

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
