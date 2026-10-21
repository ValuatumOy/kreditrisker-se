# Ruotsin lukujen tarkistus 21.10.2026

**Laajaa sivugenerointia ei vielä suositella.** Julkaistut luvut vastaavat API:a,
mutta kolmessa yrityksessä vahvistui merkittävä lähteen tulkintavirhe.

**Päivitys tarkistuksen jälkeen:** [Näiden kolmen yrityksen tuontikorjaus ja varmennus](DATA-IMPORT-FIX-2026-10-21.md). Alla oleva otos ja havainnot kuvaavat korjausta edeltänyttä tilannetta. Muut avoimet kohdat säilyvät avoimina.

## Otos ja kattavuus

- 30 uutta yritystä: 20 satunnaisesti (siemen 20261021, julkaistun 832 yrityksen indeksistä) ja 10 kohdennetusti. Lisäksi 3 aiemmin tarkistettua yritystä uusintatestiin.
- Kaksi uusinta API-tilikautta kustakin: 66 vertailua. Lisäksi PNRK:n 2019 ja 2020 vanhan, vuoden 2017 taksonomian tarkistus. Yhteensä 68 yritys–tilikausiparia.
- Alkuperäinen asiakirja löytyi 62/68 parille (uusimmista 60/66). Puuttuvat kuusi eivät ole hyväksyttyjä tarkistuksia.
- Uusimpien tilikausien lähde–API-vertailussa 1 443 riviä täsmäsi ja 35 erosi. 1 741 jäi käsintarkistukseen, 4 635 ilman vertailukelpoista lähdelukua ja 66 ilman lähdekartoitusta. Nämä eivät ole vahvistettuja rivejä. Kaikki 120 mahdollista riviä eivät sovellu jokaiselle yritykselle.
- API–julkaistu sivu: 2 939 vertailukelpoista riviä täsmäsi, ei eroja. Loput 4 981 mahdollista riviä eivät olleet vertailtavissa. Vanhat PNRK-kaudet eivät näy nykyisellä sivulla.
- Rivimäärät ovat tarkistuksia, eivät riippumattomien virheiden määriä: sama virhe voi näkyä useassa summassa tai tunnusluvussa.

## Kolme merkittävää löydöstä

| Yritys ja tilikausi | Alkuperäinen | API | Selitys |
| --- | ---: | ---: | --- |
| STCC Holding, 2025, varat | 3 786 415 SEK | 7 067 036 SEK | Sama sijoitus tulee mukaan sekä lyhytaikaisena että pitkäaikaisena. |
| STCC Holding, 2024, varat | 4 643 818 SEK | 8 284 545 SEK | Sama kaksinkertainen laskenta. |
| Munters Europe, 2025, oma pääoma | 225 585 000 SEK | 225 585 SEK | Tiedoston kaksi samannimistä lukua käyttävät eri mittakaavaa. API vastaa väärän mittakaavan kohtaa. |
| FilmLance International, 2025, oma pääoma | 23 098 000 SEK | 23 098 SEK | Sama mittakaavaongelma. |

STCC:n varsinaisen taseen lyhytaikainen sijoitus viittaa liitetietoon 4.
Liitetiedon otsikko ja koneellinen tunniste luokittelevat saman sijoituksen pitkäaikaiseksi.
Molemmat lähdetunnisteet siis todella löytyvät: kyse ei ole perusteesta muuttaa
kaikkien yritysten pitkäaikaisten arvopaperien kenttäkartoitusta.

Muntersin ja FilmLancen varsinaisen taseen oma pääoma käyttää scale=3:a,
oman pääoman muutostaulukon saman näkyvän luvun tunniste scale=0:a.
Oikea tasearvo täsmäyttää taseen. API:n vastattavien summa jää vastaavasti
225 359 415 SEK ja 23 074 902 SEK liian pieneksi.
Tarkistin ei valitse ristiriitaisista oman pääoman faktoista yhtä hiljaa: rivi jää käsintarkistukseen.

Tarkistuspaketissa yrityskohtaiset raportit sisältävät linkit lähdekohtiin ja tiedostojen tarkistussummat.
Muntersin olennaiset ankkurit ovat statement-audit-1-41 (scale=0) ja -1-140 (scale=3),
FilmLancen statement-audit-0-46 ja -0-115.

## Muut erot ja tunnusluvut

HEAB:n 2025 yhden kruunun erot löytyvät jo alkuperäisen asiakirjan sisäisestä laskennasta:
rahoituserien osat ovat yhteensä -514 308 SEK, ilmoitettu välisumma -514 309 SEK.
Taseen osat ovat 4 722 032 SEK mutta ilmoitettu loppusumma 4 722 031 SEK.
API seuraa osassa rivejä eri laskentapolkua. Eroja ei muutettu hyväksytyiksi toleranssia kasvattamalla.

