"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

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
    if (!file) return;

    setLoading(true);
    setError(null);

    const supabase = createClient();
    const filnavn = `${brugerId}/avatar-${Date.now()}-${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from("avatarer")
      .upload(filnavn, file);

    if (uploadError) {
      setError(`Upload fejlede: ${uploadError.message}`);
      setLoading(false);
      return;
    }

    const { data: publicUrlData } = supabase.storage
      .from("avatarer")
      .getPublicUrl(filnavn);

    const { error: updateError } = await supabase
      .from("users")
      .update({ avatar_url: publicUrlData.publicUrl })
      .eq("id", brugerId);

    setLoading(false);

    if (updateError) {
      setError(`Kunne ikke gemme profilbillede: ${updateError.message}`);
      return;
    }

    router.refresh();
  }

  return (
    <div>
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={loading}
        className="group relative block h-24 w-24 overflow-hidden rounded-full border border-neutral-200 bg-neutral-100"
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt="Profilbillede"
            className="h-full w-full object-cover"
          />
        ) : (
          <svg
            viewBox="0 0 24 24"
            className="h-full w-full p-5 text-neutral-400"
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

        <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs font-medium text-white opacity-0 group-hover:opacity-100">
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

      {error && <p className="mt-2 max-w-xs text-xs text-red-600">{error}</p>}
    </div>
  );
}
