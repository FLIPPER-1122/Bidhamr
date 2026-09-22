const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  ShadingType, PageBreak,
} = require('docx');
const fs = require('fs');
const path = require('path');

function h1(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } });
}
function h2(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } });
}
function p(text, opts = {}) {
  return new Paragraph({ children: [new TextRun({ text, ...opts })], spacing: { before: 60, after: 60 } });
}
function bullet(text) {
  return new Paragraph({ children: [new TextRun({ text })], bullet: { level: 0 }, spacing: { before: 40, after: 40 } });
}
function blank() {
  return new Paragraph({ text: '', spacing: { before: 60, after: 60 } });
}
function statusRow(feature, status, notes) {
  const fill = status === 'Færdig' ? 'D4EDDA' : status === 'Delvist' ? 'FFF3CD' : 'F8D7DA';
  return new TableRow({ children: [
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: feature })] })], width: { size: 3500, type: WidthType.DXA } }),
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: status, bold: true })] })], width: { size: 1500, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, color: 'auto', fill } }),
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: notes })] })], width: { size: 4000, type: WidthType.DXA } }),
  ]});
}

const headerRow = new TableRow({ children: [
  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Feature', bold: true, color: 'FFFFFF' })] })], width: { size: 3500, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'E63946' } }),
  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Status', bold: true, color: 'FFFFFF' })] })], width: { size: 1500, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'E63946' } }),
  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Noter', bold: true, color: 'FFFFFF' })] })], width: { size: 4000, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'E63946' } }),
]});

