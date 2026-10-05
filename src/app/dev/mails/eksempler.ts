// Eksempeldata til mail-preview (kun dev). Én række pr. mail.
import {
  afhentningPaamindelseMail,
  afhentningsfristForlaengetMail,
  andenchanceTilbudMail,
  betalingsPaamindelseMail,
  betalingsfristForlaengetMail,
  koeberAdminAnnulleretMail,
  koeberAfhentningAnnulleretMail,
  koeberAfsendelsesfristAnnulleretMail,
  koeberAndenchanceAutobetaltMail,
  koeberAndenchanceBetalMail,
  koeberAutobetaltMail,
  koeberUbetaltAnnulleretMail,
  koeberVandtMail,
  notifikationMail,
  pakkeSendtMail,
  saelgerAdminAnnulleretMail,
  saelgerAfhentningAnnulleretMail,
  saelgerAfsendelsesfristAnnulleretMail,
  saelgerAfsendelsesPaamindelseMail,
  saelgerAndenchanceAccepteretMail,
  saelgerAndenchanceAfslaaetMail,
  saelgerBetaltMail,
  saelgerOpretUdbetalingskontoMail,
  saelgerSolgtMail,
  saelgerUbetaltAnnulleretMail,
} from "@/lib/mails/handel";
import { velkomstMail } from "@/lib/mails/venteliste";
import { adgangskodeAendretMail, kontoSlettetMail, nytLoginMail, toTrinMail } from "@/lib/mails/konto";

export type MailEksempel = {
  id: string;
  navn: string;
  mail: { subject: string; html: string; text: string };
};

const TITEL = "Vintage teaksofa fra 1960'erne";
// Viser at brugerdata escapes: må aldrig blive til rigtig HTML.
const FARLIG_TITEL = `Sofa <b>"fed"</b> & <script>alert(1)</script>`;
const TRADE = "00000000-0000-4000-8000-000000000001";
const TILBUD = "00000000-0000-4000-8000-000000000002";
const om24 = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const om48 = () => new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

