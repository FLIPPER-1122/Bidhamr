import { NextRequest, NextResponse } from "next/server";
import { adapterFor, erFragtfirmaNavn } from "@/lib/fragt";
import { findForsendelse, registrerForsendelseshaendelse } from "@/lib/fragt/server";
import { logDriftFejl } from "@/lib/drift";

// Webhook fra fragtfirmaet: /api/fragt/webhook/test | gls | shipmondo.
// Adapteren verificerer signaturen (fail closed) og oversætter til
// normaliserede hændelser. Hændelserne gemmes idempotent - samme hændelse
// to gange (eller via både webhook og sporings-cron) giver ingen dobbelt
// effekt. Ukendte forsendelser svares med 200, så fragtfirmaet ikke prøver
// igen i det uendelige.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ firma: string }> }) {
  const { firma } = await params;
  const adapter = erFragtfirmaNavn(firma) ? adapterFor(firma) : null;
  if (!adapter) return NextResponse.json({ fejl: "Ukendt fragtfirma" }, { status: 404 });

  let resultat;
  try {
    resultat = await adapter.fortolkWebhook(req);
  } catch (err) {
    await logDriftFejl({ kilde: "webhook", sti: `/api/fragt/webhook/${firma}`, hvor: "Fragt: fortolk", fejl: err });
    return NextResponse.json({ fejl: "Kunne ikke læse webhooken" }, { status: 400 });
  }
  if (!resultat.ok) {
    return NextResponse.json({ fejl: resultat.fejl }, { status: resultat.status });
  }

  let gemt = 0;
  let ukendte = 0;
  for (const h of resultat.haendelser) {
    try {
      const id = await findForsendelse(firma, {
        forsendelsesId: h.forsendelsesId,
        sporingsnummer: h.sporingsnummer,
      });
      if (!id) {
        ukendte++;
        continue;
      }
      const { ny } = await registrerForsendelseshaendelse(id, h, "webhook");
      if (ny) gemt++;
    } catch (err) {
      // Databasefejl: svar 500, så fragtfirmaet leverer igen (idempotent).
      await logDriftFejl({ kilde: "webhook", sti: `/api/fragt/webhook/${firma}`, hvor: "Fragt: registrér", fejl: err });
      return NextResponse.json({ fejl: "Midlertidig fejl" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, gemt, ukendte });
}
