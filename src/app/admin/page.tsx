import { Suspense } from "react";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getErhvervRolle, getStaffRole, harMindstRolle, type StaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFejl from "@/components/admin/AdminFejl";
import DriftStatuslinje from "@/components/admin/forside/DriftStatuslinje";
import StatusLamper from "@/components/admin/forside/StatusLamper";
import KraeverHandling, { type HandlingRaekke } from "@/components/admin/forside/KraeverHandling";
import Noegletal, { somPeriode } from "@/components/admin/forside/Noegletal";
import PengeStatus from "@/components/admin/forside/PengeStatus";
import { tolkForsideTal, type ForsideTal } from "@/components/admin/forside/forsideTal";
import { HAENGER_GRAENSER_DAGE } from "@/lib/adminGraenser";
import { hentErhvervTal } from "@/lib/admin/erhvervTal";
import { hentAdminStatus } from "@/lib/admin/status";
import { hentPengesikkerhed as hentPengesikkerhedRaa } from "@/app/actions/adminPengesikkerhed";
import { hentPengeoverblikKort } from "@/lib/admin/pengeOekonomi";

// Admin-forsiden = kontrolpanelet (docs/ADMIN-REDESIGN.md 3 og den godkendte
// showcase). Rækkefølgen er prioriteten: er der noget galt? -> hvad skal jeg
// gøre? -> tal. Alle staff-roller må se den; systemlamper kun admin og chef,
// beløb kun chef. Ingen personoplysninger.
//
// Hastighed: hver sektion er sin egen <Suspense>, så sidehovedet kommer med
// det samme, og en langsom kilde (fx Healthchecks) ikke holder resten tilbage.
// Statuslinjen er den samme beregning som menuens lampe (hentAdminStatus).
// Daglig afstemning, "Hos Stripe nu" og "Hos sælgerne" kommer fra sikkerhedsnet B.

export const metadata = { title: "Admin" };

const TZ = "Europe/Copenhagen";

// Deles mellem Kræver handling og Penge-kortene (ét kald pr. visning).
const hentPengesikkerhed = cache(hentPengesikkerhedRaa);
// Sikkerhedsnet B - kun chef (null for alle andre).
const hentOverblik = cache(hentPengeoverblikKort);

// admin_forside_tal() deles mellem Kræver handling og Nøgletal (ét kald).
const hentForsideTal = cache(async (): Promise<ForsideTal | null> => {
  const { data, error } = await createAdminClient().rpc("admin_forside_tal");
  if (error) {
    console.error("admin_forside_tal fejlede:", error.message);
    return null;
  }
  return tolkForsideTal(data);
});

function Skelet({ hoejde = "h-20", titel = true }: { hoejde?: string; titel?: boolean }) {
  return (
    <div aria-hidden="true" className="space-y-2.5">
      {titel && <div className="h-4 w-32 animate-pulse rounded bg-skelet/70" />}
      <div className={`${hoejde} animate-pulse rounded-[14px] bg-skelet/50`} />
    </div>
  );
}

async function StatusSektion({ rolle }: { rolle: StaffRole }) {
  const { status } = await hentAdminStatus(rolle);
  return <DriftStatuslinje status={status} />;
}

async function LampeSektion({ rolle }: { rolle: StaffRole }) {
  const { lamper } = await hentAdminStatus(rolle);
  return <StatusLamper lamper={lamper} />;
}

const flere = (n: number, en: string, mange: string) => (n === 1 ? en : mange);

