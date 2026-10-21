# Avoimien lukutarkistusten loppukierros 21.10.2026

Tämä jatkaa [päivän aiempaa tarkistusta](DATA-VISIBLE-ROWS-2026-10-21.md). Kaikki siinä nimetyt avoimet kohdat on tutkittu. Tämä ei tarkoita kaikkien 832 julkaistun yrityksen kaikkien alkuperäislukujen hyväksymistä. Uusia yrityssivuja tai arvioraportteja ei generoida tässä työssä.

## Korjaukset

| Kohta | Mitä löytyi ja mitä muutettiin |
| --- | --- |
| Magnus Thor, varaukset 2025/2024 | Samassa raportissa oleva nolla oli ristiriidassa kahden näkyvän erän kanssa. Erät vahvistettiin rahastojen liitetiedoista, vuoden muutoksista ja taseen loppusummasta. Luetaan ilmoitetut 4 376 061 / 2 450 981 SEK ja 12 069 699 / 9 909 699 SEK omille riveilleen. Nollaa ei muuteta eikä lisätä näiden päälle. Lähteen ristiriita ja edellisen vuoden yhden kruunun ero säilyvät tarkistusmerkintöinä. |
| Magnus Thor, henkilöstö 2023/2022 | Luetaan alkuperäisen raportin ilmoittamat 193 / 207 henkilöä. Naisten ja miesten erittely täsmää summiin. Palkkakuluihin perustuvaa arviota ei käytetä. |
| Kiwa, henkilöstö 2023/2022 | Sama tarkistettu lukutapa löytää ilmoitetut 698,60 / 668,72 henkilöä. Desimaalit ovat lähteen mukaisia: yritys laskee keskimäärän työtunneista. Tuonnissa niitä ei pyöristetä. |
| Livsmedel, vuoden 2021 velat | Vuoden 2022 raportin koko velkataulukko on esitetty miinusmerkkisenä ilman koneellisia merkintöjä. Kuuden velkarivin suuruudet, oma pääoma, loppusumma ja erillinen pankkilainaliite vahvistavat saman kokonaisuuden. Luetaan koko tarkistettu velkaerittely positiivisena; yksittäisiä miinuslukuja ei käännetä yleisesti. Vuoden 2022 sarakkeen yhden kruunun ristiriita estää sen sarakkeen vastaavan lukemisen. |
| Livsmedel, kalusto ja muut pysyvät varat 2022/2021 | Luetaan täsmäävän kokonaisen taseosion näkyvät kalusto-, konserniosuus- ja saamiserät. Sama kalusto oli liitetiedossa väärällä keskeneräisen rakentamisen merkinnällä. Päällekkäinen merkintä poistetaan vain täsmällisen lähdevarmennuksen perusteella; jos se ei onnistu, koko uusi erittely perutaan. Kalustoa ei saa jäädä kahteen kertaan. |
| Luni, bruttotulos | Lähde käytti toista virallista bruttotuloksen nimikettä. Tarkistustyökalu tunnistaa sen nyt. Vuodet 2026/2025 täsmäävät: 28 641 592 / 21 485 735 SEK. Järjestelmän lukua ei tarvinnut muuttaa. |
| Käyttökate ja poistot sivulla | Jos poistoja ei ole saatu ja kulujen esitystapa tai aineelliset/aineettomat varat osoittavat epävarmuuden, poistot ja käyttökate näytetään puuttuvina. Liikevoittoa ei tällöin esitetä vahvistettuna käyttökatteena. Tämä on sivun epävarmuusmerkintä, ei backendin tuloslaskelman oikaisu. |
| Pitkäaikaisten saamisten välisumma | Poistetaan sivulta päällekkäistä kuvaa antava välisummarivi. Luokitellut saamiset säilyvät rahoitusomaisuuden riveissä. Laskennalliset verosaamiset ja erittelemättömät saamiset ovat erillisiä rivejä; puuttuvaa erittelemätöntä määrää ei hyväksytä nollaksi. |

## Selitetyt erot ja puuttuvat alkuperäiset

