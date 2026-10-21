import { type NextRequest } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { hentReklamationspakke } from "@/lib/reklamation/pakke";
import { reklamationZipSvar, tekstSvar } from "@/lib/reklamation/zipSvar";

// Staff: alle billeder til en reklamation som én ZIP (sælgers pakkebilleder +
// købers skadebilleder + oplysninger.txt).
//
// GET /admin/reklamationer/<id>/billeder
// KUN staff (medarbejder+) med to-trins-login (assertRole -> hentStaffAdgang).
// Alle andre får 404. Ingen ændringer. Sælgerens udgave:
// /api/reklamation/<id>/billeder.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let adgang: Awaited<ReturnType<typeof assertRole>>;
  try {
    adgang = await assertRole("medarbejder");
  } catch {
    return tekstSvar(404, "Siden findes ikke.");
  }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return tekstSvar(404, "Reklamationen findes ikke.");

  try {
    const res = await hentReklamationspakke(adgang.admin, id.toLowerCase(), "staff");
    if (!res) return tekstSvar(404, "Reklamationen findes ikke.");
    return await reklamationZipSvar(adgang.admin, res.pakke, res.filer);
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "admin/reklamationer/billeder", fejl: err, brugerId: adgang.userId });
    return tekstSvar(500, "Billederne kunne ikke hentes. Prøv igen om lidt.");
  }
}
