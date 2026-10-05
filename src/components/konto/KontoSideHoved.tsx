import Link from "next/link";

// Brødkrumme + overskrift på undersiderne til Min konto (samme udseende som
// /konto/notifikationer).
export default function KontoSideHoved({
  titel,
  krumme,
  tekst,
}: {
  titel: string;
  // Kort navn i brødkrummen, fx "Statistik".
  krumme: string;
  tekst?: string;
}) {
  return (
    <>
      <nav aria-label="Brødkrumme" className="flex items-center text-sm">
        <Link
          href="/konto"
          className="inline-flex min-h-11 items-center rounded-md font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          Min konto
        </Link>
        <span aria-hidden="true" className="mx-2 text-tekst-svag">/</span>
        <span className="text-tekst-daempet" aria-current="page">{krumme}</span>
      </nav>
      <h1 className="mt-1 text-[26px] leading-tight break-words hyphens-auto sm:text-[32px]">{titel}</h1>
      {tekst && <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">{tekst}</p>}
    </>
  );
}
