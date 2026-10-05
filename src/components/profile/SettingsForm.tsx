"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import AvatarUpload from "@/components/profile/AvatarUpload";

export default function SettingsForm({
  brugerId,
  navn: initialNavn,
  telefon: initialTelefon,
  adresse: initialAdresse,
  email,
  avatarUrl,
}: {
  brugerId: string;
  navn: string;
  telefon: string | null;
  adresse: string | null;
  email: string;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const [navn, setNavn] = useState(initialNavn);
  const [telefon, setTelefon] = useState(initialTelefon ?? "");
  const [adresse, setAdresse] = useState(initialAdresse ?? "");
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
      .update({ navn, telefon: telefon.trim() || null, adresse: adresse.trim() || null })
      .eq("id", brugerId);

    setLoading(false);

    if (updateError) {
      console.error("Profil kunne ikke gemmes:", updateError);
      setError(
        updateError.code === "BHN01"
          ? 'Navnet må ikke indeholde "BidHamr".'
          : "Dine oplysninger kunne ikke gemmes. Prøv igen om lidt."
      );
      return;
    }

    setGemt(true);
    router.refresh();
  }

  return (
    <div className="max-w-sm space-y-6">
      <div>
        <label className="block text-sm font-medium text-neutral-900">
          Profilbillede
        </label>
        <div className="mt-1.5">
          <AvatarUpload brugerId={brugerId} avatarUrl={avatarUrl} />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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

      <div>
        <label htmlFor="adresse" className="block text-sm font-medium text-neutral-900">
          Adresse til afhentning <span className="font-normal text-tekst-svag">(valgfri)</span>
        </label>
        <textarea
          id="adresse"
          rows={2}
          maxLength={300}
          value={adresse}
          onChange={(e) => setAdresse(e.target.value)}
          placeholder="Vejnavn og nummer, postnummer og by"
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>

      <p className="text-xs text-tekst-svag">
        Din e-mail, dit telefonnummer og din adresse vises aldrig offentligt. Sælger du en vare til
        afhentning, kan køberen se din adresse og dit telefonnummer, når varen er betalt – og kun
        indtil den er hentet.
      </p>

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
        className="rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
      >
        {loading ? "Gemmer…" : "Gem ændringer"}
      </button>
      </form>
    </div>
  );
}
