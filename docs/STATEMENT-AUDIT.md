# Paikallinen tilinpäätösten tarkistus

Työkalu helpottaa käsintarkistusta: alkuperäinen tilinpäätös näkyy vieressä,
asiakirjan voi avata omalle ruudulle ja yrityssivulle sekä CV-järjestelmään pääsee linkeistä.
14 pääluvun automaattinen vertailu auttaa löytämään tarkistettavat kohdat.

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
   joita 14 pääluvun vertailu ei kata. Tilintarkastuskertomus on erikseen avattavissa.
6. **Lataa tarkistus** tallentaa JSON-raportin lähdetietoineen.

## Mitä automatiikka tarkistaa

- Liikevaihto, bruttotulos, liiketulos, tulos rahoituserien jälkeen ja tilikauden tulos.
- Vaihto-omaisuus, taseen loppusumma, oma pääoma, verottamattomat varaukset,
  pitkä- ja lyhytaikaiset velat, oma pääoma ja velat yhteensä sekä rahat ja pankkisaamiset.
- Keskimääräinen henkilöstömäärä.

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

Tunnuslukujen määritelmät, kaikki yksityiskohtaiset tilinpäätösrivit ja liitetiedot
eivät kuulu automaattiseen vertailuun. Vihreä yhteenveto ei hyväksy koko tilinpäätöstä.
REST-vastauksen hakupäivä ja verkkosivun tarkistushetki näytetään, koska tiedot voivat
olla eri päivityksistä.

Verkkosivun hyväksyminen edellyttää taulukon yritys- ja tilikausitietoja
(`data-orgnr`, `data-period-start/end/months`, `data-consolidated`). Ne lisättiin
yrityssivujen HTML:ään tätä työkalua varten. Vanha CloudFront-versio näyttää luvut,
mutta sivuvertailu jää käsintarkistettavaksi, kunnes yrityssivut rakennetaan uudelleen.

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

## Säilytys ja kehitys

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
