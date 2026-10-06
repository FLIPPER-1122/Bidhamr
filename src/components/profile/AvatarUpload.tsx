"use client";

import Image from "next/image";
import { kanOptimeres } from "@/lib/billedUrl";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { BilledFejl, klargoerBillede } from "@/lib/billedBehandling";

// Profilbilleder vises højst ~100 px; 800 px er rigeligt og holder filen lille.
const AVATAR_MAKS_SIDE = 800;

// Stien i avatarer-bucketen for en offentlig URL, hvis den ligger i brugerens egen mappe.
function avatarSti(url: string | null, brugerId: string): string | null {
  if (!url) return null;
  const markoer = "/storage/v1/object/public/avatarer/";
  const i = url.indexOf(markoer);
  if (i < 0) return null;
  const sti = decodeURIComponent(url.slice(i + markoer.length).split("?")[0]);
  return sti.startsWith(`${brugerId}/`) && !sti.includes("..") ? sti : null;
}

export default function AvatarUpload({
  brugerId,
  avatarUrl,
}: {
  brugerId: string;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Samme fil kan vælges igen efter en fejl.
    e.target.value = "";
    if (!file) return;

    setLoading(true);
    setError(null);

    try {
      // Genkodes som JPEG i browseren (som auktionsbilleder): fjerner EXIF,
      // fx GPS-position fra telefonen, og holder filen under bucketens 2 MB.
      let klar: File;
      try {
        klar = await klargoerBillede(file, AVATAR_MAKS_SIDE);
      } catch (err) {
        setError(err instanceof BilledFejl ? err.message : "Billedet kunne ikke behandles. Prøv et andet billede.");
        return;
      }

      const supabase = createClient();
      // <bruger-id>/<uuid>.jpg - filnavnet fra brugerens enhed bruges ikke.
      const filnavn = `${brugerId}/${crypto.randomUUID()}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from("avatarer")
        .upload(filnavn, klar, { contentType: "image/jpeg", cacheControl: "31536000" });

      if (uploadError) {
        console.error("Profilbillede: upload fejlede:", uploadError.message);
        setError("Billedet kunne ikke uploades. Tjek din forbindelse, og prøv igen.");
        return;
      }

      const { data: publicUrlData } = supabase.storage
        .from("avatarer")
        .getPublicUrl(filnavn);

      const { error: updateError } = await supabase
        .from("users")
        .update({ avatar_url: publicUrlData.publicUrl })
        .eq("id", brugerId);

      if (updateError) {
        console.error("Profilbillede: kunne ikke gemmes:", updateError.message);
        setError("Profilbilledet kunne ikke gemmes. Prøv igen om lidt.");
        return;
      }

      // Det gamle billede ryddes op, så mappen ikke rammer loftet på antal
      // filer (storage-policyen avatarer_insert_own). Fejl her er ligegyldige.
      const gammelSti = avatarSti(avatarUrl, brugerId);
      if (gammelSti && gammelSti !== filnavn) {
        await supabase.storage.from("avatarer").remove([gammelSti]).catch(() => undefined);
      }

      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={loading}
        aria-label={avatarUrl ? "Skift profilbillede" : "Tilføj profilbillede"}
        aria-busy={loading || undefined}
        className="group relative block h-24 w-24 overflow-hidden rounded-full border border-kant bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt=""
            fill
            sizes="96px"
            unoptimized={!kanOptimeres(avatarUrl)}
            className="object-cover"
          />
        ) : (
          <svg
            viewBox="0 0 24 24"
            className="h-full w-full p-5 text-groen-mork"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
            />
          </svg>
        )}

        <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs font-medium text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
          {loading ? "Uploader…" : "Skift billede"}
        </span>
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {error && <p className="mt-2 max-w-xs text-xs text-fejl-tekst">{error}</p>}
    </div>
  );
}
