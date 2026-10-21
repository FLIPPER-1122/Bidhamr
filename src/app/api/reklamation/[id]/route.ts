import { NextResponse, type NextRequest } from "next/server";
import { hentSaelgerPakke } from "@/lib/reklamation/saelgerRute";

// Sælgerens reklamationspakke som JSON (felter + signerede billed-links,
// 1 time) - til handelssiden og appen.
//
// GET /api/reklamation/<id>
//   Hjemmesiden: cookie-login. Appen: Authorization: Bearer <token>.
// Kun sælgeren på reklamationen, og kun mens den er åben (afventer_saelger,
// anmeldt). Ingen købers e-mail/telefon - modtageren som på fragtlabelen.
// Svar: 200 { pakke } | 401 | 404 | 429 | 500.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await hentSaelgerPakke(req, id, "api/reklamation");
  if (res instanceof Response) return res;
  return NextResponse.json(
    { pakke: res.pakke, zip: `/api/reklamation/${res.pakke.reklamation.id}/billeder` },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
