import Link from "next/link";
import { kraevSideRolle, harMindstRolle } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFaner from "@/components/admin/AdminFaner";
import Statuslinje from "@/components/admin/Statuslinje";
import {
  AnmeldelseGruppeKort,
  KlageKort,
  type Afgoerelse,
  type Anmeldelse,
  type Gruppe,
  type Klage,
} from "@/components/admin/dsa/DsaKort";
import { Pille, PlaceringLink, fristNiveau, tid, type FristNiveau } from "@/components/admin/dsa/DsaDele";
import {
  GRUNDLAG_NAVNE,
  UDFALD_NAVNE,
  anmeldKategoriNavn,
  handlingKraeverAdmin,
  handlingNavn,
  handlingerFor,
  indholdNavn,
} from "@/lib/dsa/regler";

// DSA: anmeldelser af ulovligt indhold (art. 16) og klager over afgørelser
// (art. 20). Medarbejder og op. At fjerne en auktion eller lukke en konto
// kræver admin – en medarbejder videresender. Intet slettes.
//
// Anmeldelser af samme indhold vises som ét kort. Inhabilitet (egen sag,
// selv anmeldt, handlet med ejeren) beregnes her med samme regler som i
// databasen, så knapperne slet ikke vises; databasen tjekker det igen.

export const dynamic = "force-dynamic";

export const metadata = { title: "Anmeldelser og klager" };

const ANM_FELTER =
  "id, sagsnummer, indhold_type, indhold_id, auktion_id, anmeldt_bruger_id, placering, kategori, begrundelse, anmelder_id, anmelder_navn, anmelder_email, status, frist_kl, eskaleret_kl, eskaleret_af, eskaleret_note, udfald, svar_til_anmelder, intern_note, politi_underrettet, behandlet_af, behandlet_kl, genaabnet_kl, anonymiseret_kl, oprettet_kl";
const AFG_FELTER =
  "id, sagsnummer, bruger_id, indhold_type, indhold_id, indhold_tekst, handling, regel_kode, regel_tekst, grundlag, fakta, intern_note, automatisk_opdaget, anmeldelse_id, medarbejder_id, oprettet_kl, ophaevet_kl, ophaevet_grund";
const KLAGE_FELTER =
  "id, sagsnummer, afgoerelse_id, anmeldelse_id, klager_id, klager_email, begrundelse, status, udfald, svar, afgjort_af, afgjort_kl, frist_kl, oprettet_kl";

type Vis = "alle" | "admin" | "videresendt" | "mine";
const VIS_NAVNE: Record<Vis, string> = {
  alle: "Alle",
  admin: "Kræver admin",
  videresendt: "Videresendt",
  mine: "Mine",
};

const GRUND = {
  selvAnmeldt: "Du har selv anmeldt dette indhold.",
  egen: "Sagen handler om dig selv.",
  handel: "Du har handlet med en af parterne.",
  traf: "Du traf selv den oprindelige afgørelse.",
  klager: "Du har selv klaget.",
};

// Spørgsmål og svar hører til samme indhold (og skjules sammen).
function indholdGruppe(type: string): string {
  return type === "spoergsmaal_svar" ? "spoergsmaal" : type;
}

function byggeHref(p: { fane?: string; vis?: Vis; kategori?: string | null }): string {
  const q = new URLSearchParams();
  if (p.fane && p.fane !== "anmeldelser") q.set("fane", p.fane);
  if (p.vis && p.vis !== "alle") q.set("vis", p.vis);
  if (p.kategori) q.set("kategori", p.kategori);
  const s = q.toString();
  return s ? `/admin/dsa?${s}` : "/admin/dsa";
}

