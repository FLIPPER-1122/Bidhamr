import AdminFaner from "@/components/admin/AdminFaner";
import { getErhvervRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentErhvervTal } from "@/lib/admin/erhvervTal";
import { ADMIN_ERHVERV } from "@/lib/tekster/erhverv";
import { KLAGE_ADMIN } from "@/lib/tekster/erhvervKlager";
import { ERHVERV_DSA_KLAGER } from "@/lib/tekster/erhvervDsaKlager";

export type ErhvervFane = "oversigt" | "henvendelser" | "firmaer" | "klager" | "dsa-klager" | "pakker";

// Faner under Admin → Erhverv (kun chef og saelger). Tallene er kun antal og
// hentes én gang pr. forespørgsel (cache() i src/lib/admin/erhvervTal.ts) -
// først efter rolletjekket.
export default async function ErhvervFaner({ aktiv }: { aktiv: ErhvervFane }) {
  const tal = (await getErhvervRolle()) ? await hentErhvervTal(createAdminClient()) : null;
  return (
    <AdminFaner
      label="Erhverv"
      aktiv={aktiv}
      faner={[
        { id: "oversigt", label: "Oversigt", href: "/admin/erhverv" },
        { id: "henvendelser", label: ADMIN_ERHVERV.faner.henvendelser, href: "/admin/erhverv/henvendelser", antal: tal?.nyeHenvendelser, tone: "gul" },
        { id: "firmaer", label: ADMIN_ERHVERV.faner.firmaer, href: "/admin/erhverv/firmaer" },
        { id: "klager", label: KLAGE_ADMIN.fane, href: "/admin/erhverv/klager", antal: tal?.aabneKlager, tone: "gul" },
        { id: "dsa-klager", label: ERHVERV_DSA_KLAGER.fane, href: "/admin/erhverv/dsa-klager", antal: tal?.dsaKlager, tone: "gul" },
        { id: "pakker", label: ADMIN_ERHVERV.faner.pakker, href: "/admin/erhverv/pakker" },
      ]}
    />
  );
}

export const datoTid = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("da-DK", {
        timeZone: "Europe/Copenhagen",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "–";

export const dato = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("da-DK", {
        timeZone: "Europe/Copenhagen",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "–";

const STATUS_KLASSE: Record<string, string> = {
  ny: "bg-orange-lys text-[#8A4210]",
  i_gang: "bg-info-bg text-info-tekst",
  godkendt: "bg-succes-bg text-succes-tekst",
  afvist: "bg-neutral-100 text-neutral-700",
};

export function HenvendelseStatusBadge({ status }: { status: string }) {
  const navn =
    status === "ny"
      ? ADMIN_ERHVERV.henvendelser.status.ny
      : status === "i_gang"
        ? ADMIN_ERHVERV.henvendelser.status.igang
        : status === "godkendt"
          ? ADMIN_ERHVERV.henvendelser.status.godkendt
          : status === "afvist"
            ? ADMIN_ERHVERV.henvendelser.status.afvist
            : status;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_KLASSE[status] ?? "bg-neutral-100"}`}>
      {navn}
    </span>
  );
}
