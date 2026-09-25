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
]
