"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import AvatarUpload from "@/components/profile/AvatarUpload";

// Samme rensning som ved oprettelse (renNavn i actions/auth.ts).
function renset(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

// users.fornavn/efternavn kan ikke læses fra klienten (kolonne-grants), så
// felterne forudfyldes ud fra det samlede navn: sidste ord er efternavnet
// (samme regel som delNavn i lib/dac7/regler.ts). Brugeren kan rette det.
function delNavn(navn: string): { fornavn: string; efternavn: string } {
  const dele = renset(navn).split(" ").filter(Boolean);
  if (dele.length <= 1) return { fornavn: dele[0] ?? "", efternavn: "" };
  return { fornavn: dele.slice(0, -1).join(" "), efternavn: dele[dele.length - 1] };
}

type Felt = "fornavn" | "efternavn";

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
  const [start] = useState(() => delNavn(initialNavn));
  const [fornavn, setFornavn] = useState(start.fornavn);
  const [efternavn, setEfternavn] = useState(start.efternavn);
  const [fejlFelt, setFejlFelt] = useState<Felt | null>(null);
  const [telefon, setTelefon] = useState(initialTelefon ?? "");
  const [adresse, setAdresse] = useState(initialAdresse ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFejlFelt(null);
    setGemt(false);

    // Fornavn og efternavn er begge påkrævet - også når navnet rettes.
    const rensetFornavn = renset(fornavn).slice(0, 100);
    const rensetEfternavn = renset(efternavn).slice(0, 100);
    const tomtFelt: Felt | null = !rensetFornavn ? "fornavn" : !rensetEfternavn ? "efternavn" : null;
    if (tomtFelt) {
      setError(tomtFelt === "fornavn" ? "Skriv dit fornavn." : "Skriv dit efternavn.");
      setFejlFelt(tomtFelt);
      requestAnimationFrame(() => document.getElementById(tomtFelt)?.focus());
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const navnRettet =
      rensetFornavn !== renset(start.fornavn) ||
      rensetEfternavn !== renset(start.efternavn) ||
      `${rensetFornavn} ${rensetEfternavn}` !== renset(initialNavn);
    const { error: updateError } = await supabase
      .from("users")
      .update({
        // Navnet skrives kun, når det er ændret, så en gemt telefon ikke
        // overskriver fornavn/efternavn med det gættede skel.
        ...(navnRettet
          ? { navn: `${rensetFornavn} ${rensetEfternavn}`, fornavn: rensetFornavn, efternavn: rensetEfternavn }
          : {}),
        telefon: telefon.trim() || null,
        adresse: adresse.trim() || null,
      })
      .eq("id", brugerId);

    setLoading(false);

    if (updateError) {
      console.error("Profil kunne ikke gemmes:", updateError);
      // BHN03: tomt efternavn (users_kraev_efternavn, 20261017030000) -
      // sikkerhedsnet bag tjekket ovenfor.
      if (updateError.code === "BHN03") {
        setError("Skriv dit efternavn.");
        setFejlFelt("efternavn");
        return;
      }
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

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-tekst">
          E-mail
        </label>
        <input
          id="email"
          type="email"
          value={email}
          disabled
          className="mt-1.5 w-full h-11 rounded-xl border border-transparent bg-groen-lys px-4 text-[15px] text-tekst-daempet"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="fornavn" className="block text-sm font-medium text-tekst">
            Fornavn
          </label>
          <input
            id="fornavn"
            type="text"
            autoComplete="given-name"
            required
            maxLength={100}
            value={fornavn}
            onChange={(e) => setFornavn(e.target.value)}
            aria-invalid={fejlFelt === "fornavn" || undefined}
            className={`min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-[15px] text-tekst bg-white placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25 ${fejlFelt === "fornavn" ? "border-fejl-kant bg-fejl-bg/40" : ""}`}
          />
        </div>
        <div>
          <label htmlFor="efternavn" className="block text-sm font-medium text-tekst">
            Efternavn
          </label>
          <input
            id="efternavn"
            type="text"
            autoComplete="family-name"
            required
            maxLength={100}
            value={efternavn}
            onChange={(e) => setEfternavn(e.target.value)}
            aria-invalid={fejlFelt === "efternavn" || undefined}
            className={`min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-[15px] text-tekst bg-white placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25 ${fejlFelt === "efternavn" ? "border-fejl-kant bg-fejl-bg/40" : ""}`}
          />
        </div>
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