Myös Engaholmsin, Lunin, Gamla Stansin, Konradssonin ja Talarforumin pienissä eroissa on alkuperäisen
osien/summien tai päällekkäisten faktojen ristiriitoja. Hedmansin kuuden rivin ja
Brandtin palkka/sivukulujen, Nordbergsin korkokulujen sekä Fred & Friendsin liiketuloksen/korkokulujen erot vastaavat uudempien tilinpäätösten vertailulukuja.
PNRK:n 2019 yhden kruunun kassavaroero vastaa vuoden 2020 vertailulukua.
Brightecin aiemmat pienet erot säilyivät näkyvissä; pelkkä osien pyöristys ei ole yleinen hyväksyntäsääntö.

Kahdeksan apulaskelman ja yhden kartoittamattoman rivin hyväksyntää ei avattu.
Tuotannon 103 lähdekartoitusta ja 631 laskentamäärittelyä ovat ennallaan 16.10. verrattuna.
Tunnuslukujen koostumus selvitettiin pidemmälle nykyisestä formulas-repon masterista
(f7cd853a1a6aef4c14d09e9c1b6a577d410998f5), mutta mallin käyttöönoton vastaavuutta ja
kaikkien osatekijöiden riippumatonta ruotsalaista lähdettä ei ole vahvistettu.
Esimerkiksi käyttökate sisältää poistoja laajemman oikaisun, quick ratio myös erillisiä
rahoitusvaroja ja oman pääoman tunnusluvut pääomalaina-/konsernioikaisuja.
Puuttuvia osia ei oleteta nollaksi. Lyhyisiin saamisiin sisältyvä maksamaton osakepääoma
on nykyisen laskentakaavan mukainen; sitä ei poistettu vanhan SQL:n perusteella.

Luni Metallin molemmat kaudet varmistivat lyhennetyn tuloslaskelman tapauksen: liikevaihtoa ei ole ilmoitettu, mutta alkuperäisen BruttoresultatKostnadsslagsindelad-luvut 21 485 735 SEK (2025) ja 28 641 592 SEK (2026) vastaavat API:n bruttotulosta. Liikevaihtoa ei tulkittu nollaksi. Automaattinen grossProfit-rivi jää tässä vielä käsintarkistukseen, koska sen suora lähdetunniste ei kata tätä bruttotuloksen varianttia; edellä on erillisen käsintarkistuksen tulos.

## Mitä korjasimme itse

Tarkistustyökalu tunnisti osan yhdistetyistä tilinpäätös–tilintarkastuskertomustiedostoista
pelkiksi tilintarkastuskertomuksiksi. Korjaus käyttää varsinaisia XBRL-faktoja ja GAAP-skeemaviittausta
pelkkien nimiavaruusilmoitusten sijaan. Erilliset tilintarkastuskertomukset säilyvät erillisinä.
Korjauksen jälkeen aiemmin ohitetut asiakirjat tarkistettiin uudelleen.
129 tarkistustyökalun testiä läpäisi. Sivuston tai tuotantokannan lukuja ei muutettu tässä työssä.

API-haut ovat 21.10.2026. Pääotoksen uudelleenvertailussa käytettiin saman päivän talteen otettuja
API-vastauksia; jokaisen raakakentän vastaavuus alkuperäiseen ajon raporttiin tarkistettiin ennen vertailua.
Julkaistu sivu haettiin uudelleen. Alkuperäinen HEAB:n tilapäinen hakuvirhe ratkesi uusintahaulla.

## Koko julkaistun joukon lisäseulonta

832 yrityssivun näkyvien tasesummien aritmeettinen seulonta onnistui kaikille sivuille.
30 yrityksellä ainakin yhden näkyvän vuoden varat ja vastattavat eroavat yli 1 tkr.
Yhden tkr:n raja sallii kahden itsenäisesti pyöristetyn summan eron.
Nämä ovat tarkistuskohteita, eivät 30 vahvistettua tuontivirhettä.
Seulonta ei vertaa kaikkien 832 yrityksen alkuperäisiä tilinpäätöksiä/API:a.
Munters ja FilmLance poimittiin tähän lähdetarkistukseen juuri tästä listasta.

## Mitä seuraavaksi

1. Korjataan tiedon tuonnissa saman sijoituksen päällekkäinen käsittely ja ristiriitaisten fakta-arvojen mittakaavan valinta. Ensisijaisen taseen, liitetietojen ja yksiköiden erottelu tarvitaan; yrityskohtainen vähennys tai kaikkien lukujen kertominen tuhannella ei ole turvallinen korjaus.
2. Ajetaan tuonti uudelleen ainakin kolmelle vahvistetulle yritykselle ja tarkistetaan sekä lähde–API että API–sivu. Tämän työtilan sivustokorjaus ei korjaisi järjestelmän alkuperäistä virhettä.
3. Käydään läpi jäljellä oleva tase-erolista ennen suurta laajennusta ja vahvistetaan avoimien tunnuslukujen lähdeosat. Puuttuvat alkuperäiset hankitaan erikseen tai jätetään selvästi vahvistamattomiksi.

Tuotantokantaan ei kirjoitettu, raporttigeneraattoria ei ajettu eikä Aceen lähetetty kommenttia.
