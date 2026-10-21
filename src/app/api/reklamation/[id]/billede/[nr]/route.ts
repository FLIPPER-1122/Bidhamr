import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { hentSaelgerPakke } from "@/lib/reklamation/saelgerRute";
import { filStoerrelse, tekstSvar } from "@/lib/reklamation/zipSvar";

// Ét billede fra sælgerens reklamationspakke (sælgers pakkebillede eller
// købers skadebillede) - så sælgeren aldrig får et storage-link, hvis sti
// indeholder købers id.
//
// GET /api/reklamation/<id>/billede/<nr>   (nr = 1, 2, ... som i pakken)
//   Hjemmesiden: cookie-login. Appen: Authorization: Bearer <token>.
// Samme adgang som pakken: kun sælgeren og kun mens reklamationen er åben
// (min_reklamationspakke_adgang). Grænse: 600 billeder i timen pr. bruger.

export const dynamic = "force-dynamic";

const MAKS_BYTES = 15 * 1024 * 1024;

const TYPER: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; nr: string }> }) {
  const { id, nr: rawNr } = await ctx.params;
  if (!/^[1-9][0-9]{0,2}$/.test(rawNr)) return tekstSvar(404, "Billedet findes ikke.");
  const res = await hentSaelgerPakke(req, id, "api/reklamation/billede", "billede");
  if (res instanceof Response) return res;

  const fil = res.filer[Number(rawNr) - 1];
  if (!fil) return tekstSvar(404, "Billedet findes ikke.");
  try {
    const admin = createAdminClient();
    // Afvis et for stort billede, før det hentes ind i hukommelsen
    // (storage-metadata); ukendt størrelse tjekkes efter download.
    const kendt = await filStoerrelse(admin, fil.bucket, fil.sti);
    if (kendt !== null && kendt > MAKS_BYTES) return tekstSvar(413, "Billedet er for stort til at blive vist.");
    const { data, error } = await admin.storage.from(fil.bucket).download(fil.sti);
    if (error || !data) return tekstSvar(404, "Billedet kunne ikke hentes.");
    if (data.size > MAKS_BYTES) return tekstSvar(413, "Billedet er for stort til at blive vist.");
    const endelse = (/\.([a-z0-9]{2,5})$/i.exec(fil.filnavn)?.[1] ?? "").toLowerCase();
    const buf = new Uint8Array(await data.arrayBuffer());
    return new NextResponse(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), {
      headers: {
        "Content-Type": TYPER[endelse] ?? "application/octet-stream",
        "Content-Length": String(buf.byteLength),
        "Content-Disposition": `inline; filename="${fil.filnavn}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "api/reklamation/billede", fejl: err, brugerId: res.brugerId });
    return tekstSvar(500, "Billedet kunne ikke hentes. Prøv igen om lidt.");
  }
}
