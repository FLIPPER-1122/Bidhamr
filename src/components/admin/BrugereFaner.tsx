import AdminFaner from "./AdminFaner";

// Faner øverst på "Brugere": søgning og mistænkelig aktivitet.
const FANER = [
  { id: "soeg", label: "Søg bruger", href: "/admin/brugere" },
  { id: "mistaenkelig", label: "Mistænkelig aktivitet", href: "/admin/brugere/mistaenkelig" },
] as const;

export default function BrugereFaner({ aktiv }: { aktiv: "soeg" | "mistaenkelig" }) {
  return <AdminFaner faner={FANER} aktiv={aktiv} label="Brugere" />;
}
