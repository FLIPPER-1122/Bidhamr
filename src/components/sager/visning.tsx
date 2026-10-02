// Fælles visning til sager (handelssiden og admin). Ingen "use client":
// bruges både i server- og klientkomponenter.
import { SAG_KATEGORI_NAVN, SAG_STATUS_NAVN, type SagBilledeKategori, type SagStatus } from "@/lib/sager";

// Fast tidszone, så server og browser viser det samme (ingen hydreringsfejl).
export function sagTid(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("da-DK", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

const STATUS_STIL: Record<SagStatus, string> = {
  aaben: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst",
  afventer_retur: "border-info-kant bg-info-bg text-info-tekst",
  afgjort_koeber: "border-succes-kant bg-succes-bg text-succes-tekst",
  afgjort_saelger: "border-succes-kant bg-succes-bg text-succes-tekst",
  lukket: "border-kant-staerk bg-neutral-100 text-tekst-daempet",
};

// Kort navn til badges (det lange står i SAG_STATUS_NAVN).
export const SAG_STATUS_KORT: Record<SagStatus, string> = {
  aaben: "Åben",
  afventer_retur: "Afventer retur",
  afgjort_koeber: "Medhold til køber",
  afgjort_saelger: "Medhold til sælger",
  lukket: "Lukket",
};

export function SagStatusBadge({ status, lang = false }: { status: SagStatus; lang?: boolean }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STIL[status]}`}
    >
      {lang ? SAG_STATUS_NAVN[status] : SAG_STATUS_KORT[status]}
    </span>
  );
}

export function BeskyttelseBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-groen-lys px-2.5 py-1 text-xs font-semibold text-groen-mork">
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      </svg>
      BidHamr Beskyttelse
    </span>
  );
}

export type VistSagBillede = {
  id: string;
  kategori: SagBilledeKategori;
  url: string | null;
  oprettetKl: string;
};

// Billedgitter. Klik åbner billedet i fuld størrelse i en ny fane (signerede
// links udløber efter en time - genindlæs siden for nye). Billederne er
// private og signerede, så de vises med <img> og lazy loading i stedet for
// next/image (optimeringen kan ikke cache et link, der udløber).
export function SagBilleder({ billeder, stor = false }: { billeder: VistSagBillede[]; stor?: boolean }) {
  if (billeder.length === 0) {
    return <p className="text-sm text-tekst-svag">Ingen billeder.</p>;
  }
  return (
    <ul
      className={`grid gap-3 ${
        stor ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-2 sm:grid-cols-3"
      }`}
    >
      {billeder.map((b) => (
        <li key={b.id} className="overflow-hidden rounded-xl border border-kant bg-white">
          {b.url ? (
            <a
              href={b.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              aria-label={`${SAG_KATEGORI_NAVN[b.kategori]}: åbn billedet i fuld størrelse`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={b.url}
                alt={`Billede af ${SAG_KATEGORI_NAVN[b.kategori].toLowerCase()}`}
                loading="lazy"
                decoding="async"
                width={stor ? 600 : 300}
                height={stor ? 450 : 300}
                className={`w-full bg-skelet object-cover ${stor ? "aspect-[4/3]" : "aspect-square"}`}
              />
            </a>
          ) : (
            <div
              className={`flex w-full items-center justify-center bg-skelet px-2 text-center text-xs text-tekst-daempet ${
                stor ? "aspect-[4/3]" : "aspect-square"
              }`}
            >
              Billedet kunne ikke hentes
            </div>
          )}
          <p className="px-3 py-2 text-xs font-medium text-tekst-daempet">
            {SAG_KATEGORI_NAVN[b.kategori]}
          </p>
        </li>
      ))}
    </ul>
  );
}
