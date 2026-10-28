import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { StaffRole } from "@/lib/adminAuth";
import DokumentationKnap from "@/components/admin/sager/DokumentationKnap";
import { sagTid } from "@/components/sager/visning";
import { maaLaveDokumentation, type SagDokumentationUdgave } from "@/lib/sagDokumentation/regler";

// Kortet "Dokumentation" på admin-sagssiden: knapperne og loggen over
// udleveringer. Databasen (sag_dokumentation_liste) filtrerer loggen efter
// rollen: kun chefen ser udleveringer af udgaven til politiet. Kaldes efter
// sidens rolletjek (kraevSideRolle/hentSag).

type Raekke = {
  id: string;
  udgave: SagDokumentationUdgave;
  givet_til: string;
  journalnummer: string | null;
  lavet_af_navn: string | null;
  lavet_kl: string;
};

export default async function SagDokumentation({
  admin,
  sagId,
  mig,
  rolle,
  inhabil,
}: {
  admin: ReturnType<typeof createAdminClient>;
  sagId: string;
  mig: string;
  rolle: StaffRole | null;
  inhabil: boolean;
}) {
  const { data, error } = await admin.rpc("sag_dokumentation_liste", { p_medarbejder: mig || null, p_sag: sagId });
  // Før migrationen 20261102360000 er kørt, findes funktionen ikke.
  const mangler = !!error && (error.code === "PGRST202" || error.code === "42883");
  const logFejl = !!error && !mangler;
  if (logFejl) console.error("sag_dokumentation_liste fejlede:", error.code, error.message);
  const raekker = (data ?? []) as Raekke[];
  const kanSaelger = maaLaveDokumentation(rolle, "saelger", inhabil);
  const kanPoliti = maaLaveDokumentation(rolle, "politi", inhabil);

  return (
    <section className="rounded-none border border-admin-kant bg-white p-4 sm:p-5">
      <h2 className="mb-1 text-base font-semibold text-neutral-900">Dokumentation til sælger og politi</h2>
      <p className="mb-3 text-sm text-neutral-600">
        PDF med sagens dokumentation, fx når sælgeren vil anmelde en tom pakke på politi.dk. Hver udlevering logges.
      </p>
      {mangler ? (
        <p className="text-sm text-neutral-500">Kræver migrationen 20261102360000_sag_dokumentation.sql.</p>
      ) : inhabil ? (
        <p className="text-sm text-neutral-600">
          Du er inhabil i sagen (part i handlen eller har handlet med en af parterne) og kan ikke lave dokumentationen.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {kanSaelger && <DokumentationKnap sagId={sagId} udgave="saelger" />}
          {kanPoliti && <DokumentationKnap sagId={sagId} udgave="politi" />}
        </div>
      )}
      {logFejl && (
        <p role="alert" className="mt-3 text-sm text-fejl-tekst">
          Loggen over udleveringer kunne ikke hentes. Genindlæs siden.
        </p>
      )}
      {raekker.length > 0 && (
        <div className="mt-4 border-t border-neutral-100 pt-3">
          <h3 className="mb-2 text-sm font-medium text-neutral-700">Udleveret ({raekker.length})</h3>
          <ul className="space-y-2 text-sm">
            {raekker.map((r) => (
              <li key={r.id} className="border-l-2 border-neutral-200 pl-3">
                <p className="font-medium text-neutral-800">
                  {r.udgave === "politi" ? "Til politiet" : "Til sælger"} · {r.givet_til}
                  {r.journalnummer && <span className="font-normal text-neutral-600"> · journalnr. {r.journalnummer}</span>}
                </p>
                <p className="text-xs text-neutral-500">
                  {sagTid(r.lavet_kl)} · {r.lavet_af_navn ?? "ukendt"}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
