# Ruotsin puuttuvien tilinpäätösrivien jatkotarkistus 21.10.2026

Korjaukset ovat [PR:ssä 86](https://bitbucket.org/valuatum/profinder-environment/pull-requests/86), joka yhdistettiin masteriin commitilla `772eb5f` (koodi `3fe5414`). Korjaus koskee tilinpäätösten lukemista Valuatumiin. Kyse ei ole nettisivulle käsin vaihdetuista luvuista.

## Mitä korjattiin ja miksi

| Yritys | Löydös ja korjaus | Tuoreen API:n vahvistama tulos |
| --- | --- | --- |
| Livsmedel i Alunda (5562244540) | Uudemmissa tilinpäätöksissä osa koneellisesti merkitsemättömistä tase-erittelyistä jäi pois. Luemme nyt näkyvät kalusto-, saamis- ja velkarivit vain, kun koko erittely täsmää lähteen loppusummaan. Pitkä- ja lyhytaikaiset pankkivelat erotetaan taulukon otsikoiden perusteella. Vanhempaa tilinpäätöstä ei kopioida uudemman päälle. | Vuoden 2024 varat ja vastattavat kumpikin **10 632 049 SEK**, vuoden 2023 kumpikin **10 933 781 SEK**. |
| Magnus Thor (5563077352) | Lähde merkitsi yhden tilinpäätössiirron osan koko yhteissummaksi. Poistojen muutos ja annettu konserniavustus olivat lisäksi näkyvissä ilman koneellista merkintää. Luemme nyt nämä kolme erää niiden omille riveilleen. | Tilikauden tulos 2025 **6 404 367 → 3 670 617 SEK**, 2024 **3 695 121 → 2 222 089 SEK**. Taseen ristiriitaisia varauksia tämä ei korjaa. |
| Café Levinsky (5565800934) | Näkyvät poistojen muutokset, konserniavustukset ja niiden ilmoitettu yhteissumma puuttuivat tuonnin erittelystä. | Vuoden 2023 poistojen muutos **−714 000 SEK** on nyt omalla rivillään. Lopullinen tilikauden tulos säilyi lähteen mukaisena. |
| Raw Sushi (5565048500) | Sama näkyvien mutta koneellisesti merkitsemättömien tilinpäätössiirtojen ongelma. | Vuoden 2023 poistojen muutos **−573 000 SEK** on nyt omalla rivillään. Lopullinen tilikauden tulos säilyi lähteen mukaisena. |

Magnus Thorin vuoden 2024 voittovarat muuttuivat lisäksi yhdellä kruunulla: oman pääoman muutostaulukon 10 699 365 korvautui varsinaisen taseen 10 699 364 kruunulla. Tämä on jo aiemmin käyttöön otetun ensisijaisen taseen valintasäännön vaikutus, tarkistettu erikseen alkuperäisestä taulukosta. Taseen yhden kruunun sisäisiä ristiriitoja ei merkitty ratkaistuiksi.

## Miten varmistettiin

- 78 kohdennettua testiä läpäisi. Ne tarkistavat myös virheelliset etumerkit, yritys-/tilikausisekoitukset, piilotetut solut, puuttuvat rivit, päällekkäiset erät ja lähteen sisäiset ristiriidat.
- Lopullista koodia verrattiin edelliseen versioon **154 alkuperäisellä tilinpäätös-ZIPillä**: 0 käsittelyvirhettä. Muutoksia tuli kahdeksan tiedoston 82 lähdekenttään, vain näissä neljässä yrityksessä.
- Luetaan ilmoitetut osarivit, ei keksittyä tasauserää. Tuloslaskelman osien on johdettava täsmälleen ilmoitettuun tulokseen ennen veroja ja verojen jälkeen. Tase-erittelyjen on täsmättävä koko tarkistettavan osion loppusummaan. Epäselvä kohta jää lukematta ja tarkistettavaksi.
- AWS-päivitys muutti vain Ruotsin tilinpäätöksiä lukevan Lambdan koodin. Julkaistusta ZIPistä varmennettiin neljän lähdekooditiedoston tarkistussummat.
- Neljän yrityksen täydet historiat tuotiin normaalin yhdistetyn tuonnin kautta. Kaikki **21 tilikautta** sekä yritys- ja mallikoodit säilyivät. Tuotannon koeajojen **55 yhdistettyä kenttämuutosta** tarkistettiin; jonoon tallennetut aineistot vastasivat koeajoja täsmälleen.
- Tuore API vahvisti taulukon luvut. Yrityssivujen julkaisu ja jälkitarkistus kirjataan alle erikseen.

Tarkistuksen aineisto ja ennen/jälkeen-vastaukset ovat paikallisessa `artifacts/open-followup`-hakemistossa. API:n ja sivun vastaavuus on eri asia kuin kaikkien lukujen hyväksyminen alkuperäislähteeseen nähden.

## Mitä jää auki

- **Magnus Thorin tase:** näkyvät varauskomponentit 16 445 760 / 12 360 680 SEK ovat ristiriidassa samassa lähteessä ilmoitetun nollan kanssa. Komponentteja ei lisätty nollan päälle eikä nollaa ohitettu automaattisesti.
- **Svetsekonomi:** vuoden 2025 tilinpäätös näyttää varaukset −17 778 / −31 752 SEK, mutta taseen muut summat edellyttäisivät positiivisia lukuja. Vuoden 2024 alkuperäinen raportti näyttää vertailuvuoden 31 752 positiivisena. Tämä osoittaa lähdeversioiden etumerkkiristiriidan, ei anna lupaa vaihtaa etumerkkejä yleisesti.
- **Bike, 2024:** ero sopii tuhansiksi pyöristettyjen osalukujen laskentaan. Lähteen lyhytaikaiset varat ovat 52 155 tkr, mutta sen varasto 41 973 + saamiset 5 998 + kassa 4 185 = 52 156 tkr. Vastattavien osat 24 589 + 1 324 + 29 527 = 55 440 tkr, kun ilmoitettu loppusumma on 55 441 tkr. API laskee varat 55 442 ja vastattavat 55 440 tkr. Näitä ei pakotettu samaksi eikä tarkistusrajaa nostettu.
- **Shekharin vuoden 2022 muuttuneet vertailuluvut:** API noudattaa uudempaa tilinpäätöstä, mutta suurten muutosten syytä ei ole vahvistettu.
- Kahdeksan tunnusluku-/välisummavertailun kaikki lähdeosat ja yhden erittelemättömän pitkäaikaisen saamisen alkuperä ovat edelleen vahvistamatta. Esimerkiksi käyttökate, omavaraisuusaste, quick ratio ja oman pääoman tuotto eivät saa yleistä hyväksyntää tämän korjauksen perusteella. Niiden määritelmiä ei muutettu vain saadaksemme vertailun vihreäksi.

Laajaa sivugenerointia tai raporttien yleistä lukuhyväksyntää ei anneta tällä perusteella. Nämä julkaisut päivittävät vain neljä olemassa olevaa yrityssivua.

## Yrityssivujen jälkitarkistus

[Jenkins-ajo 16](https://ci.valuatum.com/job/SweCompanyDirectory-ProdUpdate/16/) julkaisi nämä neljä olemassa olevaa yrityssivua onnistuneesti. Hylättyjä tai poistettuja yrityksiä ei ollut. Hakemiston kaikki 832 yritystä, nimet ja polut säilyivät täsmälleen samoina.

Julkaisun jälkeen haettiin API ja HTML uudelleen kaikkien neljän yrityksen 21 API-tilikaudelle: **1 056 vertailukelpoista API–sivuriviä täsmäsi, eroja 0**. Muut 1 464 mahdollista riviä eivät olleet vertailukelpoisia, esimerkiksi sivulta puuttuvan vanhemman tilikauden tai puuttuvan arvon vuoksi. Niitä ei merkitty hyväksytyiksi. Alkuperäislähteiden puuttuvat tai ristiriitaiset kohdat säilyivät myös erillisen lähdevertailun tarkistusmerkinnöissä.

Raportit: `data/statement-audit/runs/20261021-visible-rows-verified/summary.json` sekä yritys-/tilikausikohtaiset `.report.json`-tiedostot. Normaali tuontijono tyhjeni (0 näkyvää ja 0 käsittelyssä olevaa viestiä). Tuontipalvelin käynnistyi viiveellä automaattisesti; pysyvää infrastruktuurikorjausta ei tehty.
