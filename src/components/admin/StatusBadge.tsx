export type BrugerStatus = "ok" | "advarsel" | "suspenderet";

// Suspension tæller kun hvis den er aktiv (permanent eller ikke udløbet).
export function erSuspensionAktiv(u: {
  suspenderet: boolean;
  suspenderet_til: string | null;
}) {
  return (
    u.suspenderet &&
    (!u.suspenderet_til || new Date(u.suspenderet_til) > new Date())
  );
}

export function brugerStatus(
  u: { suspenderet: boolean; suspenderet_til: string | null },
  advarselCount: number,
): BrugerStatus {
  if (erSuspensionAktiv(u)) return "suspenderet";
  if (advarselCount > 0) return "advarsel";
  return "ok";
}

const STYLES: Record<
  Exclude<BrugerStatus, "ok">,
  { klasse: string; prik: string; tekst: string }
> = {
  advarsel: { klasse: "bg-yellow-100 text-yellow-800", prik: "bg-yellow-500", tekst: "Advarsel" },
  suspenderet: { klasse: "bg-red-100 text-red-800", prik: "bg-red-500", tekst: "Suspenderet" },
};

export function StatusBadge({ status }: { status: BrugerStatus }) {
  // Almindelige brugere får intet badge – kun advarsel og suspension fremhæves.
  if (status === "ok") return null;

  const s = STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.klasse}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.prik}`} />
      {s.tekst}
    </span>
  );
}

// Rollebadge: chef = guld, admin = lilla, medarbejder = blå, bruger = grå.
const ROLLE_STYLES: Record<string, { klasse: string; tekst: string }> = {
  chef: { klasse: "bg-amber-100 text-amber-800", tekst: "Chef" },
  admin: { klasse: "bg-purple-100 text-purple-700", tekst: "Admin" },
  medarbejder: { klasse: "bg-blue-100 text-blue-700", tekst: "Medarbejder" },
  bruger: { klasse: "bg-neutral-100 text-neutral-600", tekst: "Bruger" },
};

export function RolleBadge({ rolle }: { rolle: string | null }) {
  const s = ROLLE_STYLES[rolle ?? "bruger"] ?? ROLLE_STYLES.bruger;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.klasse}`}>
      {s.tekst}
    </span>
  );
}
