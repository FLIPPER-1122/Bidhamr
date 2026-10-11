import { redirect } from "next/navigation";
import { assertRole, getErhvervRolle, harMindstRolle, type StaffRole } from "@/lib/adminAuth";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFejl from "@/components/admin/AdminFejl";
import DriftStatuslinje from "@/components/admin/forside/DriftStatuslinje";
import StatusLamper from "@/components/admin/forside/StatusLamper";
import KraeverHandling, { type HandlingRaekke } from "@/components/admin/forside/KraeverHandling";
import Noegletal, { somPeriode } from "@/components/admin/forside/Noegletal";
import { tolkForsideTal, type ForsideTal } from "@/components/admin/forside/forsideTal";
import { HAENGER_GRAENSER_DAGE } from "@/lib/adminGraenser";
import { hentStaffTal, type StaffTal } from "@/lib/admin/taellere";
import { hentErhvervTal, type ErhvervTal } from "@/lib/admin/erhvervTal";
import { hentLamper, type Lampe } from "@/lib/admin/lamper";
import { beregnStatus, koePunkter, type StatusPunkt } from "@/lib/admin/statuslinje";

// Admin-forsiden = kontrolpanelet (docs/ADMIN-REDESIGN.md 3 og den godkendte
// showcase). Rækkefølgen er prioriteten: er der noget galt? -> hvad skal jeg
// gøre? -> tal. Alle staff-roller må se den; systemlamper kun admin og chef.
// Kun ANTAL - beløb og indtjening ligger på Penge (kun chef). Ingen
// personoplysninger.
//
// Trin 1-2: data fra det, der findes i dag (admin_forside_tal, menuens
// tællere og drift-data). Nødstop, afstemning, godkendelser og pengestatus
// kommer i trin 3, når penge-agenterne er flettet ind - indtil da er de skjult.

export const metadata = { title: "Admin" };

type Data = {
  rolle: StaffRole;
  tal: ForsideTal | null;
  staff: StaffTal;
  lamper: Lampe[];
  erhverv: ErhvervTal | null;
  betaFejl: { nye: number; blokerer: number } | null;
};

async function hentData(): Promise<Data | null> {
  let adgang: Awaited<ReturnType<typeof assertRole>>;
  try {
    adgang = await assertRole("medarbejder");
  } catch {
    return null;
  }
  const { admin, rolle } = adgang;
  const erAdmin = harMindstRolle(rolle, "admin");

  const [forside, staff, erhverv, beta] = await Promise.all([
    admin.rpc("admin_forside_tal"),
    hentStaffTal(),
    rolle === "chef" ? hentErhvervTal(admin) : Promise.resolve(null),
    erAdmin
      ? Promise.all([
          admin.from("beta_fejl").select("id", { count: "exact", head: true }).eq("status", "ny"),
          admin.from("beta_fejl").select("id", { count: "exact", head: true }).eq("status", "ny").eq("alvor", "blokerer"),
        ])
      : Promise.resolve(null),
  ]);
  if (forside.error) console.error("admin_forside_tal fejlede:", forside.error.message);
  const tal = forside.error ? null : tolkForsideTal(forside.data);
  const lamper = erAdmin ? await hentLamper(admin, { fragtTilHandling: tal?.handling.fragt ?? 0 }) : [];
  const betaFejl =
    beta && !beta[0].error && !beta[1].error ? { nye: beta[0].count ?? 0, blokerer: beta[1].count ?? 0 } : null;
  return { rolle, tal, staff, lamper, erhverv, betaFejl };
}

const flere = (n: number, en: string, mange: string) => (n === 1 ? en : mange);