- **Café Levinsky 2023:** alkuperäisen raportin tulos 134 193 SEK on seuraavan vuoden raportin vertailusarakkeessa 134 194 SEK. Järjestelmä seuraa uudempaa ilmoitettua lukua. Eroa ei korjata palauttamalla vanhaa raporttia uudemman päälle.
- **Raw Sushi 2023:** vastaavasti siirtosaamiset muuttuvat seuraavassa raportissa 186 743 → 186 744 SEK ja lyhytaikaiset saamiset 895 171 → 895 172 SEK. Järjestelmä seuraa uudempaa vertailua.
- **Bike 2024:** erikseen tuhansiin kruunuihin pyöristetyt osaluvut eivät summaudu ilmoitettuihin loppusummiin. Järjestelmä laskee kokonaisuudet osista. Ero on selitetty; osalukuihin ei lisätä keksittyä tasauserää eikä tarkistusrajaa kasvateta.
- **Magnus Thorin yhden kruunun jäännöserot:** vuoden 2025 näkyvä varasto 2 221 995 + saamisten ilmoitettu välisumma 16 024 527 + kassa 27 034 033 = 45 280 555 SEK, mutta raportin lyhytaikaiset varat ovat 45 280 556. Järjestelmän varat ovat siksi 104 167 764 ja lähteen loppusumma 104 167 765 SEK. Vuoden 2024 taseessa on lisäksi aiemmin dokumentoitu yhden kruunun sisäinen ristiriita. Suuri varauspuute on korjattu; lähteen pientä sisäistä eroa ei peitetä tasaamalla osia.
- **Kuusi puuttuvaa oman vuoden raporttia:** Finsliparna 2025-04-30, Talarforum 2024-12-31, Konradsson 2025-05-31, HEAB 2024-12-31, Munters 2024-12-31 ja FilmLance 2024-12-31. Uusi haku ei löytänyt niitä. Kaikille löytyi täsmällisen tilikauden vertailusarake uudemmasta virallisesta raportista: 159 vertailukelpoista lähde–API-riviä täsmäsi, eroja 0. Raportteihin merkitään käytetty lähdevuosi. Tämä ei vahvista puuttuvan alkuperäisen ja uudemman version yhtäpitävyyttä.

## Mitä ei voida vielä hyväksyä

| Kohta | Miksi se jää auki |
| --- | --- |
| Svetsekonomi 2025 | Raportti näyttää varaukset negatiivisina, mutta loppusumma ja aiemman vuoden alkuperäinen tukevat positiivista merkkiä. Samassa raportissa ei ole riittävää riippumatonta vahvistusta automaattiselle etumerkin vaihdolle. Lähderistiriita vaatii vahvistuksen raportin laatijalta tai korjatun lähteen. |
| Shekhar 2022 | Uudempi virallinen raportti muuttaa vanhan tilikauden tuloslaskelman nolliksi ja taseen 1 323 056 → 688 537 SEK. Järjestelmä noudattaa uudempaa raporttia. Muutosten syytä ei selitetä sen kertomuksessa tai liitetiedoissa; emme vaihda takaisin vanhaan versioon arvaamalla. |
| Tunnuslukujen ja välisummien puuttuvat lähdeosat | Käyttökatteen, omavaraisuusasteen, quick ration, pankkilainojen ja saamisten kaikkia laskennan lähtötietoja ei saada riippumattomasti lähteestä. Tuotantokannan laskentamääritelmiä tarkistettiin vain lukemalla. Tarkistustyökalun liian yksinkertaiset osakaavat korvattiin täysillä määritelmillä: puuttuva osa estää hyväksynnän, vaikka osalaskelma sattuisi täsmäämään. ROE:n tuotantokaava vahvistettiin; puuttuva edellinen tilikausi tai vähemmistöosuus jättää kyseisen vertailun tarkistettavaksi. |
| Livsmedel 2021, tuloslaskelman erittely | Uudempi lyhennetty vertailu ei anna kaikkia vanhan raportin kulu- ja poistotietoja, ja näkyvä funktionaalinen erittely sisältää pienen sisäisen eron. Vanhan raportin poistoa ei kopioida uudemman päälle. Sivulla käyttökate jää puuttuvaksi. |

Näitä ei ole jätetty teknisille automaattisesti korjattaviksi tuontivirheinä. Lähteen ristiriita, puuttuva alkuperäinen ja puuttuva laskennan lähtötieto erotetaan varmennetusta ohjelmavirheestä. Uusien sivujen yleistä lukuhyväksyntää ei anneta näiden epäselvien tapausten osalta. Tulevien raporttien henkilöstötietona pitää käyttää ilmoitettua määrää, ei palkkakuluista arvioitua määrää.

## Varmennus ja julkaisu

Lopullinen erillinen kooditarkastus läpäisi: 119 tuontiohjelman testiä, 131 tarkistustyökalun testiä ja 61 sivustotestiä. Sivuston paikallinen rakentaminen onnistui (84 sivua). Tarkistuksissa testattiin myös päällekkäiset taulukot, piilotetut ja ristiriitaiset luvut, väärät tilikaudet, osittaiset erittelyt sekä kaluston kaksinkertaisen laskennan esto.