export default async function DsaAdminSide({
  searchParams,
}: {
  searchParams: Promise<{ fane?: string; vis?: string; kategori?: string }>;
}) {
  const { admin, rolle, userId } = await kraevSideRolle("medarbejder");
  const sp = await searchParams;
  const fane = sp.fane === "klager" || sp.fane === "afsluttede" ? sp.fane : "anmeldelser";
  const vis: Vis = sp.vis === "admin" || sp.vis === "videresendt" || sp.vis === "mine" ? sp.vis : "alle";
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
  const fejl = aabneRes.error ?? (fane === "klager" ? klagerRes.error : null);

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
  // Hvem anmeldte det, der førte til en påklaget afgørelse (inhabilitet).
  const afgAnmIds = klager
    .map((k) => (k.afgoerelse_id ? afgMap.get(k.afgoerelse_id)?.anmeldelse_id : null))
    .filter((x): x is string => !!x);
  const { data: afgAnm } = afgAnmIds.length
    ? await admin.from("dsa_anmeldelser").select("id, anmelder_id").in("id", afgAnmIds)
    : { data: [] as { id: string; anmelder_id: string | null }[] };
  const afgAnmelder = new Map(((afgAnm ?? []) as { id: string; anmelder_id: string | null }[]).map((x) => [x.id, x.anmelder_id]));

  // ---------------------------------------------------------------- Grupper
  const gruppeMap = new Map<string, Anmeldelse[]>();
  for (const a of aabne) {
    const noegle = a.indhold_id ? `${indholdGruppe(a.indhold_type)}:${a.indhold_id}` : `id:${a.id}`;
    const liste = gruppeMap.get(noegle);
    if (liste) liste.push(a);
    else gruppeMap.set(noegle, [a]);
  }

  // Ejer og uddrag pr. indhold (én opslag pr. gruppe, kun på fanen anmeldelser).
  const ejerInfo = new Map<string, { ejer: string | null; tekst: string | null }>();
  if (fane === "anmeldelser") {
    await Promise.all(
      [...gruppeMap.entries()].map(async ([noegle, liste]) => {
        const a = liste[0];
        if (!a.indhold_id || a.indhold_type === "andet") return;
        const { data } = await admin.rpc("dsa_indhold_ejer", { p_type: a.indhold_type, p_id: a.indhold_id });
        const r = (data as { bruger_id: string | null; tekst: string | null }[] | null)?.[0];
        ejerInfo.set(noegle, { ejer: r?.bruger_id ?? null, tekst: r?.tekst ?? "(Indholdet findes ikke længere)" });
      }),
    );
  }

  // Ekstra parter: spørgsmål (spørger + sælger) og bedømmelser (begge parter).
  const spIds = new Set<string>();
  const bedIds = new Set<string>();
  if (fane === "anmeldelser") {
    for (const liste of gruppeMap.values()) {
      const a = liste[0];
      if (a.indhold_id && indholdGruppe(a.indhold_type) === "spoergsmaal") spIds.add(a.indhold_id);
    }
  }
  for (const k of klager) {
    const af = k.afgoerelse_id ? afgMap.get(k.afgoerelse_id) : null;
    if (!af) continue;
    if (af.handling === "spoergsmaal_skjult") spIds.add(af.indhold_id);
    if (af.handling === "bedoemmelse_skjult" || af.handling === "bedoemmelse_svar_skjult") bedIds.add(af.indhold_id);
  }
  const [{ data: spData }, { data: bedData }] = await Promise.all([
    spIds.size
      ? admin.from("auction_questions").select("id, asker_id, auction_id").in("id", [...spIds])
      : Promise.resolve({ data: [] as { id: string; asker_id: string | null; auction_id: string }[] }),
    bedIds.size
      ? admin.from("ratings").select("id, fra_bruger_id, til_bruger_id").in("id", [...bedIds])
      : Promise.resolve({ data: [] as { id: string; fra_bruger_id: string | null; til_bruger_id: string | null }[] }),
  ]);
  const spRaekker = (spData ?? []) as { id: string; asker_id: string | null; auction_id: string }[];
  const auktionIds = [...new Set(spRaekker.map((q) => q.auction_id))];
  const { data: aukData } = auktionIds.length
    ? await admin.from("auctions").select("id, bruger_id").in("id", auktionIds)
    : { data: [] as { id: string; bruger_id: string }[] };
  const saelger = new Map(((aukData ?? []) as { id: string; bruger_id: string }[]).map((x) => [x.id, x.bruger_id]));
  const ekstraParter = new Map<string, string[]>();
  for (const q of spRaekker) {
    ekstraParter.set(q.id, [q.asker_id, saelger.get(q.auction_id) ?? null].filter((x): x is string => !!x));
  }
  for (const r of (bedData ?? []) as { id: string; fra_bruger_id: string | null; til_bruger_id: string | null }[]) {
    ekstraParter.set(r.id, [r.fra_bruger_id, r.til_bruger_id].filter((x): x is string => !!x));
  }

  // Parter pr. gruppe og pr. klage (dem, man ikke må have handlet med).
  const gruppeParter = new Map<string, string[]>();
  for (const [noegle, liste] of gruppeMap) {
    const a = liste[0];
    const p = new Set<string>();
    const ejer = ejerInfo.get(noegle)?.ejer;
    if (ejer) p.add(ejer);
    for (const x of liste) if (x.anmeldt_bruger_id) p.add(x.anmeldt_bruger_id);
    if (a.indhold_id && indholdGruppe(a.indhold_type) === "spoergsmaal") {
      for (const x of ekstraParter.get(a.indhold_id) ?? []) p.add(x);
    }
    gruppeParter.set(noegle, [...p]);
  }
  const klageParter = new Map<string, string[]>();
  for (const k of klager) {
    const af = k.afgoerelse_id ? afgMap.get(k.afgoerelse_id) : null;
    const an = k.anmeldelse_id ? anmMap.get(k.anmeldelse_id) : null;
    const p = new Set<string>();
    if (af) {
      p.add(af.bruger_id);
      for (const x of ekstraParter.get(af.indhold_id) ?? []) p.add(x);
    } else if (an?.anmeldt_bruger_id) {
      p.add(an.anmeldt_bruger_id);
    }
    klageParter.set(k.id, [...p]);
  }

  // Handler mellem mig og parterne (trades) - samme regel som dsa_er_inhabil.
  const alleParter = [...new Set([...gruppeParter.values(), ...klageParter.values()].flat())].filter((x) => x !== userId);
  const handelMed = new Set<string>();
  if (alleParter.length) {
    const [som1, som2] = await Promise.all([
      admin.from("trades").select("seller_id").eq("buyer_id", userId).in("seller_id", alleParter).limit(500),
      admin.from("trades").select("buyer_id").eq("seller_id", userId).in("buyer_id", alleParter).limit(500),
    ]);
    for (const r of (som1.data ?? []) as { seller_id: string }[]) handelMed.add(r.seller_id);
    for (const r of (som2.data ?? []) as { buyer_id: string }[]) handelMed.add(r.buyer_id);
  }

  // Tidligere afgørelser (gældende) mod ejerne.
  const ejere = [...new Set([...ejerInfo.values()].map((e) => e.ejer).filter((x): x is string => !!x))];
  const tidligere = new Map<string, number>();
  if (ejere.length) {
    const { data } = await admin
      .from("dsa_afgoerelser")
      .select("bruger_id")
      .in("bruger_id", ejere)
      .is("ophaevet_kl", null)
      .limit(2000);
    for (const r of (data ?? []) as { bruger_id: string }[]) tidligere.set(r.bruger_id, (tidligere.get(r.bruger_id) ?? 0) + 1);
  }

  const grupper: Gruppe[] = [...gruppeMap.entries()]
    .map(([noegle, liste]) => {
      const anm = [...liste].sort((x, y) => x.frist_kl.localeCompare(y.frist_kl));
      const forste = anm[0];
      const info = ejerInfo.get(noegle);
      const ejer = info?.ejer ?? forste.anmeldt_bruger_id;
      const parter = gruppeParter.get(noegle) ?? [];
      const alle = handlingerFor(forste.indhold_type);
      const inhabil = anm.some((x) => x.anmelder_id === userId)
        ? GRUND.selvAnmeldt
        : parter.includes(userId)
          ? GRUND.egen
          : parter.some((x) => handelMed.has(x))
            ? GRUND.handel
            : null;
      return {
        noegle,
        anm,
        forste,
        frist: forste.frist_kl,
        kategorier: [...new Set(anm.map((x) => x.kategori))],
        ejer,
        uddrag: info?.tekst ?? null,
        tidligereAfg: ejer ? (tidligere.get(ejer) ?? 0) : 0,
        videresendt: anm.find((x) => x.eskaleret_kl) ?? null,
        kunAdmin: alle.length > 0 && alle.every(handlingKraeverAdmin),
        inhabil,
      };
    })
    .sort((x, y) => x.frist.localeCompare(y.frist));

  // Filtre
  const passerVis = (g: Gruppe, v: Vis) =>
    v === "alle"
      ? true
      : v === "admin"
        ? g.kunAdmin || !!g.videresendt
        : v === "videresendt"
          ? !!g.videresendt
          : g.anm.some((x) => x.eskaleret_af === userId);
  const kategoriTal = new Map<string, number>();
  for (const g of grupper.filter((g) => passerVis(g, vis))) {
    for (const k of g.kategorier) kategoriTal.set(k, (kategoriTal.get(k) ?? 0) + 1);
  }
  const kategori = sp.kategori && kategoriTal.has(sp.kategori) ? sp.kategori : null;
  const viste = grupper.filter((g) => passerVis(g, vis) && (!kategori || g.kategorier.includes(kategori)));

  const SEKTIONER: { id: FristNiveau; titel: string }[] = [
    { id: "over", titel: "Over fristen" },
    { id: "snart", titel: "Frist inden for 24 timer" },
    { id: "senere", titel: "Senere" },
  ];

  // Inhabilitet for klager.
  const klageInhabil = (k: Klage): string | null => {
    const af = k.afgoerelse_id ? afgMap.get(k.afgoerelse_id) : null;
    const an = k.anmeldelse_id ? anmMap.get(k.anmeldelse_id) : null;
    const parter = klageParter.get(k.id) ?? [];
    if (k.klager_id === userId) return GRUND.klager;
    if (af ? af.medarbejder_id === userId : an?.behandlet_af === userId) return GRUND.traf;
    if (af?.anmeldelse_id && afgAnmelder.get(af.anmeldelse_id) === userId) return GRUND.selvAnmeldt;
    if (an?.anmelder_id === userId) return GRUND.selvAnmeldt;
    if (parter.includes(userId)) return GRUND.egen;
    if (parter.some((x) => handelMed.has(x))) return GRUND.handel;
    return null;
  };

  // Navne på brugere og medarbejdere.
  const ids = new Set<string>();
  for (const a of [...aabne, ...afsAnm, ...anmMap.values()]) {
    for (const x of [a.anmeldt_bruger_id, a.anmelder_id, a.behandlet_af, a.eskaleret_af]) if (x) ids.add(x);
  }
  for (const e of ejere) ids.add(e);
  for (const a of [...afg, ...afgMap.values()]) for (const x of [a.bruger_id, a.medarbejder_id]) if (x) ids.add(x);
  for (const k of [...klager, ...afsKlager]) for (const x of [k.klager_id, k.afgjort_af]) if (x) ids.add(x);
  const { data: brugere } = ids.size
    ? await admin.from("users").select("id, navn").in("id", [...ids])
    : { data: [] as { id: string; navn: string | null }[] };
  const navne = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? "Uden navn"]));
  const navn = (id: string | null) => (id ? (navne.get(id) ?? "Ukendt") : "—");

  const overskredne = grupper.filter((g) => fristNiveau(g.frist) === "over").length;

  const chip = (aktiv: boolean) =>
    `inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
      aktiv ? "border-groen bg-groen text-white" : "border-kant-staerk bg-white text-neutral-700 hover:bg-groen-lys"
    }`;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Anmeldelser og klager"
        forklaring={
          <>
            Anmeldelser af ulovligt indhold og klager over vores afgørelser (DSA). Svar på anmeldelser inden for 7 dage
            (24 timer ved misbrug af børn og hadefuld tale) og på klager inden for 14 dage. En klage behandles altid af
            en anden end den, der traf afgørelsen.
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
          <p className="mt-2 inline-flex items-center gap-2 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-1.5 text-sm font-semibold text-fejl-tekst">
            {overskredne} {overskredne === 1 ? "sag er" : "sager er"} over fristen
          </p>
        )}
      </AdminSideHoved>

      <AdminFaner
        label="Anmeldelser og klager"
        aktiv={fane}
        faner={[
          { id: "anmeldelser", label: `Anmeldelser (${grupper.length})`, href: "/admin/dsa" },
          { id: "klager", label: `Klager (${antalKlager.count ?? 0})`, href: "/admin/dsa?fane=klager" },
          { id: "afsluttede", label: "Afsluttede", href: "/admin/dsa?fane=afsluttede" },
        ]}
      />

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Sagerne kunne ikke hentes. Genindlæs siden, eller kontakt en udvikler, hvis det bliver ved.
        </p>
      )}

      {fane === "anmeldelser" && (
        <div className="space-y-5">
          <nav aria-label="Filtrér anmeldelser" className="space-y-2">
            <ul className="flex flex-wrap gap-2">
              {(Object.keys(VIS_NAVNE) as Vis[]).map((v) => {
                const n = grupper.filter((g) => passerVis(g, v)).length;
                return (
                  <li key={v}>
                    <Link
                      href={byggeHref({ vis: v, kategori })}
                      aria-current={vis === v ? "true" : undefined}
                      className={chip(vis === v)}
                      title={v === "mine" ? "Sager, du selv har videresendt" : undefined}
                    >
                      {VIS_NAVNE[v]} <span className={vis === v ? "text-white/85" : "text-neutral-500"}>({n})</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {kategoriTal.size > 1 && (
              <ul className="flex flex-wrap gap-2" aria-label="Kategori">
                <li>
                  <Link href={byggeHref({ vis })} aria-current={!kategori ? "true" : undefined} className={chip(!kategori)}>
                    Alle kategorier
                  </Link>
                </li>
                {[...kategoriTal.entries()].map(([k, n]) => (
                  <li key={k}>
                    <Link
                      href={byggeHref({ vis, kategori: k })}
                      aria-current={kategori === k ? "true" : undefined}
                      className={chip(kategori === k)}
                    >
                      {anmeldKategoriNavn(k)} <span className={kategori === k ? "text-white/85" : "text-neutral-500"}>({n})</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {vis === "mine" && (
              <p className="text-xs text-neutral-600">Viser sager, du selv har videresendt til admin.</p>
            )}
          </nav>

          {SEKTIONER.map((s) => {
            const liste = viste.filter((g) => fristNiveau(g.frist) === s.id);
            if (liste.length === 0) return null;
            return (
              <section key={s.id} aria-labelledby={`sek-${s.id}`} className="space-y-3">
                <h2
                  id={`sek-${s.id}`}
                  className={`text-sm font-semibold ${s.id === "over" ? "text-fejl-tekst" : "text-neutral-800"}`}
                >
                  {s.titel} ({liste.length})
                </h2>
                <ul className="space-y-3">
                  {liste.map((g) => (
                    <AnmeldelseGruppeKort key={g.noegle} g={g} navn={navn} erAdmin={erAdmin} />
                  ))}
                </ul>
              </section>
            );
          })}

          {viste.length === 0 && !fejl && (
            <p className="rounded-[14px] border border-kant bg-white px-5 py-10 text-center text-sm text-neutral-600">
              {grupper.length === 0 ? "Der er ingen åbne anmeldelser." : "Ingen anmeldelser passer til filteret."}
            </p>
          )}
        </div>
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
              inhabil={klageInhabil(k)}
              erAdmin={erAdmin}
            />
          ))}
          {klager.length === 0 && !fejl && (
            <li className="rounded-[14px] border border-kant bg-white px-5 py-10 text-center text-sm text-neutral-600">
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
                        <p className="text-xs text-neutral-600">{GRUNDLAG_NAVNE[x.grundlag] ?? x.grundlag}</p>
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
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-600">Ingen indgreb endnu.</td></tr>
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
                    {indholdNavn(a.indhold_type)} · <PlaceringLink indholdType={a.indhold_type} placering={a.placering} /> · behandlet af {navn(a.behandlet_af)}
                    {a.behandlet_kl && ` ${tid(a.behandlet_kl)}`}
                  </p>
                  {a.svar_til_anmelder && <p className="mt-1 whitespace-pre-wrap text-neutral-700">Svar: {a.svar_til_anmelder}</p>}
                </li>
              ))}
              {afsAnm.length === 0 && (
                <li className="rounded-xl border border-neutral-200 bg-white px-5 py-8 text-center text-sm text-neutral-600">
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
                    <span className="text-xs text-neutral-600">
                      afgjort af {navn(k.afgjort_af)} {k.afgjort_kl && tid(k.afgjort_kl)}
                    </span>
                  </div>
                  {k.svar && <p className="mt-1 whitespace-pre-wrap text-neutral-700">{k.svar}</p>}
                </li>
              ))}
              {afsKlager.length === 0 && (
                <li className="rounded-xl border border-neutral-200 bg-white px-5 py-8 text-center text-sm text-neutral-600">
                  Ingen afgjorte klager endnu.
                </li>
              )}
            </ul>
          </section>
        </div>
      )}

      <Statuslinje />
    </div>
  );
}
