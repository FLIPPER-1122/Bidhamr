import Link from "next/link";
import type { ErhvervHenvendelse } from "@/app/actions/adminErhverv";
import { HenvendelseStatusBadge, datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import HenvendelseHurtig from "@/components/admin/erhverv/HenvendelseHurtig";
import AdminBadge from "@/components/admin/AdminBadge";
import { ADMIN_ERHVERV, ADMIN_ERHVERV_EKSTRA } from "@/lib/tekster/erhverv";

// Én erhvervshenvendelse som kort med det vigtigste og hurtighandlingerne
// (Godkend, Afvis, Notér, Opret firmakonto). Bruges på Oversigt og i listen.
export default function HenvendelseKort({ h }: { h: ErhvervHenvendelse }) {
  return (
    <article
      className={`rounded-none border bg-white p-4 sm:p-5 ${h.status === "ny" ? "border-advarsel-kant" : "border-admin-kant"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Link href={`/admin/erhverv/henvendelser/${h.id}`} className="break-words font-semibold text-tekst hover:text-groen hover:underline">
              {h.firmanavn}
            </Link>
            <HenvendelseStatusBadge status={h.status} />
            {h.firma_id && <AdminBadge tone="groen">{ADMIN_ERHVERV_EKSTRA.kontoOprettet}</AdminBadge>}
          </p>
          <p className="mt-0.5 break-words text-sm text-tekst-daempet">
            {ADMIN_ERHVERV.henvendelser.kolonneCvr} {h.cvr} · {h.kontaktperson} ·{" "}
            <a href={`tel:${h.telefon.replace(/\s/g, "")}`} className="text-groen hover:underline">
              {h.telefon}
            </a>{" "}
            ·{" "}
            <a href={`mailto:${h.email}`} className="break-all text-groen hover:underline">
              {h.email}
            </a>
          </p>
        </div>
        <p className="shrink-0 text-xs text-tekst-svag">{datoTid(h.oprettet_kl)}</p>
      </div>
      <p className="mt-2 line-clamp-3 whitespace-pre-line break-words text-sm text-tekst">
        {h.hvad_saelger_i}
        {h.antal_varer_ca != null && <span className="text-tekst-daempet"> · ca. {h.antal_varer_ca.toLocaleString("da-DK")} varer</span>}
      </p>
      {h.noter && (
        <p className="mt-2 line-clamp-2 whitespace-pre-line break-words rounded-lg bg-admin-bg px-3 py-2 text-xs text-tekst-daempet">
          {h.noter}
        </p>
      )}
      <div className="mt-3">
        <HenvendelseHurtig id={h.id} firmanavn={h.firmanavn} status={h.status} firmaId={h.firma_id} />
      </div>
    </article>
  );
}
