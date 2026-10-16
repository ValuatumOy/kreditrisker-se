# Paikallinen tilinpäätösten tarkistus

Työkalu helpottaa käsintarkistusta: alkuperäinen tilinpäätös näkyy vieressä,
asiakirjan voi avata omalle ruudulle ja yrityssivulle sekä CV-järjestelmään pääsee linkeistä.
63 rivin lähdesäännöt ja 120 mahdollisen taulukkorivin API–sivuvertailu
auttavat löytämään tarkistettavat kohdat. Vertailujen kattavuus näkyy erikseen.

## Käynnistä

Tarvitset projektin Node-ympäristön ja Python 3:n. Projektin juuressa:

```powershell
npm run audit:statements
```

Avaa `http://127.0.0.1:4332/`. Hae yritys nimellä tai organisationsnummerilla,
valitse tilikausi ja paina **Hae ja vertaa**. Tilinpäätös haetaan automaattisesti
Bolagsverketistä. Kun Valuatumin API-tunnus on asetettu, myös yrityshaku ja
tilinpäätösluvut haetaan suoraan API:sta. Tarkistajan ei tarvitse tuoda tiedostoja.

Ilman API-tunnusta mukana on S M Entreprenadin tallennettu REST-esimerkki.
Näkymä ja raportti kertovat, käytetäänkö tallennettuja lukuja vai API-hakua.
Tuoreen API-haun epäonnistumista ei peitetä siirtymällä hiljaa vanhaan välimuistiin.

## Valuatumin yhteys: ylläpitäjän kertaluonteinen asetus

Projektin juureen paikallinen `.env`, joka ei kuulu Gitiin:

```dotenv
PUBLIC_VALUATUM_API_BASE_URL=https://sweden.valuatum.com
SECRET_VALUATUM_API_TOKEN=<oikea API-tunnus>
```

Jenkinsin nykyinen credential on `kreditrisker-se-api-token`; jobin ohje viittaa
KeePassiin. Tunnusta ei näytetä selaimessa tai tallenneta tarkistusraporttiin.
Käynnistä työkalu asetuksen jälkeen uudelleen. Yrityshaku käyttää samaa
`/rest/company?name=...` / `?code=...` -rajapintaa kuin DK-sivuston API-asiakas.
Haussa hyväksytään vain yksi tuontimalli. Oletusarvoiset analystName-arvot ovat
`Data Import` ja `Bolagsverket data import`; tarvittaessa niitä voi määrittää
`SE_AUDIT_MODEL_ACCOUNTS`-asetuksella pilkulla erotettuina. Epäselvää mallia ei valita arvauksella.
Haku ei käynnistä raporttigeneraattoria tai tee muutoksia kantaan.

Jos koko hakemiston `staticparams.txt` on jo saatavilla, ylläpitäjä voi antaa
`--params polku/staticparams.txt` tai `BUILD_STATIC_PARAMS_FILE_ALL`-asetuksen.
Tämä esitäyttää yrityslistan ja mallien tunnukset; tarkistaja käyttää samaa valintanäkymää.

## Valmiin aineiston käyttö vaihtoehtona

Tiedostot voi antaa myös käynnistyksessä:

```powershell
npm run audit:statements -- --bundle "polku/valuatum.json" --filing "polku/5561939215_2026-06-30.zip"
```

`--fid 52` esilataa yrityksen REST-vastauksen nykyisellä projektin API-asiakkaalla.
Tarkistusnäkymän automaattihaku ohittaa REST-välimuistin ja hakee luvut uudelleen.
**Lähdetiedostot ja järjestelmälinkki** sisältää myös käsintuonnin.
Tuonti valitsee **Käytä itse tuotuja tiedostoja automaattihaun sijaan** -tilan.
Liitä CV-yrityssivun osoite, jos haluat avata järjestelmän toiselle ruudulle.
`--site-origin URL` vaihtaa sivuston, `--system-url URL` asettaa CV-linkin ja
`--source-url URL` tallentaa alkuperäisen latausosoitteen tarkistusraporttiin.
`--port 4333` vaihtaa portin. Tarvittaessa `SE_AUDIT_PYTHON` määrittää Pythonin polun.

