import Ikon from "@/components/Ikon";
import { MITID } from "@/lib/tekster/mitid";

// Boksen før første bud / første auktion: "Bekræft med MitID" starter flowet
// (/api/mitid/start) og sender brugeren tilbage til `retur` bagefter.
// Et almindeligt link (ikke next/link): det er en route handler, der sender
// videre til Idura.
export function mitIdStartHref(retur: string): string {
  return `/api/mitid/start?retur=${encodeURIComponent(retur)}`;
}

export function MitIDKnap({ retur, stor = false }: { retur: string; stor?: boolean }) {
  return (
    <a href={mitIdStartHref(retur)} className={`btn btn-primaer ${stor ? "btn-stor" : ""} inline-flex items-center gap-2`}>
      <Ikon navn="personTjek" className="h-5 w-5 shrink-0" strøg={2} />
      {MITID.knap}
    </a>
  );
}

export default function MitIDKraeves({ sted, retur }: { sted: "bud" | "saelg"; retur: string }) {
  return (
    <div role="note" className="rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-4 text-advarsel-tekst">
      <p className="text-[17px] font-semibold">{sted === "bud" ? MITID.kraevesTitelBud : MITID.kraevesTitelSaelg}</p>
      <p className="mt-1 text-base">{MITID.kraevesTekst}</p>
      <p className="mt-2 text-sm">{MITID.kraevesPrivat}</p>
      <div className="mt-3">
        <MitIDKnap retur={retur} />
      </div>
    </div>
  );
}
