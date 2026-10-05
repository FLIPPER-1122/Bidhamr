// Fælles links til topbar, mobilmenu og footer, så de altid peger samme sted.
import { kategorier } from "@/lib/kategorier";

export type NavLink = { href: string; tekst: string };

export const kategoriHref = (kategori: string) =>
  `/auktioner?kategori=${encodeURIComponent(kategori)}`;

// TODO søgning/filtre-opgaven: /auktioner skal læse ?sortering= (slutter_snart, nyeste).
export const UDFORSK: NavLink[] = [
  { href: "/auktioner", tekst: "Alle auktioner" },
  { href: "/auktioner?sortering=slutter_snart", tekst: "Slutter snart" },
  { href: "/auktioner?sortering=nyeste", tekst: "Nye auktioner" },
];

// Kategorier, der står direkte i kategorilinjen på store skærme.
export const KATEGORIER_I_LINJEN = kategorier.filter((k) =>
  ["Elektronik", "Møbler", "Tøj & sko", "Sport"].includes(k),
);

export const HJAELP: NavLink[] = [
  { href: "/saadan-virker-det", tekst: "Sådan virker det" },
  { href: "/bidhamr-beskyttelse", tekst: "BidHamr Beskyttelse" },
  { href: "/faq", tekst: "Hjælp og FAQ" },
  { href: "/kontakt", tekst: "Kontakt kundeservice" },
];
