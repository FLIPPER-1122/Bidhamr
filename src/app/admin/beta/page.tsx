import type { Metadata } from "next";
import { kraevSideRolle } from "@/lib/adminAuth";
import { hentBetaOversigt } from "@/app/actions/adminBeta";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import BetaAdmin from "@/components/admin/beta/BetaAdmin";

export const metadata: Metadata = { title: "Beta-invitationer", robots: { index: false, follow: false } };

// Admin → Beta-invitationer (docs/BETA-TEST.md). Admin og chef inviterer
// testpersoner; kun chefen åbner og lukker beta-testen.
export default async function AdminBetaSide() {
  const { rolle } = await kraevSideRolle("admin");
  const oversigt = await hentBetaOversigt();

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <AdminSideHoved
        titel="Beta-invitationer"
        forklaring="Invitér testpersoner til beta-testen. Kun inviterede e-mails kan oprette en konto og komme forbi coming-soon, og kun mens beta-testen er åben. Admin er altid lukket for dem."
      />
      {"fejl" in oversigt ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {oversigt.fejl}
        </p>
      ) : (
        <BetaAdmin oversigt={oversigt} erChef={rolle === "chef"} />
      )}
    </div>
  );
}
