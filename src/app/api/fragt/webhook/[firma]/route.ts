import { NextRequest, NextResponse, after } from "next/server";
import { adapterFor, erFragtfirmaNavn } from "@/lib/fragt";
import {
  findForsendelseInfo,
  registrerForsendelseshaendelse,
  registrerUkendteKoder,
  udfoerHandelseffekterFor,
} from "@/lib/fragt/server";
import { logDriftFejl } from "@/lib/drift";

// Webhook fra fragtfirmaet: /api/fragt/webhook/test | gls | shipmondo.
// Shipmondo: "Shipment Monitor" (latest + delivered) for DAO, GLS og PostNord.
// Signaturen (JWT HS256 med SHIPMONDO_WEBHOOK_NOEGLE) tjekkes i adapteren,
// før noget læses. Ukendte statuskoder gemmes og ændrer aldrig status, og en
// hændelse, hvis transportør ikke passer med forsendelsens, gemmes ikke.
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

  if (resultat.ukendte && resultat.ukendte.length > 0) {
    await registrerUkendteKoder(firma, adapter.visningsnavn, resultat.ukendte);
  }

  let gemt = 0;
  let ukendte = 0;
  let forkertTransportoer = 0;
  const nye = new Set<string>();
  for (const h of resultat.haendelser) {
    try {
      const info = await findForsendelseInfo(firma, {
        forsendelsesId: h.forsendelsesId,
        sporingsnummer: h.sporingsnummer,
      });
      if (!info) {
        ukendte++;
        continue;
      }
      const id = info.id;
      // Værn: fragtfirmaets transportør skal passe med forsendelsens (leveret
      // styrer frigivelsen af penge). Ellers gemmes intet, og drift får besked.
      if (h.transportoer && info.transportoer && h.transportoer !== info.transportoer) {
        forkertTransportoer++;
        await logDriftFejl({
          kilde: "webhook",
          sti: `/api/fragt/webhook/${firma}`,
          hvor: "Fragt: forkert transportør",
          fejl: `Hændelsen (${h.type}) for forsendelse ${id} kom fra ${h.transportoer}, men forsendelsen er sendt med ${info.transportoer}. Den er ikke gemt.`,
        });
        continue;
      }
      // Den endelige hændelse afhænger af forsendelsen (Shipmondo: retur-
      // tekst efter type, 'leveret' kun på det rigtige sted). En foreløbig
      // hændelse gemmes aldrig uden vurdering.
      const endelige = adapter.vurderWebhookHaendelse
        ? adapter.vurderWebhookHaendelse(h, { type: info.type, steder: info.steder })
        : (h.raa as { vurderes?: unknown } | null | undefined)?.vurderes === true
          ? []
          : [h];
      for (const e of endelige) {
        const { ny } = await registrerForsendelseshaendelse(id, e, "webhook", { effekter: false });
        if (ny) {
          gemt++;
          nye.add(id);
        }
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
  return NextResponse.json({ ok: true, gemt, ukendte, forkertTransportoer });
}
