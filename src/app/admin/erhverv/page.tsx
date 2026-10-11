import Link from "next/link";
import { redirect } from "next/navigation";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervHenvendelser, hentFirmaer } from "@/app/actions/adminErhverv";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminBadge from "@/components/admin/AdminBadge";
import ErhvervFaner, { dato } from "@/components/admin/erhverv/ErhvervFaner";
import HenvendelseKort from "@/components/admin/erhverv/HenvendelseKort";
import KraeverHandling, { type HandlingRaekke } from "@/components/admin/forside/KraeverHandling";
import { hentErhvervTal } from "@/lib/admin/erhvervTal";
import { ABONNEMENT_STATUS_NAVN, type AbonnementStatus } from "@/lib/erhverv/regler";

// Admin → Erhverv → Oversigt: sælgerens (og chefens) forside for erhverv
// (Filip, 12. okt. 2026). Øverst de nye henvendelser fra firmaformularen med
// hurtighandlinger, så Kræver handling (klager, firmaers DSA-klager,
// forslag), og nederst firmaer, abonnementer samt lukning og suspension.
// Kun chef og saelger (kraevErhvervSide + erhverv_har_adgang i databasen).
//
// /admin/erhverv var før listen over henvendelser. Gamle links med ?status=
// eller ?arkiv=1 sendes videre til /admin/erhverv/henvendelser.

export const metadata = { title: "Erhverv" };

const VIS_NYE = 5;

// Uden for komponenten (React-reglen om rene komponenter).
function naa() {
  return Date.now();
}

