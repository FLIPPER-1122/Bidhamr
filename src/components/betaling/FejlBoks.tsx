// Fejlbesked i betalingsflader. Ligger i sin egen fil, så sider uden
// Payment Element ikke trækker Stripe-koden med.
export function FejlBoks({ tekst }: { tekst: string }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst"
    >
      {tekst}
    </p>
  );
}
