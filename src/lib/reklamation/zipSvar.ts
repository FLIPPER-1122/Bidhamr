import "server-only";

// Bygger ZIP-svaret med reklamationspakken: oplysninger.txt + sælgers
// pakkebilleder + købers skadebilleder. Bruges af staff-ruten
// (/admin/reklamationer/<id>/billeder) og sælgerens rute
// (/api/reklamation/<id>/billeder). Adgangen er tjekket af kalderen.
//
// Hukommelse: ZIP'en bygges i hukommelsen (stored, ingen komprimering).
// Værn: højst MAKS_BYTES billeder i alt (tjekkes på filstørrelsen, før
// billedet læses), ingen ekstra kopi af den færdige ZIP, og højst
// MAKS_SAMTIDIGE_BRUGER samtidige ZIP'er pr. bruger og MAKS_SAMTIDIGE i alt
// pr. serverinstans.
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PakkeFiler, Reklamationspakke } from "@/lib/reklamation/pakke";
import { lavZip, type ZipFil } from "@/lib/reklamation/zip";

// Højst 50 billeder (20 pakke + 30 sag) - typisk få MB hver.
const MAKS_BYTES = 60 * 1024 * 1024;
const MAKS_SAMTIDIGE_BRUGER = 1;
const MAKS_SAMTIDIGE = 4;

const aktive = new Map<string, number>();
let aktiveIAlt = 0;

export function tekstSvar(status: number, tekst: string) {
  return new NextResponse(tekst, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const FOR_STOR = "Billederne fylder for meget til én ZIP-fil. Hent dem enkeltvis.";

async function byg(admin: SupabaseClient, pakke: Reklamationspakke, filer: PakkeFiler): Promise<NextResponse> {
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
    // Tjek størrelsen, før indholdet læses ind.
    if (bytes + data.size > MAKS_BYTES) return tekstSvar(413, FOR_STOR);
    const buf = new Uint8Array(await data.arrayBuffer());
    bytes += buf.byteLength;
    if (bytes > MAKS_BYTES) return tekstSvar(413, FOR_STOR);
    ud.push({ navn: f.filnavn, data: buf, tid: new Date(f.oprettetKl) });
  }
  const tekst = pakke.tekst + (mangler > 0 ? `\n\nOBS: ${mangler} billede(r) kunne ikke hentes.` : "");
  ud.unshift({ navn: "oplysninger.txt", data: enc.encode(tekst.replace(/\n/g, "\r\n")) });

  const zip = lavZip(ud);
  // Frigiv billederne, før svaret sendes.
  ud.length = 0;
  const spor = (pakke.trackingnummer ?? pakke.reklamation.id.slice(0, 8)).replace(/[^A-Za-z0-9_-]/g, "");
  // Ingen kopi: Buffer-visning på samme hukommelse.
  return new NextResponse(Buffer.from(zip.buffer as ArrayBuffer, zip.byteOffset, zip.byteLength), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.byteLength),
      "Content-Disposition": `attachment; filename="reklamation-${pakke.transportoer}-${spor}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// brugerId: hvem henter (begrænser samtidige ZIP'er pr. bruger).
export async function reklamationZipSvar(
  admin: SupabaseClient,
  pakke: Reklamationspakke,
  filer: PakkeFiler,
  brugerId: string,
): Promise<NextResponse> {
  const mine = aktive.get(brugerId) ?? 0;
  if (mine >= MAKS_SAMTIDIGE_BRUGER || aktiveIAlt >= MAKS_SAMTIDIGE) {
    return tekstSvar(429, "Der bliver allerede hentet en ZIP-fil. Vent, til den er færdig, og prøv igen.");
  }
  aktive.set(brugerId, mine + 1);
  aktiveIAlt++;
  try {
    return await byg(admin, pakke, filer);
  } finally {
    aktiveIAlt--;
    const n = (aktive.get(brugerId) ?? 1) - 1;
    if (n <= 0) aktive.delete(brugerId);
    else aktive.set(brugerId, n);
  }
}
