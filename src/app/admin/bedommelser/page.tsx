import { Suspense } from "react";
import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import AdminFaner from "@/components/admin/AdminFaner";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { beholdBedoemmelse, skjulBedoemmelse, visBedoemmelse } from "@/app/actions/adminBedoemmelser";
import {
  BEDOEMMELSE_RAPPORT_KATEGORIER,
  SKJUL_GRUNDE,
  skjulGrundNavn,
  type BedoemmelseDel,
} from "@/lib/bedoemmelser";

// Bedømmelser og sælgernes svar: rapporterede (til gennemsyn), skjulte og
// alle. Medarbejder og op. Intet slettes – en bedømmelse eller et svar
// skjules med en fast begrundelse, kan vises igen, og alt logges i
// medarbejder-loggen. Database: 20261007020000_bedoemmelse_svar.sql.

export const dynamic = "force-dynamic";

type Vis = "rapporterede" | "skjulte" | "alle";

type RatingRaekke = {
  id: string;
  fra_bruger_id: string;
  til_bruger_id: string;
  auktion_id: string;
  trade_id: string | null;
  stjerner: number;
  kommentar: string | null;
  oprettet: string;
  skjult: boolean;
};

type SvarRaekke = {
  rating_id: string;
  saelger_id: string;
  tekst: string;
  oprettet: string;
  rettet_kl: string | null;
  slettet_kl: string | null;
  skjult: boolean;
};

type ModRaekke = {
  rating_id: string;
  del: BedoemmelseDel;
  skjult: boolean;
  grund: string | null;
  aarsag: string | null;
  medarbejder_id: string;
  kl: string;
};

type RapportRaekke = {
  id: string;
  rating_id: string;
  rating_del: BedoemmelseDel;
  reporter_id: string | null;
  category: string;
  description: string | null;
  status: "ny" | "behandlet";
  handled_note: string | null;
  created_at: string;
};

const TZ = "Europe/Copenhagen";
const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const kategoriNavn = (k: string) =>
  BEDOEMMELSE_RAPPORT_KATEGORIER.find((x) => x.vaerdi === k)?.label ?? k;

const GRUND_VALG = SKJUL_GRUNDE.map((g) => ({ value: g.vaerdi, label: g.label }));

function Stjerner({ antal }: { antal: number }) {
  return (
    <span className="text-amber-500" role="img" aria-label={`${antal} af 5 stjerner`}>
      {"★".repeat(antal)}
      <span className="text-neutral-300">{"★".repeat(Math.max(0, 5 - antal))}</span>
    </span>
  );
}

function Status({ skjult }: { skjult: boolean }) {
  return skjult ? (
    <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700">Skjult</span>
  ) : (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">Synlig</span>
  );
}

const KNAP_SKJUL =
  "rounded-md bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-800 transition-colors hover:bg-red-200";
const KNAP_NEUTRAL =
  "rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-200";
const KNAP_BEHOLD =
  "rounded-md bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-800 transition-colors hover:bg-green-200";

function SkjulKnap({ ratingId, del }: { ratingId: string; del: BedoemmelseDel }) {
  const hvad = del === "bedoemmelse" ? "bedømmelsen" : "svaret";
  return (
    <ConfirmDialog
      triggerLabel={del === "bedoemmelse" ? "Skjul bedømmelse" : "Skjul svar"}
      triggerClassName={KNAP_SKJUL}
      title={`Skjul ${hvad}?`}
      description={
        del === "bedoemmelse"
          ? "Bedømmelsen bliver usynlig for alle og tæller ikke længere med i sælgerens gennemsnit. Den slettes ikke og kan vises igen. Køberen får begrundelsen og kan klage."
          : "Svaret bliver usynligt for alle. Det slettes ikke og kan vises igen. Sælgeren får begrundelsen og kan klage."
      }
      confirmLabel={`Ja, skjul ${hvad}`}
      action={skjulBedoemmelse}
      hiddenFields={{ ratingId, del }}
      valgField={{ name: "grund", label: "Begrundelse", valg: GRUND_VALG }}
      valgKraeverTekst={{
        valg: "andet",
        felt: "aarsag",
        besked: "Skriv en uddybning, når du vælger \"Andet\".",
      }}
      tekstFelter={[
        {
          name: "aarsag",
          label: "Uddybning",
          placeholder: "Påkrævet ved \"Andet\". Fx hvilke ord der bryder reglerne.",
          required: false,
          maxLength: 500,
          hjaelp: "Sendes til brugeren sammen med begrundelsen (som kan klage) og gemmes i medarbejder-loggen.",
        },
      ]}
    />
  );
}