async function HandlingSektion({ rolle }: { rolle: StaffRole }) {
  const admin = createAdminClient();
  const erAdmin = harMindstRolle(rolle, "admin");
  const [{ tal: s, lamper, noedstop }, forside, erhverv, beta, pengeRes] = await Promise.all([
    hentAdminStatus(rolle),
    hentForsideTal(),
    rolle === "chef" ? hentErhvervTal(admin) : Promise.resolve(null),
    erAdmin
      ? Promise.all([
          admin.from("beta_fejl").select("id", { count: "exact", head: true }).eq("status", "ny"),
          admin.from("beta_fejl").select("id", { count: "exact", head: true }).eq("status", "ny").eq("alvor", "blokerer"),
        ])
      : Promise.resolve(null),
    rolle === "chef" ? hentPengesikkerhed() : Promise.resolve(null),
  ]);
  const overblikRes = rolle === "chef" ? await hentOverblik() : null;
  const overblik = overblikRes && overblikRes.ok ? overblikRes.data : null;
  const h = forside?.handling;
  const penge = pengeRes && "ok" in pengeRes ? pengeRes : null;
  const betaFejl = beta && !beta[0].error && !beta[1].error ? { nye: beta[0].count ?? 0, blokerer: beta[1].count ?? 0 } : null;
  const roedeVagter = lamper.filter((l) => l.tone === "roed" && l.navn.startsWith("Ekstern vagt"));
  const r: HandlingRaekke[] = [];

  // Nødstop (sikkerhedsnet A) - alle skal vide det, så de kan svare brugerne.
  if (noedstop.stoppet) {
    r.push({
      id: "noedstop",
      alvor: "roed",
      titel: noedstop.udbetalinger ? "Udbetalinger stoppet (nødstop)" : "Nye betalinger stoppet (nødstop)",
      antal: 1,
      forklaring: rolle === "chef" ? "Slå det fra under Penge, når det er sikkert" : "Chefen genoptager under Penge",
      href: rolle === "chef" ? "/admin/penge" : "/admin",
    });
  }
  if (roedeVagter.length > 0) {
    r.push({
      id: "vagt",
      alvor: "roed",
      titel: "Ekstern vagt melder fejl",
      antal: roedeVagter.length,
      forklaring: roedeVagter.map((l) => l.navn.replace("Ekstern vagt – ", "")).join(" og ") + " har ikke meldt sig",
      href: "/admin/drift",
    });
  }
  if (overblik && overblik.afstemning.aabne_afvigelser > 0) {
    r.push({
      id: "afvigelser",
      alvor: "gul",
      titel: "Afstemningen har fundet afvigelser",
      antal: overblik.afstemning.aabne_afvigelser,
      forklaring: "Stripe og databasen er ikke enige – se Penge",
      href: "/admin/penge",
    });
  }
  if (penge && penge.godkendelser.length > 0) {
    r.push({
      id: "godkendelser",
      alvor: "gul",
      titel: "Udbetalinger til godkendelse",
      antal: penge.godkendelser.length,
      forklaring: "Godkend, før pengene sendes til sælgerens bank",
      href: "/admin/penge",
    });
  }
  if (s.dsa > 0) {
    r.push({
      id: "dsa",
      alvor: s.dsaOverskredet > 0 ? "roed" : "gul",
      titel: s.dsaOverskredet > 0 ? "DSA-sager over fristen" : "DSA-anmeldelser og -klager",
      antal: s.dsa,
      forklaring: "Lovpligtig frist – skal behandles i tide",
      frist: s.dsaOverskredet > 0 ? { tekst: `${s.dsaOverskredet} over frist`, alvor: "roed" } : undefined,
      href: "/admin/dsa",
    });
  }
  // Samme tal som menuen og Betalingsfejl-siden (betalinger + forkerte beløb + udbetalingskonti).
  r.push(
    { id: "sager", alvor: "gul", titel: "Åbne sager", antal: s.sager, forklaring: "Køber har klaget over en handel – afgør sagen", href: "/admin/sager" },
    {
      id: "betalinger",
      alvor: "gul",
      titel: "Betalingsfejl",
      antal: s.betalinger,
      forklaring: "En udbetaling eller refusion fejlede, beløbet passer ikke, eller en sælgers udbetalingskonto kræver hjælp",
      href: "/admin/betalinger",
    },
  );
  // Reklamationer hos fragtfirmaet (sælgeren anmelder selv). Rødt, når staff skal se på dem.
  if (s.reklamationSagAendret > 0) {
    r.push({
      id: "reklamation-aendret",
      alvor: "roed",
      titel: "Reklamation: sagen er ændret",
      antal: s.reklamationSagAendret,
      forklaring: "Sagen er ændret, efter sælgeren anmeldte skaden – ret reklamationen",
      href: "/admin/reklamationer?vis=sag_aendret",
    });
  }
  if (s.reklamationStille > 0) {
    r.push({
      id: "reklamation-stille",
      alvor: "roed",
      titel: "Reklamationer står stille",
      antal: s.reklamationStille,
      forklaring: "Intet er sket i 14 dage – send oplysningerne igen, eller kontakt sælgeren",
      href: "/admin/reklamationer?vis=stille",
    });
  }
  if (h && erAdmin) {
    r.push({ id: "anker", alvor: "gul", titel: "Anker", antal: h.anker, forklaring: "En part er uenig i afgørelsen – se på den igen", href: "/admin/sager?vis=anker" });
  }
  if (erhverv) {
    r.push(
      {
        id: "erhverv-henv",
        alvor: "gul",
        titel: flere(erhverv.nyeHenvendelser, "Ny erhvervshenvendelse", "Nye erhvervshenvendelser"),
        antal: erhverv.nyeHenvendelser,
        forklaring: "Et firma vil sælge på BidHamr – godkend eller afvis",
        href: "/admin/erhverv",
      },
      { id: "erhverv-klager", alvor: "gul", titel: "Købers klager over firmaer", antal: erhverv.aabneKlager, forklaring: "Tag sagen, og afgør den", href: "/admin/erhverv/klager?status=aaben" },
      { id: "erhverv-dsa", alvor: "gul", titel: "Firmaers klager (DSA)", antal: erhverv.dsaKlager, forklaring: "Et firma klager over vores afgørelse – frist 14 dage", href: "/admin/erhverv/dsa-klager" },
    );
  }
  if (betaFejl) {
    r.push({
      id: "beta",
      alvor: betaFejl.blokerer > 0 ? "gul" : "graa",
      titel: betaFejl.blokerer > 0 ? "Beta-fejl, blokerer" : "Nye beta-fejl",
      antal: betaFejl.nye,
      forklaring: betaFejl.blokerer > 0 ? `${betaFejl.blokerer} kan ikke komme videre` : "Meldt af beta-testere",
      href: "/admin/beta-fejl",
    });
  }
  if (h) {
    r.push(
      { id: "retur", alvor: "graa", titel: "Returfrist udløbet", antal: h.retur_udloebet, forklaring: "Køber har ikke sendt varen retur inden for 7 dage", href: "/admin/sager?vis=afventer_retur" },
      { id: "reklamation-venter", alvor: "graa", titel: "Reklamationer venter på sælger", antal: s.reklamationAfventer, forklaring: "Sælgeren har ikke anmeldt skaden hos fragtfirmaet endnu", href: "/admin/reklamationer?vis=afventer_saelger" },
      { id: "ubetalte", alvor: "graa", titel: "Ubetalte vindere", antal: s.ubetalte, forklaring: "Vinderen betalte ikke til tiden – advar eller afvis", href: "/admin/ubetalte" },
      {
        id: "ikke-sendt",
        alvor: "graa",
        titel: "Betalt, ikke sendt",
        antal: h.ikke_sendt,
        forklaring: "Sælgeren har ikke sendt varen",
        frist: { tekst: `> ${HAENGER_GRAENSER_DAGE.ikke_sendt} dage`, alvor: "graa" },
        href: "/admin/handler?vis=haenger",
      },
      {
        id: "ikke-modtaget",
        alvor: "graa",
        titel: "Sendt, ikke modtaget",
        antal: h.ikke_modtaget,
        forklaring: "Pakken er ikke kommet frem",
        frist: { tekst: `> ${HAENGER_GRAENSER_DAGE.ikke_modtaget} dage`, alvor: "graa" },
        href: "/admin/handler?vis=haenger",
      },
      { id: "afhentning", alvor: "graa", titel: "Afhentning ikke gennemført", antal: h.afhentning, forklaring: "Fristen for afhentning er overskredet", href: "/admin/handler?vis=haenger" },
      { id: "fragt", alvor: "graa", titel: "Fragt kræver handling", antal: h.fragt, forklaring: "Fragtfirmaet har meldt noget, der skal tjekkes", href: "/admin/handler?vis=fragt" },
    );
  }
  if (erAdmin) {
    r.push({ id: "lukning", alvor: "graa", titel: "Forslag om kontolukning", antal: s.kontolukninger, forklaring: "En bruger har fået 3 advarsler", href: "/admin/kontolukninger" });
  }
  r.push(
    { id: "rapporter", alvor: "graa", titel: "Nye anmeldelser", antal: s.rapporter, forklaring: "Anmeldte auktioner, chatbeskeder og profiler", href: "/admin/rapporter" },
    { id: "bedoemmelser", alvor: "graa", titel: "Anmeldte bedømmelser", antal: s.bedoemmelser, href: "/admin/bedommelser" },
    { id: "kontakt", alvor: "graa", titel: "Kontaktformular uden svar", antal: s.kontakt, href: "/admin/kontakt" },
    { id: "chats", alvor: "graa", titel: "Chats uden svar", antal: s.chats, href: "/admin/chats" },
  );
  return (
    <>
      {!forside && <AdminFejl hvad="Nogle af tallene til forsiden" />}
      <KraeverHandling raekker={r} />
    </>
  );
}

