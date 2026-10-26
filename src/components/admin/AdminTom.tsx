import Link from "next/link";

// Tom tilstand på admin-lister (DESIGN 9): ikon + én sætning + evt. link.
// `nulstilHref` = listen er tom, fordi et filter/en søgning er sat -> knap
// "Nulstil filter" i stedet for det almindelige link.
export default function AdminTom({
  tekst,
  link,
  nulstilHref,
  ok = true,
}: {
  tekst: string;
  link?: { href: string; label: string };
  nulstilHref?: string;
  // ok = "der er intet, der venter" (grønt flueben). false = neutral.
  ok?: boolean;
}) {
  const groen = ok && !nulstilHref;
  return (
    <div className="flex flex-col items-center gap-3 rounded-none border border-kant bg-white px-5 py-10 text-center">
      <span
        aria-hidden="true"
        className={`grid h-12 w-12 place-items-center rounded-full ${groen ? "bg-groen-lys text-groen-mork" : "bg-admin-graa text-tekst-daempet"}`}
      >
        {groen ? (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M21 21l-6 -6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <p className="max-w-[50ch] text-sm text-tekst-daempet">{tekst}</p>
      {nulstilHref ? (
        <Link href={nulstilHref} className="btn btn-sekundaer btn-lille">
          Nulstil filter
        </Link>
      ) : (
        link && (
          <Link href={link.href} className="text-sm font-semibold text-groen hover:underline">
            {link.label}
          </Link>
        )
      )}
    </div>
  );
}
