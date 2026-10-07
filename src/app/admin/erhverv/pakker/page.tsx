import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervPakker } from "@/app/actions/adminErhverv";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ErhvervFaner from "@/components/admin/erhverv/ErhvervFaner";
import PakkeEditor from "@/components/admin/erhverv/PakkeEditor";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";

// Pakker: chef opretter og ændrer, saelger kan kun se.
export default async function ErhvervPakkerSide() {
  const { rolle } = await kraevErhvervSide();
  const res = await hentErhvervPakker();

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <AdminSideHoved titel={A.menupunkt} forklaring={X.forklaring} />
      <ErhvervFaner aktiv="pakker" />
      <div>
        <h2 className="font-sans text-lg font-semibold text-neutral-900">{A.pakker.titel}</h2>
        <p className="text-sm text-neutral-600">{A.pakker.forklaring}</p>
      </div>
      {"fejl" in res ? (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {res.fejl}
        </p>
      ) : (
        <PakkeEditor pakker={res.pakker} erChef={rolle === "chef"} />
      )}
    </div>
  );
}
