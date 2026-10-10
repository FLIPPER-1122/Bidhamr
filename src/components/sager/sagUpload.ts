// Klientside: komprimering og upload af billeder direkte til Supabase
// Storage. Bruges til sagsbilleder (bucket 'sag-billeder', køberens mappe) og
// pakkebilleder (bucket 'pakke-billeder', sælgerens mappe). Stien laves med
// sagBilledeSti() (<bruger-id>/<handel-id>/<uuid>.<endelse>), og der uploades
// med { upsert: false } - storage-policyerne tillader kun upload i brugerens
// egen mappe, og der er ingen update-policy.
import { BilledFejl, klargoerBillede } from "@/lib/billedBehandling";
import {
  SAG_BILLEDTYPER,
  SAG_BUCKET,
  SAG_MAKS_BILLEDSTOERRELSE,
  sagBilledeSti,
  type SagBilledeKategori,
} from "@/lib/sager";

export type ValgtBillede<K extends string = SagBilledeKategori> = {
  id: string;
  fil: File;
  kategori: K;
  // Object-URL til forhåndsvisning (frigives, når billedet fjernes).
  preview: string;
  // Sat, når billedet er uploadet - så det ikke uploades igen ved et nyt forsøg.
  sti?: string;
};

export const ACCEPT = SAG_BILLEDTYPER.join(",");

const ENDELSE_TIL_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
};

// Nogle browsere (fx Chrome på Windows) giver HEIC-filer en tom type.
export function filType(fil: File): string | null {
  const t = (fil.type || "").toLowerCase();
  if ((SAG_BILLEDTYPER as readonly string[]).includes(t)) return t;
  const endelse = fil.name.split(".").pop()?.toLowerCase() ?? "";
  return ENDELSE_TIL_TYPE[endelse] ?? null;
}

// Genkoder billedet med samme hjælpefunktion som auktionsbilleder
// (src/lib/billedBehandling.ts): HEIC/HEIF konverteres, billedet skaleres ned
// til højst 2000 px og gemmes altid som JPEG. Genkodningen fjerner EXIF-data
// som GPS-position - originalen uploades aldrig (heller ikke HEIC).
// Kaster BilledFejl med en dansk besked, hvis billedet ikke kan læses.
export async function komprimer(fil: File): Promise<{ data: Blob; type: string }> {
  if (!filType(fil)) throw new BilledFejl(UPLOAD_FEJL.ugyldig_type);
  const jpeg = await klargoerBillede(fil);
  return { data: jpeg, type: jpeg.type };
}

export const UPLOAD_FEJL = {
  for_stor: "Et billede er for stort (højst 10 MB). Prøv med et mindre billede.",
  ugyldig_type: "Billedet skal være JPG, PNG, HEIC eller WEBP.",
  upload: "Et billede kunne ikke uploades. Tjek din forbindelse, og prøv igen.",
} as const;

// Uploader de billeder, der ikke allerede er uploadet. onFremskridt kaldes
// efter hvert billede. Returnerer listen med stier, eller en fejltekst.
// brugerId er den indloggede brugers id (mappen i bucket'en).
export async function uploadBilleder<K extends string>(
  brugerId: string,
  tradeId: string,
  billeder: ValgtBillede<K>[],
  onFremskridt: (faerdige: number, ialt: number, opdateret: ValgtBillede<K>[]) => void,
  bucket: string = SAG_BUCKET,
): Promise<{ billeder: ValgtBillede<K>[] } | { fejl: string; billeder: ValgtBillede<K>[] }> {
  // Supabase-klienten hentes først ved upload (ikke med handelssidens første
  // JavaScript). Kan den ikke hentes, er det som en mislykket upload.
  let supabase;
  try {
    supabase = (await import("@/lib/supabase/client")).createClient();
  } catch {
    return { fejl: UPLOAD_FEJL.upload, billeder };
  }
  const ud = [...billeder];
  const ialt = ud.length;
  let faerdige = ud.filter((b) => b.sti).length;
  onFremskridt(faerdige, ialt, ud);

  for (let i = 0; i < ud.length; i++) {
    if (ud[i].sti) continue;
    let data: Blob;
    let type: string;
    try {
      ({ data, type } = await komprimer(ud[i].fil));
    } catch (err) {
      return {
        fejl: err instanceof BilledFejl ? err.message : UPLOAD_FEJL.ugyldig_type,
        billeder: ud,
      };
    }
    if (data.size > SAG_MAKS_BILLEDSTOERRELSE) return { fejl: UPLOAD_FEJL.for_stor, billeder: ud };
    const sti = sagBilledeSti(brugerId, tradeId, type);
    if (!sti) return { fejl: UPLOAD_FEJL.ugyldig_type, billeder: ud };
    const { error } = await supabase.storage
      .from(bucket)
      .upload(sti, data, { upsert: false, contentType: type, cacheControl: "3600" });
    if (error) {
      console.error(`Upload af billede til ${bucket} fejlede:`, error.message);
      return { fejl: UPLOAD_FEJL.upload, billeder: ud };
    }
    ud[i] = { ...ud[i], sti };
    faerdige++;
    onFremskridt(faerdige, ialt, ud);
  }
  return { billeder: ud };
}
