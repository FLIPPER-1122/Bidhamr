import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { hentSaelgerPakke } from "@/lib/reklamation/saelgerRute";
import { reklamationZipSvar, tekstSvar } from "@/lib/reklamation/zipSvar";

// Sælgerens ZIP med reklamationspakken (oplysninger.txt + egne pakkebilleder
// + købers skadebilleder), så den kan vedhæftes hos fragtfirmaet.
//
// GET /api/reklamation/<id>/billeder
//   Hjemmesiden: cookie-login. Appen: Authorization: Bearer <token>.
// Kun sælgeren, og kun mens reklamationen er åben.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await hentSaelgerPakke(req, id, "api/reklamation/billeder");
  if (res instanceof Response) return res;
  try {
    return await reklamationZipSvar(createAdminClient(), res.pakke, res.filer);
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "api/reklamation/billeder", fejl: err, brugerId: res.brugerId });
    return tekstSvar(500, "Billederne kunne ikke hentes. Prøv igen om lidt.");
  }
}
