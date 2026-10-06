// Klargøring af auktionsbilleder i browseren, før de uploades:
//   1. HEIC/HEIF (iPhone) konverteres til JPEG.
//   2. Billedet nedskaleres, så den længste side højst er MAKS_SIDE px.
//   3. Det gemmes som JPEG med kvalitet JPEG_KVALITET (~80 %).
// Genkodningen fjerner også EXIF-data (fx GPS-position fra telefonen).
//
// HEIC: først prøves browserens egen afkodning (Safari kan selv læse HEIC, og
// iPhone konverterer ofte allerede til JPEG ved upload). Lykkes det ikke,
// hentes biblioteket heic-to (libheif, LGPL-3.0) - kun i den situation, så
// det store bibliotek (~3 MB) ikke belaster alle andre. Vi bruger den
// CSP-venlige udgave "heic-to/csp" (ingen eval; worker via blob:, som
// CSP'en i src/lib/csp.ts tillader).
//
// Resultatet hedder altid "billede.jpg" med type image/jpeg, så
// auktionBilledeSti giver <bruger-id>/<uuid>.jpg (public.auktion_billeder_gyldige).

export const MAKS_SIDE = 2000;
export const JPEG_KVALITET = 0.8;
// Grænse for den fil, brugeren vælger (før komprimering).
export const MAKS_ORIGINAL_MB = 40;

export class BilledFejl extends Error {}

export function erHeic(fil: File): boolean {
  const type = fil.type.toLowerCase();
  return (
    type === "image/heic" ||
    type === "image/heif" ||
    type === "image/heic-sequence" ||
    type === "image/heif-sequence" ||
    /\.(heic|heif)$/i.test(fil.name)
  );
}

export function erBillede(fil: File): boolean {
  return fil.type.startsWith("image/") || erHeic(fil);
}

type Kilde = { billede: CanvasImageSource; bredde: number; hoejde: number; luk: () => void };

async function afkodNativt(blob: Blob): Promise<Kilde | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { billede: bmp, bredde: bmp.width, hoejde: bmp.height, luk: () => bmp.close() };
    } catch {
      // Falder tilbage til <img> nedenfor.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return {
      billede: img,
      bredde: img.naturalWidth,
      hoejde: img.naturalHeight,
      luk: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

async function afkodHeic(fil: File): Promise<Kilde | null> {
  try {
    const { heicTo } = await import("heic-to/csp");
    const bmp = await heicTo({ blob: fil, type: "bitmap" });
    return { billede: bmp, bredde: bmp.width, hoejde: bmp.height, luk: () => bmp.close() };
  } catch (err) {
    console.error("HEIC-konvertering fejlede:", err);
    return null;
  }
}

function tilJpeg(kilde: Kilde, maksSide: number): Promise<Blob> {
  const skala = Math.min(1, maksSide / Math.max(kilde.bredde, kilde.hoejde));
  const b = Math.max(1, Math.round(kilde.bredde * skala));
  const h = Math.max(1, Math.round(kilde.hoejde * skala));
  const canvas = document.createElement("canvas");
  canvas.width = b;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new BilledFejl("Billedet kunne ikke behandles."));
  // Hvid baggrund, så gennemsigtige PNG'er ikke bliver sorte i JPEG.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, b, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(kilde.billede, 0, 0, b, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new BilledFejl("Billedet kunne ikke behandles."))),
      "image/jpeg",
      JPEG_KVALITET,
    );
  });
}

// Returnerer en komprimeret JPEG-fil. Kaster BilledFejl med en dansk besked.
// maksSide: længste side i px (profilbilleder bruger en mindre værdi).
export async function klargoerBillede(fil: File, maksSide: number = MAKS_SIDE): Promise<File> {
  if (!erBillede(fil)) {
    throw new BilledFejl(`"${fil.name}" er ikke et billede.`);
  }
  if (fil.size > MAKS_ORIGINAL_MB * 1024 * 1024) {
    throw new BilledFejl(`"${fil.name}" er for stort (over ${MAKS_ORIGINAL_MB} MB).`);
  }

  let kilde = await afkodNativt(fil);
  if (!kilde && erHeic(fil)) kilde = await afkodHeic(fil);
  if (!kilde) {
    throw new BilledFejl(
      erHeic(fil)
        ? `"${fil.name}" kunne ikke læses. Prøv at gemme billedet som JPEG og vælg det igen.`
        : `"${fil.name}" kunne ikke læses. Brug et JPEG-, PNG- eller HEIC-billede.`,
    );
  }

  try {
    const blob = await tilJpeg(kilde, maksSide);
    return new File([blob], "billede.jpg", { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    kilde.luk();
  }
}
