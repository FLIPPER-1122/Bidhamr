import Link from "next/link";
import type { createAdminClient } from "@/lib/supabase/admin";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { nulstilMitId } from "@/app/actions/adminMitid";

// MitID på brugersiden i admin (20261013010000_mitid.sql): status,
// tidspunkt, juridisk navn og fødselsdato (kun internt - staff), historik,
// afviste forsøg (mulig dobbeltkonto) og "Nulstil MitID" (admin/chef).

type Admin = ReturnType<typeof createAdminClient>;

type Verificering = {
  id: string;
  status: "aktiv" | "nulstillet" | "slettet";
  juridisk_navn: string | null;
  foedselsdato: string | null;
  verificeret_kl: string;
  nulstillet_kl: string | null;
  nulstil_aarsag: string | null;
};

type Forsoeg = {
  id: string;
  bruger_id: string;
  anden_bruger_id: string | null;
  aarsag: string;
  oprettet_kl: string;
  behandlet_kl: string | null;
};

const FORSOEG_TEKST: Record<string, string> = {
  dobbeltkonto: "MitID'en er allerede brugt på en anden konto (mulig dobbeltkonto)",
  lukket_konto: "MitID'en hører til en permanent lukket konto",
  under_18: "Under 18 år",
  tidligere_slettet: "Samme MitID som en slettet konto (tilladt)",
  tidligere_spaerret: "Afvist: samme MitID som en slettet konto, der var suspenderet eller havde 3 advarsler",
};

const STATUS_TEKST: Record<Verificering["status"], string> = {
  aktiv: "Aktiv",
  nulstillet: "Nulstillet",
  slettet: "Konto slettet",
};

function tid(iso: string) {
  return new Date(iso).toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Copenhagen" });
}

export function MitIdBadge({ verificeretKl, erFirma }: { verificeretKl: string | null; erFirma: boolean }) {
  if (erFirma) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-600">
        MitID: firmakonto (undtaget)
      </span>
    );
  }
  return verificeretKl ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-800">
      MitID-verificeret {new Date(verificeretKl).toLocaleDateString("da-DK")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 font-medium text-yellow-800">
      MitID: ikke verificeret
    </span>
  );
}

export default async function MitIdAdminKort({
  admin,
  brugerId,
  brugerNavn,
  verificeretKl,
  erFirma,
  kanNulstille,
  erLukket,
}: {
  admin: Admin;
  brugerId: string;
  brugerNavn: string;
  verificeretKl: string | null;
  erFirma: boolean;
  kanNulstille: boolean;
  erLukket: boolean;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brugerId)) return null;
  const [{ data: v }, { data: f }] = await Promise.all([
    admin
      .from("mitid_verificeringer")
      .select("id, status, juridisk_navn, foedselsdato, verificeret_kl, nulstillet_kl, nulstil_aarsag")
      .eq("bruger_id", brugerId)
      .order("verificeret_kl", { ascending: false })
      .limit(20),
    admin
      .from("mitid_forsoeg")
      .select("id, bruger_id, anden_bruger_id, aarsag, oprettet_kl, behandlet_kl")
      .or(`bruger_id.eq.${brugerId},anden_bruger_id.eq.${brugerId}`)
      .order("oprettet_kl", { ascending: false })
      .limit(20),
  ]);
  const verificeringer = (v ?? []) as Verificering[];
  const forsoeg = (f ?? []) as Forsoeg[];
  const aktiv = verificeringer.find((x) => x.status === "aktiv") ?? null;

  if (erFirma && verificeringer.length === 0 && forsoeg.length === 0) return null;

  return (
    <section aria-labelledby="mitid-titel" className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="mitid-titel" className="text-base font-semibold text-neutral-900">MitID</h2>
        <MitIdBadge verificeretKl={verificeretKl} erFirma={erFirma} />
      </div>

      {aktiv ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-neutral-500">Verificeret</dt>
            <dd className="text-neutral-900">{tid(aktiv.verificeret_kl)}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Juridisk navn (kun internt)</dt>
            <dd className="text-neutral-900">{aktiv.juridisk_navn ?? "–"}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Fødselsdato (kun internt)</dt>
            <dd className="text-neutral-900">
              {aktiv.foedselsdato ? new Date(aktiv.foedselsdato).toLocaleDateString("da-DK") : "–"}
            </dd>
          </div>
        </dl>
      ) : (
        !erFirma && (
          <p className="mt-2 text-sm text-neutral-600">
            Brugeren er ikke verificeret. Brugeren bliver bedt om MitID før første bud eller auktion.
          </p>
        )
      )}

      {aktiv && kanNulstille && !erLukket && (
        <div className="mt-4">
          <ConfirmDialog
            triggerLabel="Nulstil MitID"
            triggerClassName="inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-semibold text-neutral-800 hover:bg-neutral-200 transition-colors"
            title={`Nulstil MitID for ${brugerNavn}?`}
            description="Brugeren skal bekræfte sig med MitID igen, før næste bud eller auktion. MitID'en frigives, så den kan bruges på en anden konto. Handlingen logges."
            confirmLabel="Ja, nulstil MitID"
            action={nulstilMitId}
            hiddenFields={{ userId: brugerId }}
            tekstFelter={[
              {
                name: "aarsag",
                label: "Begrundelse (intern)",
                placeholder: "Fx: Forkert person verificerede kontoen (se samtale).",
                required: true,
                maxLength: 1000,
              },
            ]}
          />
        </div>
      )}

      {verificeringer.some((x) => x.status !== "aktiv") && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-neutral-700">Tidligere</h3>
          <ul className="mt-1 space-y-1 text-sm text-neutral-600">
            {verificeringer
              .filter((x) => x.status !== "aktiv")
              .map((x) => (
                <li key={x.id}>
                  {STATUS_TEKST[x.status]} · verificeret {tid(x.verificeret_kl)}
                  {x.nulstillet_kl && ` · nulstillet ${tid(x.nulstillet_kl)}`}
                  {x.nulstil_aarsag && ` – ${x.nulstil_aarsag}`}
                </li>
              ))}
          </ul>
        </div>
      )}

      {forsoeg.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-neutral-700">MitID-forsøg og mulige dobbeltkonti</h3>
          <ul className="mt-1 space-y-1 text-sm text-neutral-700">
            {forsoeg.map((x) => {
              const anden = x.bruger_id === brugerId ? x.anden_bruger_id : x.bruger_id;
              return (
                <li key={x.id} className="flex flex-wrap gap-x-2">
                  <span>{tid(x.oprettet_kl)}:</span>
                  <span>
                    {x.bruger_id === brugerId
                      ? FORSOEG_TEKST[x.aarsag] ?? x.aarsag
                      : `En anden konto prøvede at bruge denne brugers MitID (${FORSOEG_TEKST[x.aarsag] ?? x.aarsag})`}
                  </span>
                  {anden && (
                    <Link href={`/admin/brugere/${anden}`} className="font-medium text-groen underline">
                      Se den anden konto
                    </Link>
                  )}
                  {x.behandlet_kl && <span className="text-neutral-400">(gennemgået)</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
