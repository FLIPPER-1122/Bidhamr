import Link from "next/link";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { afvisKontoLukning, godkendKontoLukning } from "@/app/actions/adminKontoLukning";

// Ét forslag om permanent lukning efter 3 advarsler (konto_lukning_forslag).
// Bruges på /admin/kontolukninger og på admin-brugersiden.

export type KontoLukningForslag = {
  id: string;
  bruger_id: string;
  advarsler_antal: number;
  status: "afventer" | "godkendt" | "afvist" | "bortfaldet";
  oprettet_kl: string;
  behandlet_af: string | null;
  behandlet_kl: string | null;
  begrundelse: string | null;
};

export type KontoLukningAdvarsel = {
  id: string;
  bruger_id: string;
  begrundelse_bruger: string | null;
  aarsag: string | null;
  grund: string | null;
  oprettet_kl: string;
};

const STATUS_NAVN: Record<KontoLukningForslag["status"], string> = {
  afventer: "Afventer",
  godkendt: "Lukket permanent",
  afvist: "Afvist",
  bortfaldet: "Bortfaldet (var allerede lukket)",
};

const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Copenhagen",
  });

export default function KontoLukningKort({
  f,
  bruger,
  behandletAf,
  advarsler,
  paamindelser,
}: {
  f: KontoLukningForslag;
  bruger?: { navn: string | null; email: string | null; rolle: string | null; konto_lukket_kl: string | null };
  behandletAf: string | null;
  advarsler: KontoLukningAdvarsel[];
  paamindelser: number;
}) {
  const erStaff = bruger?.rolle === "medarbejder" || bruger?.rolle === "admin" || bruger?.rolle === "chef";
  return (
    <div className="rounded-xl border border-red-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/admin/brugere/${f.bruger_id}`} className="block hover:underline">
            <span className="block truncate font-semibold text-neutral-900">{bruger?.navn ?? "Uden navn"}</span>
            <span className="block truncate text-xs text-neutral-500">{bruger?.email}</span>
          </Link>
          <p className="mt-1 text-xs text-neutral-500">Forslag oprettet {dato(f.oprettet_kl)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700">
            {advarsler.length} advarsler
          </span>
          {paamindelser > 0 && (
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
              {paamindelser} {paamindelser === 1 ? "påmindelse" : "påmindelser"} (tæller ikke)
            </span>
          )}
          {f.status !== "afventer" && (
            <span className="rounded-full bg-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700">
              {STATUS_NAVN[f.status]}
            </span>
          )}
        </div>
      </div>

      <ol className="mt-3 space-y-2">
        {advarsler.map((a) => (
          <li key={a.id} className="rounded-lg bg-neutral-50 px-3 py-2 text-sm">
            <p className="text-xs text-neutral-500">
              {dato(a.oprettet_kl)}
              {a.grund === "daarlig_indpakning" && " · Dårlig indpakning"}
            </p>
            <p className="whitespace-pre-line text-neutral-800">
              {a.begrundelse_bruger ?? "Ingen begrundelse til brugeren (gammel advarsel)."}
            </p>
            {a.aarsag && <p className="mt-1 whitespace-pre-line text-xs text-neutral-500">Intern: {a.aarsag}</p>}
          </li>
        ))}
      </ol>

      {f.status === "afventer" ? (
        <div className="mt-4 space-y-2">
          {bruger?.konto_lukket_kl && (
            <p className="text-sm text-neutral-600">
              Kontoen er allerede lukket. Godkend for at markere forslaget som bortfaldet.
            </p>
          )}
          {erStaff && (
            <p className="rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
              Brugeren er {bruger?.rolle}. Staff-konti kan ikke lukkes herfra – en chef skal fjerne rollen først,
              ellers afvis forslaget.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <ConfirmDialog
              triggerLabel="Luk kontoen permanent"
              triggerClassName="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700"
              title="Luk kontoen permanent?"
              description={`Kontoen lukkes uden slutdato og kan ikke åbnes igen fra admin. Brugeren får beskeden: "Din konto er lukket permanent efter 3 advarsler. Kontakt support@bidhamr.dk".`}
              confirmLabel="Luk kontoen permanent"
              action={godkendKontoLukning}
              hiddenFields={{ forslagId: f.id }}
              tekstFelter={[
                {
                  name: "note",
                  label: "Intern note (kun staff)",
                  required: false,
                  maxLength: 2000,
                  hjaelp: "Brugeren ser aldrig noten. Ved login står årsagen \"3 advarsler\".",
                },
              ]}
            />
            <ConfirmDialog
              triggerLabel="Afvis"
              triggerClassName="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-200"
              title="Afvis lukningen?"
              description="Kontoen forbliver åben, og brugeren får ingen besked. Får brugeren en ny advarsel, oprettes et nyt forslag."
              confirmLabel="Afvis lukningen"
              action={afvisKontoLukning}
              hiddenFields={{ forslagId: f.id }}
              tekstFelter={[
                {
                  name: "begrundelse",
                  label: "Hvorfor skal kontoen ikke lukkes? (kun staff)",
                  required: true,
                  maxLength: 2000,
                  hjaelp: "Gemmes i loggen. Brugeren ser den ikke.",
                },
              ]}
            />
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
          {f.behandlet_kl && (
            <p className="text-xs text-neutral-500">
              {dato(f.behandlet_kl)} · {behandletAf ?? "ukendt"}
            </p>
          )}
          {f.begrundelse && <p className="mt-1 whitespace-pre-line">{f.begrundelse}</p>}
        </div>
      )}
    </div>
  );
}
