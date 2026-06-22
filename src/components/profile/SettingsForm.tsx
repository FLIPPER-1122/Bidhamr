"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SettingsForm({
  brugerId,
  navn: initialNavn,
  telefon: initialTelefon,
  email,
}: {
  brugerId: string;
  navn: string;
  telefon: string | null;
  email: string;
}) {
  const router = useRouter();
  const [navn, setNavn] = useState(initialNavn);
  const [telefon, setTelefon] = useState(initialTelefon ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setGemt(false);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("users")
      .update({ navn, telefon: telefon || null })
      .eq("id", brugerId);

    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setGemt(true);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-sm space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-neutral-900">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          disabled
          className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-2.5 text-sm text-neutral-500"
        />
      </div>

      <div>
        <label htmlFor="navn" className="block text-sm font-medium text-neutral-900">
          Navn
        </label>
        <input
          id="navn"
          type="text"
          required
          value={navn}
          onChange={(e) => setNavn(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>

      <div>
        <label htmlFor="telefon" className="block text-sm font-medium text-neutral-900">
          Telefon
        </label>
        <input
          id="telefon"
          type="tel"
          value={telefon}
          onChange={(e) => setTelefon(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {gemt && (
        <div className="border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700">
          Profil opdateret.
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
      >
        {loading ? "Gemmer…" : "Gem ændringer"}
      </button>
    </form>
  );
}