export function mailEksempler(): MailEksempel[] {
  return [
    { id: "nyt-login", navn: "Konto: nyt login fra ny enhed", mail: nytLoginMail({ tidspunkt: new Date(), enhed: "Chrome på Windows" }) },
    { id: "adgangskode-aendret", navn: "Konto: adgangskoden er ændret", mail: adgangskodeAendretMail({ tidspunkt: new Date() }) },
    { id: "to-trin-til", navn: "Konto: to-trins-login slået til", mail: toTrinMail({ slaaetTil: true, tidspunkt: new Date() }) },
    { id: "to-trin-fra", navn: "Konto: to-trins-login slået fra", mail: toTrinMail({ slaaetTil: false, tidspunkt: new Date() }) },
    { id: "konto-slettet", navn: "Konto: din konto er slettet", mail: kontoSlettetMail() },
    { id: "koeber-vandt", navn: "Køber: du vandt", mail: koeberVandtMail(TITEL, 128_950, TRADE, om48()) },
    { id: "koeber-autobetalt", navn: "Køber: vandt og betalt automatisk", mail: koeberAutobetaltMail(TITEL, 128_950, TRADE) },
    { id: "betalingspaamindelse", navn: "Køber: husk at betale", mail: betalingsPaamindelseMail(TITEL, 128_950, TRADE, om24()) },
    { id: "betalingsfrist-forlaenget", navn: "Køber: ny betalingsfrist", mail: betalingsfristForlaengetMail(TITEL, 128_950, TRADE, om48()) },
    { id: "saelger-solgt", navn: "Sælger: auktionen er solgt", mail: saelgerSolgtMail(TITEL, 115_000, TRADE) },
    { id: "saelger-betalt", navn: "Sælger: køberen har betalt", mail: saelgerBetaltMail(TITEL, TRADE) },
    { id: "pakke-sendt", navn: "Køber: pakken er sendt", mail: pakkeSendtMail(TITEL, "00370730253765234", TRADE) },
    { id: "koeber-ubetalt", navn: "Køber: annulleret (ikke betalt)", mail: koeberUbetaltAnnulleretMail(TITEL, TRADE) },
    { id: "saelger-ubetalt", navn: "Sælger: køberen betalte ikke", mail: saelgerUbetaltAnnulleretMail(TITEL, TRADE) },
    { id: "andenchance-tilbud", navn: "Byder: du får tilbudt varen", mail: andenchanceTilbudMail(TITEL, 98_000, TILBUD, om24()) },
    { id: "andenchance-ja", navn: "Sælger: byderen sagde ja", mail: saelgerAndenchanceAccepteretMail(TITEL, TRADE) },
    { id: "andenchance-nej", navn: "Sælger: byderen sagde nej", mail: saelgerAndenchanceAfslaaetMail(TITEL, TRADE, "afvist") },
    { id: "andenchance-udloebet", navn: "Sælger: byderen svarede ikke", mail: saelgerAndenchanceAfslaaetMail(TITEL, TRADE, "udloebet") },
    { id: "andenchance-kan-ikke", navn: "Sælger: byderen kan ikke købe", mail: saelgerAndenchanceAfslaaetMail(TITEL, TRADE, "kan_ikke_koebe") },
    { id: "andenchance-betal", navn: "Køber: du har fået varen", mail: koeberAndenchanceBetalMail(TITEL, 112_350, TRADE, om48()) },
    { id: "andenchance-autobetalt", navn: "Køber: fået varen og betalt", mail: koeberAndenchanceAutobetaltMail(TITEL, 112_350, TRADE) },
    { id: "udbetalingskonto", navn: "Sælger: opret udbetalingskonto", mail: saelgerOpretUdbetalingskontoMail(TITEL, 109_250, false) },
    { id: "udbetalingskonto-paamindelse", navn: "Sælger: påmindelse om udbetalingskonto", mail: saelgerOpretUdbetalingskontoMail(TITEL, 109_250, true) },
    { id: "koeber-admin-annulleret", navn: "Køber: annulleret af BidHamr", mail: koeberAdminAnnulleretMail(TITEL, TRADE) },
    { id: "saelger-admin-annulleret", navn: "Sælger: annulleret af BidHamr", mail: saelgerAdminAnnulleretMail(TITEL, TRADE) },
    { id: "saelger-afsendelse-paamindelse", navn: "Sælger: husk at sende pakken", mail: saelgerAfsendelsesPaamindelseMail(TITEL, TRADE, "mandag 6. oktober kl. 14.30") },
    { id: "koeber-afsendelsesfrist", navn: "Køber: sælgeren sendte ikke i tide", mail: koeberAfsendelsesfristAnnulleretMail(TITEL, 128_950, TRADE) },
    { id: "saelger-afsendelsesfrist", navn: "Sælger: annulleret (ikke sendt i tide)", mail: saelgerAfsendelsesfristAnnulleretMail(TITEL, TRADE) },
    { id: "koeber-afhentning-paamindelse", navn: "Køber: husk at hente varen", mail: afhentningPaamindelseMail("koeber", TITEL, TRADE, "mandag 6. oktober kl. 14.30") },
    { id: "saelger-afhentning-paamindelse", navn: "Sælger: varen er ikke hentet endnu", mail: afhentningPaamindelseMail("saelger", TITEL, TRADE, "mandag 6. oktober kl. 14.30") },
    { id: "koeber-afhentningsfrist-forlaenget", navn: "Køber: ny afhentningsfrist", mail: afhentningsfristForlaengetMail(TITEL, TRADE, "fredag 10. oktober kl. 14.30") },
    { id: "koeber-afhentningsfrist", navn: "Køber: varen blev ikke hentet (alle pengene tilbage)", mail: koeberAfhentningAnnulleretMail(TITEL, 128_950, TRADE) },
    { id: "saelger-afhentningsfrist", navn: "Sælger: annulleret (varen blev ikke hentet)", mail: saelgerAfhentningAnnulleretMail(TITEL, TRADE) },
    {
      id: "notifikation",
      navn: "Notifikation (fælles skabelon, fx overbudt)",
      mail: notifikationMail(
        "Du er blevet overbudt",
        `Nogen har budt mere end dig på "${TITEL}".\nByd igen, hvis du stadig vil have den.`,
        `/auktion/${TRADE}`,
      ),
    },
    {
      id: "escape-test",
      navn: "Test: titel med HTML (skal vises som tekst)",
      mail: pakkeSendtMail(FARLIG_TITEL, `<img src=x onerror=alert(1)>`, TRADE),
    },
    { id: "venteliste", navn: "Venteliste: velkomst", mail: velkomstMail("navn@eksempel.dk") },
  ];
}