function VisKnap({ ratingId, del }: { ratingId: string; del: BedoemmelseDel }) {
  const hvad = del === "bedoemmelse" ? "bedømmelsen" : "svaret";
  return (
    <ConfirmDialog
      triggerLabel={del === "bedoemmelse" ? "Vis bedømmelsen igen" : "Vis svaret igen"}
      triggerClassName={KNAP_NEUTRAL}
      title={`Vis ${hvad} igen?`}
      description={
        del === "bedoemmelse"
          ? "Bedømmelsen bliver synlig for alle igen og tæller med i gennemsnittet. Køberen får besked."
          : "Svaret bliver synligt for alle igen. Sælgeren får besked."
      }
      confirmLabel={`Ja, vis ${hvad}`}
      action={visBedoemmelse}
      hiddenFields={{ ratingId, del }}
      tekstFelter={[
        {
          name: "aarsag",
          label: "Intern note",
          placeholder: "Hvorfor vises den igen?",
          required: false,
          maxLength: 500,
          hjaelp: "Gemmes kun i medarbejder-loggen.",
        },
      ]}
    />
  );
}

export default async function AdminBedommelser({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; q?: string; id?: string }>;
}) {
  // Rollen tjekkes på selve siden, før service-role bruges.
  const { admin, userId } = await kraevSideRolle("medarbejder");
  const { vis: visParam, q, id: idParam } = await searchParams;
  const enkelt = idParam && UUID.test(idParam) ? idParam : null;
  const vis: Vis = enkelt
    ? "alle"
    : visParam === "skjulte" || visParam === "alle"
      ? visParam
      : "rapporterede";
  const soeg = (q ?? "").trim().slice(0, 200);

  // Tal til fanerne.
  const [{ data: aabne, error: rapportFejl }, { data: skjulteR }, { data: skjulteS }] = await Promise.all([
    admin
      .from("bruger_rapporter")
      .select("rating_id")
      .not("rating_id", "is", null)
      .eq("status", "ny")
      .order("created_at", { ascending: true })
      .limit(1000),
    admin.from("ratings").select("id").eq("skjult", true).order("oprettet", { ascending: false }).limit(200),
    admin
      .from("bedoemmelse_svar")
      .select("rating_id")
      .eq("skjult", true)
      .is("slettet_kl", null)
      .order("oprettet", { ascending: false })
      .limit(200),
  ]);
  const rapporteredeIds = [...new Set((aabne ?? []).map((r) => r.rating_id as string))];
  const skjulteIds = [
    ...new Set([...(skjulteR ?? []).map((r) => r.id as string), ...(skjulteS ?? []).map((s) => s.rating_id as string)]),
  ];

  // Bedømmelserne på den valgte fane.
  let ratings: RatingRaekke[] = [];
  const felter = "id, fra_bruger_id, til_bruger_id, auktion_id, trade_id, stjerner, kommentar, oprettet, skjult";
  if (vis === "alle") {
    let query = admin.from("ratings").select(felter).order("oprettet", { ascending: false }).limit(100);
    if (enkelt) query = query.eq("id", enkelt);
    else if (soeg) query = query.ilike("kommentar", `%${soeg.replace(/[%_\\]/g, (t) => `\\${t}`)}%`);
    const { data } = await query;
    ratings = (data ?? []) as RatingRaekke[];
  } else {
    const ids = vis === "rapporterede" ? rapporteredeIds.slice(0, 100) : skjulteIds.slice(0, 100);
    if (ids.length > 0) {
      const { data } = await admin.from("ratings").select(felter).in("id", ids);
      const map = new Map(((data ?? []) as RatingRaekke[]).map((r) => [r.id, r]));
      // Rapporterede: ældste rapport først. Skjulte: nyeste først.
      ratings = ids.map((i) => map.get(i)).filter((r): r is RatingRaekke => !!r);
    }
  }

  const ratingIds = ratings.map((r) => r.id);
  const [{ data: svarData }, { data: modData }, { data: rapportData }] = await Promise.all([
    ratingIds.length
      ? admin
          .from("bedoemmelse_svar")
          .select("rating_id, saelger_id, tekst, oprettet, rettet_kl, slettet_kl, skjult")
          .in("rating_id", ratingIds)
      : Promise.resolve({ data: [] as SvarRaekke[] }),
    ratingIds.length
      ? admin
          .from("bedoemmelse_moderation")
          .select("rating_id, del, skjult, grund, aarsag, medarbejder_id, kl")
          .in("rating_id", ratingIds)
      : Promise.resolve({ data: [] as ModRaekke[] }),
    ratingIds.length
      ? admin
          .from("bruger_rapporter")
          .select("id, rating_id, rating_del, reporter_id, category, description, status, handled_note, created_at")
          .in("rating_id", ratingIds)
          .order("created_at", { ascending: false })
          .limit(1000)
      : Promise.resolve({ data: [] as RapportRaekke[] }),
  ]);
  const svarMap = new Map(((svarData ?? []) as SvarRaekke[]).map((s) => [s.rating_id, s]));
  const modMap = new Map(((modData ?? []) as ModRaekke[]).map((m) => [`${m.rating_id}:${m.del}`, m]));
  const rapporter = (rapportData ?? []) as RapportRaekke[];

  const brugerIds = [
    ...new Set([
      ...ratings.flatMap((r) => [r.fra_bruger_id, r.til_bruger_id]),
      ...rapporter.map((r) => r.reporter_id).filter((x): x is string => !!x),
      ...((modData ?? []) as ModRaekke[]).map((m) => m.medarbejder_id),
    ]),
  ];
  const auktionIds = [...new Set(ratings.map((r) => r.auktion_id))];
  const [{ data: brugere }, { data: auktioner }] = await Promise.all([
    brugerIds.length
      ? admin.from("users").select("id, navn").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string | null }[] }),
    auktionIds.length
      ? admin.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
  ]);
  const navnMap = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? "Uden navn"]));
  const titelMap = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));
  const navn = (id: string | null | undefined) => (id ? (navnMap.get(id) ?? "Ukendt") : "—");

  const faner = [
    {
      id: "rapporterede",
      label: `Til gennemsyn${rapporteredeIds.length ? ` (${rapporteredeIds.length})` : ""}`,
      href: "/admin/bedommelser",
    },
    { id: "skjulte", label: `Skjulte${skjulteIds.length ? ` (${skjulteIds.length})` : ""}`, href: "/admin/bedommelser?vis=skjulte" },
    { id: "alle", label: "Alle", href: "/admin/bedommelser?vis=alle" },
  ];

  const tomTekst =
    vis === "rapporterede"
      ? "Ingen rapporterede bedømmelser lige nu. Godt arbejde."
      : vis === "skjulte"
        ? "Ingen skjulte bedømmelser eller svar."
        : enkelt
          ? "Bedømmelsen findes ikke."
          : "Ingen bedømmelser fundet.";

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Bedømmelser"
        forklaring="Købernes bedømmelser af sælgere og sælgernes svar. Under Til gennemsyn ligger det, brugere har rapporteret: læs teksten, og vælg Skjul (med begrundelse) eller Behold. Intet slettes, og alt kan vises igen."
      />

      <AdminFaner faner={faner} aktiv={vis} label="Bedømmelser" />

      {rapportFejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Rapporterne kunne ikke hentes. Er migrationen 20261007020000_bedoemmelse_svar.sql kørt?
        </p>
      )}

      {vis === "alle" && !enkelt && (
        <Suspense>
          <AdminSearchInput placeholder="Søg i bedømmelsernes tekst..." />
        </Suspense>
      )}
      {enkelt && (
        <Link href="/admin/bedommelser?vis=alle" className="inline-block text-sm font-medium text-groen hover:underline">
          ← Alle bedømmelser
        </Link>
      )}

      {ratings.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">
          {tomTekst}
        </p>
      ) : (
        <ul className="space-y-4">
          {ratings.map((r) => {
            const svar = svarMap.get(r.id);
            const modB = modMap.get(`${r.id}:bedoemmelse`);
            const modS = modMap.get(`${r.id}:svar`);
            const egne = rapporter.filter((x) => x.rating_id === r.id);
            const aabneB = egne.filter((x) => x.status === "ny" && x.rating_del === "bedoemmelse");
            const aabneS = egne.filter((x) => x.status === "ny" && x.rating_del === "svar");
            const tidligere = egne.filter((x) => x.status === "behandlet").length;
            const harAabne = aabneB.length + aabneS.length > 0;
            // Inhabil: medarbejderen skrev eller modtog bedømmelsen eller
            // skrev svaret. Databasen afviser også (kode 'inhabil').
            const egenSag =
              userId === r.fra_bruger_id || userId === r.til_bruger_id || userId === svar?.saelger_id;
            return (
              <li key={r.id} className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
                {/* Handlen */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 bg-neutral-50 px-4 py-3 text-xs text-neutral-600 sm:px-5">
                  <span className="min-w-0">
                    <Link href={`/admin/brugere/${r.fra_bruger_id}`} className="font-medium text-neutral-900 hover:underline">
                      {navn(r.fra_bruger_id)}
                    </Link>{" "}
                    (køber) bedømte{" "}
                    <Link href={`/admin/brugere/${r.til_bruger_id}`} className="font-medium text-neutral-900 hover:underline">
                      {navn(r.til_bruger_id)}
                    </Link>{" "}
                    (sælger) · {tid(r.oprettet)}
                  </span>
                  <span className="flex flex-wrap gap-3">
                    <Link href={`/auktion/${r.auktion_id}`} className="font-medium text-groen hover:underline">
                      {titelMap.get(r.auktion_id) ?? "Auktionen"}
                    </Link>
                    {r.trade_id && (
                      <Link
                        href={`/admin/handler?vis=alle&q=${r.trade_id}`}
                        className="font-medium text-groen hover:underline"
                      >
                        Se handlen
                      </Link>
                    )}
                  </span>
                </div>

                <div className="space-y-4 p-4 sm:p-5">
                  {/* Bedømmelsen */}
                  <section aria-label="Bedømmelsen">
                    <div className="flex flex-wrap items-center gap-2">
                      <Stjerner antal={r.stjerner} />
                      <Status skjult={r.skjult} />
                      {aabneB.length > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                          {aabneB.length} {aabneB.length === 1 ? "rapport" : "rapporter"}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-neutral-800">
                      {r.kommentar ?? <span className="italic text-neutral-500">Ingen kommentar – kun stjerner.</span>}
                    </p>
                    {r.skjult && modB && (
                      <p className="mt-2 text-xs text-neutral-500">
                        Skjult af {navn(modB.medarbejder_id)} · {tid(modB.kl)} · {skjulGrundNavn(modB.grund)}
                        {modB.aarsag && `: ${modB.aarsag}`}
                      </p>
                    )}
                  </section>

                  {/* Svar fra sælger */}
                  {svar && (
                    <section
                      aria-label="Svar fra sælger"
                      className="rounded-lg border-l-4 border-groen bg-neutral-50 px-3 py-2.5 sm:px-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-groen-mork">Svar fra sælger</p>
                        {svar.slettet_kl ? (
                          <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700">
                            Slettet af sælger {tid(svar.slettet_kl)}
                          </span>
                        ) : (
                          <Status skjult={svar.skjult} />
                        )}
                        {aabneS.length > 0 && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                            {aabneS.length} {aabneS.length === 1 ? "rapport" : "rapporter"}
                          </span>
                        )}
                        <span className="text-xs text-neutral-500">
                          {tid(svar.oprettet)}
                          {svar.rettet_kl && ` · rettet ${tid(svar.rettet_kl)}`}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-800">{svar.tekst}</p>
                      {svar.skjult && modS && (
                        <p className="mt-2 text-xs text-neutral-500">
                          Skjult af {navn(modS.medarbejder_id)} · {tid(modS.kl)} · {skjulGrundNavn(modS.grund)}
                          {modS.aarsag && `: ${modS.aarsag}`}
                        </p>
                      )}
                    </section>
                  )}

                  {/* Rapporterne */}
                  {(harAabne || tidligere > 0) && (
                    <section aria-label="Rapporter">
                      {harAabne && (
                        <ul className="space-y-2">
                          {[...aabneB, ...aabneS].map((x) => (
                            <li key={x.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                              <p className="font-medium text-neutral-900">
                                {kategoriNavn(x.category)}
                                <span className="font-normal text-neutral-600">
                                  {" "}
                                  · om {x.rating_del === "svar" ? "sælgerens svar" : "bedømmelsen"}
                                </span>
                              </p>
                              <p className="text-xs text-neutral-600">
                                {tid(x.created_at)} · Rapporteret af{" "}
                                {x.reporter_id ? (
                                  <Link href={`/admin/brugere/${x.reporter_id}`} className="hover:underline">
                                    {navn(x.reporter_id)}
                                  </Link>
                                ) : (
                                  "systemet"
                                )}
                              </p>
                              {x.description && (
                                <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{x.description}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {tidligere > 0 && (
                        <p className="mt-2 text-xs text-neutral-500">
                          {tidligere} tidligere {tidligere === 1 ? "rapport er" : "rapporter er"} behandlet.
                        </p>
                      )}
                    </section>
                  )}

                  {/* Handlinger */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3">
                    {egenSag && (
                      <p className="text-sm text-neutral-600">
                        Du er selv part i denne bedømmelse. Lad en kollega tage den.
                      </p>
                    )}
                    {!egenSag && (r.skjult ? (
                      <VisKnap ratingId={r.id} del="bedoemmelse" />
                    ) : (
                      <SkjulKnap ratingId={r.id} del="bedoemmelse" />
                    ))}
                    {!egenSag && svar && !svar.slettet_kl && !r.skjult &&
                      (svar.skjult ? (
                        <VisKnap ratingId={r.id} del="svar" />
                      ) : (
                        <SkjulKnap ratingId={r.id} del="svar" />
                      ))}
                    {!egenSag && harAabne && (
                      <ConfirmDialog
                        triggerLabel="Behold – bryder ikke reglerne"
                        triggerClassName={KNAP_BEHOLD}
                        title="Behold bedømmelsen?"
                        description="Alle åbne rapporter på bedømmelsen og svaret lukkes. Teksten forbliver synlig. Rapporterne slettes ikke."
                        confirmLabel="Ja, behold"
                        action={beholdBedoemmelse}
                        hiddenFields={{ ratingId: r.id }}
                        tekstFelter={[
                          {
                            name: "aarsag",
                            label: "Note",
                            placeholder: "Fx: Kritisk, men saglig og om handlen.",
                            required: false,
                            maxLength: 500,
                            hjaelp: "Gemmes i medarbejder-loggen.",
                          },
                        ]}
                      />
                    )}
                    <Link
                      href={`/admin/bedommelser?id=${r.id}`}
                      className="ml-auto text-xs font-medium text-neutral-500 hover:text-neutral-800 hover:underline"
                    >
                      Direkte link
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
