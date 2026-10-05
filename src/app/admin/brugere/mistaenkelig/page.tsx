import Link from "next/link";
import BrugereFaner from "@/components/admin/BrugereFaner";
import { RolleBadge } from "@/components/admin/StatusBadge";
import { assertRole } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";

// Mistænkelig aktivitet: reglerne ligger samlet i SQL-funktionen
// admin_mistaenkelige_brugere() (service_role). Listen viser kun, hvilke
// regler der rammer, og tallene – der sker ingen automatiske handlinger.
// Staff vurderer selv og bruger de almindelige knapper på brugersiden.

type Regel = { regel: string; antal: number; graense: number };

type MistaenkeligRaekke = {
  bruger_id: string;
  navn: string | null;
  email: string;
  rolle: string | null;
  oprettet: string;
  suspenderet_aktiv: boolean;
  regler: Regel[];
  antal_regler: number;
};

// Tekst pr. regel. Grænser og perioder bestemmes i SQL-funktionen.
const REGEL_TEKST: Record<string, (r: Regel) => string> = {
  ubetalte_vindere: (r) => `${r.antal} ubetalte vinderauktioner som køber de sidste 90 dage`,
  sager_koeber: (r) => `${r.antal} sager som køber de sidste 90 dage`,
  sager_tabt_saelger: (r) => `${r.antal} sager tabt som sælger de sidste 90 dage`,
  afsendelsesfrist: (r) =>
    `${r.antal} handler annulleret, fordi varen ikke blev sendt i tide, de sidste 90 dage`,
  indsigelser: (r) => `${r.antal} indsigelser fra købers bank de sidste 90 dage`,
  rapporter: (r) => `${r.antal} forskellige brugere har rapporteret brugerens auktioner de sidste 90 dage`,
  ny_konto_mange_bud: (r) => `Ny konto (under 7 dage) med ${r.antal} bud`,
};

function regelTekst(r: Regel): string {
  return REGEL_TEKST[r.regel]?.(r) ?? `${r.regel}: ${r.antal}`;
}

export default async function AdminMistaenkelig() {
  const { admin } = await assertRole("medarbejder");

  const { data, error } = await admin.rpc("admin_mistaenkelige_brugere");
  if (error) console.error("admin_mistaenkelige_brugere fejlede:", error);
  const raekker = (data ?? []) as MistaenkeligRaekke[];

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      <AdminSideHoved
        titel="Brugere"
        forklaring="Brugere, der opfører sig mistænkeligt. Listen er kun et signal – vurdér altid selv, før du advarer eller suspenderer."
      />

      <BrugereFaner aktiv="mistaenkelig" />

      {error && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          Listen kunne ikke hentes. Prøv igen om lidt.
        </p>
      )}

      <div className="space-y-2">
        {raekker.map((r) => (
          <Link
            key={r.bruger_id}
            href={`/admin/brugere/${r.bruger_id}`}
            className="block rounded-xl border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md"
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 truncate font-semibold text-neutral-900">
                {r.navn ?? "Uden navn"}
                <span className="ml-2 text-sm font-normal text-neutral-500">{r.email}</span>
              </p>
              {r.rolle && r.rolle !== "bruger" && <RolleBadge rolle={r.rolle} />}
              {r.suspenderet_aktiv && (
                <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-800">
                  Suspenderet
                </span>
              )}
              <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-800">
                {r.antal_regler} {r.antal_regler === 1 ? "regel" : "regler"}
              </span>
            </div>
            <ul className="mt-2 space-y-1 text-sm text-neutral-700">
              {r.regler.map((regel) => (
                <li key={regel.regel} className="flex gap-2">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500" />
                  <span>
                    {regelTekst(regel)}
                    <span className="ml-1 text-xs text-neutral-400">(grænse {regel.graense})</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-neutral-400">
              Medlem siden {new Date(r.oprettet).toLocaleDateString("da-DK")}
            </p>
          </Link>
        ))}
        {!error && raekker.length === 0 && (
          <div className="rounded-xl border border-neutral-200 bg-white p-10 text-center text-neutral-400">
            Ingen brugere rammer reglerne lige nu.
          </div>
        )}
      </div>

      <details className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
        <summary className="cursor-pointer font-medium text-neutral-800">Reglerne</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Mindst 2 ubetalte vinderauktioner som køber (sidste 90 dage, afviste tæller ikke)</li>
          <li>Mindst 3 sager som køber (sidste 90 dage)</li>
          <li>Mindst 2 sager tabt som sælger (sidste 90 dage)</li>
          <li>Mindst 2 handler annulleret, fordi sælgeren ikke sendte i tide (sidste 90 dage)</li>
          <li>Mindst 2 indsigelser fra købers bank (sidste 90 dage)</li>
          <li>Mindst 3 forskellige brugere har rapporteret brugerens auktioner (sidste 90 dage)</li>
          <li>Konto under 7 dage gammel med mindst 20 bud</li>
        </ul>
        <p className="mt-2 text-xs text-neutral-400">Lukkede konti vises ikke.</p>
      </details>
    </div>
  );
}
