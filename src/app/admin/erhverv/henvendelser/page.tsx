import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervHenvendelser } from "@/app/actions/adminErhverv";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFilterChips from "@/components/admin/AdminFilterChips";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminTom from "@/components/admin/AdminTom";
import ErhvervFaner from "@/components/admin/erhverv/ErhvervFaner";
import HenvendelseKort from "@/components/admin/erhverv/HenvendelseKort";
import { ADMIN_ERHVERV, ADMIN_ERHVERV_EKSTRA } from "@/lib/tekster/erhverv";
import { HENVENDELSE_STATUSSER, HENVENDELSE_STATUS_NAVN, erHenvendelseStatus } from "@/lib/erhverv/regler";

// Admin → Erhverv → Henvendelser (formularen fra /erhverv). Kun chef og
// saelger (kraevErhvervSide + erhverv_har_adgang i databasen). Lå før på
// /admin/erhverv, som nu er sælgerens oversigt - de gamle adresser med
// ?status= eller ?arkiv=1 sendes hertil.
export default async function ErhvervHenvendelserListe({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; arkiv?: string }>;
}) {
  await kraevErhvervSide();
  const { status: raaStatus, arkiv } = await searchParams;
  const status = erHenvendelseStatus(raaStatus) ? raaStatus : null;
  const arkiverede = arkiv === "1";

  const [res, alleAktive] = await Promise.all([
    hentErhvervHenvendelser({ status, arkiverede }),
    status || arkiverede ? hentErhvervHenvendelser({}) : null,
  ]);
  const fejl = "fejl" in res ? res.fejl : null;
  const liste = "fejl" in res ? [] : res.henvendelser;
  const ufiltreret = alleAktive && !("fejl" in alleAktive) ? alleAktive.henvendelser : liste;
  const antalNye = ufiltreret.filter((h) => h.status === "ny").length;

  const sti = "/admin/erhverv/henvendelser";
  const filtre = [
    { id: "alle", label: ADMIN_ERHVERV.henvendelser.filterAlle, href: sti },
    ...HENVENDELSE_STATUSSER.map((s) => ({
      id: s,
      label: HENVENDELSE_STATUS_NAVN[s],
      href: `${sti}?status=${s}`,
      antal: s === "ny" ? antalNye : undefined,
      tone: "gul" as const,
    })),
    { id: "arkiv", label: ADMIN_ERHVERV_EKSTRA.arkiverede, href: `${sti}?arkiv=1` },
  ];
  const aktivFilter = arkiverede ? "arkiv" : (status ?? "alle");

  return (
    <AdminSide>
      <AdminSideHoved titel="Henvendelser" forklaring={ADMIN_ERHVERV.henvendelser.forklaring} />
      <ErhvervFaner aktiv="henvendelser" />
      <AdminFilterChips label="Filter" chips={filtre} aktiv={aktivFilter} />

      {fejl && <AdminFejl hvad="Henvendelserne" detalje={fejl} />}

      {!fejl && liste.length === 0 ? (
        <AdminTom
          tekst={status || arkiverede ? ADMIN_ERHVERV.henvendelser.tomFilter : ADMIN_ERHVERV.henvendelser.tom}
          nulstilHref={status || arkiverede ? sti : undefined}
        />
      ) : (
        <ul className="space-y-3">
          {liste.map((h) => (
            <li key={h.id}>
              <HenvendelseKort h={h} />
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-tekst-daempet">
        <Link href="/admin/erhverv" className="font-semibold text-groen hover:underline">
          ← Til oversigten
        </Link>
      </p>
    </AdminSide>
  );
}
