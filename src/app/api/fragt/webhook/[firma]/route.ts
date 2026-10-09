import { NextRequest, NextResponse, after } from "next/server";
import { adapterFor, erFragtfirmaNavn } from "@/lib/fragt";
import {
  findForsendelse,
  registrerForsendelseshaendelse,
  udfoerHandelseffekterFor,
} from "@/lib/fragt/server";
import { logDriftFejl } from "@/lib/drift";

// Webhook fra fragtfirmaet: /api/fragt/webhook/test | gls | shipmondo.
// Adapteren verificerer signaturen (fail closed) og oversætter til
// normaliserede hændelser. Hændelserne gemmes idempotent - samme hændelse
// to gange (eller via både webhook og sporings-cron) giver ingen dobbelt
// effekt. Ukendte forsendelser svares med 200, så fragtfirmaet ikke prøver
// igen i det uendelige.
// Svaret skal komme hurtigt (Shipmondo: 200 inden for 3 sekunder): ruten gemmer
// kun hændelserne; beskeder (fx "Pakken er kommet frem") sendes bagefter med
// after(), og fragt-cron'en (hvert 5. minut) sender dem, der mangler.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Højst 64 KB body. Content-Length tjekkes, før body'en læses, og body'en
// læses derefter med et loft (Content-Length kan mangle eller lyve).
const MAKS_BYTES = 64 * 1024;

const forStor = () => NextResponse.json({ fejl: "For stor" }, { status: 413 });

// Læser body'en som bytes og stopper, så snart loftet overskrides.
async function laesBegraenset(req: NextRequest): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const laeser = req.body.getReader();
  const dele: Uint8Array[] = [];
  let iAlt = 0;
  for (;;) {
    const { done, value } = await laeser.read();
    if (done) break;
    iAlt += value.byteLength;
    if (iAlt > MAKS_BYTES) {
      await laeser.cancel().catch(() => {});
      return null;
    }
    dele.push(value);
  }
  const ud = new Uint8Array(iAlt);
  let pos = 0;
  for (const d of dele) {
    ud.set(d, pos);
    pos += d.byteLength;
  }
  return ud;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ firma: string }> }) {
  const { firma } = await params;
  const adapter = erFragtfirmaNavn(firma) ? adapterFor(firma) : null;
  if (!adapter) return NextResponse.json({ fejl: "Ukendt fragtfirma" }, { status: 404 });

  const laengde = req.headers.get("content-length");
  if (laengde !== null) {
    if (!/^\d{1,12}$/.test(laengde.trim())) {
      return NextResponse.json({ fejl: "Ugyldig Content-Length" }, { status: 400 });
    }
    if (Number(laengde.trim()) > MAKS_BYTES) return forStor();
  }

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await laesBegraenset(req);
  } catch {
    return NextResponse.json({ fejl: "Kunne ikke læse webhooken" }, { status: 400 });
  }
  if (!body) return forStor();

  // Adapteren læser selv body'en (signaturen beregnes på de rå bytes), så den
  // får en ny Request med de allerede læste bytes.
  const kopi = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: body.byteLength > 0 ? body : undefined,
  });

  let resultat;
  try {
    resultat = await adapter.fortolkWebhook(kopi);
  } catch (err) {
    await logDriftFejl({ kilde: "webhook", sti: `/api/fragt/webhook/${firma}`, hvor: "Fragt: fortolk", fejl: err });
    return NextResponse.json({ fejl: "Kunne ikke læse webhooken" }, { status: 400 });
  }
  if (!resultat.ok) {
    return NextResponse.json({ fejl: resultat.fejl }, { status: resultat.status });
  }

  let gemt = 0;
  let ukendte = 0;
  const nye = new Set<string>();
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
      const { ny } = await registrerForsendelseshaendelse(id, h, "webhook", { effekter: false });
      if (ny) {
        gemt++;
        nye.add(id);
      }
    } catch (err) {
      // Databasefejl: svar 500, så fragtfirmaet leverer igen (idempotent).
      await logDriftFejl({ kilde: "webhook", sti: `/api/fragt/webhook/${firma}`, hvor: "Fragt: registrér", fejl: err });
      return NextResponse.json({ fejl: "Midlertidig fejl" }, { status: 500 });
    }
  }
  if (nye.size > 0) {
    after(async () => {
      for (const id of nye) await udfoerHandelseffekterFor(id);
    });
  }
  return NextResponse.json({ ok: true, gemt, ukendte });
}
