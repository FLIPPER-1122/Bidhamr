import Link from "next/link";

// Vises øverst i admin for medarbejdere uden to-trins-login. Det er ikke et
// krav endnu, men medarbejderkonti har adgang til andres handler og sager.
export default function ToTrinAnbefaling() {
  return (
    <div className="border-b border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst sm:px-6">
      <p>
        <strong className="font-semibold">Slå to-trins-login til.</strong> Din medarbejderkonto har adgang til
        brugeres handler og sager, så den bør være ekstra beskyttet.{" "}
        <Link href="/konto#sikkerhed" className="font-semibold underline">
          Slå det til under Min konto
        </Link>
      </p>
    </div>
  );
}
