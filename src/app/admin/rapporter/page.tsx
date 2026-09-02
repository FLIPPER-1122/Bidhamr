import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { kategoriLabel } from "@/lib/anmeldelseKategorier";
import {
  rapportMarkerBehandlet,
  rapportSletMidlertidigt,
  rapportFjernOpslag,
  rapportGenaabn,
} from "@/app/actions/adminActions";

type RapportRow = {
  id: string;
  auction_id: string;
  reporter_id: string;
  category: string;
  description: string | null;
  created_at: string;
  status: string;
};

const STATUS_STIL: Record<string, { klasse: string; tekst: string }> = {
  pending: { klasse: "bg-yellow-100 text-yellow-800", tekst: "Afventer" },
  under_behandling: { klasse: "bg-blue-100 text-blue-800", tekst: "Under behandling" },
  fjernet: { klasse: "bg-red-100 text-red-800", tekst: "Opslag fjernet" },
};

function StatusMaerkat({ status }: { status: string }) {
  const s = STATUS_STIL[status] ?? STATUS_STIL.pending;
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.klasse}`}>
      {s.tekst}
    </span>
  );
}

export default async function AdminRapporter({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const rolle = await getStaffRole();
  if (!rolle) {
    redirect("/");
  }
  // Kun de to handlinger der ændrer et opslag kræver admin.
  const kanModerereOpslag = harMindstRolle(rolle, "admin");

  const { q } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  const supabase = createAdminClient();

  // Behandlede rapporter flyttes til /admin/opklarede-rapporter og vises
  // derfor ikke her.
  const { data: rapporter } = await supabase
    .from("reports")
    .select("id, auction_id, reporter_id, category, description, created_at, status")
    .neq("status", "behandlet")
    .order("created_at", { ascending: false })
    .limit(500);

  const alle = (rapporter ?? []) as RapportRow[];

  const auktionIds = [...new Set(alle.map((r) => r.auction_id))];
  const brugerIds = [...new Set(alle.map((r) => r.reporter_id))];

  const [{ data: auktioner }, { data: brugere }] = await Promise.all([
    auktionIds.length
      ? supabase.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
    brugerIds.length
      ? supabase.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string; email: string }[] }),
  ]);

  const titelMap: Record<string, string> = {};
  (auktioner ?? []).forEach((a) => {
    titelMap[a.id] = a.titel;
  });
  const brugerMap: Record<string, { navn: string | null; email: string }> = {};
  (brugere ?? []).forEach((u) => {
    brugerMap[u.id] = { navn: u.navn, email: u.email };
  });

  // Filtrering sker i hukommelsen, fordi der søges på titel og anmeldernavn,
  // som ligger i andre tabeller end reports.
  const rows = søgetekst
    ? alle.filter((r) => {
        const nål = søgetekst.toLowerCase();
        const anmelder = brugerMap[r.reporter_id];
        return (
          (titelMap[r.auction_id] ?? "").toLowerCase().includes(nål) ||
          kategoriLabel(r.category).toLowerCase().includes(nål) ||
          (r.description ?? "").toLowerCase().includes(nål) ||
          (anmelder?.navn ?? "").toLowerCase().includes(nål) ||
          (anmelder?.email ?? "").toLowerCase().includes(nål)
        );
      })
    : alle;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Rapporter</h1>
        <span className="text-sm text-neutral-500">
          {rows.length} {rows.length === 1 ? "anmeldelse" : "anmeldelser"}
        </span>
      </div>

      <Suspense>
        <AdminSearchInput placeholder="Søg på auktion, kategori, beskrivelse eller anmelder..." />
      </Suspense>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Auktion</th>
                <th className="px-5 py-3 text-left font-medium">Kategori</th>
                <th className="px-5 py-3 text-left font-medium">Beskrivelse</th>
                <th className="px-5 py-3 text-left font-medium">Anmelder</th>
                <th className="px-5 py-3 text-left font-medium">Dato</th>
                <th className="px-5 py-3 text-left font-medium">Status</th>
                <th className="px-5 py-3 text-left font-medium">Handlinger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => {
                const anmelder = brugerMap[r.reporter_id];
                const afsluttet = r.status !== "pending";
                return (
                  <tr key={r.id} className="hover:bg-neutral-50 align-top">
                    <td className="px-5 py-3">
                      <Link
                        href={`/auktion/${r.auction_id}`}
                        className="font-medium text-neutral-800 hover:text-brand hover:underline"
                      >
                        {titelMap[r.auction_id] ?? "(slettet auktion)"}
                      </Link>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap text-neutral-700">
                      {kategoriLabel(r.category)}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">
                      {r.description ? (
                        <span className="block max-w-[260px]">{r.description}</span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {anmelder ? (
                        <Link
                          href={`/admin/brugere/${r.reporter_id}`}
                          className="block max-w-[160px] hover:underline"
                        >
                          <span className="block truncate text-neutral-800">
                            {anmelder.navn ?? "Uden navn"}
                          </span>
                          <span className="block truncate text-xs text-neutral-500">
                            {anmelder.email}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap text-neutral-500">
                      {new Date(r.created_at).toLocaleDateString("da-DK")}
                    </td>
                    <td className="px-5 py-3">
                      <StatusMaerkat status={r.status} />
                    </td>
                    <td className="px-5 py-3">
                      {afsluttet ? (
                        <form action={rapportGenaabn}>
                          <input type="hidden" name="rapportId" value={r.id} />
                          <button
                            type="submit"
                            className="whitespace-nowrap rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-200"
                          >
                            Genåbn
                          </button>
                        </form>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {kanModerereOpslag && (
                            <ConfirmDialog
                              triggerLabel="Fjern opslag"
                              triggerClassName="whitespace-nowrap rounded-md bg-red-100 px-2 py-1 text-xs text-red-700 transition-colors hover:bg-red-200"
                              title="Er du sikker på, at du vil fjerne opslaget permanent?"
                              description="Auktionen annulleres og skjules fra platformen. Anmeldelsen bevares som dokumentation."
                              confirmLabel="Ja, fjern opslaget"
                              action={rapportFjernOpslag}
                              hiddenFields={{ rapportId: r.id }}
                              aarsagField={{
                                label: "Årsag",
                                placeholder: "Skriv hvorfor opslaget fjernes...",
                                required: true,
                              }}
                            />
                          )}
                          <ConfirmDialog
                            triggerLabel="Markér som behandlet"
                            triggerClassName="whitespace-nowrap rounded-md bg-green-100 px-2 py-1 text-xs text-green-800 transition-colors hover:bg-green-200"
                            title="Markér anmeldelsen som behandlet?"
                            description="Auktionen forbliver aktiv. Rapporten flyttes til Opklarede rapporter."
                            confirmLabel="Ja, markér som behandlet"
                            action={rapportMarkerBehandlet}
                            hiddenFields={{ rapportId: r.id }}
                            aarsagField={{
                              label: "Note",
                              placeholder: "Hvad har du tjekket, og hvad er konklusionen?",
                              required: true,
                            }}
                          />
                          {kanModerereOpslag && (
                            <ConfirmDialog
                              triggerLabel="Slet midlertidigt"
                              triggerClassName="whitespace-nowrap rounded-md bg-blue-100 px-2 py-1 text-xs text-blue-800 transition-colors hover:bg-blue-200"
                              title="Skjul opslaget midlertidigt?"
                              description="Auktionen skjules fra platformen, mens sagen undersøges. Den kan vises igen under Alle auktioner."
                              confirmLabel="Ja, skjul opslaget"
                              action={rapportSletMidlertidigt}
                              hiddenFields={{ rapportId: r.id }}
                              aarsagField={{
                                label: "Årsag",
                                placeholder: "Skriv hvad der undersøges...",
                                required: true,
                              }}
                            />
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-neutral-400">
                    {søgetekst
                      ? `Ingen anmeldelser matcher "${søgetekst}"`
                      : "Der er ikke indsendt nogen anmeldelser endnu"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