## Tarkistajan työnkulku

1. Hae yritys nimellä tai organisationsnummerilla. Valitse tilikauden päättymispäivä ja paina **Hae ja vertaa**.
2. Tarkista yrityksen nimi, organisationsnummer ja tilikausi asiakirjasta.
3. Avaa alkuperäinen asiakirja omalle ruudulle. Avaa CV tai yrityssivu toiselle ruudulle.
4. **Näytä lähdeluku** vie juuri vertailussa käytetyn luvun kohdalle.
5. Näytä tarvittaessa vain erot ja käsintarkistettavat. Tarkista myös rivit ja liitetiedot,
   joita lähdevertailu ei kata. **Kaikki 120 riviä** näyttää myös yksityiskohtaiset
   taulukkorivit ja tunnusluvut. Tilintarkastuskertomus on erikseen avattavissa.
6. **Lataa tarkistus** tallentaa JSON-raportin lähdetietoineen.

## Mitä automatiikka tarkistaa

- Liikevaihto, bruttotulos, liiketulos, tulos rahoituserien jälkeen ja tilikauden tulos.
- Vaihto-omaisuus, taseen loppusumma, oma pääoma, verottamattomat varaukset,
  pitkä- ja lyhytaikaiset velat, oma pääoma ja velat yhteensä sekä rahat ja pankkisaamiset.
- Keskimääräinen henkilöstömäärä.
- Lisäksi 49 yksityiskohtaista riviä: mm. myyntisaamiset, ostovelat, konsernisaamiset
  ja -velat, osakepääoma, liikearvo, kehittämismenot, poistot ja korkokulut.

Säännöt ovat tiedostossa `scripts/statement-audit/source-rules.json`. Suorat
säännöt perustuvat 14.10.2026 luettuihin tuotannon lähdemäppäyksiin; kolme
välisummaa vertaa vastaavaan suoraan iXBRL-käsitteeseen. Miljoonamuunnos ja
kulujen etumerkit käsitellään erikseen. Alkuperäinen arvo, yksikkö ja lähdeankkuri
säilyvät raportissa; etumerkin vaihto näytetään myös tarkistajalle.
Ehdolliset laskelmat, jäännöserät ja tunnuslukujen lähdelaskenta ovat vielä tekemättä.

Vertailu kulkee alkuperäinen iXBRL → Valuatumin REST → julkaistun sivun HTML.
CV-käyttöliittymää tai PDF-raporttia ei lueta automaattisesti; ne tarkistetaan linkistä käsin.
Valuatumin summat muunnetaan miljoonista kruunuiksi, sivun tkr-luvut kruunuiksi.
Sivun pyöristykselle sallitaan 500 kr; alkuperäiselle luvulle sen ilmoitettu tarkkuus.

**Täsmää** edellyttää molempien vertailujen onnistumista. Väärä tai epäselvä yritys,
tilikausi, yksikkö, konsernikonteksti, ristiriitaiset lähdeluvut tai tuntematon
iXBRL-muunnos jäävät tarkistettaviksi. Alkuperäisestä puuttuvaa lukua ei päätellä nollaksi.
RESTistä pois jätettyihin tilinpäätöseriin sovelletaan nykyistä nollakäytäntöä, mutta
puuttuva liikevaihto ja nollasta poikkeava bruttotulos jättävät liikevaihdon epävarmaksi.
Suoraan ilmoittamaton bruttotulos tarkistetaan laskelmana käsin.

API–sivuvertailu kattaa 31 tuloslaskelmariviä, 82 taseriviä, kuusi tunnuslukua ja
henkilöstömäärän. Prosentit muunnetaan API:n suhdeluvuista prosenttiyksiköiksi;
sallittu pyöristys vastaa sivun näyttötarkkuutta. Sivulta pois jätettyjä rivejä
ei hyväksytä täsmääviksi. Samannimiset rivit yksilöidään `data-metric-key`-avaimella.
57 riviltä puuttuu vielä alkuperäisen tilinpäätöksen vertailusääntö: ne saavat
**Ei tarkistettu** -tilan lähdevertailussa, vaikka API ja sivu täsmäisivät.
Liitetiedot, kaaviot ja CV:n käyttöliittymä eivät kuulu tähän taulukkotarkistukseen.
Vihreä yksittäinen vertailu ei hyväksy koko tilinpäätöstä.
REST-vastauksen hakupäivä ja verkkosivun tarkistushetki näytetään, koska tiedot voivat
olla eri päivityksistä.