function Sektion({ id, titel, link, children }: { id: string; titel: string; link?: { href: string; label: string }; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-[13px] font-semibold uppercase tracking-[0.06em] text-tekst-svag">
          {titel}
        </h2>
        {link && (
          <Link href={link.href} className="text-[13.5px] font-semibold text-groen hover:underline">
            {link.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export default async function ErhvervOversigt({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; arkiv?: string }>;
}) {
  const { admin } = await kraevErhvervSide();
  const sp = await searchParams;
  if (sp.status || sp.arkiv) {
    const q = new URLSearchParams();
    if (sp.status) q.set("status", sp.status);
    if (sp.arkiv) q.set("arkiv", sp.arkiv);
    redirect(`/admin/erhverv/henvendelser?${q}`);
  }

  const [tal, nye, firmaRes, lukning, suspenderede] = await Promise.all([
    hentErhvervTal(admin),
    hentErhvervHenvendelser({ status: "ny" }),
    hentFirmaer(),
    admin
      .from("konto_lukning_forslag")
      .select("id, bruger_id, oprettet_kl, bruger:users!konto_lukning_forslag_bruger_id_fkey!inner(konto_type)")
      .eq("status", "afventer")
      .eq("bruger.konto_type", "erhverv")
      .order("oprettet_kl", { ascending: true })
      .limit(20),
    admin
      .from("users")
      .select("id, suspenderet_til")
      .eq("konto_type", "erhverv")
      .eq("suspenderet", true)
      .is("konto_lukket_kl", null)
      .limit(50),
  ]);

  const nyeListe = "fejl" in nye ? [] : nye.henvendelser;
  const firmaer = "fejl" in firmaRes ? [] : firmaRes.firmaer;
  const firmaFraBruger = new Map(firmaer.map((f) => [f.bruger_id, f]));
  const lukningForslag = ((lukning.data ?? []) as { id: string; bruger_id: string; oprettet_kl: string }[])
    .map((l) => ({ ...l, firma: firmaFraBruger.get(l.bruger_id) }))
    .filter((l) => l.firma);
  const nu = naa();
  const susp = ((suspenderede.data ?? []) as { id: string; suspenderet_til: string | null }[])
    .filter((u) => !u.suspenderet_til || new Date(u.suspenderet_til).getTime() > nu)
    .map((u) => ({ ...u, firma: firmaFraBruger.get(u.id) }))
    .filter((u) => u.firma);

  // Abonnementer: antal pr. status + dem, der kræver opmærksomhed.
  const pr = new Map<AbonnementStatus, number>();
  for (const f of firmaer) pr.set(f.abonnement_status, (pr.get(f.abonnement_status) ?? 0) + 1);
  const abonnementProblemer = firmaer.filter(
    (f) => f.betaling_mislykket_kl || f.abonnement_status === "pauset" || f.abonnement_status === "afventer_betaling" || f.afventende_opgradering,
  );

  const raekker: HandlingRaekke[] = [
    {
      id: "henv",
      alvor: "gul",
      titel: tal.nyeHenvendelser === 1 ? "Ny henvendelse fra firmaformularen" : "Nye henvendelser fra firmaformularen",
      antal: Math.max(0, tal.nyeHenvendelser - Math.min(VIS_NYE, nyeListe.length)),
      forklaring: "Flere end dem, der står ovenfor",
      href: "/admin/erhverv/henvendelser?status=ny",
    },
    { id: "klager", alvor: "gul", titel: "Klager over firmaer", antal: tal.aabneKlager, forklaring: "Køber klager over en erhvervssælger – tag sagen", href: "/admin/erhverv/klager?status=aaben" },
    { id: "dsa", alvor: "gul", titel: "Firmaers klager (DSA)", antal: tal.dsaKlager, forklaring: "Et firma klager over vores afgørelse – frist 14 dage", href: "/admin/erhverv/dsa-klager" },
    { id: "forslag", alvor: "gul", titel: "Forslag om advarsel", antal: tal.advarselForslag, forklaring: "Firmaet har fået flere berettigede klager", href: "/admin/erhverv/klager" },
    { id: "lukning", alvor: "gul", titel: "Forslag om lukning af firmakonto", antal: lukningForslag.length, forklaring: "Godkend eller afvis på firmaets side", href: lukningForslag[0]?.firma ? `/admin/erhverv/firmaer/${lukningForslag[0].firma.id}` : "/admin/erhverv/firmaer" },
    { id: "behandling", alvor: "graa", titel: "Klager under behandling", antal: tal.klagerUnderBehandling, href: "/admin/erhverv/klager?status=under_behandling" },
    { id: "abonnement", alvor: "graa", titel: "Abonnementer, der kræver opmærksomhed", antal: abonnementProblemer.length, forklaring: "Betaling fejlet, på pause eller venter på første betaling", href: "#abonnementer" },
  ];

  return (
    <AdminSide className="space-y-[22px]">
      <AdminSideHoved
        titel="Erhverv"
        forklaring="Dit overblik over firmaer på BidHamr. Øverst det, der venter på dig – svar på nye henvendelser direkte herfra."
        handlinger={
          <Link href="/admin/erhverv/henvendelser" className="btn btn-sekundaer btn-lille">
            Alle henvendelser
          </Link>
        }
      />
      <ErhvervFaner aktiv="oversigt" />

      {"fejl" in nye && <AdminFejl hvad="Henvendelserne" detalje={nye.fejl} />}

      <Sektion
        id="erhverv-nye"
        titel={`Nye henvendelser (${tal.nyeHenvendelser})`}
        link={tal.nyeHenvendelser > VIS_NYE ? { href: "/admin/erhverv/henvendelser?status=ny", label: "Se alle nye →" } : undefined}
      >
        {nyeListe.length === 0 ? (
          <p className="rounded-[14px] border border-succes-kant bg-succes-bg px-5 py-4 text-sm text-succes-tekst">
            <span aria-hidden="true">✓ </span>Ingen nye henvendelser.{" "}
            <Link href="/admin/erhverv/henvendelser?status=i_gang" className="font-semibold underline">
              Se dem, der er i gang
            </Link>
          </p>
        ) : (
          <ul className="space-y-3">
            {nyeListe.slice(0, VIS_NYE).map((h) => (
              <li key={h.id}>
                <HenvendelseKort h={h} />
              </li>
            ))}
          </ul>
        )}
      </Sektion>

      <KraeverHandling raekker={raekker} tomLink={{ href: "/admin/erhverv/klager?status=afsluttet", label: "Se afsluttede klager" }} />

      <Sektion id="erhverv-lukning" titel="Lukning, suspension og forslag">
        {lukningForslag.length === 0 && susp.length === 0 && tal.advarselForslag === 0 ? (
          <p className="rounded-[14px] border border-admin-kant bg-white px-5 py-4 text-sm text-tekst-daempet">
            Ingen firmakonti er suspenderet, og der er ingen forslag om lukning eller advarsel.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-[14px] border border-admin-kant bg-white">
            {lukningForslag.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-admin-kant px-4 py-3 first:border-t-0">
                <span className="min-w-0">
                  <span className="font-semibold text-tekst">{l.firma!.firmanavn}</span>{" "}
                  <AdminBadge tone="gul">Forslag om lukning</AdminBadge>
                  <span className="block text-xs text-tekst-svag">Siden {dato(l.oprettet_kl)}</span>
                </span>
                <Link href={`/admin/erhverv/firmaer/${l.firma!.id}`} className="btn btn-primaer btn-lille">
                  Behandl forslaget
                </Link>
              </li>
            ))}
            {susp.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-admin-kant px-4 py-3 first:border-t-0">
                <span className="min-w-0">
                  <span className="font-semibold text-tekst">{u.firma!.firmanavn}</span>{" "}
                  <AdminBadge tone="roed">Suspenderet</AdminBadge>
                  <span className="block text-xs text-tekst-svag">
                    {u.suspenderet_til ? `Til ${dato(u.suspenderet_til)}` : "Permanent"}
                  </span>
                </span>
                <Link href={`/admin/erhverv/firmaer/${u.firma!.id}`} className="btn btn-sekundaer btn-lille">
                  Se firma
                </Link>
              </li>
            ))}
            {tal.advarselForslag > 0 && (
              <li className="flex flex-wrap items-center justify-between gap-2 border-t border-admin-kant px-4 py-3 first:border-t-0">
                <span className="font-semibold text-tekst">
                  {tal.advarselForslag} {tal.advarselForslag === 1 ? "forslag" : "forslag"} om advarsel
                </span>
                <Link href="/admin/erhverv/klager" className="btn btn-sekundaer btn-lille">
                  Behandl
                </Link>
              </li>
            )}
          </ul>
        )}
      </Sektion>

      <Sektion id="abonnementer" titel={`Firmaer og abonnementer (${firmaer.length})`} link={{ href: "/admin/erhverv/firmaer", label: "Alle firmaer →" }}>
        {"fejl" in firmaRes && <AdminFejl hvad="Firmaerne" detalje={firmaRes.fejl} />}
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {(Object.keys(ABONNEMENT_STATUS_NAVN) as AbonnementStatus[]).map((s) => (
            <div key={s} className="rounded-xl border border-admin-kant bg-white px-4 py-3.5">
              <small className="block text-[12.5px] text-tekst-svag">{ABONNEMENT_STATUS_NAVN[s]}</small>
              <b className="mt-0.5 block text-[22px] font-bold tabular-nums text-tekst">{pr.get(s) ?? 0}</b>
            </div>
          ))}
        </div>
        {abonnementProblemer.length > 0 && (
          <ul className="overflow-hidden rounded-[14px] border border-admin-kant bg-white">
            {abonnementProblemer.slice(0, 10).map((f) => (
              <li key={f.id} className="border-t border-admin-kant first:border-t-0">
                <Link href={`/admin/erhverv/firmaer/${f.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-admin-bg">
                  <span className="min-w-0 font-semibold text-tekst">{f.firmanavn}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {f.betaling_mislykket_kl && <AdminBadge tone="roed">Betaling fejlet</AdminBadge>}
                    {f.afventende_opgradering && <AdminBadge tone="blaa">Opgradering venter på betaling</AdminBadge>}
                    <AdminBadge tone={f.abonnement_status === "aktiv" ? "groen" : "gul"}>{ABONNEMENT_STATUS_NAVN[f.abonnement_status]}</AdminBadge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Sektion>
    </AdminSide>
  );
}
