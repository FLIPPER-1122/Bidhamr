// Klientside: komprimering og upload af sagsbilleder direkte til Supabase
// Storage (bucket 'sag-billeder', privat). Stien laves med sagBilledeSti(),
// og der uploades med { upsert: false } - storage-policyen tillader kun
// upload i køberens egen mappe på en handel, han er køber på.
import { createClient } from "@/lib/supabase/client";
import {
  SAG_BILLEDTYPER,
  SAG_BUCKET,
  SAG_MAKS_BILLEDSTOERRELSE,
  sagBilledeSti,
  type SagBilledeKategori,
} from "@/lib/sager";

export type ValgtBillede = {
  id: string;
  fil: File;
  kategori: SagBilledeKategori;
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

const MAKS_KANT = 2000;
const KVALITET = 0.85;

// Skalerer billedet ned (højst 2000 px på den længste led) og gemmer som JPEG.
// Fjerner samtidig metadata som GPS-position. Kan browseren ikke læse
// billedet (fx HEIC i Chrome), sendes originalen.
export async function komprimer(fil: File): Promise<{ data: Blob; type: string }> {
  const type = filType(fil);
  if (!type) throw new Error("ugyldig_type");
  if (type === "image/heic" || type === "image/heif") return { data: fil, type };
  try {
    const bitmap = await createImageBitmap(fil, { imageOrientation: "from-image" });
    const skala = Math.min(1, MAKS_KANT / Math.max(bitmap.width, bitmap.height));
    const b = Math.round(bitmap.width * skala);
    const h = Math.round(bitmap.height * skala);
    const canvas = document.createElement("canvas");
    canvas.width = b;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return { data: fil, type };
    }
    // Hvid baggrund, så gennemsigtige PNG'er ikke bliver sorte som JPEG.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, b, h);
    ctx.drawImage(bitmap, 0, 0, b, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", KVALITET));
    if (!blob) return { data: fil, type };
    // Bliver det ikke mindre, og er originalen ikke for stor, beholdes den.
    if (blob.size >= fil.size && skala === 1) return { data: fil, type };
    return { data: blob, type: "image/jpeg" };
  } catch {
    return { data: fil, type };
  }
}

export const UPLOAD_FEJL = {
  for_stor: "Et billede er for stort (højst 10 MB). Prøv med et mindre billede.",
  ugyldig_type: "Billedet skal være JPG, PNG, HEIC eller WEBP.",
  upload: "Et billede kunne ikke uploades. Tjek din forbindelse, og prøv igen.",
} as const;

// Uploader de billeder, der ikke allerede er uploadet. onFremskridt kaldes
// efter hvert billede. Returnerer listen med stier, eller en fejltekst.
export async function uploadBilleder(
  koeberId: string,
  tradeId: string,
  billeder: ValgtBillede[],
  onFremskridt: (faerdige: number, ialt: number, opdateret: ValgtBillede[]) => void,
): Promise<{ billeder: ValgtBillede[] } | { fejl: string; billeder: ValgtBillede[] }> {
  const supabase = createClient();
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
    } catch {
      return { fejl: UPLOAD_FEJL.ugyldig_type, billeder: ud };
    }
    if (data.size > SAG_MAKS_BILLEDSTOERRELSE) return { fejl: UPLOAD_FEJL.for_stor, billeder: ud };
    const sti = sagBilledeSti(koeberId, tradeId, type);
    if (!sti) return { fejl: UPLOAD_FEJL.ugyldig_type, billeder: ud };
    const { error } = await supabase.storage
      .from(SAG_BUCKET)
      .upload(sti, data, { upsert: false, contentType: type, cacheControl: "3600" });
    if (error) {
      console.error("Upload af sagsbillede fejlede:", error.message);
      return { fejl: UPLOAD_FEJL.upload, billeder: ud };
    }
    ud[i] = { ...ud[i], sti };
    faerdige++;
    onFremskridt(faerdige, ialt, ud);
  }
  return { billeder: ud };
}