async function PengeSektion() {
  const [res, overblikRes] = await Promise.all([hentPengesikkerhed(), hentOverblik()]);
  if (!("ok" in res)) {
    const ingenAdgang = /adgang/i.test(res.fejl);
    return <AdminFejl>{ingenAdgang ? "Ingen adgang til pengetallene." : "Pengetallene kunne ikke hentes. Prøv at genindlæse siden."}</AdminFejl>;
  }
  return <PengeStatus penge={res} overblik={overblikRes && overblikRes.ok ? overblikRes.data : null} />;
}

async function NoegletalSektion({ periode }: { periode: string | undefined }) {
  const tal = await hentForsideTal();
  return tal ? <Noegletal tal={tal} periode={somPeriode(periode)} /> : null;
}

export default async function AdminForside({ searchParams }: { searchParams: Promise<{ periode?: string }> }) {
  const rolle = await getStaffRole();
  if (!rolle) {
    // Sælger (erhverv) har kun adgang til Erhverv.
    if ((await getErhvervRolle()) === "saelger") redirect("/admin/erhverv");
    redirect("/");
  }
  const { periode } = await searchParams;
  const erAdmin = harMindstRolle(rolle, "admin");
  const opdateret = new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

  return (
    <AdminSide className="space-y-[22px]">
      <AdminSideHoved titel="Forside" forklaring={`Det vigtigste først. Opdateret ${opdateret}.`} />

      <Suspense fallback={<Skelet hoejde="h-[72px]" titel={false} />}>
        <StatusSektion rolle={rolle} />
      </Suspense>

      {erAdmin && (
        <Suspense fallback={<Skelet hoejde="h-36" />}>
          <LampeSektion rolle={rolle} />
        </Suspense>
      )}

      <Suspense fallback={<Skelet hoejde="h-64" />}>
        <HandlingSektion rolle={rolle} />
      </Suspense>

      {rolle === "chef" && (
        <Suspense fallback={<Skelet hoejde="h-24" />}>
          <PengeSektion />
        </Suspense>
      )}

      <Suspense fallback={<Skelet hoejde="h-48" />}>
        <NoegletalSektion periode={periode} />
      </Suspense>
    </AdminSide>
  );
}
