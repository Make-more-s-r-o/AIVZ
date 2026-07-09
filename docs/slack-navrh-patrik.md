# Návrh Slack odpovědi pro Patrika (#ludone-vz)

> NEODESÍLAT — jen návrh textu ke kontrole. Kanál C0BE0TJTS3X, adresát Patrik U03GNDJG2SV.

---

Ahoj Patriku, mrknul jsem na ten zaseknutý match job.

Byly tam nakonec dvě vrstvy problému: (1) job narážel na 600s watchdog, který ho tvrdě zabíjel bez ohledu na to, jak daleko byl, a (2) i po prodloužení timeoutu se ukázalo, že odpovědi od AI se občas ořezávaly na limitu tokenů a rozbitý JSON pak shodil match úplně stejně, jen rychleji. Obě jsme opravili a je to nasazené na produkci.

Zkus to prosím znovu na té zakázce, kde to padalo, ať mám jistotu, že to sedí i u tebe.

Jedna změna navíc, co si asi všimneš: když teď něco selže, neuvidíš už jen věčně točící se spinner — vyskočí červený box s chybou a tlačítkem „Zkusit znovu".

Díky za nahlášení, ať víme kam se dívat.
