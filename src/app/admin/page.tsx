import { redirect } from "next/navigation";
import { assertRole, harMindstRolle, type StaffRole } from "@/lib/adminAuth";
import KraeverHandling from "@/components/admin/forside/KraeverHandling";
import PeriodeKort from "@/components/admin/forside/PeriodeKort";
import TilvaekstGraf from "@/components/admin/forside/TilvaekstGraf";
import { tolkForsideTal, type ForsideTal } from "@/components/admin/forside/forsideTal";

// Admin-forsiden (ROADMAP fase 1B). Alle staff-roller må se den. Kun ANTAL -
// beløb og indtjening ligger på en side, som kun chef har adgang til, og der
// vises ingen personoplysninger. Alle tal kommer fra admin_forside_tal()
// (kun service_role) i ét kald.

async function hentTal(): Promise<{ rolle: StaffRole; tal: ForsideTal | null } | null> {
  let adgang: Awaited<ReturnType<typeof assertRole>>;
  try {
    adgang = await assertRole("medarbejder");
  } catch {
    return null;
  }
  const { data, error } = await adgang.admin.rpc("admin_forside_tal");
  if (error) {
    console.error("admin_forside_tal fejlede:", error.message);
    return { rolle: adgang.rolle, tal: null };
  }
  return { rolle: adgang.rolle, tal: tolkForsideTal(data) };
}

export default async function AdminForside() {
  const res = await hentTal();
  if (!res) redirect("/");
  const { rolle, tal } = res;

  return (
    <div className="space-y-8 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-neutral-900">Forside</h1>

      {!tal ? (
        <div role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Tallene kunne ikke hentes lige nu. Prøv at genindlæse siden.
        </div>
      ) : (
        <>
          <KraeverHandling tal={tal.handling} visKontolukninger={harMindstRolle(rolle, "admin")} />

          <section aria-labelledby="forside-brugere" className="space-y-3">
            <h2 id="forside-brugere" className="text-lg font-bold text-neutral-900">
              Brugere
            </h2>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <PeriodeKort
                titel="Nye brugere"
                tal={tal.brugere}
                hovedtal={{ label: "brugere i alt", vaerdi: tal.brugere.i_alt }}
              />
              <div className="min-w-0 lg:col-span-2">
                <TilvaekstGraf data={tal.tilvaekst} />
              </div>
            </div>
          </section>

          <section aria-labelledby="forside-aktivitet" className="space-y-3">
            <h2 id="forside-aktivitet" className="text-lg font-bold text-neutral-900">
              Aktivitet
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <PeriodeKort titel="Nye auktioner" tal={tal.aktivitet.auktioner} />
              <PeriodeKort titel="Solgte varer (betalte handler)" tal={tal.aktivitet.solgte} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