Verkkosivun hyväksyminen edellyttää taulukon yritys- ja tilikausitietoja
(`data-orgnr`, `data-period-start/end/months`, `data-consolidated`). Ne lisättiin
yrityssivujen HTML:ään tätä työkalua varten. CloudFrontin 16.10.2026 versiossa
tiedot ovat mukana; kahdeksan kauden julkaistut luvut voitiin varmistaa.
Vanha sivu ilman näitä tietoja jää edelleen käsintarkistettavaksi.

## Mistä alkuperäinen tiedosto tulee

[Bolagsverketin tiedostopalvelu](https://vardefulla-datamangder.bolagsverket.se/arsredovisningar/)
sisältää viikkopaketit. Työkalu lukee niiden tiedostohakemistot HTTP Range -pyynnöillä
ja hakee täsmälleen valitun yrityksen ja päättymispäivän ZIP:n. Kokonaisia viikkopaketteja
ei ladata. Ladatun yritystiedoston koko ja CRC tarkistetaan.

Hakemistot ja yritystiedostot jäävät paikalliseen välimuistiin. Pakettien lista päivitetään
tunnin välein, ja uudempien pakettien mahdolliset korjatut tilinpäätökset tarkistetaan
ennen vanhan yritystiedoston käyttöä. Samassa paketissa olevia epäselviä vaihtoehtoja
ei valita arvauksella. Vanhojen tai puuttuvien tilinpäätösten ensihaku voi tutkia monta
pakettia ja kestää useita minuutteja. Näkymä näyttää edistymisen; **Peru haku** pysäyttää
työn viimeistään nykyisen verkkopyynnön valmistuttua.

Myöhemmin yrityskohtaiseen automaattihakuun voi käyttää
[Bolagsverketin API:a](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder/apiforvardefulladatamangder.5513.html),
joka edellyttää asiakasrekisteröintiä ja OAuth-tunnuksia. Digitaaliset tilinpäätökset
eivät kata kaikkia yrityksiä tai skannattuja asiakirjoja.

## Eräajo ja paketti kollegalle

Ylläpitäjä voi tarkistaa valitut yritykset ja kaksi uusinta tilikautta yhdellä ajolla:

```powershell
npm run audit:batch -- --company 5561939215 --company 5562368075 --company 5564248937 --company 5564480282 --latest 2 --share
```

`--period YYYY-MM-DD` valitsee täsmällisen kauden kaikille valituille yrityksille.
`--output kansio` määrittää tuloskansion. Ajo hakee API:n luvut tuoreina,
tarkistaa tuontimallin ja yritystunnuksen ja käyttää alkuperäisten paikallista
välimuistia. Yksi epäonnistunut tapaus ei katkaise muita. Alkuperäisen puuttuminen
ei estä API–sivuvertailua, mutta lähdelukuja ei silloin hyväksytä.
Prosessin paluukoodi 1 kertoo lukueroista tai hakuvioista; käsintarkistus ja
puuttuva kattavuus näkyvät raportissa myös silloin, kun paluukoodi on 0.

`summary.json` erottaa molemmat vertailut. Jokaiselle yritykselle ja kaudelle
tallennetaan oma raportti. Jos otoksessa on myös uudempi tilinpäätös, työkalu
tarkistaa, selittääkö siinä ilmoitettu saman kauden vertailuluku API:n luvun.
Alkuperäisen asiakirjan ero säilytetään; uudempi lähdetodiste kirjataan erikseen.

`--share` tuottaa ajon kansioon `share.zip`. Kollegan tarvitsee purkaa koko ZIP
ja avata **index.html**. Paketissa on tarkistuksen luvut, tilat, päivämäärät,
alkuperäisten asiakirjojen avausversiot ja linkit juuri valittuihin lähdelukuihin.
Asiakirjat ja ZIP-hashit varmistetaan ennen liittämistä. Avausversioista poistetaan
aktiivinen sisältö; API-avaimet ja kokonaiset REST-vastaustiedostot eivät tule mukaan.
Paketti toimii ilman asennusta ja yhteyttä API:in. Verkkosivulinkit tarvitsevat verkon.
Tämä on tallennettu otos: vastaanottaja voi tarkistaa sen rivejä itse, mutta uusia
yrityksiä varten tarvitaan uusi ajo tai paikallinen työkalu.

Jo tehdyn ajon voi paketoida ilman verkkohakuja:

```powershell
python scripts/statement-audit/share.py --run data/statement-audit/runs/<ajo> --output <jakokansio>
```

Jatkuvaan kollegakäyttöön suositus on yksi sisäinen, kirjautumisella suojattu
osoite ja palvelimelle asetettu API-tunnus. Nykyinen paikallinen palvelin pitää
ennen sitä muuttaa käyttäjäkohtaisiksi hauiksi ja pysyviksi raporttitunnuksiksi:
sen asiakirja ja aktiivinen haku ovat nyt yhteisiä saman prosessin selaimille.
Nykyistä palvelinta ei siis pidä sellaisenaan avata julkiseen verkkoon.
Satunnaistarkistaja valitsisi yrityksen ja kauden; ylläpitäjä ajaisi erävertailut
ja jättäisi erot sekä puuttuvat lähteet tarkistajan työlistaksi.

## Uusintatarkistus 16.10.2026

Yritysnumerohaku korjattiin API:n nykyiseen muotoon `556193-9215`.
Tarkistaja voi edelleen kirjoittaa tunnuksen väliviivalla tai ilman sitä.
Sama neljän yrityksen ja kahdeksan kauden otos haettiin uudelleen API:sta.
Julkaistun CloudFrontin kaikki 413 vertailtavaa solua täsmäsivät API:in.

Lähdesäännöt laajenivat 14:stä 63:een. Sääntöjen lukumäärä ei tarkoita,
että kaikki nämä rivit löytyisivät jokaisesta asiakirjasta tai täsmäisivät.
Puuttuvat ja epäselvät lähdeluvut pysyvät erillään hyväksytyistä. Otoksessa
160 lähdelukua täsmäsi ja seitsemän eroa jäi näkyviin. Kaikkia uusia käsitteitä
ei löytynyt näistä yrityksistä, joten koko sääntöjoukkoa ei ole vahvistettu
oikealla asiakirjaesimerkillä.

103 työkalutestiä ja 57 sivustotestiä läpäisivät. Sivuston build valmistui
84 sivulla. Kollegapaketin 169 lähdeankkuria tarkistettiin. Riippumaton tarkistus
kävi läpi etumerkit, yksiköt, kausityypit ja yrityskontekstin suojaukset.

Erot ja niiden jatkokäsittely:

- S M Entreprenadin 2025 lyhytaikaiset velat vastaavat uudemman tilinpäätöksen
  vertailulukua. Alkuperäisen vuoden 2025 asiakirjan ero säilyy näkyvissä.
- Brightecin kummankin vuoden tasesummien 1 000 kr erot sopivat osalukujen
  erilliseen tuhansiin pyöristykseen. Esimerkiksi 2025 varojen osat ovat
  2 707 000 + 10 709 000 + 8 922 000 = 22 338 000 kr, mutta asiakirjan suora
  loppusumma on 22 337 000 kr. Toleranssia ei kasvatettu.
- Brightecin 2025 tuloslaskelman tulos on lähteessä 2 583 000 kr ja API:ssa
  2 582 000 kr. Lähteestä johdettu pyöristetty komponenttilaskelma
  3 032 000 − 113 000 − 150 000 − 187 000 = 2 582 000 kr vastaa API:a.
  Ero sopii pyöristykseen, mutta tämä ei todista API:n sisäistä laskentasääntöä.
- Brightecin 2024 taseen tilikauden tulos on tarkassa liitetiedossa 8 429 503 kr,
  mutta API vastaa tuhansiin pyöristettyä 8 430 000 kr riviä. Tarkemman luvun
  497 kr ero säilytetään. Vuoden 2025 tarkka vastaava rivi täsmää.
- Atean 2025 rahoitusomaisuuden suora välisummavertailu jätettiin pois:
  lähteen 1 155 450 659 kr sisältää 7 029 119 kr laskennallista verosaamista,
  kun API:n `cr_investments_total` 1 148 421 540 kr ei sisällä sitä.
  Verosaaminen tarkistetaan omana rivinään. Suora vertailu antaisi väärän hälytyksen;
  koko välisumman lähdelaskenta vaatii erillisen luokittelusäännön.
- Lyhytaikaisten saamisten välisumman suora sääntö odottaa vielä maksamattoman
  osakepääoman luokittelun varmistusta. Sen yksittäiset saamisrivit tarkistetaan.
- Atean 2024 alkuperäinen ei edelleenkään löytynyt. Sen lähdelukuja ei hyväksytty.

Kantaan tai tuotannon laskentasääntöihin ei tehty muutoksia. Jäljelle jäävät
selvitykset ovat työlistaa, eivät päätös muuttaa lukuja tai lähettää kaikki teknisille.

## Moniyritystesti 14.10.2026

Tuore REST-haku, Bolagsverketin automaattihaku ja vertailu ajettiin neljälle
yritykselle, kahdelle uusimmalle kaudelle. Kahdeksan kausivertailua
onnistui ilman hakuvikoja; alkuperäinen löytyi seitsemälle kaudelle.

| Yritys / kausi päättyy | Lähde → API: täsmää / ero / käsin / puuttuu | Paikallinen uusi sivu → API: täsmää |
| --- | --- | --- |
| S M Entreprenad / 2026-06-30 | 13 / 0 / 1 / 0 | 53 |
| S M Entreprenad / 2025-06-30 | 11 / 1 / 1 / 1 | 53 |
| Brightec / 2025-12-31 | 9 / 3 / 2 / 0 | 61 |
| Brightec / 2024-12-31 | 10 / 2 / 2 / 0 | 61 |
| Aros Städ / 2025-12-31 | 9 / 0 / 1 / 4 | 28 |
| Aros Städ / 2024-12-31 | 9 / 0 / 1 / 4 | 28 |
| Atea / 2025-12-31 | 13 / 0 / 1 / 0 | 65 |
| Atea / 2024-12-31 | 0 / 0 / 1 / 13 | 64 |

Lähdevertailun luvut koskevat 14 päälukua. Lisäksi jokaisella kaudella 106 riviä
on ilman lähdesääntöä. Paikallisista, tuoreesta REST-aineistosta rakennetuista
44 sivusta tarkistettiin yritystaulukoiden 413 vertailtavaa solua: kaikki täsmäsivät
API:in pyöristyksen rajoissa. Muita mahdollisia rivejä ei ollut näkyvissä tai niiltä
puuttui vertailtava arvo; niitä ei laskettu hyväksytyiksi. **Julkaistun CloudFrontin
sivuvertailut jäivät käsintarkistettaviksi**, koska vanhasta HTML:stä puuttuvat tarkat
yritys-/kausitiedot. Jenkinsin yrityssivut tarvitsevat uuden rakennuksen nykyisestä
mainista (koko hakemistolle `COMPANIES=all`). Tätä tuotantoajoa ei tehty tässä testissä.

Korjaukset: yritys- ja konsernikontekstien erottelu Brightecin asiakirjoissa,
120 rivin kattavuus, prosenttien yksiköt, samannimisten rivien avaimet,
puuttuvan alkuperäisen selkeä käsittely ja rajattu rinnakkainen pakettihaku.

S M Entreprenadin 2025 lyhytaikaiset velat ovat vuoden 2025 alkuperäisessä
73 365 587 kr, uudemman vuoden 2026 tilinpäätöksen vertailuluvussa 71 387 079 kr.
API vastaa uudempaa vertailulukua. Brightecin 2025 tulos on lähteessä 2 583 000 kr
ja API:ssa 2 582 000 kr; taseen loppusumma ja oma pääoma + velat ovat 22 337 000
vs. 22 338 000 kr. Vuonna 2024 samat tasesummat ovat 20 682 000 vs. 20 683 000 kr.
Eroja ei peitetty kasvattamalla toleranssia tai muuttamalla kantaa.
Atean 2024 alkuperäistä ei löytynyt 858 vuosien 2024–2026 viikkopaketista.

Nykyiset 103 Bolagsverketin lähdemäppäykset luettiin myös tuotannon ai/IAM-tilillä,
pelkkänä metatietojen lukuoperaationa. Tämä poisti Excelin käyttöönottoon liittyvän
epävarmuuden. Aggregaattien, ehtojen, etumerkkien ja laskettujen tunnuslukujen
riippumaton toteutus tarkistimeen on silti tekemättä; kartoituksen olemassaolo ei
yksin vahvista kaikkia lähderivejä. Tätä laajennusta voidaan jatkaa itse ilman,
että teknisten tarvitsee ensin toimittaa uutta mäppäystiedostoa.

102 työkalutestiä ja 57 sivustotestiä läpäisivät. Riippumaton tarkistus vahvisti
paketin lähdehashit, kaikki 82 lähdeankkuria ja kattavuusrajausten säilymisen.

## Paikallinen säilytys

Palvelin kuuntelee vain tämän koneen osoitteessa `127.0.0.1`. Asiakirjat luetaan
muistiin ja näytetään ilman skriptejä tai ulkoisia verkkopyyntöjä.
`data/statement-audit/` sisältää paikalliset asetukset, REST-haut, Bolagsverketin
hakemistovälimuistin ja yritystiedostot sekä viimeisimmän onnistuneen raportin;
hakemisto on Gitistä pois rajattu. Käsin valitut alkuperäistiedostot
säilyvät niiden omassa kansiossa. Työkalua ei rakenneta julkisille yrityssivuille.

Käyttöliittymän suunta: rauhallinen sisäinen tarkistuspöytä, jossa lähde ja luvut ovat
rinnakkain. Tärkein tehtävä on yrityksen ja tilikauden varmistaminen, lähdeluvun
avaaminen ja eron selvittäminen. Päätoiminnot ovat näppäimistöllä käytettäviä,
numerot tasalevyisiä ja kapealla ruudulla taulukolla on oma vaakavieritys.

```powershell
npm run test:audit
npm test
npm run build
```

Ensimmäinen oikea esimerkki: S M Entreprenad, 2025-07-01–2026-06-30,
Bolagsverketin `2026/39_1.zip`-paketin yrityskohtainen ZIP ja 12.10.2026 haettu REST.
Uudelleen rakennetun sivun vertailussa 13 pääluvun molemmat vaiheet täsmäsivät;
bruttotulos jäi käsintarkistettavaksi, koska alkuperäisessä ei ole suoraa bruttotulosriviä.
Vanhan CloudFront-sivun yritys-/kausitietojen puuttuminen esti automaattisen hyväksynnän.
45 parseri-/vertailutestiä ja 57 sivustotestiä läpäisivät; näyteaineiston build tuotti 34 sivua.

Automaattihaku löysi saman 83 973 tavun yritystiedoston 13 uusimman paketin
hakemistoista noin 20 sekunnissa; välimuistihaku kesti 0,28 sekuntia. 67 työkalutestiä
läpäisivät, mukaan lukien osittaiset ZIP-lataukset, CRC-virheet, oikean Node-asiakkaan
REST-haku paikallista testi-API:a vasten, väärän yrityksen/mallin torjunta,
peruutus ja vanhan raportin poistuminen epäonnistuneessa haussa.
14.10.2026 yhteys kokeiltiin myös oikealla Ruotsin REST-API:lla paikallisen tunnuksen
asettamisen jälkeen. S M Entreprenadin nimihaku löysi mallin 52, tilikausivalinta
2026-06-30 haki luvut uudelleen API:sta (backendMode `live`, hakupäivä 14.10.2026),
ja automaattinen Bolagsverket-haku löysi saman tilinpäätöksen hakemistojen ja
yritystiedoston välimuistia hyödyntäen. Käyttöliittymässä 13 päälukua täsmäsi,
eroja oli 0 ja bruttotulos jäi käsintarkistettavaksi. Tiedostoja ei tuotu käsin.
Paikallinen `.env` ja tunnus pysyvät Gitin ulkopuolella.
