import type { Metadata } from "next";
import Link from "next/link";
import Ikon from "@/components/Ikon";
import { redirect } from "next/navigation";
import { hentBruger } from "@/lib/supabase/bruger";
import { hentMitIdStatus } from "@/lib/mitid/status";
import { MitIDIkon, MitIDKnap } from "@/components/mitid/MitIDKraeves";
import { MITID } from "@/lib/tekster/mitid";

// Hertil sendes man, når e-mailen er bekræftet (auth/callback, signup og
// koden fra mailen). Mangler brugeren MitID, er næste trin "Bekræft dig med
// MitID nu" - man kan springe over og gøre det senere (det kræves først før
// første bud/auktion). Firmakonti sendes til /firma af proxyen.
export const metadata: Metadata = { title: "Velkommen", robots: { index: false, follow: false } };

export default async function VelkommenSide() {
  const bruger = await hentBruger();
  if (!bruger) redirect("/login");
  const mitid = await hentMitIdStatus(bruger.id);

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md rounded-[14px] border border-kant bg-white p-5 text-center shadow-kort sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-succes-bg">
          <svg viewBox="0 0 24 24" className="h-7 w-7 text-succes-tekst" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-4 text-[26px] leading-tight sm:text-[32px]">Velkommen til BidHamr</h1>

        {mitid.mangler ? (
          <>
            <p className="mt-2 text-[15px] text-tekst-daempet">Din e-mail er bekræftet, og du er logget ind.</p>
            <section
              aria-labelledby="velkommen-mitid"
              className="mt-6 rounded-xl bg-groen-lys p-4 text-left text-groen-mork sm:p-5"
            >
              <div className="flex items-start gap-3">
                <MitIDIkon />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">Sidste trin</p>
                  <h2 id="velkommen-mitid" className="text-[20px] leading-tight text-groen-mork">
                    {MITID.velkommenTitel}
                  </h2>
                  <p className="mt-1 text-[15px]">{MITID.velkommenTekst}</p>
                </div>
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {MITID.hvorfor.map((h) => (
                  <li key={h} className="flex items-start gap-2">
                    <Ikon navn="flueben" className="mt-0.5 h-4 w-4 shrink-0" strøg={2.25} />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                <MitIDKnap retur="/velkommen" fuldBredde />
              </div>
            </section>
            <Link
              href="/auktioner"
              className="mt-4 inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              {MITID.springOver}
            </Link>
          </>
        ) : (
          <>
            <p className="mt-2 text-[15px] text-tekst-daempet">
              Din e-mail er bekræftet, og du er logget ind. Nu kan du byde på auktioner og følge med i dine handler.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Link href="/auktioner" className="btn btn-primaer btn-stor w-full sm:w-auto">
                Find auktioner
              </Link>
              <Link href="/konto" className="btn btn-sekundaer btn-stor w-full sm:w-auto">
                Gå til Min konto
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
