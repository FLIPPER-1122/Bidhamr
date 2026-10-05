// Upload af klargjorte auktionsbilleder (browser). Gemte billeder beholder
// deres URL; nye uploades til <bruger-id>/<uuid>.jpg i auktion-billeder.
import type { createClient } from "@/lib/supabase/client";
import { auktionBilledeSti } from "@/lib/auktionRegler";

export type UploadBillede = { url: string } | { fil: File };

export async function uploadAuktionsbilleder(
  supabase: ReturnType<typeof createClient>,
  brugerId: string,
  billeder: UploadBillede[],
  fremskridt?: (nr: number, ialt: number) => void,
): Promise<string[]> {
  const urls: string[] = [];
  const nye = billeder.filter((b) => "fil" in b).length;
  let nr = 0;
  for (const b of billeder) {
    if ("url" in b) {
      urls.push(b.url);
      continue;
    }
    nr += 1;
    fremskridt?.(nr, nye);
    const sti = auktionBilledeSti(brugerId, b.fil);
    const { error } = await supabase.storage
      .from("auktion-billeder")
      .upload(sti, b.fil, { contentType: "image/jpeg", cacheControl: "31536000" });
    if (error) {
      console.error("Billede-upload fejlede:", error.message);
      throw new Error("Et billede kunne ikke uploades. Tjek din forbindelse, og prøv igen.");
    }
    urls.push(supabase.storage.from("auktion-billeder").getPublicUrl(sti).data.publicUrl);
  }
  return urls;
}
