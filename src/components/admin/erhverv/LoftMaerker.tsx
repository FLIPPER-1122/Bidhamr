import { UGENS_ADMIN as T } from "@/lib/tekster/ugensButik";

// Loft-status for en booket uge i Ugens butik (ugens_butik_admin -> uger,
// 20261102020000): "Over loftet", når firmaets uger omkring denne bryder
// reglen (4 uger i træk), og "Loft tilsidesat af chef", når staff omgik
// loftet ved netop denne booking. Egne mærker (ikke AdminBadge), så teksten
// kan bryde over flere linjer i de smalle kalenderceller.
const MAERKE = "block w-full border px-1.5 py-0.5 text-[11px] font-semibold leading-tight";

export default function LoftMaerker({ brudt, omgaaet, maks }: { brudt: boolean; omgaaet: boolean; maks: number }) {
  if (!brudt && !omgaaet) return null;
  return (
    <span className="mt-1 flex flex-col gap-1">
      {brudt && <span className={`${MAERKE} border-fejl-kant bg-fejl-bg text-fejl-tekst`}>{T.overLoftet(maks)}</span>}
      {omgaaet && <span className={`${MAERKE} border-advarsel-kant bg-orange-lys text-advarsel-tekst`}>{T.loftTilsidesat}</span>}
    </span>
  );
}
