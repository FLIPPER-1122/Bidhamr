// Trinnene i tidslinjen. 'leveret' er slutpunktet: det er dér, sælgeren får
// pengene udbetalt.
//
// 'modtaget' ligger imellem: køberen har kvitteret for pakken, men endnu
// ikke godkendt varen, og der er ikke flyttet penge.
//
// Check-constrainten på trades.status tillader også 'afsluttet'. Den værdi
// sættes ikke af noget i dag og er reserveret til et senere trin efter
// udbetaling (fx udløbet klagefrist) - derfor står den ikke her.
export const HANDEL_STATUS = [
  { vaerdi: "betaling_modtaget", label: "Betaling modtaget" },
  { vaerdi: "pakke_sendt", label: "Pakke sendt" },
  { vaerdi: "modtaget", label: "Modtaget" },
  { vaerdi: "leveret", label: "Godkendt og afregnet" },
] as const;

// Handlen er i gang, indtil køberen har godkendt.
export const AKTIVE_STATUSSER = ["betaling_modtaget", "pakke_sendt", "modtaget"];

const STIL: Record<string, string> = {
  betaling_modtaget: "bg-amber-100 text-amber-800",
  pakke_sendt: "bg-blue-100 text-blue-800",
  modtaget: "bg-indigo-100 text-indigo-800",
  leveret: "bg-green-100 text-green-800",
  // Reserveret; se kommentaren ved HANDEL_STATUS.
  afsluttet: "bg-neutral-100 text-neutral-600",
  // Sat af admin via Sager (koeber refunderet). Ikke en del af tidslinjen.
  annulleret: "bg-red-100 text-red-700",
};

export function statusLabel(status: string) {
  if (status === "annulleret") return "Annulleret";
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
