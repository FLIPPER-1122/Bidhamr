import { NextResponse } from "next/server";

// Indbetaling til saldo er lukket: BidHamr har ingen saldo/wallet længere.
// Vinderen betaler selv efter auktionen (se src/app/actions/betaling.ts).
// Ruten og IndbetalForm fjernes helt sammen med wallet-tabellerne i næste
// roadmap-punkt.
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "Indbetaling er ikke længere mulig. Du betaler, når du vinder en auktion." },
    { status: 410 },
  );
}
