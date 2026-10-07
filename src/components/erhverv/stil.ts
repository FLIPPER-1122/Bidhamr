// Fælles klasser til erhvervssiderne (/erhverv, /firma og felterne til
// firmaer). Målgruppen er primært ældre: brødtekst 17-18px, felter og knapper
// mindst 48px høje (her 56px), høj kontrast og tydelige fejl ved feltet.
// Farver og radier følger DESIGN.md.

export const E_LABEL = "mb-2 block text-[18px] font-semibold text-tekst";
export const E_HJAELP = "mt-2 text-[16px] leading-snug text-tekst-daempet";
export const E_FEJL = "mt-2 flex items-start gap-2 text-[16px] font-semibold text-fejl-tekst";

export const eFelt = (fejl?: boolean) =>
  `h-14 w-full rounded-xl border-2 bg-white px-4 text-[18px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-offset-1 focus:outline-groen/40 ${
    fejl ? "border-fejl-tekst bg-fejl-bg/40" : "border-kant-staerk"
  }`;

export const eTekstfelt = (fejl?: boolean) =>
  `min-h-[140px] w-full rounded-xl border-2 bg-white px-4 py-3 text-[18px] leading-relaxed text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-offset-1 focus:outline-groen/40 ${
    fejl ? "border-fejl-tekst bg-fejl-bg/40" : "border-kant-staerk"
  }`;

// Store knapper (56px). Brug én primær pr. kort.
// Teksten må bryde (lange danske knaptekster på 360px), derfor h-auto.
const E_KNAP = "btn h-auto min-h-14 whitespace-normal px-7 py-3 text-center text-[18px] leading-snug";
export const E_KNAP_PRIMAER = `${E_KNAP} btn-primaer`;
export const E_KNAP_SEKUNDAER = `${E_KNAP} btn-sekundaer border-2`;

// Kort på Firma oversigt.
export const E_KORT = "rounded-[18px] border border-kant bg-white p-5 sm:p-7";
export const E_KORT_TITEL = "text-[24px] leading-tight text-tekst sm:text-[26px]";
export const E_TEKST = "text-[18px] leading-relaxed text-tekst";
export const E_TEKST_DAEMPET = "text-[17px] leading-relaxed text-tekst-daempet";