function byggRaekker(d: Data): HandlingRaekke[] {
  const { rolle, staff: s, erhverv: e, betaFejl } = d;
  const h = d.tal?.handling;
  const admin = harMindstRolle(rolle, "admin");
  const r: HandlingRaekke[] = [];

  // Lovpligtige frister først.
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
  if (h) {
    r.push(
      { id: "sager", alvor: "gul", titel: "Åbne sager", antal: h.aabne_sager, forklaring: "Køber har klaget over en handel – afgør sagen", href: "/admin/sager" },
      ...(admin
        ? [{ id: "anker", alvor: "gul" as const, titel: "Anker", antal: h.anker, forklaring: "En part er uenig i afgørelsen – se på den igen", href: "/admin/sager?vis=anker" }]
        : []),
      {
        id: "betalinger",
        alvor: "gul",
        titel: "Betalingsfejl",
        antal: h.betalinger + h.afvigelser,
        forklaring: "En udbetaling eller refusion fejlede, eller beløbet passer ikke",
        href: "/admin/betalinger",
      },
    );
  }
  if (e) {
    r.push(
      {
        id: "erhverv-henv",
        alvor: "gul",
        titel: flere(e.nyeHenvendelser, "Ny erhvervshenvendelse", "Nye erhvervshenvendelser"),
        antal: e.nyeHenvendelser,
        forklaring: "Et firma vil sælge på BidHamr – godkend eller afvis",
        href: "/admin/erhverv",
      },
      { id: "erhverv-klager", alvor: "gul", titel: "Klager over firmaer", antal: e.aabneKlager, forklaring: "Køber klager over en erhvervssælger", href: "/admin/erhverv/klager?status=aaben" },
      { id: "erhverv-dsa", alvor: "gul", titel: "Firmaers klager (DSA)", antal: e.dsaKlager, forklaring: "Et firma klager over vores afgørelse – frist 14 dage", href: "/admin/erhverv/dsa-klager" },
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
      { id: "ubetalte", alvor: "graa", titel: "Ubetalte vindere", antal: h.ubetalte, forklaring: "Vinderen betalte ikke til tiden – advar eller afvis", href: "/admin/ubetalte" },
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
      { id: "konti", alvor: "graa", titel: "Sælgers udbetalingskonto", antal: h.udbetalingskonti, forklaring: "En sælger kan ikke få penge udbetalt", href: "/admin/betalinger" },
    );
    if (admin) {
      r.push({ id: "lukning", alvor: "graa", titel: "Forslag om kontolukning", antal: h.kontolukninger, forklaring: "En bruger har fået 3 advarsler", href: "/admin/kontolukninger" });
    }
  }
  r.push(
    { id: "rapporter", alvor: "graa", titel: "Nye anmeldelser", antal: s.rapporter, forklaring: "Anmeldte auktioner, chatbeskeder og profiler", href: "/admin/rapporter" },
    { id: "bedoemmelser", alvor: "graa", titel: "Anmeldte bedømmelser", antal: s.bedoemmelser, href: "/admin/bedommelser" },
    { id: "kontakt", alvor: "graa", titel: "Kontaktformular uden svar", antal: s.kontakt, href: "/admin/kontakt" },
    { id: "chats", alvor: "graa", titel: "Chats uden svar", antal: s.chats, href: "/admin/chats" },
  );
  return r;
}

const TZ = "Europe/Copenhagen";

export default async function AdminForside({ searchParams }: { searchParams: Promise<{ periode?: string }> }) {
  const d = await hentData();
  if (!d) {
    // Sælger (erhverv) har kun adgang til Erhverv.
    if ((await getErhvervRolle()) === "saelger") redirect("/admin/erhverv");
    redirect("/");
  }
  const { periode } = await searchParams;
  const raekker = byggRaekker(d);

  // Statuslinjen: køerne (som menuen) + røde/gule systemlamper.
  const lampePunkter: StatusPunkt[] = d.lamper
    .filter((l) => l.tone === "roed" || l.tone === "gul")
    .map((l) => ({ tone: l.tone as "roed" | "gul", tekst: l.statusTekst ?? `${l.navn}: ${l.tekst}`, href: l.href ?? "/admin/drift" }));
  const status = beregnStatus([
    ...lampePunkter.filter((p) => p.tone === "roed"),
    ...koePunkter({ dsaOverskredet: d.staff.dsaOverskredet, dsa: d.staff.dsa, sager: d.staff.sager, betalinger: d.staff.betalinger }),
    ...lampePunkter.filter((p) => p.tone === "gul"),
  ], { systemerTjekket: d.lamper.length > 0 });
  const opdateret = new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

  return (
    <AdminSide className="space-y-[22px]">
      <AdminSideHoved titel="Forside" forklaring={`Det vigtigste først. Opdateret ${opdateret}.`} />

      <DriftStatuslinje status={status} />

      <StatusLamper lamper={d.lamper} />

      {!d.tal && <AdminFejl hvad="Tallene til forsiden" />}

      <KraeverHandling raekker={raekker} />

      {d.tal && <Noegletal tal={d.tal} periode={somPeriode(periode)} />}
    </AdminSide>
  );
}
