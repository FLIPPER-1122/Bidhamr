import AdminFaner from "@/components/admin/AdminFaner";
import { ADMIN_ERHVERV } from "@/lib/tekster/erhverv";

// Faner under Admin → Erhverv (kun chef og saelger).
export default function ErhvervFaner({ aktiv }: { aktiv: "henvendelser" | "firmaer" | "pakker" }) {
  return (
    <AdminFaner
      label="Erhverv"
      aktiv={aktiv}
      faner={[
        { id: "henvendelser", label: ADMIN_ERHVERV.faner.henvendelser, href: "/admin/erhverv" },
        { id: "firmaer", label: ADMIN_ERHVERV.faner.firmaer, href: "/admin/erhverv/firmaer" },
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
