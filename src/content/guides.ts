// Editorial guides. Plain structured blocks so they render with the site's
// own typography; facts are general and link to primary sources.

export type Block = { h: string } | { p: string } | { ul: string[] } | { src: string }

export interface Guide {
    slug: string
    title: string
    description: string
    updated: string
    blocks: Block[]
}

export const GUIDES: Guide[] = [
    {
        slug: 'las-en-arsredovisning',
        title: 'Så läser du en årsredovisning',
        description: 'Vad de olika delarna av ett svenskt aktiebolags årsredovisning innehåller och var du hittar det viktigaste.',
        updated: '2026-09-25',
        blocks: [
            { p: 'Ett aktiebolag ska lämna sin årsredovisning till Bolagsverket senast sju månader efter räkenskapsårets slut. Den är offentlig, och för den som ska ge kredit är den den viktigaste källan till hur bolaget går.' },
            { h: 'Förvaltningsberättelsen' },
            { p: 'Här beskriver styrelsen verksamheten, väsentliga händelser under året och hur resultatet ska disponeras. Läs den först: den förklarar ofta varför siffrorna ser ut som de gör.' },
            { h: 'Resultaträkningen' },
            { p: 'Visar intäkter och kostnader under året. Nettoomsättningen är försäljningen. Rörelseresultatet är vad verksamheten gav före räntor och skatt. Årets resultat är vad som blir kvar till ägarna.' },
            { h: 'Balansräkningen' },
            { p: 'Visar vad bolaget äger och hur det är finansierat på bokslutsdagen. Eget kapital och skulder ska tillsammans vara lika stora som tillgångarna. Negativt eget kapital betyder att skulderna är större än tillgångarna.' },
            { h: 'Noter och revisionsberättelse' },
            { p: 'Noterna förklarar posterna och redovisningsprinciperna. Mindre aktiebolag kan sakna revisor; har bolaget en revisor finns revisionsberättelsen sist. En revisionsberättelse med anmärkning är värd att läsa noga.' },
            { h: 'K2 och K3' },
            { p: 'Mindre företag följer ofta det förenklade regelverket K2, som ger en kortare årsredovisning med färre poster. Därför saknas vissa uppgifter för små bolag, och därför skriver vi «saknas» i stället för att gissa.' },
            { src: 'Källa: Bolagsverket, bolagsverket.se, om årsredovisning för aktiebolag.' },
        ],
    },
    {
        slug: 'nyckeltal',
        title: 'Nyckeltal: soliditet, kassalikviditet och marginaler',
        description: 'Vad de vanligaste nyckeltalen säger om ett företag, hur de räknas och vad de inte säger.',
        updated: '2026-09-25',
        blocks: [
            { p: 'Nyckeltal gör bokslut jämförbara mellan år och mellan företag. Inget enskilt tal säger allt, och alla tal behöver läsas mot branschen.' },
            { h: 'Soliditet' },
            { p: 'Andelen av tillgångarna som finansieras med eget kapital. Hög soliditet betyder att bolaget tål förluster bättre. Obeskattade reserver räknas delvis som eget kapital, eftersom de till största delen är bolagets egna pengar.' },
            { h: 'Kassalikviditet' },
            { p: 'Omsättningstillgångar utom varulager i förhållande till kortfristiga skulder. Ett värde runt 100 procent betyder att bolaget kan betala sina kortfristiga skulder med likvida medel och fordringar.' },
            { h: 'Rörelsemarginal och vinstmarginal' },
            { p: 'Hur stor del av omsättningen som blir resultat, före respektive efter finansiella poster. Marginalerna skiljer sig mycket mellan branscher: en grossist har ofta låga marginaler, ett konsultbolag högre.' },
            { h: 'Vad nyckeltalen inte säger' },
            { ul: ['De beskriver bokslutsdagen, inte i dag.', 'De säger inget om betalningsanmärkningar eller skulder hos Kronofogden.', 'Ett räkenskapsår som är längre eller kortare än tolv månader gör tillväxttal missvisande.'] },
            { p: 'Exakta formler finns på metodsidan.' },
        ],
    },
    {
        slug: 'kontrollera-ny-kund',
        title: 'Kontrollera en ny kund innan du fakturerar',
        description: 'En kort lista för att kontrollera ett företag innan du levererar mot faktura.',
        updated: '2026-09-25',
        blocks: [
            { p: 'Det tar några minuter att kontrollera en ny företagskund, och det kan spara en obetald faktura. Börja med det som är offentligt.' },
            { h: '1. Stäm av organisationsnumret' },
            { p: 'Be om organisationsnumret och kontrollera att namn och nummer hör ihop. Ett organisationsnummer har tio siffror och en kontrollsiffra; sökningen här säger till om numret inte kan stämma.' },
            { h: '2. Kontrollera status' },
            { p: 'Ett bolag i likvidation, konkurs eller företagsrekonstruktion är en annan motpart än ett aktivt bolag. Status registreras hos Bolagsverket.' },
            { h: '3. Kontrollera F-skatt och momsregistrering' },
            { p: 'Skatteverket visar om företaget är godkänt för F-skatt och registrerat för moms. Det behövs bland annat för att du ska kunna betala ut ersättning utan att dra skatt.' },
            { h: '4. Läs senaste bokslutet' },
            { ul: ['Har bolaget omsättning, eller är det vilande?', 'Är det egna kapitalet positivt?', 'Hur gammalt är bokslutet? Ett bokslut som är flera år gammalt är en varningssignal i sig.'] },
            { h: '5. Anpassa villkoren' },
            { p: 'Om underlaget är tunt kan du korta betalningstiden, begära förskott eller dela upp leveransen. Det är vanliga och rimliga villkor mot nya kunder.' },
        ],
    },
    {
        slug: 'organisationsnummer',
        title: 'Organisationsnummer: så är numret uppbyggt',
        description: 'Vad de tio siffrorna i ett organisationsnummer betyder, hur kontrollsiffran fungerar och varför enskilda firmor saknar ett eget nummer.',
        updated: '2026-10-02',
        blocks: [
            { p: 'Varje juridisk person i Sverige har ett organisationsnummer. Numret följer bolaget hela livet och byts inte när namnet ändras, så det är det säkraste sättet att veta att du pratar om rätt företag.' },
            { h: 'Tio siffror' },
            { p: 'Numret skrivs NNNNNN-NNNN. Den första siffran anger vilken typ av organisation det är, och den tredje siffran är alltid 2 eller högre. Därför kan ett organisationsnummer aldrig se ut som ett datum och förväxlas med ett personnummer.' },
            { ul: ['5: aktiebolag', '9: handelsbolag och kommanditbolag', '7: ekonomiska föreningar och bostadsrättsföreningar', '8: ideella föreningar och stiftelser', '2: stat, regioner och kommuner', '1: dödsbon', '3: utländska företag med verksamhet i Sverige'] },
            { h: 'Kontrollsiffran' },
            { p: 'Den sista siffran räknas fram ur de nio första med samma metod som för personnummer (Luhn-algoritmen). Ett felskrivet nummer avslöjas därför nästan alltid. Söker du på ett nummer som inte kan stämma säger sökningen här till direkt.' },
            { h: 'Enskild firma' },
            { p: 'En enskild näringsidkare är ingen juridisk person och har inget eget organisationsnummer. Företaget använder ägarens personnummer. Därför publicerar vi inga profiler för enskilda firmor: numret är en personuppgift.' },
            { src: 'Källor: Skatteverket och SCB, om organisationsnummer.' },
        ],
    },
    {
        slug: 'negativt-eget-kapital',
        title: 'Negativt eget kapital och kontrollbalansräkning',
        description: 'Vad det betyder när ett aktiebolag har förbrukat sitt eget kapital, och vad styrelsen då måste göra enligt aktiebolagslagen.',
        updated: '2026-10-02',
        blocks: [
            { p: 'Eget kapital är skillnaden mellan bolagets tillgångar och skulder. Är det negativt är skulderna större än tillgångarna. Det är en tydlig varningssignal för den som ska ge kredit, men inte samma sak som att bolaget är på obestånd.' },
            { h: 'När är kapitalet förbrukat?' },
            { p: 'Aktiebolagslagen kräver att styrelsen agerar när det egna kapitalet understiger hälften av det registrerade aktiekapitalet. Då ska styrelsen genast upprätta en kontrollbalansräkning och, om den bekräftar läget, kalla till en kontrollstämma.' },
            { h: 'Vad händer sedan?' },
            { ul: ['På den första kontrollstämman beslutar aktieägarna om bolaget ska gå i likvidation eller fortsätta.', 'Fortsätter bolaget måste det egna kapitalet vara återställt inom åtta månader, vilket prövas på en andra kontrollstämma.', 'Gör styrelsen inte det lagen kräver kan ledamöterna bli personligt ansvariga för bolagets nya skulder.'] },
            { h: 'Hur du läser det i bokslutet' },
            { p: 'Jämför eget kapital med aktiekapitalet i balansräkningen och läs förvaltningsberättelsen: där ska styrelsen beskriva läget och vad som görs. Ett aktieägartillskott eller en nyemission efter bokslutsdagen syns inte i siffrorna, så fråga gärna bolaget.' },
            { src: 'Källa: aktiebolagslagen (2005:551), 25 kap. 13–20 §§.' },
        ],
    },
    {
        slug: 'likvidation-konkurs-rekonstruktion',
        title: 'Likvidation, konkurs och företagsrekonstruktion',
        description: 'Vad de olika statusarna betyder och vad de innebär för dig som kund, leverantör eller långivare.',
        updated: '2026-10-02',
        blocks: [
            { p: 'Ett företag som inte är aktivt kan befinna sig i flera olika lägen. Statusen registreras hos Bolagsverket och visas på företagets profil här.' },
            { h: 'Likvidation' },
            { p: 'Bolaget avvecklas. En likvidator tar över från styrelsen, säljer tillgångarna, betalar skulderna och delar ut det som blir över till ägarna. Likvidation kan vara frivillig eller beslutas av Bolagsverket eller domstol, till exempel om bolaget inte har lämnat årsredovisning.' },
            { h: 'Konkurs' },
            { p: 'Tingsrätten försätter bolaget i konkurs när det inte kan betala sina skulder. En konkursförvaltare tar hand om tillgångarna och fördelar dem mellan borgenärerna i den ordning lagen anger. Leverera inte mot faktura till ett bolag i konkurs utan att ha talat med förvaltaren.' },
            { h: 'Företagsrekonstruktion' },
            { p: 'Ett bolag med betalningssvårigheter men en livskraftig kärna får tid att lösa sin situation under ledning av en rekonstruktör. Verksamheten fortsätter. Under rekonstruktionen kan gamla skulder skrivas ned genom en rekonstruktionsplan, så skilj på fordringar från före och efter beslutet.' },
            { h: 'Avregistrerat' },
            { p: 'Bolaget finns inte längre, till exempel efter avslutad likvidation eller konkurs, eller efter en fusion med ett annat bolag.' },
            { src: 'Källor: Bolagsverket; konkurslagen (1987:672); lag (2022:964) om företagsrekonstruktion.' },
        ],
    },
]
