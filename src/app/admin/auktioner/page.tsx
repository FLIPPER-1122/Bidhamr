import Link from "next/link";
import { orVaerdi } from "@/lib/postgrest";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteAuction, cancelAuction, hideAuction, unhideAuction } from "@/app/actions/adminActions";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { indgrebFelter } from "@/components/admin/indgrebFelter";
import type { AdminAuktionRow } from "@/lib/adminRowTypes";
import { nuMs } from "@/lib/dsa/regler";
import {
  autoAnnulleringTekst,
  erPaaPause,
  formatVarighed,
  intervalTilMs,
  pauseDage,
  PAUSE_PAAMIND_DAGE,
} from "@/lib/auctionTid";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminSide from "@/components/admin/AdminSide";

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

export default async function AdminAuktioner({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const rolle = await getStaffRole();
  if (!rolle || !harMindstRolle(rolle, "admin")) {
    notFound();
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
    .select("id, titel, billeder, startpris, nuværende_bud, status, slutter_kl, oprettet, bruger_id, skjult, pauset_kl, pause_resterende")
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

  // Auktioner på pause i over 3 dage (uanset filter): staff skal tage stilling,
  // før de annulleres automatisk efter 14 dage (Filip, 6. okt. 2026).
  const nu = nuMs();
  const { data: laengePause } = await supabase
    .from("auctions")
    .select("id, titel, pauset_kl")
    .eq("status", "aktiv")
    .not("pauset_kl", "is", null)
    .lte("pauset_kl", new Date(nu - PAUSE_PAAMIND_DAGE * 86400000).toISOString())
    .order("pauset_kl", { ascending: true })
    .limit(50)
    .overrideTypes<{ id: string; titel: string | null; pauset_kl: string }[], { merge: false }>();

  // Sælgerinfo til de viste auktioner
  const brugerIds = [...new Set((auctions ?? []).map((a) => a.bruger_id))];
  const { data: sælgere } = brugerIds.length
    ? await supabase.from("users").select("id, navn, email").in("id", brugerIds)
    : { data: [] };

  // Gældende (ikke ophævede) afgørelser på de viste annullerede, skjulte
  // auktioner: kun dem kan "Ophæv fjernelse"/"Ophæv skjulning" ophæve.
  const annulleretSkjultIds = (auctions ?? [])
    .filter((a) => a.status === "annulleret" && a.skjult)
    .map((a) => a.id);
  const { data: gaeldende } = annulleretSkjultIds.length
    ? await supabase
        .from("dsa_afgoerelser")
        .select("indhold_id, handling")
        .eq("indhold_type", "auktion")
        .in("indhold_id", annulleretSkjultIds)
        .in("handling", ["auktion_fjernet", "auktion_annulleret", "auktion_skjult"])
        .is("ophaevet_kl", null)
    : { data: [] };
  const gaeldendeAfg: Record<string, "fjernelse" | "skjulning"> = {};
  ((gaeldende ?? []) as { indhold_id: string; handling: string }[]).forEach((g) => {
    if (g.handling === "auktion_skjult") gaeldendeAfg[g.indhold_id] ??= "skjulning";
    else gaeldendeAfg[g.indhold_id] = "fjernelse";
  });

  // Ophævede afgørelser på de samme auktioner ("erstattet" tæller ikke som
  // ophævet): kun dem viser "fjernelse ophævet"/"skjulning ophævet".
  const { data: ophaevede } = annulleretSkjultIds.length
    ? await supabase
        .from("dsa_afgoerelser")
        .select("indhold_id, handling")
        .eq("indhold_type", "auktion")
        .in("indhold_id", annulleretSkjultIds)
        .in("handling", ["auktion_fjernet", "auktion_annulleret", "auktion_skjult"])
        .not("ophaevet_kl", "is", null)
        .neq("ophaevet_grund", "erstattet")
    : { data: [] };
  const ophaevetAfg: Record<string, "fjernelse" | "skjulning"> = {};
  ((ophaevede ?? []) as { indhold_id: string; handling: string }[]).forEach((g) => {
    if (g.handling === "auktion_skjult") ophaevetAfg[g.indhold_id] ??= "skjulning";
    else ophaevetAfg[g.indhold_id] = "fjernelse";
  });

  const sælgerMap: Record<string, { navn: string | null; email: string }> = {};
  (sælgere ?? []).forEach((u) => {
    sælgerMap[u.id] = { navn: u.navn, email: u.email };
  });

  const statusBadge = (s: string) => {
    if (s === "aktiv") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Aktiv</span>;
    if (s === "afsluttet") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-tekst-daempet">Afsluttet</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-fejl-tekst">Annulleret</span>;
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
    <AdminSide>
      <AdminSideHoved
        titel="Auktioner"
        forklaring="Alle auktioner på BidHamr. Brug siden, når du skal finde, skjule eller vise en bestemt auktion."
        hoejre={<span className="text-sm text-tekst-svag">{auctions?.length ?? 0} resultater</span>}
      />

      {(laengePause?.length ?? 0) > 0 && (
        <div role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-red-800">
          <p className="font-semibold">
            {laengePause!.length === 1
              ? "1 auktion har været på pause i over 3 dage"
              : `${laengePause!.length} auktioner har været på pause i over 3 dage`}
          </p>
          <p className="mt-1">
            Vis dem igen, eller fjern dem. Ellers annulleres de automatisk efter 14 dage, og byderne får besked om, at
            buddet ikke gælder.
          </p>
          <ul className="mt-2 space-y-1">
            {laengePause!.map((a) => (
              <li key={a.id}>
                <Link href={`/admin/auktioner?q=${a.id}`} className="font-medium underline">
                  {a.titel || "Uden titel"}
                </Link>{" "}
                – på pause i {pauseDage(a.pauset_kl, nu)} dage, {autoAnnulleringTekst(a.pauset_kl, nu)}
              </li>
            ))}
          </ul>
        </div>
      )}

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
              aria-current={active ? "true" : undefined}
              className={`inline-flex min-h-10 items-center rounded-full px-4 text-[13px] font-medium transition-colors ${
                active ? "bg-groen text-white" : "bg-groen-lys text-groen-mork hover:bg-[#DCEAE4]"
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </div>

      <div className="lg:overflow-hidden lg:rounded-[14px] lg:border lg:border-admin-kant lg:bg-white">
        {/* Under lg er hver auktion et kort (ingen vandret scroll), fra lg en tabel. */}
        <div className="lg:overflow-x-auto">
          <table className="block w-full text-sm lg:table">
            <thead className="hidden lg:table-header-group">
              <tr className="bg-neutral-50 text-xs text-tekst-svag uppercase">
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
            <tbody className="block space-y-3 lg:table-row-group lg:space-y-0 lg:divide-y lg:divide-admin-kant">
              {(auctions ?? []).map((a) => {
                const img = Array.isArray(a.billeder) ? a.billeder[0] : null;
                const sælger = sælgerMap[a.bruger_id];
                return (
                  <tr key={a.id} className="block rounded-[14px] border border-admin-kant bg-white p-4 lg:table-row lg:rounded-none lg:border-0 lg:p-0 lg:hover:bg-neutral-50">
                    <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt={a.titel} className="w-10 h-10 rounded-lg object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center">
                          <svg className="w-4 h-4 text-tekst-svag" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                          </svg>
                        </div>
                      )}
                    </td>
                    <td className="block py-1 font-semibold text-tekst lg:table-cell lg:max-w-[200px] lg:truncate lg:px-5 lg:py-3 lg:font-medium">{a.titel}</td>
                    <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                      {sælger ? (
                        <Link
                          href={`/admin/brugere/${a.bruger_id}`}
                          className="block max-w-[180px] hover:underline"
                        >
                          <span className="block truncate text-tekst">
                            {sælger.navn ?? "Uden navn"}
                          </span>
                          <span className="block truncate text-xs text-tekst-svag">
                            {sælger.email}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-tekst-svag">—</span>
                      )}
                    </td>
                    <td className="block py-1 text-tekst-daempet lg:table-cell lg:px-5 lg:py-3"><span className="mr-1 text-xs text-tekst-svag lg:hidden">Startpris:</span>{a.startpris?.toLocaleString("da-DK")} kr</td>
                    <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                      {a["nuværende_bud"] != null ? (
                        <span className="font-medium text-tekst">
                          {a["nuværende_bud"].toLocaleString("da-DK")} kr
                        </span>
                      ) : (
                        <span className="text-tekst-svag">Ingen bud</span>
                      )}
                    </td>
                    <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                      <span className="inline-flex flex-wrap gap-1.5">
                        {statusBadge(a.status)}
                        {a.skjult && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-200 text-tekst-daempet">Skjult</span>
                        )}
                        {erPaaPause(a) && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">På pause</span>
                        )}
                        {erPaaPause(a) && a.pauset_kl && pauseDage(a.pauset_kl, nu) >= PAUSE_PAAMIND_DAGE && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-fejl-tekst">
                            Pause i {pauseDage(a.pauset_kl, nu)} dage – {autoAnnulleringTekst(a.pauset_kl, nu)}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="block py-1 text-tekst-svag lg:table-cell lg:px-5 lg:py-3">
                      {erPaaPause(a)
                        ? `${formatVarighed(intervalTilMs(a.pause_resterende))} tilbage`
                        : a["slutter_kl"]
                          ? new Date(a["slutter_kl"]).toLocaleDateString("da-DK")
                          : "—"}
                    </td>
                    <td className="block py-1 lg:table-cell lg:px-5 lg:py-3">
                      <div className="flex flex-wrap gap-2">
                        {a.status === "aktiv" && (
                          <ConfirmDialog
                            triggerLabel="Annullér"
                            triggerClassName="inline-flex min-h-10 items-center px-3 py-1 text-xs lg:min-h-0 lg:px-2 bg-amber-100 text-amber-700 rounded-md hover:bg-amber-200 transition-colors"
                            title="Er du sikker på, at du vil annullere auktionen?"
                            description="Auktionen stoppes, og der kan ikke bydes længere. Sælgeren får begrundelsen og kan klage."
                            confirmLabel="Ja, annullér auktionen"
                            action={cancelAuction}
                            hiddenFields={{ auktionId: a.id }}
                            {...indgrebFelter({ faktaPlaceholder: "Fx: Auktionen sælger en billet til over den oprindelige pris." })}
                          />
                        )}
                        {a.skjult && a.status === "annulleret" && !gaeldendeAfg[a.id] ? (
                          // Intet at ophæve (allerede ophævet, eller skjult uden afgørelse).
                          <span className="px-2 py-1 text-xs text-tekst-svag">
                            {ophaevetAfg[a.id] === "fjernelse"
                              ? "Annulleret – fjernelse ophævet"
                              : ophaevetAfg[a.id] === "skjulning"
                                ? "Annulleret – skjulning ophævet"
                                : "Annulleret"}
                          </span>
                        ) : (
                        <ConfirmDialog
                          triggerLabel={
                            a.skjult
                              ? a.status === "annulleret"
                                ? gaeldendeAfg[a.id] === "skjulning"
                                  ? "Ophæv skjulning"
                                  : "Ophæv fjernelse"
                                : "Vis igen"
                              : "Skjul"
                          }
                          triggerClassName="inline-flex min-h-10 items-center px-3 py-1 text-xs lg:min-h-0 lg:px-2 bg-neutral-100 text-tekst-daempet rounded-md hover:bg-neutral-200 transition-colors"
                          title={
                            a.skjult
                              ? a.status === "annulleret"
                                ? gaeldendeAfg[a.id] === "skjulning"
                                  ? "Er du sikker på, at du vil ophæve skjulningen?"
                                  : "Er du sikker på, at du vil ophæve fjernelsen?"
                                : "Er du sikker på, at du vil vise auktionen igen?"
                              : "Er du sikker på, at du vil skjule auktionen?"
                          }
                          description={
                            a.skjult
                              ? a.status === "annulleret"
                                ? gaeldendeAfg[a.id] === "skjulning"
                                  ? "En annulleret auktion åbnes aldrig igen og forbliver skjult for andre. Afgørelsen om skjulning ophæves."
                                  : "En annulleret auktion åbnes aldrig igen og forbliver skjult for andre. Afgørelsen ophæves, så sælgeren kan sætte varen op igen med ét klik, og sælgeren får en undskyldning."
                                : erPaaPause(a)
                                ? "Auktionen bliver synlig for alle igen og fortsætter med den resterende tid – dog mindst 24 timer. Sælger og bydere får besked."
                                : "Auktionen bliver synlig for alle igen."
                              : a.status === "aktiv"
                                ? "Auktionen bliver usynlig for brugerne og sættes på pause: der kan ikke bydes, og den slutter ikke, før den vises igen. Den slettes ikke."
                                : "Auktionen bliver usynlig for brugerne, men slettes ikke."
                          }
                          confirmLabel={
                            a.skjult
                              ? a.status === "annulleret"
                                ? gaeldendeAfg[a.id] === "skjulning"
                                  ? "Ja, ophæv skjulningen"
                                  : "Ja, ophæv fjernelsen"
                                : "Ja, vis auktionen"
                              : "Ja, skjul auktionen"
                          }
                          action={a.skjult ? unhideAuction : hideAuction}
                          hiddenFields={{ auktionId: a.id }}
                          {...(a.skjult
                            ? {}
                            : indgrebFelter({ faktaPlaceholder: "Fx: Billederne er kopieret fra en anden hjemmeside." }))}
                        />
                        )}
                        <ConfirmDialog
                          triggerLabel="Slet"
                          triggerClassName="inline-flex min-h-10 items-center px-3 py-1 text-xs lg:min-h-0 lg:px-2 bg-red-100 text-fejl-tekst rounded-md hover:bg-red-200 transition-colors"
                          title="Er du sikker på, at du vil fjerne auktionen?"
                          description="Auktionen annulleres og skjules. Data bevares af hensyn til bogføringen. Sælgeren får begrundelsen og kan klage."
                          confirmLabel="Ja, fjern auktionen"
                          action={deleteAuction}
                          hiddenFields={{ auktionId: a.id }}
                          {...indgrebFelter({ faktaPlaceholder: "Fx: Auktionen sælger et skydevåben, som ikke må sælges på BidHamr." })}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {(auctions ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-tekst-svag">
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
    </AdminSide>
  );
}
