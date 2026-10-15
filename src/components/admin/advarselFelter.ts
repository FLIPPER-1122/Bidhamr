import type { Skabelon } from "@/components/admin/Skabeloner";
import type { TekstFelt } from "@/components/admin/ConfirmDialog";

// De to tekster ved en advarsel (ROADMAP-BESLUTNINGER, "Advarsler og
// begrundelse"). Samme felter alle steder, hvor staff giver en advarsel.
// Feltnavnene matcher server actions: begrundelse_bruger + intern note-feltet.
export function advarselFelter(opts: {
  internNavn: string;
  brugerPlaceholder: string;
  internPlaceholder: string;
  // Standardbegrundelser (ét klik) og forudfyldt tekst til brugeren.
  brugerSkabeloner?: readonly Skabelon[];
  brugerStandard?: string;
}): TekstFelt[] {
  return [
    {
      name: "begrundelse_bruger",
      label: "Begrundelse til brugeren (vises for brugeren)",
      placeholder: opts.brugerPlaceholder,
      required: true,
      maxLength: 1000,
      hjaelp: "Brugeren ser teksten i beskeden om advarslen og på sin konto. Højst 1000 tegn.",
      ...(opts.brugerSkabeloner ? { skabeloner: opts.brugerSkabeloner } : {}),
      ...(opts.brugerStandard ? { standard: opts.brugerStandard } : {}),
    },
    {
      name: opts.internNavn,
      label: "Intern note (kun staff)",
      placeholder: opts.internPlaceholder,
      required: false,
      maxLength: 2000,
      hjaelp: "Ses kun af medarbejdere. Brugeren ser aldrig den interne note.",
    },
  ];
}
