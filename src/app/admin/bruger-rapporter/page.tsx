import Link from "next/link";
import { kraevSideRolle, harMindstRolle } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import RapportFaner from "@/components/admin/RapportFaner";
import AdminActionKnap from "@/components/admin/AdminActionKnap";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { brugerRapportBehandlet, brugerRapportGenaabn } from "@/app/actions/adminTryghed";
import { rapportKategoriNavn, spamNavnStaff } from "@/lib/tryghed";

// Rapporter af chatbeskeder og profiler (bruger_rapporter): fra brugere og
// fra spamfilteret. Medarbejder og op. Rapporter slettes aldrig.

export const dynamic = "force-dynamic";

type Raekke = {
  id: string;
  kilde: "bruger" | "auto";
  reporter_id: string | null;
  reported_id: string;
  message_id: string | null;
  trade_id: string | null;
  category: string;
  description: string | null;
  status: "ny" | "behandlet";
  handled_by: string | null;
  handled_at: string | null;
  handled_note: string | null;
  created_at: string;
};

const TZ = "Europe/Copenhagen";
const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });

export default async function BrugerRapporterSide({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string }>;
}) {
  const { admin, rolle } = await kraevSideRolle("medarbejder");
  const { vis } = await searchParams;
  const visBehandlede = vis === "behandlede";

  const { data, error } = await admin
    .from("bruger_rapporter")
    .select(
      "id, kilde, reporter_id, reported_id, message_id, trade_id, category, description, status, handled_by, handled_at, handled_note, created_at",
    )
    .eq("status", visBehandlede ? "behandlet" : "ny")
    .order(visBehandlede ? "handled_at" : "created_at", { ascending: false })
    .limit(300);
  const rapporter = (data ?? []) as Raekke[];

  const brugerIds = [
    ...new Set(
      rapporter.flatMap((r) => [r.reporter_id, r.reported_id, r.handled_by]).filter((x): x is string => !!x),
    ),
  ];
  const beskedIds = [...new Set(rapporter.map((r) => r.message_id).filter((x): x is string => !!x))];

  const [{ data: brugere }, { data: beskeder }] = await Promise.all([
    brugerIds.length
      ? admin.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string | null; email: string }[] }),
    beskedIds.length
      ? admin.from("messages").select("id, content, created_at, blokeret_grund").in("id", beskedIds)
      : Promise.resolve({
          data: [] as { id: string; content: string; created_at: string; blokeret_grund: string | null }[],
        }),
  ]);
  const brugerMap = new Map((brugere ?? []).map((u) => [u.id as string, u]));
  const beskedMap = new Map((beskeder ?? []).map((b) => [b.id as string, b]));

  const navn = (id: string | null) => (id ? (brugerMap.get(id)?.navn ?? "Uden navn") : "—");

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Rapporter"
        forklaring="Beskeder og brugere, som andre brugere har rapporteret, og beskeder, spamfilteret har markeret. Se samtalen igennem, og afgør om brugeren skal have en advarsel (under Brugere)."
        hoejre={
          <span className="text-sm text-neutral-500">
            {rapporter.length} {rapporter.length === 1 ? "rapport" : "rapporter"}
          </span>
        }
      />

      <RapportFaner aktiv="chat" visArkiv={harMindstRolle(rolle, "admin")} />

      <div className="flex gap-2 text-sm">
        <Link
          href="/admin/bruger-rapporter"
          aria-current={!visBehandlede ? "page" : undefined}
          className={`rounded-full px-3 py-1 ${!visBehandlede ? "bg-groen text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"}`}
        >
          Nye
        </Link>
        <Link
          href="/admin/bruger-rapporter?vis=behandlede"
          aria-current={visBehandlede ? "page" : undefined}
          className={`rounded-full px-3 py-1 ${visBehandlede ? "bg-groen text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"}`}
        >
          Behandlede
        </Link>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Rapporterne kunne ikke hentes. Er migrationen 20261006030000_tryghed_chat_kontakt.sql kørt?
        </p>
      )}

      <ul className="space-y-3">
        {rapporter.map((r) => {
          const besked = r.message_id ? beskedMap.get(r.message_id) : undefined;
          return (
            <li key={r.id} className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-neutral-900">
                    {rapportKategoriNavn(r.category)}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {tid(r.created_at)} ·{" "}
                    {r.kilde === "auto" ? (
                      "Spamfilteret"
                    ) : (
                      <>
                        Rapporteret af{" "}
                        <Link href={`/admin/brugere/${r.reporter_id}`} className="hover:underline">
                          {navn(r.reporter_id)}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <Link
                  href={`/admin/brugere/${r.reported_id}`}
                  className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-200"
                >
                  Rapporteret: {navn(r.reported_id)}
                </Link>
              </div>

              {r.description && (
                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-neutral-700">{r.description}</p>
              )}

              {besked && (
                <blockquote className="mt-3 rounded-lg border-l-4 border-kant-staerk bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
                  <p className="whitespace-pre-wrap break-words">{besked.content}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {tid(besked.created_at)}
                    {besked.blokeret_grund &&
                      ` · Stoppet af spamfilteret (${spamNavnStaff(besked.blokeret_grund)})`}
                  </p>
                </blockquote>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {r.trade_id && (
                  <Link
                    href={`/admin/handler/${r.trade_id}/chat`}
                    className="text-sm font-medium text-groen hover:underline"
                  >
                    Se hele samtalen
                  </Link>
                )}
                {r.status === "ny" ? (
                  <ConfirmDialog
                    triggerLabel="Markér som behandlet"
                    triggerClassName="whitespace-nowrap rounded-md bg-green-100 px-2 py-1 text-xs text-green-800 transition-colors hover:bg-green-200"
                    title="Markér rapporten som behandlet?"
                    description="Rapporten flyttes til Behandlede. Den slettes aldrig."
                    confirmLabel="Ja, markér som behandlet"
                    action={brugerRapportBehandlet}
                    hiddenFields={{ rapportId: r.id }}
                    aarsagField={{
                      label: "Note",
                      placeholder: "Hvad har du tjekket, og hvad er konklusionen?",
                      required: true,
                    }}
                  />
                ) : (
                  <>
                    <span className="text-xs text-neutral-500">
                      Behandlet af {navn(r.handled_by)}
                      {r.handled_at && ` · ${tid(r.handled_at)}`}
                      {r.handled_note && `: ${r.handled_note}`}
                    </span>
                    <AdminActionKnap
                      action={brugerRapportGenaabn}
                      hiddenFields={{ rapportId: r.id }}
                      label="Genåbn"
                      className="whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-200"
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
        {rapporter.length === 0 && !error && (
          <li className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-400">
            {visBehandlede ? "Ingen behandlede rapporter endnu." : "Der er ingen nye rapporter."}
          </li>
        )}
      </ul>
    </div>
  );
}