const doc = new Document({
  sections: [{ children: [
    blank(),
    new Paragraph({ children: [new TextRun({ text: 'BidHamr', bold: true, size: 72, color: 'E63946' })], alignment: AlignmentType.CENTER, spacing: { before: 1440, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: 'Projektstatus & Dokumentation', size: 40, color: '555555' })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: 'Opdateret: September 2026', size: 24, color: '888888' })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: 'Filip Jeppesen  |  jeppesenfilip1@gmail.com', size: 22, color: '888888' })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 1440 } }),

    h1('1. Hvad er BidHamr?'),
    p('BidHamr er en dansk C2C-auktionsplatform hvor privatpersoner kan sælge og købe brugte varer via tidsbegrænsede auktioner. Inspireret af eBay og DBA, med fokus på transparens og sikkerhed.'),
    blank(),
    p('Domæne: bidhamr.dk', { bold: true }),
    p('Stack: Next.js 14 + Supabase + Expo (React Native)'),
    p('Hosting: Vercel Hobby (auto-deploy fra GitHub main)'),
    p('Email: Resend — noreply@bidhamr.dk (DKIM verificeret)'),
    p('Betaling: Stripe Customer Balance (wallet-model)'),
    blank(),

    h1('2. Forretningsmodel & Gebyrer'),
    bullet('5% sælgergebyr af slutpris'),
    bullet('5% købergebyr af slutpris'),
    bullet('3% returretsforsikring (frivillig tilkøb)'),
    bullet('Min. gebyr: 20 kr — Maks. gebyr: 250 kr'),
    blank(),
    h2('Wallet-model'),
    p('Brugere SKAL deponere penge i BidHamr-wallet via Stripe FØR de kan byde. Eliminerer tabte handler og giver platformen kontrol over transaktionsflowet.'),
    blank(),
    h2('Anti-snipe (2 minutter)'),
    p('Bud inden for de sidste 2 min. forlænger auktionen med 2 min. Ingen øvre grænse. Sikrer fair budgivning.'),
    blank(),

    h1('3. Teknisk Opsætning'),
    h2('Repository & Deploy'),
    bullet('GitHub: FLIPPER-1122/Bidhamr → Vercel auto-deploy ved push til main'),
    bullet('DNS: One.com → A-record 216.198.79.1 → Vercel → SSL automatisk'),
    blank(),
    h2('Miljøvariabler på Vercel'),
    bullet('NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    bullet('SUPABASE_SERVICE_ROLE_KEY — kun server-side (API routes, cron)'),
    bullet('RESEND_API_KEY'),
    bullet('CRON_SECRET — beskytter /api/cron/* endpoints'),
    bullet('NEXT_PUBLIC_SITE_URL = https://bidhamr.dk'),
    blank(),
    h2('Supabase tabeller'),
    bullet('users — profil, saldo, MitID verificeret, rolle (Chef/Admin/Medarbejder/Bruger)'),
    bullet('auctions — titel, billeder, startbud, slutdato, status, vinder_id'),
    bullet('bids — auktion_id, bruger_id, beløb, tidsstempel'),
    bullet('trades — handel oprettet ved auktionsafslutning (status, sporingsnummer)'),
    bullet('messages — realtids-chat inden for en handel'),
    bullet('favorites — brugers gemte auktioner'),
    bullet('reports — anmeldte opslag'),
    blank(),

    new Paragraph({ children: [new PageBreak()] }),
    h1('4. Feature-status'),
    blank(),
    new Table({
      columnWidths: [3500, 1500, 4000],
      width: { size: 9000, type: WidthType.DXA },
      rows: [
        headerRow,
        statusRow('bidhamr.dk på Vercel', 'Færdig', 'A-record via One.com'),
        statusRow('GitHub → Vercel auto-deploy', 'Færdig', 'FLIPPER-1122/Bidhamr'),
        statusRow('Supabase database + RLS', 'Færdig', 'Alle tabeller og policies'),
        statusRow('Brugerprofiler + MitID (Criipto)', 'Færdig', 'Verificering ved oprettelse'),
        statusRow('Auktionsoprettelse', 'Færdig', 'Billeder, kategorier, startbud'),
        statusRow('Budgivning + anti-snipe (2 min)', 'Færdig', 'Realtid via Supabase Realtime'),
        statusRow('Wallet (Stripe Customer Balance)', 'Færdig', 'Deponering krævet før bud'),
        statusRow('Wallet saldo i navigation', 'Færdig', 'Vises i topbar for indloggede'),
        statusRow('Favoritter (hjerte-ikon)', 'Færdig', 'Gemt lokalt + Supabase sync'),
        statusRow('Cron: auktioner lukkes auto', 'Færdig', 'Hvert 5. min via vercel.json'),
        statusRow('Handler oprettes ved afslutning', 'Færdig', 'cron → trades + emails'),
        statusRow('Mine handler (oversigtsside)', 'Færdig', 'Køber og sælger ser deres handler'),
        statusRow('Chat i handel (realtid)', 'Færdig', 'messages tabel + Supabase Realtime'),
        statusRow('Sporingsnummer upload (sælger)', 'Færdig', '"Send pakke"-knap'),
        statusRow('Resend email integration', 'Færdig', 'noreply@bidhamr.dk DKIM ok'),
        statusRow('Waitlist + bekræftelsesmail', 'Færdig', 'Landing page coming-soon'),
        statusRow('Password reset flow', 'Færdig', 'Virker på bidhamr.dk'),
        statusRow('Admin dashboard', 'Færdig', 'Service role key korrekt'),
        statusRow('Admin: sæt bruger saldo', 'Færdig', 'Til testformål'),
        statusRow('Rapport/anmeld-system', 'Delvist', 'Grundstruktur klar'),
        statusRow('Sager-siden (admin handler)', 'Mangler', 'NÆSTE opgave'),
        statusRow('Behandlede rapporter slettes 48t', 'Mangler', 'Cron auto-delete'),
        statusRow('Auktioner slettes 48t v. afhentning', 'Mangler', 'Cron auto-delete'),
        statusRow('Cookie-banner', 'Mangler', 'Lovpligtigt ved lancering'),
        statusRow('Navigation menu forbedring', 'Mangler', 'Topbar-organisering'),
        statusRow('Expo mobilapp (bidhamr-fresh)', 'Delvist', 'Grundstruktur klar, app-features mangler'),
      ],
    }),
    blank(),

    new Paragraph({ children: [new PageBreak()] }),
    h1('5. Auktionsflow (efter auktion slutter)'),
    new Paragraph({ children: [new TextRun({ text: 'Trin 1 — Cron (hvert 5. min)', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Vercel cron → /api/cron/afslut-auktioner (kræver CRON_SECRET). Kalder Supabase RPC "afslut_udloebne_auktioner" → status = afsluttet.'),
    blank(),
    new Paragraph({ children: [new TextRun({ text: 'Trin 2 — Handel oprettes', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Auktioner med vinder → ny række i "trades" med status "afventer_betaling". Email til køber OG sælger via Resend.'),
    blank(),
    new Paragraph({ children: [new TextRun({ text: 'Trin 3 — Mine handler', bold: true })], spacing: { before: 100, after: 40 } }),
    p('/mine-handler viser aktive handler. Sælger uploader sporingsnummer via "Send pakke"-knap. Chat mellem parterne i realtid.'),
    blank(),
    new Paragraph({ children: [new TextRun({ text: 'Trin 4 — Frigivelse (TODO)', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Køber bekræfter modtagelse → beløb frigives til sælgers wallet minus gebyrer. 48t efter → auktion slettes automatisk.'),
    blank(),

    h1('6. Resterende opgaver (prioriteret)'),
    new Paragraph({ children: [new TextRun({ text: '1. Sager-siden', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Admin-overblik over aktive handler og tvister. Admin kan gribe ind.'),
    new Paragraph({ children: [new TextRun({ text: '2. Behandlede rapporter slettes efter 48t', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Cron job auto-sletter behandlede rapporter.'),
    new Paragraph({ children: [new TextRun({ text: '3. Auktioner slettes 48t efter afhentning', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Holder databasen ren. Kombineres med frigivelsesflowet.'),
    new Paragraph({ children: [new TextRun({ text: '4. Cookie-banner', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Lovpligtigt. Anbefaling: Cookiebot eller CookieYes (gratis tier).'),
    new Paragraph({ children: [new TextRun({ text: '5. Navigation menu forbedring', bold: true })], spacing: { before: 100, after: 40 } }),
    p('Bedre rækkefølge og organisering af links i topbar.'),
    new Paragraph({ children: [new TextRun({ text: '6. Expo mobilapp', bold: true })], spacing: { before: 100, after: 40 } }),
    p('GPS swipe-flow, kamera-scan og invitér-en-sælger er app-only features der mangler.'),
    blank(),

    h1('7. Vigtige regler & noter'),
    bullet('GIT: Al kode pushes MANUELT af Filip — Claude skriver kode men pusher aldrig selv'),
    bullet('SERVICE ROLE KEY må aldrig eksponeres klient-side — kun i API routes og cron'),
    bullet('Vercel Hobby er gratis — opgradér til Pro ved skalering (~$20/md)'),
    bullet('Metro-fix: @opentelemetry/api stubbet i metro.config.js (Expo app)'),
    blank(),

    h1('8. Adgange'),
    bullet('GitHub: FLIPPER-1122'),
    bullet('Email: jeppesenfilip1@gmail.com'),
    bullet('Vercel: FLIPPER-1122/Bidhamr'),
    bullet('One.com: DNS for bidhamr.dk'),
    bullet('Resend: noreply@bidhamr.dk (DKIM ok)'),
    bullet('Supabase: projektdashboard via supabase.com'),
  ]}],
});

const outPath = path.join(__dirname, 'BidHamr_Status_Sept2026.docx');
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log('GEMT:', outPath);
}).catch(err => {
  console.error('FEJL:', err.message);
});
