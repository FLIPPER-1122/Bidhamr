import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteAuction, cancelAuction, hideAuction, unhideAuction } from "@/app/actions/adminActions";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import type { AdminAuktionRow } from "@/lib/adminRowTypes";

const statusOptions = [
  { value: "alle", label: "Alle" },
  { value: "aktiv", label: "Aktiv" },
  { value: "afsluttet", label: "Afsluttet" },
  { value: "ingen_bud", label: "Ingen bud" },
  { value: "annulleret", label: "Annulleret" },
] as const;

// Matcher et fuldt UUID hvor som helst i teksten, så et indsat auktions-link
// (…/auktion/<id>) også virker som søgning.
const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// PostgREST bruger komma og parenteser som syntaks i .or(), så værdien
// citeres og indlejrede citationstegn escapes.
function orVaerdi(tekst: string) {
  return `"%${tekst.replace(/["\\]/g, "\\$&")}%"`;
}

export default async function AdminAuktioner({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const rolle = await getStaffRole();
  if (!rolle || !harMindstRolle(rolle, "admin")) {
    redirect("/admin/brugere");
  }

  const { status, q } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  const aktivStatus = status ?? "alle";
  const supabase = createAdminClient();

  // Sælger-søgning kræver et opslag i users først, da PostgREST ikke kan
  // filtrere auktioner på en joinet tabels felter i et .or().
  let sælgerTræf: string[] = [];
  if (søgetekst) {
    const { data } = await supabase
      .from("users")
      .select("id")
      .or(`navn.ilike.${orVaerdi(søgetekst)},email.ilike.${orVaerdi(søgetekst)}`)
      .limit(200);
    sælgerTræf = (data ?? []).map((u) => u.id);
  }

  let query = supabase
    .from("auctions")
    .select("id, titel, billeder, startpris, nuværende_bud, status, slutter_kl, oprettet, bruger_id, skjult")
    .order("oprettet", { ascending: false })
    .limit(200);

  if (aktivStatus === "ingen_bud") {
    // nuværende_bud sættes først af bud-triggeren, så null = ingen bud.
    query = query.is("nuværende_bud", null);
  } else if (aktivStatus !== "alle") {
    query = query.eq("status", aktivStatus);
  }

  if (søgetekst) {
    const orDele = [`titel.ilike.${orVaerdi(søgetekst)}`];
    const uuid = søgetekst.match(UUID_REGEX)?.[0];
    if (uuid) orDele.push(`id.eq.${uuid}`);
    if (sælgerTræf.length) orDele.push(`bruger_id.in.(${sælgerTræf.join(",")})`);
    query = query.or(orDele.join(","));
  }

  const { data: auctions } = await query.overrideTypes<AdminAuktionRow[], { merge: false }>();

  // Sælgerinfo til de viste auktioner
  const brugerIds = [...new Set((auctions ?? []).map((a) => a.bruger_id))];
  const { data: sælgere } = brugerIds.length
    ? await supabase.from("users").select("id, navn, email").in("id", brugerIds)
    : { data: [] };

  const sælgerMap: Record<string, { navn: string | null; email: string }> = {};
  (sælgere ?? []).forEach((u) => {
    sælgerMap[u.id] = { navn: u.navn, email: u.email };
  });

  const statusBadge = (s: string) => {
    if (s === "aktiv") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Aktiv</span>;
    if (s === "afsluttet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">Afsluttet</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Annulleret</span>;
  };

  // Bevar søgetekst når man skifter statusfilter
  const filterHref = (s: string) => {
    const params = new URLSearchParams();
    if (s !== "alle") params.set("status", s);
    if (søgetekst) params.set("q", søgetekst);
    const qs = params.toString();
    return `/admin/auktioner${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Alle auktioner</h1>
        <span className="text-sm text-neutral-500">{auctions?.length ?? 0} resultater</span>
      </div>

      <Suspense>
        <AdminSearchInput placeholder="Søg på auktions-ID, titel, sælgers navn eller e-mail..." />
      </Suspense>

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {statusOptions.map((s) => {
          const active = aktivStatus === s.value;
          return (
            <Link
              key={s.value}
              href={filterHref(s.value)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-[#E63946] text-white"
                  : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <th className="px-5 py-3 text-left font-medium">Billede</th>
                <th className="px-5 py-3 text-left font-medium">Titel</th>
                <th className="px-5 py-3 text-left font-medium">Sælger</th>
                <th className="px-5 py-3 text-left font-medium">Startpris</th>
                <th className="px-5 py-3 text-left font-medium">Højeste bud</th>
                <th className="px-5 py-3 text-left font-medium">Status</th>
                <th className="px-5 py-3 text-left font-medium">Slutdato</th>
                <th className="px-5 py-3 text-left font-medium">Handlinger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(auctions ?? []).map((a) => {
                const img = Array.isArray(a.billeder) ? a.billeder[0] : null;
                const sælger = sælgerMap[a.bruger_id];
                return (
                  <tr key={a.id} className="hover:bg-neutral-50">
                    <td className="px-5 py-3">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt={a.titel} className="w-10 h-10 rounded-lg object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center">
                          <svg className="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                          </svg>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-neutral-800 max-w-[200px] truncate">{a.titel}</td>
                    <td className="px-5 py-3">
                      {sælger ? (
                        <Link
                          href={`/admin/brugere/${a.bruger_id}`}
                          className="block max-w-[180px] hover:underline"
                        >
                          <span className="block truncate text-neutral-800">
                            {sælger.navn ?? "Uden navn"}
                          </span>
                          <span className="block truncate text-xs text-neutral-500">
                            {sælger.email}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">{a.startpris?.toLocaleString("da-DK")} kr</td>
                    <td className="px-5 py-3">
                      {a["nuværende_bud"] != null ? (
                        <span className="font-medium text-neutral-800">
                          {a["nuværende_bud"].toLocaleString("da-DK")} kr
                        </span>
                      ) : (
                        <span className="text-neutral-400">Ingen bud</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex gap-1.5">
                        {statusBadge(a.status)}
                        {a.skjult && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-200 text-neutral-600">Skjult</span>
                        )}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-neutral-500">
                      {a["slutter_kl"] ? new Date(a["slutter_kl"]).toLocaleDateString("da-DK") : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex gap-2">
                        {a.status === "aktiv" && (
                          <ConfirmDialog
                            triggerLabel="Annullér"
                            triggerClassName="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded-md hover:bg-amber-200 transition-colors"
                            title="Er du sikker på, at du vil annullere auktionen?"
                            description="Auktionen stoppes, og der kan ikke bydes længere."
                            confirmLabel="Ja, annullér auktionen"
                            action={cancelAuction}
                            hiddenFields={{ auktionId: a.id }}
                          />
                        )}
                        <ConfirmDialog
                          triggerLabel={a.skjult ? "Vis igen" : "Skjul"}
                          triggerClassName="px-2 py-1 text-xs bg-neutral-100 text-neutral-600 rounded-md hover:bg-neutral-200 transition-colors"
                          title={
                            a.skjult
                              ? "Er du sikker på, at du vil vise auktionen igen?"
                              : "Er du sikker på, at du vil skjule auktionen?"
                          }
                          description={
                            a.skjult
                              ? "Auktionen bliver synlig for alle igen."
                              : "Auktionen bliver usynlig for brugerne, men slettes ikke."
                          }
                          confirmLabel={a.skjult ? "Ja, vis auktionen" : "Ja, skjul auktionen"}
                          action={a.skjult ? unhideAuction : hideAuction}
                          hiddenFields={{ auktionId: a.id }}
                        />
                        <ConfirmDialog
                          triggerLabel="Slet"
                          triggerClassName="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors"
                          title="Er du sikker på, at du vil slette auktionen?"
                          description="Handlingen kan ikke fortrydes."
                          confirmLabel="Ja, slet auktionen"
                          action={deleteAuction}
                          hiddenFields={{ auktionId: a.id }}
                          aarsagField={{
                            label: "Årsag",
                            placeholder: "Skriv hvorfor auktionen slettes...",
                            required: true,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {(auctions ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-neutral-400">
                    {søgetekst
                      ? `Ingen auktioner matcher "${søgetekst}"`
                      : "Ingen auktioner fundet"}
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
