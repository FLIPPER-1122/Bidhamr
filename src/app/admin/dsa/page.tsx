import Link from "next/link";
import { kraevSideRolle, harMindstRolle } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFaner from "@/components/admin/AdminFaner";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import {
  dsaAnmeldelseAfgoer,
  dsaIndgrebFraAnmeldelse,
  dsaKlageAfgoer,
  dsaVideresend,
} from "@/app/actions/adminDsa";
import {
  GRUNDLAG_NAVNE,
  KATEGORI_TIL_REGEL,
  REGEL_VALG,
  UDFALD_NAVNE,
  anmeldKategoriNavn,
  handlingKraeverAdmin,
  handlingNavn,
  handlingerFor,
  indholdNavn,
  nuMs,
} from "@/lib/dsa/regler";

// DSA: anmeldelser af ulovligt indhold (art. 16) og klager over afgørelser
// (art. 20). Medarbejder og op. At fjerne en auktion eller lukke en konto
// kræver admin – en medarbejder videresender. Intet slettes.

export const dynamic = "force-dynamic";

export const metadata = { title: "Anmeldelser og klager" };

type Anmeldelse = {
  id: string;
  sagsnummer: string;
  indhold_type: string;
  indhold_id: string | null;
  auktion_id: string | null;
  anmeldt_bruger_id: string | null;
  placering: string;
  kategori: string;
  begrundelse: string;
  anmelder_id: string | null;
  anmelder_navn: string | null;
  anmelder_email: string | null;
  status: string;
  frist_kl: string;
  eskaleret_kl: string | null;
  eskaleret_af: string | null;
  eskaleret_note: string | null;
  udfald: string | null;
  svar_til_anmelder: string | null;
  intern_note: string | null;
  politi_underrettet: boolean;
  behandlet_af: string | null;
  behandlet_kl: string | null;
  genaabnet_kl: string | null;
  anonymiseret_kl: string | null;
  oprettet_kl: string;
};

type Afgoerelse = {
  id: string;
  sagsnummer: string;
  bruger_id: string;
  indhold_type: string;
  indhold_id: string;
  indhold_tekst: string | null;
  handling: string;
  regel_kode: string;
  regel_tekst: string;
  grundlag: string;
  fakta: string;
  intern_note: string | null;
  automatisk_opdaget: boolean;
  anmeldelse_id: string | null;
  medarbejder_id: string | null;
  oprettet_kl: string;
  ophaevet_kl: string | null;
  ophaevet_grund: string | null;
};

type Klage = {
  id: string;
  sagsnummer: string;
  afgoerelse_id: string | null;
  anmeldelse_id: string | null;
  klager_id: string | null;
  klager_email: string | null;
  begrundelse: string;
  status: string;
  udfald: string | null;
  svar: string | null;
  afgjort_af: string | null;
  afgjort_kl: string | null;
  frist_kl: string;
  oprettet_kl: string;
};

const ANM_FELTER =
  "id, sagsnummer, indhold_type, indhold_id, auktion_id, anmeldt_bruger_id, placering, kategori, begrundelse, anmelder_id, anmelder_navn, anmelder_email, status, frist_kl, eskaleret_kl, eskaleret_af, eskaleret_note, udfald, svar_til_anmelder, intern_note, politi_underrettet, behandlet_af, behandlet_kl, genaabnet_kl, anonymiseret_kl, oprettet_kl";
const AFG_FELTER =
  "id, sagsnummer, bruger_id, indhold_type, indhold_id, indhold_tekst, handling, regel_kode, regel_tekst, grundlag, fakta, intern_note, automatisk_opdaget, anmeldelse_id, medarbejder_id, oprettet_kl, ophaevet_kl, ophaevet_grund";
const KLAGE_FELTER =
  "id, sagsnummer, afgoerelse_id, anmeldelse_id, klager_id, klager_email, begrundelse, status, udfald, svar, afgjort_af, afgjort_kl, frist_kl, oprettet_kl";

const TZ = "Europe/Copenhagen";
const tid = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });

const KNAP_FJERN = "whitespace-nowrap rounded-md bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-800 transition-colors hover:bg-red-200";
const KNAP_BEHOLD = "whitespace-nowrap rounded-md bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-800 transition-colors hover:bg-green-200";
const KNAP_NEUTRAL = "whitespace-nowrap rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-200";

