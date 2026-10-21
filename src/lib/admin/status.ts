import "server-only";

import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { harMindstRolle, type StaffRole } from "@/lib/adminAuth";
import { hentNoedstopTal, hentStaffTal, type NoedstopTal, type StaffTal } from "@/lib/admin/taellere";
import { IKKE_HENTET, hentLamper, type Lampe } from "@/lib/admin/lamper";
import { beregnStatus, koePunkter, type Status, type StatusPunkt } from "@/lib/admin/statuslinje";

// ÉN beregning af statuslinjen, som både menuens lille lampe og forsidens
// brede linje bruger (cache() deler den i samme forespørgsel). Med:
//   - nødstop (alle roller - alle skal kunne svare brugerne)
//   - røde og gule systemlamper inkl. Healthchecks (kun admin og chef)
//   - køerne (DSA, sager, betalingsfejl)
// Kaldes kun efter rolletjekket i layoutet/siden.

export type AdminStatus = {
  status: Status;
  lamper: Lampe[];
  noedstop: NoedstopTal;
  tal: StaffTal;
};

export const hentAdminStatus = cache(async (rolle: StaffRole): Promise<AdminStatus> => {
  const erAdmin = harMindstRolle(rolle, "admin");
  const [tal, noedstop] = await Promise.all([hentStaffTal(), hentNoedstopTal()]);
  const lamper = (erAdmin ? await hentLamper(createAdminClient(), { noedstop }) : []).map((l) =>
    // Kun chefen kan åbne Penge og Fakturaer.
    l.navn === "Daglig afstemning" && rolle === "chef"
      ? { ...l, href: "/admin/penge" }
      : l.navn === "Fakturaer" && rolle === "chef"
        ? { ...l, href: "/admin/fakturaer" }
        : l,
  );

  const noedstopPunkt: StatusPunkt[] = noedstop.stoppet
    ? [
        {
          tone: "roed",
          tekst: `${noedstop.udbetalinger ? "Udbetalinger" : "Nye betalinger"} stoppet (nødstop)`,
          href: rolle === "chef" ? "/admin/penge" : "/admin",
        },
      ]
    : [];
  // Nødstop-lampen er allerede med som punkt ovenfor.
  const lampePunkter: StatusPunkt[] = lamper
    .filter((l) => (l.tone === "roed" || l.tone === "gul") && l.navn !== "Nødstop")
    .map((l) => ({ tone: l.tone as "roed" | "gul", tekst: l.statusTekst ?? `${l.navn}: ${l.tekst}`, href: l.href ?? "/admin/drift" }));

  const status = beregnStatus(
    [
      ...noedstopPunkt,
      ...lampePunkter.filter((p) => p.tone === "roed"),
      ...koePunkter({
        dsaOverskredet: tal.dsaOverskredet,
        dsa: tal.dsa,
        sager: tal.sager,
        betalinger: tal.betalinger,
        reklamationStille: tal.reklamationStille,
        reklamationSagAendret: tal.reklamationSagAendret,
        ekstraFragtIndsigelser: tal.ekstraFragtIndsigelser,
      }),
      ...lampePunkter.filter((p) => p.tone === "gul"),
    ],
    // "Alt kører" kun, når alle lamper faktisk kunne hentes.
    { systemerTjekket: erAdmin && !lamper.some((l) => l.tekst === IKKE_HENTET) },
  );
  return { status, lamper, noedstop, tal };
});
