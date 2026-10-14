# Paikallinen tilinpäätösten tarkistus

Työkalu helpottaa käsintarkistusta: alkuperäinen tilinpäätös näkyy vieressä,
asiakirjan voi avata omalle ruudulle ja yrityssivulle sekä CV-järjestelmään pääsee linkeistä.
14 pääluvun automaattinen vertailu auttaa löytämään tarkistettavat kohdat.

## Käynnistä

Tarvitset projektin Node-ympäristön ja Python 3:n. Projektin juuressa:

```powershell
npm run audit:statements
```

Avaa `http://127.0.0.1:4332/`. Ensimmäisenä mukana on paikallinen S M Entreprenadin
REST-esimerkki. Valitse **Lähdetiedostot ja järjestelmälinkki** ja tuo yrityksen
tilinpäätös ZIP- tai XHTML-tiedostona. Liitä CV-yrityssivun osoite, jos haluat avata
järjestelmän toiselle ruudulle.

Tiedostot voi antaa myös käynnistyksessä:

```powershell
npm run audit:statements -- --bundle "polku/valuatum.json" --filing "polku/5561939215_2026-06-30.zip"
```

`--fid 52` hakee tuoreen REST-vastauksen nykyisellä projektin API-asiakkaalla;
tämä vaatii `.env`-tiedoston `PUBLIC_VALUATUM_API_BASE_URL`- ja
`SECRET_VALUATUM_API_TOKEN`-arvot. Ilman niitä käytä paikallista JSON-vastausta.
`--site-origin URL` vaihtaa sivuston, `--system-url URL` asettaa CV-linkin ja
`--source-url URL` tallentaa alkuperäisen latausosoitteen tarkistusraporttiin.
`--port 4333` vaihtaa portin. Tarvittaessa `SE_AUDIT_PYTHON` määrittää Pythonin polun.

## Tarkistajan työnkulku

1. Tuo yrityksen ZIP ja saman yrityksen Valuatum JSON. Valitse tilikauden päättymispäivä.
2. Tarkista yrityksen nimi, organisationsnummer ja tilikausi asiakirjasta.
3. Avaa alkuperäinen asiakirja omalle ruudulle. Avaa CV tai yrityssivu toiselle ruudulle.
4. Paina **Vertaa luvut**. **Näytä lähdeluku** vie juuri vertailussa käytetyn luvun kohdalle.
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
sisältää viikkopaketit. Niiden sisältä tarvitaan yrityksen oma
`<organisationsnummer>_<tilikauden-päättymispäivä>.zip`, ei koko viikkopakettia.
Helpoin jatkuva käyttö on ottaa yritystiedostot talteen samassa latauksessa, jossa
nykyinen tuontijärjestelmä jo hakee tilinpäätökset, ja antaa tarkistajalle tiedosto tai
sisäinen latauslinkki. Tämä työkalu ei vielä etsi yritystä kaikista viikkopaketeista.

Myöhemmin yrityskohtaiseen automaattihakuun voi käyttää
[Bolagsverketin API:a](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder/apiforvardefulladatamangder.5513.html),
joka edellyttää asiakasrekisteröintiä ja OAuth-tunnuksia. Digitaaliset tilinpäätökset
eivät kata kaikkia yrityksiä tai skannattuja asiakirjoja.

## Säilytys ja kehitys

Palvelin kuuntelee vain tämän koneen osoitteessa `127.0.0.1`. Asiakirjat luetaan
muistiin ja näytetään ilman skriptejä tai ulkoisia verkkopyyntöjä.
`data/statement-audit/` sisältää paikallisen asetustiedoston, mahdollisen REST-haun
ja viimeisimmän raportin; hakemisto on Gitistä pois rajattu. Valitut alkuperäistiedostot
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
