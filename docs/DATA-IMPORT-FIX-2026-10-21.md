# STCC:n, Muntersin ja FilmLancen tuontikorjaus 21.10.2026

Tuontikorjaus on tuotannossa. Kolme yritystä tuotiin uudelleen normaalin tuontijonon kautta,
ja oikeat luvut varmennettiin tuoreista REST-vastauksista. Yritysten ja mallien tunnukset sekä
kaikki aiemmat tilikaudet säilyivät (STCC kuusi kautta 2020–2025, muilla kaksi 2024–2025).

## Varmennetut luvut (SEK)

| Yritys | Mittari | 2025 korjauksen jälkeen | 2024 korjauksen jälkeen |
| --- | --- | ---: | ---: |
| STCC Holding, 5563135028 | Varat yhteensä | 3 786 415 | 4 643 818 |
| Munters Europe, 5563803039 | Oma pääoma | 225 585 000 | 951 000 |
| FilmLance International, 5563185437 | Oma pääoma | 23 098 000 | 17 628 000 |

Vuoden 2024 luvut tarkistettiin myös vuoden 2025 alkuperäisen tilinpäätöksen vertailusarakkeesta.
Muntersin ja FilmLancen osakepääoma, vararahasto ja oman pääoman muut erittelyluvut korjautuivat samalla.

## Missä virhe korjattiin

Varsinainen korjaus tehtiin `profinder-environment`-repon tiedostoon
`lib/bolagsverket-xbrl-dataimport/parsing-worker-lambda/se_ixbrl.py`:

- STCC:n liitetiedossa toistuvaa pitkäaikaista arvopaperia ei lasketa uudelleen, kun varsinaisen taseen lyhytaikainen sijoitus ja täsmäävät taseen välisummat osoittavat sen olevan jo mukana. Aidosti erilliset sijoitukset säilyvät.
- Oman pääoman viiden erän yhtä tarkkojen päällekkäisten faktojen valinnassa ensisijainen on varsinainen tase, jolloin väärässä mittakaavassa oleva muutostaulukon fakta ei voita.
- Tarkempia lähdelukuja ei korvata pyöristetyillä tasearvoilla. Samanarvoisen, tarkemman faktan tarkkuus muistetaan myös seuraavissa vertailuissa; tämä estää FilmLancen tuloslaskelman luvun korvautumisen väärin merkityllä kassavirtataulukon luvulla.

[Bitbucket PR 83](https://bitbucket.org/valuatum/profinder-environment/pull-requests/83)
on yhdistetty masteriin (26d9064; korjauscommit bb79c8d).
`BolagsverketXbrlDataimportStackProd` päivitettiin yksinään CDK:n `--exclusively`-valinnalla.
Tarkistettu infrastruktuuriero koski tuonti-Lambdan koodia; Profinderin muita ympäristöjä ei päivitetty.

14 kohdennettua testiä läpäisi. Vanhan ja uuden parserin vertailu tehtiin 62 alkuperäisellä
tilinpäätöstiedostolla; kaikki tiedostot jäsentyivät. Riippumaton tarkistus vahvisti muuttuneet luvut lähteistä
ja Brightecin tarkkojen lukujen säilymisen. Ennen varsinaista tuontia tuotannon koeajoissa
kaikki seitsemän asiakirjaa jäsentyivät ja historiakaudet säilyivät; jonoon tallentunut aineisto
vastasi täsmälleen tarkistettua koeajon aineistoa. Tuontijono tyhjeni käsittelyn jälkeen.

## Sivujen päivityksen välimuistikorjaus

Ensimmäinen rajattu Jenkins-ajo 11 onnistui teknisesti, mutta palautti vanhat luvut sivuille.
S3:n sivutiedostosta varmistettiin, että syy oli Jenkins-työtilan vanha REST-välimuisti.
Korjaus `jenkins/kreditrisker-se.groovy`: tuotannon Fetch-vaihe käyttää nyt
`SE_API_REFRESH=1 npm run fetch`. Vain valittu yrityserä haetaan tuoreena; paikallisen
esikatselun välimuistikäytäntö säilyy. Sivuston 57 testiä läpäisi.
Muutos on mainissa, commit 526b422.

[Jenkins-ajo 12](https://ci.valuatum.com/job/SweCompanyDirectory-ProdUpdate/12/) julkaisi samat kolme yritystä onnistuneesti (ei hylättyjä tai poistettuja yrityksiä). Julkaisun jälkeisessä tuoreessa tarkistuksessa kaikki 298 vertailukelpoista REST–CloudFront-riviä täsmäsivät kuudessa yritys–tilikausiparissa; eroja ei ollut. Muut 422 mahdollista riviä eivät olleet vertailukelpoisia, eikä niitä laskettu hyväksytyiksi. Lähde–API-vertailun ristiriidat ja puuttuvat lähteet säilyvät alla kuvatusti näkyvissä.

## Mitä tämä ei vielä vahvista

Alkuperäisten tiedostojen ristiriitaiset tunnisteet eivät katoa: raaka lähdevertailu voi edelleen
merkitä STCC:n liitetietosijoituksen eroksi ja Muntersin/FilmLancen oman pääoman rivit
käsintarkistukseen. STCC:n vuoden 2024 alkuperäisen tiedoston varsinainen tase luokittelee sijoituksen jo lyhytaikaiseksi (3 640 727 SEK; vuoden 2023 vertailuluku 2 229 494 SEK), vaikka liitetiedon tunniste sanoo pitkäaikainen. Aiempi tämän muistion tulkinta vuoden 2024 pitkäaikaisesta luokittelusta oli virheellinen; se korjattiin laajennetun lähdetarkistuksen yhteydessä. Ero on taseen ja liitetiedon luokitteluristiriita, ei osoitettu muutos lähdeversioiden välillä. Edellä luetellut korjatut arvot tarkistettiin nimenomaan varsinaisesta taseesta,
ei valitsemalla automaattisesti jompikumpi ristiriitaisista faktoista. STCC:n vastattavien
loppusumman yhden kruunun ero on edelleen lähteen osien ja ilmoitetun summan ristiriita.
Näitä havaintoja ei muutettu vihreiksi toleranssia kasvattamalla.

Laajennetun otoksen muut avoimet tapaukset ja tunnuslukujen lähdeosat säilyvät avoimina.
Kolmen yrityksen korjaus ei ole hyväksyntä kaikkien yritysten kaikille luvuille.

Saman päivän jatkotarkistus, loput 27 tase-erolistan yritystä ja avoimet kohdat:
[DATA-BALANCE-REVIEW-2026-10-21.md](DATA-BALANCE-REVIEW-2026-10-21.md).
