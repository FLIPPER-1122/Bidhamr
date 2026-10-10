import Ikon from "@/components/Ikon";
import { MITID } from "@/lib/tekster/mitid";

// Boksen før første bud / første auktion: "Bekræft med MitID" starter flowet
// (/api/mitid/start) og sender brugeren tilbage til `retur` bagefter.
// Et almindeligt link (ikke next/link): det er en route handler, der sender
// videre til Idura.
export function mitIdStartHref(retur: string): string {
  return `/api/mitid/start?retur=${encodeURIComponent(retur)}`;
}

// fuldBredde: fuld bredde og 52px høj på mobil (DESIGN.md 12), almindelig fra sm.
export function MitIDKnap({
  retur,
  stor = false,
  fuldBredde = false,
}: {
  retur: string;
  stor?: boolean;
  fuldBredde?: boolean;
}) {
  const stoerrelse = fuldBredde ? "btn-stor w-full sm:w-auto" : stor ? "btn-stor" : "";
  return (
    <a href={mitIdStartHref(retur)} className={`btn btn-primaer ${stoerrelse}`}>
      <Ikon navn="personTjek" className="h-5 w-5 shrink-0" strøg={2} />
      {MITID.knap}
    </a>
  );
}

// Ikonflade til MitID-boksene (DESIGN.md 7.4: 38px, rounded-lg, hvid flade).
export function MitIDIkon() {
  return (
    <span aria-hidden="true" className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-white">
      <Ikon navn="personTjek" className="h-[18px] w-[18px]" strøg={2} />
    </span>
  );
}

// Samme boks på budpanelet og Opret auktion (kun titlen skifter).
export default function MitIDKraeves({ sted, retur }: { sted: "bud" | "saelg"; retur: string }) {
  return (
    <div role="note" className="rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst sm:p-5">
      <div className="flex items-start gap-3">
        <MitIDIkon />
        <div className="min-w-0">
          <p className="text-[17px] leading-snug font-semibold">
            {sted === "bud" ? MITID.kraevesTitelBud : MITID.kraevesTitelSaelg}
          </p>
          <p className="mt-1 text-[15px] leading-normal">{MITID.kraevesTekst}</p>
        </div>
      </div>
      <p className="mt-3 text-sm">{MITID.kraevesPrivat}</p>
      <div className="mt-4">
        <MitIDKnap retur={retur} fuldBredde />
      </div>
    </div>
  );
}