function Frist({ iso }: { iso: string }) {
  const timer = (new Date(iso).getTime() - nuMs()) / 3_600_000;
  if (timer < 0) {
    return (
      <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
        Over fristen ({Math.ceil(-timer)} t)
      </span>
    );
  }
  if (timer < 24) {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
        Frist om {Math.max(1, Math.floor(timer))} t
      </span>
    );
  }
  return (
    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
      Frist {tid(iso)}
    </span>
  );
}

function Pille({ children, farve = "neutral" }: { children: React.ReactNode; farve?: "neutral" | "blaa" | "lilla" }) {
  const k =
    farve === "blaa" ? "bg-blue-100 text-blue-800" : farve === "lilla" ? "bg-purple-100 text-purple-800" : "bg-neutral-100 text-neutral-700";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${k}`}>{children}</span>;
}

function PlaceringLink({ a }: { a: Pick<Anmeldelse, "indhold_type" | "placering"> }) {
  // Kendt indhold: placeringen er en intern sti, som serveren har bygget.
  if (a.indhold_type !== "andet" && a.placering.startsWith("/")) {
    return (
      <Link href={a.placering} className="break-all font-medium text-groen hover:underline" target="_blank">
        {a.placering}
      </Link>
    );
  }
  // Fritekst fra anmelderen - vises som tekst, aldrig som link.
  return <span className="break-all text-neutral-700">{a.placering}</span>;
}

export default async function DsaAdminSide({
  searchParams,
}: {
  searchParams: Promise<{ fane?: string }>;
}) {
  const { admin, rolle, userId } = await kraevSideRolle("medarbejder");
  const { fane: raaFane } = await searchParams;
  const fane = raaFane === "klager" || raaFane === "afsluttede" ? raaFane : "anmeldelser";
  const erAdmin = harMindstRolle(rolle, "admin");

  const [aabneRes, klagerRes, antalKlager, afsAnmRes, afgRes, afsKlagerRes] = await Promise.all([
    admin.from("dsa_anmeldelser").select(ANM_FELTER).eq("status", "ny").order("frist_kl").limit(200),
    fane === "klager"
      ? admin.from("dsa_klager").select(KLAGE_FELTER).eq("status", "afventer").order("frist_kl").limit(200)
      : Promise.resolve({ data: [] as Klage[], error: null }),
    admin.from("dsa_klager").select("id", { count: "exact", head: true }).eq("status", "afventer"),
    fane === "afsluttede"
      ? admin.from("dsa_anmeldelser").select(ANM_FELTER).eq("status", "afgjort").order("behandlet_kl", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as Anmeldelse[], error: null }),
    fane === "afsluttede"
      ? admin.from("dsa_afgoerelser").select(AFG_FELTER).order("oprettet_kl", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as Afgoerelse[], error: null }),
    fane === "afsluttede"
      ? admin.from("dsa_klager").select(KLAGE_FELTER).eq("status", "afgjort").order("afgjort_kl", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as Klage[], error: null }),
  ]);

  const aabne = (aabneRes.data ?? []) as Anmeldelse[];
  const klager = (klagerRes.data ?? []) as Klage[];
  const afsAnm = (afsAnmRes.data ?? []) as Anmeldelse[];
  const afg = (afgRes.data ?? []) as Afgoerelse[];
  const afsKlager = (afsKlagerRes.data ?? []) as Klage[];
  const fejl = aabneRes.error;

  // Afgørelser og anmeldelser, klagerne handler om.
  const klageAfgIds = [...klager, ...afsKlager].map((k) => k.afgoerelse_id).filter((x): x is string => !!x);
  const klageAnmIds = [...klager, ...afsKlager].map((k) => k.anmeldelse_id).filter((x): x is string => !!x);
  const [{ data: kAfg }, { data: kAnm }] = await Promise.all([
    klageAfgIds.length
      ? admin.from("dsa_afgoerelser").select(AFG_FELTER).in("id", klageAfgIds)
      : Promise.resolve({ data: [] as Afgoerelse[] }),
    klageAnmIds.length
      ? admin.from("dsa_anmeldelser").select(ANM_FELTER).in("id", klageAnmIds)
      : Promise.resolve({ data: [] as Anmeldelse[] }),
  ]);
  const afgMap = new Map(((kAfg ?? []) as Afgoerelse[]).map((a) => [a.id, a]));
  const anmMap = new Map(((kAnm ?? []) as Anmeldelse[]).map((a) => [a.id, a]));

  // Kort beskrivelse af det anmeldte indhold (titel, tekst).
  const visteAnm = fane === "anmeldelser" ? aabne : [];
  const uddrag = new Map<string, string>();
  await Promise.all(
    visteAnm
      .filter((a) => a.indhold_id && a.indhold_type !== "andet")
      .map(async (a) => {
        const { data } = await admin.rpc("dsa_indhold_ejer", { p_type: a.indhold_type, p_id: a.indhold_id });
        const r = (data as { tekst: string | null }[] | null)?.[0];
        uddrag.set(a.id, r?.tekst ?? "(Indholdet findes ikke længere)");
      }),
  );

  // Navne på brugere og medarbejdere.
  const ids = new Set<string>();
  for (const a of [...aabne, ...afsAnm, ...anmMap.values()]) {
    for (const x of [a.anmeldt_bruger_id, a.anmelder_id, a.behandlet_af, a.eskaleret_af]) if (x) ids.add(x);
  }
  for (const a of [...afg, ...afgMap.values()]) for (const x of [a.bruger_id, a.medarbejder_id]) if (x) ids.add(x);
  for (const k of [...klager, ...afsKlager]) for (const x of [k.klager_id, k.afgjort_af]) if (x) ids.add(x);
  const { data: brugere } = ids.size
    ? await admin.from("users").select("id, navn").in("id", [...ids])
    : { data: [] as { id: string; navn: string | null }[] };
  const navne = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? "Uden navn"]));
  const navn = (id: string | null) => (id ? (navne.get(id) ?? "Ukendt") : "—");

  const overskredne = aabne.filter((a) => new Date(a.frist_kl).getTime() < nuMs()).length;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Anmeldelser og klager"
        forklaring={
          <>
            Anmeldelser af ulovligt indhold fra hjemmesiden og appen – også fra folk uden login – og klager over
            vores afgørelser (EU&apos;s forordning om digitale tjenester, DSA). Besvar anmeldelser inden for 7
            dage (24 timer ved misbrug af børn og hadefuld tale) og klager inden for 14 dage. Den, der klager,
            behandles altid af en anden medarbejder end den, der traf afgørelsen.
          </>
        }
        hoejre={
          erAdmin ? (
            <Link href="/admin/dsa/rapport" className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50">
              Gennemsigtighedsrapport
            </Link>
          ) : undefined
        }
      >
        {overskredne > 0 && (
          <p className="mt-2 inline-flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm font-semibold text-red-800">
            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">!</span>
            {overskredne} {overskredne === 1 ? "anmeldelse er" : "anmeldelser er"} over fristen
          </p>
        )}
      </AdminSideHoved>

      <AdminFaner
        label="Anmeldelser og klager"
        aktiv={fane}
        faner={[
          { id: "anmeldelser", label: `Anmeldelser (${aabne.length})`, href: "/admin/dsa" },
          { id: "klager", label: `Klager (${antalKlager.count ?? 0})`, href: "/admin/dsa?fane=klager" },
          { id: "afsluttede", label: "Afsluttede", href: "/admin/dsa?fane=afsluttede" },
        ]}
      />

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Anmeldelserne kunne ikke hentes. Er migrationen 20261009010000_dsa.sql kørt?
        </p>
      )}

      {fane === "anmeldelser" && (
        <ul className="space-y-3">
          {aabne.map((a) => (
            <AnmeldelseKort
              key={a.id}
              a={a}
              uddrag={uddrag.get(a.id) ?? null}
              navn={navn}
              userId={userId}
              erAdmin={erAdmin}
            />
          ))}
          {aabne.length === 0 && !fejl && (
            <li className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-400">
              Der er ingen åbne anmeldelser.
            </li>
          )}
        </ul>
      )}

      {fane === "klager" && (
        <ul className="space-y-3">
          {klager.map((k) => (
            <KlageKort
              key={k.id}
              k={k}
              afg={k.afgoerelse_id ? (afgMap.get(k.afgoerelse_id) ?? null) : null}
              anm={k.anmeldelse_id ? (anmMap.get(k.anmeldelse_id) ?? null) : null}
              navn={navn}
              userId={userId}
              erAdmin={erAdmin}
            />
          ))}
          {klager.length === 0 && (
            <li className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-400">
              Der er ingen klager, der venter.
            </li>
          )}
        </ul>
      )}

      {fane === "afsluttede" && (
        <div className="space-y-6">
          <section aria-labelledby="afg-titel" className="space-y-2">
            <h2 id="afg-titel" className="text-sm font-semibold text-neutral-800">Seneste indgreb (begrundelser sendt til brugeren)</h2>
            <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-2.5">Sag</th>
                    <th className="px-4 py-2.5">Indgreb</th>
                    <th className="px-4 py-2.5">Regel</th>
                    <th className="px-4 py-2.5">Bruger</th>
                    <th className="px-4 py-2.5">Af</th>
                    <th className="px-4 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {afg.map((x) => (
                    <tr key={x.id}>
                      <td className="px-4 py-2.5 text-neutral-500">
                        {x.sagsnummer}
                        <br />
                        <span className="text-xs">{tid(x.oprettet_kl)}</span>
                      </td>
                      <td className="px-4 py-2.5 text-neutral-800">
                        {handlingNavn(x.handling)}
                        {x.automatisk_opdaget && <span className="ml-1 text-xs text-neutral-500">(automatisk opdaget)</span>}
                        {x.indhold_tekst && <p className="max-w-[260px] truncate text-xs text-neutral-500">{x.indhold_tekst}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-700">
                        {x.regel_tekst}
                        <p className="text-xs text-neutral-500">{GRUNDLAG_NAVNE[x.grundlag] ?? x.grundlag}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <Link href={`/admin/brugere/${x.bruger_id}`} className="text-groen hover:underline">{navn(x.bruger_id)}</Link>
                      </td>
                      <td className="px-4 py-2.5 text-neutral-600">{navn(x.medarbejder_id)}</td>
                      <td className="px-4 py-2.5">
                        {x.ophaevet_kl ? (
                          <Pille farve="blaa">Ophævet{x.ophaevet_grund === "klage" ? " efter klage" : ""}</Pille>
                        ) : (
                          <Pille>Gældende</Pille>
                        )}
                      </td>
                    </tr>
                  ))}
                  {afg.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-400">Ingen indgreb endnu.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="anm-titel" className="space-y-2">
            <h2 id="anm-titel" className="text-sm font-semibold text-neutral-800">Seneste afsluttede anmeldelser</h2>
            <ul className="space-y-2">
              {afsAnm.map((a) => (
                <li key={a.id} className="rounded-xl border border-neutral-200 bg-white p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-neutral-900">{a.sagsnummer}</span>
                    <Pille>{anmeldKategoriNavn(a.kategori)}</Pille>
                    <Pille farve={a.udfald === "indgreb" ? "lilla" : "neutral"}>{UDFALD_NAVNE[a.udfald ?? ""] ?? a.udfald}</Pille>
                    {a.politi_underrettet && <Pille farve="blaa">Politiet underrettet</Pille>}
                    {a.anonymiseret_kl && <Pille>Anonymiseret</Pille>}
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    {indholdNavn(a.indhold_type)} · <PlaceringLink a={a} /> · behandlet af {navn(a.behandlet_af)}
                    {a.behandlet_kl && ` ${tid(a.behandlet_kl)}`}
                  </p>
                  {a.svar_til_anmelder && <p className="mt-1 whitespace-pre-wrap text-neutral-700">Svar: {a.svar_til_anmelder}</p>}
                </li>
              ))}
              {afsAnm.length === 0 && (
                <li className="rounded-xl border border-neutral-200 bg-white px-5 py-8 text-center text-sm text-neutral-400">
                  Ingen afsluttede anmeldelser endnu.
                </li>
              )}
            </ul>
          </section>

          <section aria-labelledby="kl-titel" className="space-y-2">
            <h2 id="kl-titel" className="text-sm font-semibold text-neutral-800">Seneste afgjorte klager</h2>
            <ul className="space-y-2">
              {afsKlager.map((k) => (
                <li key={k.id} className="rounded-xl border border-neutral-200 bg-white p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-neutral-900">{k.sagsnummer}</span>
                    <Pille farve={k.udfald === "medhold" ? "blaa" : "neutral"}>
                      {k.udfald === "medhold" ? "Medhold" : "Fastholdt"}
                    </Pille>
                    <span className="text-xs text-neutral-500">
                      afgjort af {navn(k.afgjort_af)} {k.afgjort_kl && tid(k.afgjort_kl)}
                    </span>
                  </div>
                  {k.svar && <p className="mt-1 whitespace-pre-wrap text-neutral-700">{k.svar}</p>}
                </li>
              ))}
              {afsKlager.length === 0 && (
                <li className="rounded-xl border border-neutral-200 bg-white px-5 py-8 text-center text-sm text-neutral-400">
                  Ingen afgjorte klager endnu.
                </li>
              )}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function AnmeldelseKort({
  a,
  uddrag,
  navn,
  userId,
  erAdmin,
}: {
  a: Anmeldelse;
  uddrag: string | null;
  navn: (id: string | null) => string;
  userId: string;
  erAdmin: boolean;
}) {
  const inhabil = userId === a.anmeldt_bruger_id || userId === a.anmelder_id;
  const alle = handlingerFor(a.indhold_type);
  const mine = alle.filter((h) => erAdmin || !handlingKraeverAdmin(h));
  const kunAdmin = alle.length > 0 && mine.length === 0;
  const standardSvar =
    "Tak for din anmeldelse. Vi har vurderet indholdet og fundet, at det ikke er ulovligt og ikke bryder BidHamrs regler. Det bliver derfor på BidHamr.";

  return (
    <li className={`rounded-xl border bg-white p-4 sm:p-5 ${a.eskaleret_kl ? "border-purple-300" : "border-neutral-200"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-neutral-900">
            {anmeldKategoriNavn(a.kategori)}
            <Pille>{indholdNavn(a.indhold_type)}</Pille>
            {a.eskaleret_kl && <Pille farve="lilla">Videresendt til admin</Pille>}
            {a.genaabnet_kl && <Pille farve="blaa">Genåbnet efter klage</Pille>}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {a.sagsnummer} · modtaget {tid(a.oprettet_kl)} · fra{" "}
            {a.anmelder_id ? (
              <Link href={`/admin/brugere/${a.anmelder_id}`} className="hover:underline">
                {navn(a.anmelder_id)} (indlogget)
              </Link>
            ) : a.anmelder_navn || a.anmelder_email ? (
              <>
                {a.anmelder_navn ?? "Uden navn"}
                {a.anmelder_email && ` · ${a.anmelder_email}`} (uden login)
              </>
            ) : (
              "anonym (misbrug af børn)"
            )}
          </p>
        </div>
        <Frist iso={a.frist_kl} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg bg-neutral-50 p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Anmeldt indhold</p>
          <p className="mt-1"><PlaceringLink a={a} /></p>
          {uddrag && <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{uddrag}</p>}
          {a.anmeldt_bruger_id && (
            <p className="mt-1 text-xs text-neutral-500">
              Ejer:{" "}
              <Link href={`/admin/brugere/${a.anmeldt_bruger_id}`} className="text-groen hover:underline">
                {navn(a.anmeldt_bruger_id)}
              </Link>
            </p>
          )}
        </div>
        <div className="rounded-lg bg-neutral-50 p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Anmelderens begrundelse</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{a.begrundelse}</p>
        </div>
      </div>

      {a.eskaleret_kl && (
        <p className="mt-3 rounded-lg bg-purple-50 px-3 py-2 text-sm text-purple-900">
          Videresendt af {navn(a.eskaleret_af)} {tid(a.eskaleret_kl)}: {a.eskaleret_note}
        </p>
      )}

      {inhabil ? (
        <p className="mt-3 text-sm text-neutral-600">
          Du er selv part i denne anmeldelse. En kollega skal behandle den.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {mine.length > 0 && a.indhold_id && (
            <ConfirmDialog
              triggerLabel={a.indhold_type === "profil" ? "Suspendér / luk konto" : "Fjern / skjul"}
              triggerClassName={KNAP_FJERN}
              title="Grib ind over for indholdet"
              description="Brugeren får begrundelsen på mail og kan klage. Alle åbne anmeldelser af samme indhold lukkes, og anmelderne får svar."
              confirmLabel="Udfør og send begrundelse"
              action={dsaIndgrebFraAnmeldelse}
              hiddenFields={{ anmeldelseId: a.id }}
              varighedField={a.indhold_type === "profil"}
              vaelgFelter={[
                {
                  name: "handling",
                  label: "Hvad skal der ske?",
                  valg: mine.map((h) => ({ value: h, label: handlingNavn(h) })),
                  standard: mine[0],
                  hjaelp: a.indhold_type === "profil" ? "Varigheden gælder kun suspendering." : undefined,
                },
                {
                  name: "regel",
                  label: "Hvilken regel eller lov bryder det?",
                  valg: REGEL_VALG,
                  standard: KATEGORI_TIL_REGEL[a.kategori],
                },
              ]}
              tekstFelter={[
                {
                  name: "fakta",
                  label: "Begrundelse til brugeren (vises for brugeren)",
                  placeholder: "Skriv konkret, hvad brugeren har gjort, fx: Auktionen sælger en kopi af en mærketaske som ægte.",
                  required: true,
                  maxLength: 2000,
                  hjaelp: "Skriv aldrig, hvem der har anmeldt.",
                },
                {
                  name: "svar",
                  label: "Svar til anmelderen",
                  placeholder: "Tom = standardtekst om, at vi har grebet ind.",
                  required: false,
                  maxLength: 2000,
                },
                { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
              ]}
              afkrydsning={{ name: "politi", label: "Vi har givet politiet besked (mistanke om strafbart forhold, der truer liv eller sikkerhed)" }}
            />
          )}
          <ConfirmDialog
            triggerLabel="Behold"
            triggerClassName={KNAP_BEHOLD}
            title="Afslut uden at gribe ind?"
            description="Indholdet bliver. Anmelderen får dit svar og kan klage over afgørelsen."
            confirmLabel="Afslut og send svar"
            action={dsaAnmeldelseAfgoer}
            hiddenFields={{ anmeldelseId: a.id }}
            valgField={{
              name: "udfald",
              label: "Udfald",
              valg: [
                { value: "ingen_overtraedelse", label: "Ingen overtrædelse" },
                { value: "ikke_fundet", label: "Indholdet findes ikke" },
              ],
            }}
            tekstFelter={[
              {
                name: "svar",
                label: "Svar til anmelderen (vises for anmelderen)",
                required: true,
                maxLength: 2000,
                standard: standardSvar,
              },
              { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
            ]}
            afkrydsning={{ name: "politi", label: "Vi har givet politiet besked" }}
          />
          {!a.eskaleret_kl && (
            <ConfirmDialog
              triggerLabel="Videresend til admin"
              triggerClassName={KNAP_NEUTRAL}
              title="Videresend til admin?"
              description="Anmeldelsen bliver i listen, markeret til admin. Brug det, når kun admin kan gribe ind (fx en auktion), eller når du er i tvivl."
              confirmLabel="Videresend"
              action={dsaVideresend}
              hiddenFields={{ anmeldelseId: a.id }}
              aarsagField={{ label: "Note til admin", placeholder: "Hvad har du set, og hvad foreslår du?", required: true }}
            />
          )}
          {kunAdmin && <span className="text-xs text-neutral-500">Kun admin kan fjerne auktioner og lukke konti.</span>}
        </div>
      )}
    </li>
  );
}

function KlageKort({
  k,
  afg,
  anm,
  navn,
  userId,
  erAdmin,
}: {
  k: Klage;
  afg: Afgoerelse | null;
  anm: Anmeldelse | null;
  navn: (id: string | null) => string;
  userId: string;
  erAdmin: boolean;
}) {
  const traf = afg ? afg.medarbejder_id : (anm?.behandlet_af ?? null);
  const inhabil =
    userId === traf || userId === k.klager_id || (afg ? userId === afg.bruger_id : userId === anm?.anmeldt_bruger_id);
  const kraeverAdmin = afg ? handlingKraeverAdmin(afg.handling) : false;

  return (
    <li className="rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-900">
            {afg ? `Klage over: ${handlingNavn(afg.handling)}` : "Anmelder klager over, at vi ikke greb ind"}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {k.sagsnummer} · modtaget {tid(k.oprettet_kl)} · fra{" "}
            {k.klager_id ? (
              <Link href={`/admin/brugere/${k.klager_id}`} className="hover:underline">{navn(k.klager_id)}</Link>
            ) : (
              (k.klager_email ?? "anmelder uden login")
            )}
          </p>
        </div>
        <Frist iso={k.frist_kl} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg bg-neutral-50 p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Den oprindelige afgørelse</p>
          {afg ? (
            <>
              <p className="mt-1 text-neutral-800">
                {afg.sagsnummer} · {tid(afg.oprettet_kl)} · af {navn(afg.medarbejder_id)}
              </p>
              {afg.indhold_tekst && <p className="mt-1 text-neutral-700">{afg.indhold_tekst}</p>}
              <p className="mt-1 text-neutral-700"><strong>Regel:</strong> {afg.regel_tekst}</p>
              <p className="mt-1 whitespace-pre-wrap text-neutral-700"><strong>Begrundelse:</strong> {afg.fakta}</p>
              {afg.intern_note && <p className="mt-1 text-xs text-neutral-500">Intern note: {afg.intern_note}</p>}
              <Link href={`/admin/brugere/${afg.bruger_id}`} className="mt-1 inline-block text-xs text-groen hover:underline">
                Se brugeren
              </Link>
            </>
          ) : anm ? (
            <>
              <p className="mt-1 text-neutral-800">
                {anm.sagsnummer} · {anmeldKategoriNavn(anm.kategori)} · af {navn(anm.behandlet_af)}
              </p>
              <p className="mt-1"><PlaceringLink a={anm} /></p>
              <p className="mt-1 text-neutral-700">{UDFALD_NAVNE[anm.udfald ?? ""] ?? anm.udfald}</p>
              {anm.svar_til_anmelder && <p className="mt-1 whitespace-pre-wrap text-neutral-700">Svar: {anm.svar_til_anmelder}</p>}
              <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-500">Anmeldelsen: {anm.begrundelse}</p>
            </>
          ) : (
            <p className="mt-1 text-neutral-500">Ikke fundet.</p>
          )}
        </div>
        <div className="rounded-lg bg-neutral-50 p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Klagen</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{k.begrundelse}</p>
        </div>
      </div>

      {inhabil ? (
        <p className="mt-3 text-sm text-neutral-600">
          Du traf selv afgørelsen eller er part i sagen. En kollega skal behandle klagen.
        </p>
      ) : kraeverAdmin && !erAdmin ? (
        <p className="mt-3 text-sm text-neutral-600">Klager over auktioner og lukkede konti behandles af en admin eller chef.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <ConfirmDialog
            triggerLabel="Giv medhold"
            triggerClassName={KNAP_BEHOLD}
            title="Giv klageren medhold?"
            description={
              afg
                ? "Indgrebet bliver ophævet med det samme (indholdet vises igen / kontoen åbnes igen). Klageren får dit svar."
                : "Anmeldelsen bliver genåbnet og skal behandles igen. Anmelderen får dit svar."
            }
            confirmLabel="Giv medhold"
            action={dsaKlageAfgoer}
            hiddenFields={{ klageId: k.id, udfald: "medhold" }}
            tekstFelter={[
              { name: "svar", label: "Svar til klageren (vises for klageren)", required: true, maxLength: 2000 },
              { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
            ]}
          />
          <ConfirmDialog
            triggerLabel="Fasthold afgørelsen"
            triggerClassName={KNAP_FJERN}
            title="Fasthold afgørelsen?"
            description="Afgørelsen står ved magt. Klageren får dit svar og besked om andre klagemuligheder. Der er kun ét klagetrin."
            confirmLabel="Fasthold"
            action={dsaKlageAfgoer}
            hiddenFields={{ klageId: k.id, udfald: "fastholdt" }}
            tekstFelter={[
              { name: "svar", label: "Svar til klageren (vises for klageren)", required: true, maxLength: 2000 },
              { name: "aarsag", label: "Intern note (kun staff)", required: false, maxLength: 2000 },
            ]}
          />
        </div>
      )}
    </li>
  );
}
