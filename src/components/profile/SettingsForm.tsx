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
          : updateError.code === "BHN02"
            ? "Navnet må ikke indeholde en e-mail, et telefonnummer eller et link. Andre brugere kan se dit navn, så skriv kun dit navn."
            : "Dine oplysninger kunne ikke gemmes. Prøv igen om lidt."
      );
      return;
    }

    setGemt(true);
    router.refresh();
  }

  return (
    <div className="max-w-md space-y-6">
      <div>
        <label className="block text-sm font-medium text-tekst">
          Profilbillede
        </label>
        <div className="mt-1.5">
          <AvatarUpload brugerId={brugerId} avatarUrl={avatarUrl} />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-tekst">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          disabled
          className="mt-1.5 w-full h-11 rounded-xl border border-transparent bg-groen-lys px-4 text-[15px] text-tekst-daempet"
        />
      </div>

      <div>
        <label htmlFor="navn" className="block text-sm font-medium text-tekst">
          Navn
        </label>
        <input
          id="navn"
          type="text"
          required
          value={navn}
          onChange={(e) => setNavn(e.target.value)}
          className="min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-[15px] text-tekst bg-white placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
      </div>

      <div>
        <label htmlFor="telefon" className="block text-sm font-medium text-tekst">
          Telefon
        </label>
        <input
          id="telefon"
          type="tel"
          value={telefon}
          onChange={(e) => setTelefon(e.target.value)}
          className="min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-[15px] text-tekst bg-white placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
      </div>

      <div>
        <label htmlFor="adresse" className="block text-sm font-medium text-tekst">
          Adresse til afhentning <span className="font-normal text-tekst-svag">(valgfri)</span>
        </label>
        <textarea
          id="adresse"
          rows={2}
          maxLength={300}
          value={adresse}
          onChange={(e) => setAdresse(e.target.value)}
          placeholder="Vejnavn og nummer, postnummer og by"
          className="mt-1.5 min-h-[88px] w-full rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
      </div>

      <p className="text-xs text-tekst-svag">
        Din e-mail, dit telefonnummer og din adresse vises aldrig offentligt. Sælger du en vare til
        afhentning, kan køberen se din adresse og dit telefonnummer, når varen er betalt – og kun
        indtil den er hentet.
      </p>

      {error && (
        <div role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
          {error}
        </div>
      )}
      {gemt && (
        <div role="status" className="rounded-xl border border-succes-kant bg-succes-bg px-4 py-3 text-sm text-succes-tekst">
          Profil opdateret.
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        aria-busy={loading || undefined}
        className="btn btn-primaer w-full sm:w-auto"
      >
        {loading && <span className="btn-spinner" aria-hidden="true" />}
        Gem ændringer
      </button>
      </form>
    </div>
  );
}
