import Link from "next/link";
import { nuMs } from "@/lib/dsa/regler";

// Små byggeklodser til /admin/dsa (server components).

export const TZ = "Europe/Copenhagen";
export const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export const KNAP_FJERN =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-fejl-kant bg-white px-3.5 py-2 text-sm font-semibold text-fejl-tekst transition-colors hover:bg-fejl-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fejl-fyldt";
export const KNAP_BEHOLD =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-groen bg-white px-3.5 py-2 text-sm font-semibold text-groen transition-colors hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";
export const KNAP_NEUTRAL =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-kant-staerk bg-white px-3.5 py-2 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

export type FristNiveau = "over" | "snart" | "senere";

export function fristNiveau(iso: string): FristNiveau {
  const timer = (new Date(iso).getTime() - nuMs()) / 3_600_000;
  return timer < 0 ? "over" : timer < 24 ? "snart" : "senere";
}

export function Frist({ iso }: { iso: string }) {
  const timer = (new Date(iso).getTime() - nuMs()) / 3_600_000;
  if (timer < 0) {
    const t = Math.ceil(-timer);
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-fejl-fyldt px-2.5 py-1 text-xs font-bold text-white">
        Over fristen · {t >= 48 ? `${Math.floor(t / 24)} dage` : `${t} t`}
      </span>
    );
  }
  if (timer < 24) {
    return (
      <span className="rounded-full border border-advarsel-kant bg-advarsel-bg px-2.5 py-1 text-xs font-semibold text-advarsel-tekst">
        Frist om {Math.max(1, Math.floor(timer))} t
      </span>
    );
  }
  return (
    <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">Frist {tid(iso)}</span>
  );
}

type PilleFarve = "neutral" | "blaa" | "lilla" | "groen" | "orange";
const PILLE: Record<PilleFarve, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  blaa: "bg-info-bg text-info-tekst",
  lilla: "bg-purple-100 text-purple-800",
  groen: "bg-groen-lys text-groen-mork",
  orange: "bg-advarsel-bg text-advarsel-tekst",
};

export function Pille({ children, farve = "neutral" }: { children: React.ReactNode; farve?: PilleFarve }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PILLE[farve]}`}>{children}</span>;
}

// Rolle-mærke foran et navn: "Ejer", "Anmelder", "Klager".
export function Rolle({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1.5 inline-block rounded border border-neutral-300 bg-white px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
      {children}
    </span>
  );
}

export function PlaceringLink({ indholdType, placering }: { indholdType: string; placering: string }) {
  // Kendt indhold: placeringen er en intern sti, som serveren har bygget.
  if (indholdType !== "andet" && placering.startsWith("/")) {
    return (
      <Link href={placering} className="break-all font-medium text-groen hover:underline" target="_blank">
        {placering}
        <span className="sr-only"> (åbner i en ny fane)</span>
      </Link>
    );
  }
  // Fritekst fra anmelderen - vises som tekst, aldrig som link.
  return <span className="break-all text-neutral-700">{placering}</span>;
}

export function Inhabil({ grund }: { grund: string }) {
  return (
    <div className="mt-4 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2.5 text-sm text-advarsel-tekst">
      <p className="font-semibold">Du kan ikke behandle denne sag</p>
      <p className="mt-0.5">{grund} En kollega skal tage den.</p>
    </div>
  );
}

export function Boks({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-neutral-50 p-3 text-sm">
      <h3 className="font-sans text-xs font-semibold uppercase tracking-wide text-neutral-600">{titel}</h3>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
