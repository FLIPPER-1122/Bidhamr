import "server-only";

// Bygger ZIP-svaret med reklamationspakken: oplysninger.txt + sælgers
// pakkebilleder + købers skadebilleder. Bruges af staff-ruten
// (/admin/reklamationer/<id>/billeder) og sælgerens rute
// (/api/reklamation/<id>/billeder). Adgangen er tjekket af kalderen.
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PakkeFiler, Reklamationspakke } from "@/lib/reklamation/pakke";
import { lavZip, type ZipFil } from "@/lib/reklamation/zip";

// Værn mod en meget stor ZIP i hukommelsen.
const MAKS_BYTES = 150 * 1024 * 1024;

export function tekstSvar(status: number, tekst: string) {
  return new NextResponse(tekst, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function reklamationZipSvar(
  admin: SupabaseClient,
  pakke: Reklamationspakke,
  filer: PakkeFiler,
): Promise<NextResponse> {
  const enc = new TextEncoder();
  const ud: ZipFil[] = [];
  let bytes = 0;
  let mangler = 0;
  for (const f of filer) {
    const { data, error } = await admin.storage.from(f.bucket).download(f.sti);
    if (error || !data) {
      mangler++;
      continue;
    }
    const buf = new Uint8Array(await data.arrayBuffer());
    bytes += buf.length;
    if (bytes > MAKS_BYTES) return tekstSvar(413, "Billederne fylder for meget til én ZIP-fil. Hent dem enkeltvis.");
    ud.push({ navn: f.filnavn, data: buf, tid: new Date(f.oprettetKl) });
  }
  const tekst = pakke.tekst + (mangler > 0 ? `\n\nOBS: ${mangler} billede(r) kunne ikke hentes.` : "");
  ud.unshift({ navn: "oplysninger.txt", data: enc.encode(tekst.replace(/\n/g, "\r\n")) });

  const zip = lavZip(ud);
  const spor = (pakke.trackingnummer ?? pakke.reklamation.id.slice(0, 8)).replace(/[^A-Za-z0-9_-]/g, "");
  return new NextResponse(Buffer.from(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="reklamation-${pakke.transportoer}-${spor}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
