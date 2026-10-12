import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervPakker } from "@/app/actions/adminErhverv";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ErhvervFaner from "@/components/admin/erhverv/ErhvervFaner";
import PakkeEditor from "@/components/admin/erhverv/PakkeEditor";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import AdminSide from "@/components/admin/AdminSide";

// Pakker: chef opretter og ændrer, saelger kan kun se.
export default async function ErhvervPakkerSide() {
  const { rolle } = await kraevErhvervSide();
  const res = await hentErhvervPakker();

  return (
    <AdminSide>
      <AdminSideHoved titel="Pakker" forklaring={X.forklaring} />
      <ErhvervFaner aktiv="pakker" />
      <div>
        <h2 className="font-sans text-lg font-semibold text-tekst">{A.pakker.titel}</h2>
        <p className="text-sm text-tekst-daempet">{A.pakker.forklaring}</p>
      </div>
      {"fejl" in res ? (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {res.fejl}
        </p>
      ) : (
        <PakkeEditor pakker={res.pakker} erChef={rolle === "chef"} />
      )}
    </AdminSide>
  );
}
