"use client";

// Momsordning pr. erhvervsauktion (kun firmaer). "Standard" = firmaets valg
// under Fakturaer -> Indstillinger. Låses, når der er budt / varen er solgt
// (databasen: firma_saet_auktion_momsordning og auctions_momsordning_laas).
export type MomsValg = "standard" | "moms" | "brugtmoms";

export default function MomsordningValg({
  vaerdi,
  onChange,
  laast = false,
}: {
  vaerdi: MomsValg;
  onChange: (v: MomsValg) => void;
  laast?: boolean;
}) {
  return (
    <div>
      <label htmlFor="momsordning" className="mb-1.5 block text-sm font-medium text-tekst">
        Moms på fakturaen
      </label>
      <select
        id="momsordning"
        value={vaerdi}
        disabled={laast}
        onChange={(e) => onChange(e.target.value as MomsValg)}
        aria-describedby="momsordning-hjaelp"
        className="min-h-11 w-full rounded-none border border-kant-staerk bg-white px-3 text-base"
      >
        <option value="standard">Brug mit standardvalg</option>
        <option value="moms">Almindelig moms (25 % vises)</option>
        <option value="brugtmoms">Brugtmoms (ingen moms vises)</option>
      </select>
      <p id="momsordning-hjaelp" className="mt-1 text-sm text-tekst-daempet">
        {laast
          ? "Momsordningen kan ikke ændres, når der er budt."
          : "Bestemmer, hvordan momsen står på fakturaen til køberen. Prisen er altid inkl. moms. Kan ikke ændres, når der er budt."}
      </p>
    </div>
  );
}
