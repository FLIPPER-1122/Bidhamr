import type { Metadata } from "next";
import Link from "next/link";

// Vises, når brugeren selv har slettet sin konto (offentlig rute - brugeren
// er logget ud).
export const metadata: Metadata = { title: "Kontoen er slettet", robots: { index: false, follow: false } };

export default function KontoSlettetSide() {
  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md rounded-[14px] border border-kant bg-white p-5 text-center shadow-kort sm:p-8">
        <h1 className="text-[26px] leading-tight sm:text-[32px]">Din konto er slettet</h1>
        <p className="mt-3 text-[15px] text-tekst-daempet">
          Dine personlige oplysninger er fjernet, og du er logget ud. Vi har sendt en kvittering til din e-mail.
        </p>
        <p className="mt-3 text-[15px] text-tekst-daempet">
          Oplysninger om dine handler gemmer vi, fordi bogføringsloven kræver det. De står nu under navnet
          &quot;Slettet bruger&quot;.
        </p>
        <p className="mt-3 text-[15px] text-tekst-daempet">Tak, fordi du var med. Du er altid velkommen tilbage.</p>
        <Link href="/" className="btn btn-sekundaer btn-stor mt-6 w-full sm:w-auto">
          Til forsiden
        </Link>
      </div>
    </main>
  );
}
