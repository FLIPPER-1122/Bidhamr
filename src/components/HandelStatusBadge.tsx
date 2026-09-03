// Skal matche check-constrainten på trades.status.
export const HANDEL_STATUS = [
  { vaerdi: "betaling_modtaget", label: "Betaling modtaget" },
  { vaerdi: "pakke_sendt", label: "Pakke sendt" },
  { vaerdi: "leveret", label: "Leveret" },
  { vaerdi: "afsluttet", label: "Afsluttet" },
] as const;

export const AKTIVE_STATUSSER = ["betaling_modtaget", "pakke_sendt"];

const STIL: Record<string, string> = {
  betaling_modtaget: "bg-amber-100 text-amber-800",
  pakke_sendt: "bg-blue-100 text-blue-800",
  leveret: "bg-green-100 text-green-800",
  afsluttet: "bg-neutral-100 text-neutral-600",
};

export function statusLabel(status: string) {
  return HANDEL_STATUS.find((s) => s.vaerdi === status)?.label ?? status;
}

export default function HandelStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
        STIL[status] ?? STIL.afsluttet
      }`}
    >
      {statusLabel(status)}
    </span>
  );
}