Lopullista tuontikoodia verrattiin edellisen version kaikkiin omiin apumoduuleihin 154 alkuperäisellä tilinpäätös-ZIPillä: **0 käsittelyvirhettä, 22 lähdekentän muutosta neljässä tiedostossa, vain näissä kolmessa yrityksessä**. Kaikki muutokset tarkistettiin nimettyihin alkuperäislähteisiin nähden. Korjaus on yhdistetyssä [PR:ssä 87](https://bitbucket.org/valuatum/profinder-environment/pull-requests/87), koodicommit `34aa68c`, yhdistämiscommit `d84b7e3`. Sivuston ja tarkistustyökalun muutos on commitissa [`9db7202`](https://bitbucket.org/valuatum/kreditrisker-se/commits/9db7202).

Tuotantoon päivitettiin vain Ruotsin tuonti-Lambdan koodi. Julkaistun ZIPin ja seitsemän tarkistetun lähdekooditiedoston SHA-256-tarkistussummat vahvistettiin. Kolmen yrityksen yhdistetyt koeajot muuttivat 18 lähdekenttää, kaikki tarkistetun alkuperäisaineiston mukaisia. Tuontiin tallennetut JSONit vastasivat koeajoja täsmälleen; kaikki 15 tilikautta sekä tuoreen RESTin yritys- ja mallikoodit säilyivät.

Tuore REST vahvisti Magnus Thorin varauskomponenttien summat **16 445 760 / 12 360 680 SEK** ja ilmoitetut henkilöstömäärät **193/207**. Kiwan määrät ovat **698,60/668,72**. Livsmedelin vuoden 2021 varat ja vastattavat ovat kumpikin **12 954 398 SEK**, pitkäaikaiset pankkivelat **2 142 859** ja lyhytaikaiset **571 428 SEK**. Livsmedelin muiden tilikausien uudemmat vertailut säilyivät.

[Jenkins-ajo 18](https://ci.valuatum.com/job/SweCompanyDirectory-ProdUpdate/18/) julkaisi sivuston commitin `9db7202` onnistuneesti. Syötteenä oli nimenomainen 832 jo julkaistun yrityksen lista. Hylättyjä ja poistettuja oli 0; julkaistusta hakuindeksistä tarkistettiin, että yritysjoukko, nimet ja polut säilyivät täsmälleen samoina. CloudFrontin välimuistin tyhjennys valmistui.

Julkaisun jälkeen haettiin uudelleen kaikkien aiemman pääotoksen ja tase-erolistan **60 yrityksen 183 tilikauden** API ja julkinen HTML. Haku- tai vertailuvirheitä ei ollut. **7 652 vertailukelpoista API–sivuriviä täsmäsi, eroja 0.** Muut 14 125 mahdollista riviä eivät olleet vertailukelpoisia eikä niitä hyväksytty.

Lähdevertailussa käytettiin SHA-256-varmennettua oman vuoden alkuperäistä 145 tilikaudella ja nimettyä uudemman virallisen raportin täsmällistä vertailukautta 38 tilikaudella. Kaikille löytyi jokin lähde; uudempi vertailu ei todista puuttuvan oman alkuperäisen muuttumattomuutta. Lähde–API-vertailussa oli 3 893 täsmäävää riviä, 130 eromerkintää, 5 020 käsintarkistusmerkintää, 12 551 vertailukelvotonta ja 183 tarkistamatta jätettyä riviä. Nämä eivät ole 130 vahvistettua ohjelmavirhettä: 65 eromerkinnässä on suora koneellinen näyttö API:a vastaavasta uudemmasta vertailuluvusta. Mukana on myös tämän ja aiemman muistion selittämiä pyöristys-/sisäisiä lähde-eroja sekä tarkoituksella poistettuja tai uudelleen luokiteltuja liitetietopäällekkäisyyksiä. Näitä ei muutettu vihreiksi pelkän taseen täsmäämisen perusteella.

Raportit ovat `data/statement-audit/runs/20261021-final-open-verified/`; kussakin raportissa on yritys, tilikausi, käytetty lähdeversio, tarkistussummat, lähderivit ja julkisen sivun osoite. Paikallisen työtilan `artifacts/open-followup/final-open/` sisältää koeajot, ennen/jälkeen-API:t, 154 tiedoston vertailun ja julkaisuvarmennukset. API–sivun vastaavuus ei ole yleinen hyväksyntä kaikkien 832 yrityksen alkuperäisille luvuille.
