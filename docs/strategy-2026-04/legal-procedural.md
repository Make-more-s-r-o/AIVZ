# Právně‑procedurální analýza: Může autonomní AI agent podat nabídku do české veřejné zakázky?

**Autor:** VZ AI Tool / Make more s.r.o.
**Datum:** 15. 4. 2026
**Verze:** 1.0
**Status:** Podkladový dokument pro rozhodnutí o architektuře. **Nejde o právní stanovisko.** Před nasazením do produkce nutno validovat s advokátem specializovaným na veřejné zakázky a e‑government.

---

## 0. TL;DR pro netrpělivé

Autonomní AI agent běžící v cloudu **může dělat drtivou většinu pracné části** procesu nabídky — stahování, parsování, analýza, oceňování, generování dokumentů, check‑listy, validace. Kde ale stojíme před **tvrdým právním blokerem**, je finální úkon — **odeslání nabídky přes elektronický nástroj a případně komunikace přes datovou schránku**. Oba tyto úkony jsou právně vázány na **fyzickou osobu s identitou ověřenou státem** (přihlášení do nástroje, příp. kvalifikovaný podpis). Software jako takový **nemá právní osobnost** (§ 20 a násl. OZ, debatováno v rámci EU AI Act 2024/1689, ale nezavedeno), **nelze mu udělit plnou moc** a **nemůže být držitelem kvalifikovaného certifikátu statutára**.

Dobrá zpráva: **nemusí**. § 211 odst. 7 ZZVZ praví, že úkon učiněný prostřednictvím elektronického nástroje nebo datové schránky se **„považuje za podepsaný"** bez nutnosti elektronického podpisu. Bottleneck je tedy „kdo se autentizuje do nástroje", ne „kdo podepisuje PDF". A to je člověk (statutář / pověřená osoba), který klikne „Podat".

**Doporučený design:** agent připraví 99 % → jednatel v jedné session přihlášen do NEN/Tender Areny atd. proklikne „Podat" na připravených nabídkách. Agent **nikdy** nedrží přihlašovací údaje do elektronických nástrojů ani privátní klíč kvalifikovaného certifikátu.

---

## 1. ZZVZ a elektronické podání nabídky

### 1.1 Co zákon vyžaduje (§ 211 ZZVZ)

Zákon č. 134/2016 Sb., o zadávání veřejných zakázek (ZZVZ), od **18. 10. 2018** vyžaduje **povinnou elektronickou komunikaci** v celém nadlimitním a podlimitním režimu (§ 211 odst. 1–3). Komunikace probíhá:
- přes **certifikovaný elektronický nástroj** (NEN, Tender arena, E‑ZAK, EZAKAZKY, X‑EN…), nebo
- přes **datovou schránku** (ISDS), nebo
- ve specifických případech e‑mailem s uznávaným el. podpisem.

**Klíčový paragraf pro nás — § 211 odst. 7 ZZVZ:**
> Úkon učiněný prostřednictvím elektronického nástroje nebo datové schránky se považuje za podepsaný.

To znamená, že **vlastní nabídka podaná přes NEN/Tender arenu NEMUSÍ obsahovat dokumenty podepsané kvalifikovaným el. podpisem**, pokud si to zadavatel výslovně v zadávací dokumentaci nevyžádal. Identita podávajícího je prokázána **přihlášením do elektronického nástroje** (obvykle username+heslo + někdy 2FA nebo kvalifikovaný certifikát při přihlašování).

### 1.2 Kdy přece jen potřebujete uznávaný el. podpis

- **Úkony zadavatele** (§ 211 odst. 5 a 8) — výzva, oznámení o výběru, rozhodnutí o vyloučení — musí mít uznávaný el. podpis, pokud **nejsou** činěny přes el. nástroj/ISDS. Nás jako dodavatele se to přímo netýká.
- **Smluvní dokumenty** — finální smlouva o dílo / kupní smlouva na plnění VZ bývá podepisována oboustranně uznávaným (často kvalifikovaným) el. podpisem. To už **je** finální úkon statutára, ne předmět automatizace.
- **Dokumenty, u kterých ZD výslovně požaduje podpis** — některé zadávací dokumentace požadují, aby byl krycí list, čestné prohlášení nebo smlouva podepsány osobou oprávněnou jednat za dodavatele. V takovém případě **agent nemůže podepsat**, nutný je člověk s kvalifikovaným certifikátem.

### 1.3 Formální požadavky na jednotlivé dokumenty

| Dokument | Zákon vyžaduje podpis? | Praxe zadavatelů |
|---|---|---|
| Krycí list nabídky | Ne (§ 211/7), pokud přes nástroj | ~30 % ZD výslovně žádá podpis jednatele |
| Čestné prohlášení o kvalifikaci | Ne (§ 211/7), pokud přes nástroj | Většina ZD žádá podpis — je to prohlášení statutára |
| Cenová nabídka | Ne (§ 211/7) | Zřídka žádáno explicitně |
| Technický návrh | Ne | Podpis téměř nikdy nevyžadován |
| Seznam poddodavatelů | Ne | Občas žádán podpis |
| Návrh smlouvy | **Ano** (v podepsaném provedení při uzavření) | Univerzálně, ale obvykle až u vítěze |

⚠️ **NUTNO OVĚŘIT S PRÁVNÍKEM:** konkrétní formulace „musí být podepsáno osobou oprávněnou" v ZD mohou ÚOHS vykládat různě. Konzervativní přístup: nechat jednatele elektronicky podepsat čestné prohlášení a krycí list vždy, i když to ZD striktně nežádá.

**Zdroj:** [§ 211 ZZVZ — kurzy.cz](https://www.kurzy.cz/zakony/134-2016-zakon-o-zadavani-verejnych-zakazek/paragraf-211/) · [Elektronický podpis při VZ — epravo.cz](https://www.epravo.cz/top/clanky/elektronicky-podpis-pri-zadavani-verejnych-zakazek-117277.html) · [MPO, povinná elektronizace](https://mpo.gov.cz/cz/podnikani/dotace-a-podpora-podnikani/oppik-2014-2020/aktualni-informace/povinna-el--komunikace-v-zadavacich-rizenich--v-rezimu-zakona-c--134-2016-sb---o-zadavani-verejnych-zakazek--pro-vsechny-zadavatele-a-dodavatele--240448/)

---

## 2. Kvalifikovaný elektronický podpis (eIDAS) a AI agent

### 2.1 Co říká eIDAS (nařízení 910/2014 + novela 2024/1183) a ZoSVD

Kvalifikovaný elektronický podpis (KEP) je definován v nařízení eIDAS jako zaručený podpis vytvořený **kvalifikovaným prostředkem pro vytváření el. podpisu** (QSCD) a založený na kvalifikovaném certifikátu. Kvalifikovaný certifikát se v ČR vydává **pouze fyzické osobě** po osobním ověření totožnosti (Czech POINT, pobočka I.CA / PostSignum / eIdentity).

Český prováděcí zákon = **zákon č. 297/2016 Sb., o službách vytvářejících důvěru pro elektronické transakce** (ZoSVD) + zákon č. 300/2008 Sb. o elektronických úkonech (pro ISDS).

### 2.2 Technická forma úložiště privátního klíče

Zákon vyžaduje, aby byl privátní klíč uložen na **certifikovaném prostředku (QSCD)**. V praxi:
1. **USB token / čipová karta** (starší varianta) — fyzické zařízení, klíč neopouští HW.
2. **Vzdálený kvalifikovaný podpis (remote QES)** — klíč na serveru certifikované autority (ProID+, I.CA remote signing, eIDAS trust service provider), uživatel autorizuje podpis SMS kódem / push notifikací / biometrií.

### 2.3 Může AI agent v cloudu držet/používat kvalifikovaný certifikát statutára?

**Technicky:** Pokud je to USB token, objektivně **ne** — agent nemá fyzický přístup k HW klíči statutáře. Pokud je to remote QES, teoreticky by agent mohl iniciovat podpis, ale **autorizační krok (SMS, push, biometrie) je navržen explicitně jako „něco, co zná/má/je fyzicky pouze držitel"** — přesně aby se zabránilo delegaci na software. Obcházení (např. naučit agenta přečíst SMS ze SIM karty v cloudu) by bylo:
- v rozporu s **certifikačními pravidly poskytovatele** (porušení smlouvy → odvolání certifikátu),
- v rozporu se **smyslem eIDAS** („sole control" držitele — čl. 26 písm. a) eIDAS),
- pravděpodobně **trestný čin** (§ 230 tr. zák. — neoprávněné nakládání s identifikačními údaji) pokud by se dostal do rukou třetí osoby.

**Právně:** ne, ne, ne. Kvalifikovaný podpis je osobní úkon srovnatelný s vlastnoručním podpisem. Delegace softwaru je v přímém rozporu s principem „sole control" (čl. 26 eIDAS) a v podstatě s konceptem el. identity obecně.

⚠️ **NUTNO OVĚŘIT S PRÁVNÍKEM:** Existuje hraniční scénář — „systémový certifikát právnické osoby" (pečeť dle eIDAS, nikoliv podpis). Ten lze přiřadit stroji a používat pro potvrzení pravosti dokumentu vydaného PO. Pro podpis nabídky to ale **nestačí** — nabídky podává fyzická osoba jménem PO, ne PO sama.

**Zdroj:** [Požadavky na uznávaný el. podpis — I.CA](https://www.ica.cz/en/requirements-guaranteed-and-recognised-electronic-signature) · [ProID remote signing](https://proid.cz/jak-funguje-kvalifikovany-elektronicky-podpis-a-jak-ho-zridit-s-proid/) · [Digitální podpis — rozdíly](https://www.digitalni-podpis.cz/rozdil-mezi-komercnim-a-kvalifikovanym-certifikatem/)

---

## 3. Datová schránka (ISDS) a automatizace

### 3.1 Role ISDS v procesu VZ

ISDS se v zadávacím řízení používá na:
- doručování výzev a rozhodnutí zadavatele (pokud zadavatel nepoužívá e-nástroj),
- doručování smluv k podpisu,
- komunikaci s ÚOHS při námitkách a přezkumu,
- doručování daňových dokladů a obecnou úřední komunikaci.

### 3.2 API pro ISDS existuje — § 14a zákona č. 300/2008 Sb.

Ano, ISDS má **oficiální SOAP API (WebServices)**. Právní základ je § 14a zákona č. 300/2008 Sb., o elektronických úkonech. Používají je spisové služby, ERP, ekonomický software (Pohoda, Money, Helios atd.). Provozní řád ISDS vydává **Digitální a informační agentura (DIA)**.

### 3.3 Může cloudový agent přistupovat do ISDS za firmu?

**Formálně:** Ano, přes systémový certifikát PO a OAuth2/certifikátovou autentizaci do API. ISDS je navržen tak, aby s ním mohly komunikovat automatizované systémy. **Ale:**

- Autentizace vyžaduje **pověření konkrétní fyzické osoby** (statutář/administrátor schránky), která dá souhlas přes webové rozhraní.
- DIA provozuje **automatický dohled zátěže** — při překročení limitů (cca 1000 zpráv/den na schránku) může omezit přístup (§ 9 Provozního řádu ISDS).
- **Odpovědnost za úkony provedené přes ISDS** leží na **držiteli schránky**, tj. PO, nikoli na provozovateli cloudu.

### 3.4 Právní rizika automatizovaného přijímání ISDS zpráv

Doručené zprávy v ISDS nabývají účinnosti **uplynutím 10 dnů od dodání** (fikce doručení, § 17 odst. 4 ZoEÚ). To znamená:
- Pokud agent nepozná zprávu od ÚOHS nebo zadavatele a zmešká lhůtu na vyjádření / odvolání, firma ztrácí právní nárok.
- **Nelze se omlouvat tím, že „agent zprávu špatně klasifikoval"** — odpovědnost je objektivní.

**Konzervativní design:** Agent může ISDS **číst a klasifikovat** (triáž, upozornění), ale **nesmí automaticky reagovat** bez lidského review u právně důležitých zpráv (ÚOHS, zadavatel VZ, daňový úřad).

**Zdroj:** [Provozní řád ISDS — DIA](https://info.mojedatovaschranka.cz/info/files/2143_Provozni_rad_ISDS.pdf) · [Přístupové rozhraní ISDS](https://info.mojedatovaschranka.cz/info/cs/77.html) · [Pověřené osoby a administrátoři](https://info.mojedatovaschranka.cz/info/cs/96.html)

---

## 4. Elektronické nástroje: NEN, Tender arena, E‑ZAK, EZAKAZKY

### 4.1 Autentizace

| Nástroj | Přihlášení dodavatele | Podání nabídky |
|---|---|---|
| **NEN** (nipez.cz) | eIdentita (BankID, NIA, mojeID) nebo uživatel+heslo | Přes web GUI, často + kvalifikovaný certifikát při autorizaci |
| **Tender arena** (QCM) | Uživatel+heslo + volitelně cert. autentizace | Přes web GUI, elektronický „obal" nabídky |
| **E‑ZAK** (QCM) | Uživatel+heslo + volitelně cert. | Přes web GUI |
| **EZAKAZKY** (B2B Centrum) | Uživatel+heslo | Přes web GUI |
| **Profil zadavatele‑vz.cz** | Stejné jako E‑ZAK (QCM) | Stejné jako E‑ZAK |

Společný znak: **přihlášení je vázané na fyzickou osobu** (pověřenou dodavatelem). Některé nástroje navíc při klíčových úkonech požadují **podpis akce kvalifikovaným certifikátem z prohlížeče** (I.CA plugin, PKCS#11 token).

### 4.2 Oficiální API pro podání nabídky

⚠️ **Ověřeno k 4/2026:** žádný z těchto 5 nástrojů **nenabízí veřejné API pro programové podání nabídky dodavatelem**. NEN má omezené **open‑data API pro veřejné zakázky** (zveřejněné oznámení, dokumentace), Tender arena má API pro zadavatele (integrace s ERP), ale **ne pro dodavatele**. Podání nabídky je výhradně cestou webového GUI po autentizované session.

### 4.3 Obchodní podmínky — co říkají o automatizovaném přístupu

Obecná pravidla NEN ([Pravidla systému NEN — nipez.cz](https://podpora.nipez.cz/en/provozni-dokumentace/latest/pravidla-nen)) zakazují:
- jakékoli pokusy o narušení provozu, DDoS, bypass autentizace,
- sdílení přihlašovacích údajů s třetími stranami.

**Explicitní zákaz „scrapingu" nebo robotů v Pravidlech NEN není**, ale ustanovení „Uživatel je povinen postupovat tak, aby nedošlo k neoprávněnému užití identity jiné osoby" by se dalo vyložit proti cloudovému agentovi s uloženými credentials.

Tender arena VOP obdobně — primární zákaz je sdílení účtu, ne automatizace _per se_. QCM v FAQ uvádí, že certifikovaný nástroj musí zaznamenávat všechny úkony nezměnitelně a jednoznačně přiřaditelně k fyzické osobě.

⚠️ **NUTNO OVĚŘIT S PRÁVNÍKEM:** Zdali je sdílení credentials s cloudovým agentem (tj. nikoli s třetí PO, ale s vlastním softwarem firmy) obchodními podmínkami zakázáno. Moje čtení: šedá zóna, ale v praxi se tak běžně děje (spisové služby, ERP integrace s ISDS), nikdo to nepokutuje. Stejně to ale **neznamená**, že můžeme v hands‑off modu podávat nabídky — viz § 5.

### 4.4 Web scraping pro stažení ZD

Stahování **veřejně zpřístupněné zadávací dokumentace bez přihlášení** (což je regulérní stav u otevřených řízení, § 36 ZZVZ) je **legálně bezproblémové** — jde o veřejně přístupné informace, které zadavatel má povinnost veřejně publikovat. Rozumná rychlost (< 1 request/s), User‑Agent identifikující agenta, respektování robots.txt = best practice.

**Problém** by nastal u dokumentace přístupné až po registraci (např. JŘBU, obecné nabídkové smlouvy) — tam je sdílení účtu vůči podmínkám nástroje.

---

## 5. Plná moc softwaru — proč to nejde a co z toho plyne

### 5.1 Právní podstata plné moci (§ 441 a násl. OZ)

Zmocnění (plná moc) podle § 441 OZ je **jednostranný právní úkon, kterým zmocnitel určuje jinou osobu, aby za něj činila právní úkony**. „Osobou" se ve smyslu občanského zákoníku (§ 18 OZ) rozumí **osoba fyzická nebo právnická**. Software **není osobou**.

Revue pro právo a technologie (Masarykova univerzita) a české stanovisko k AI Actu (EU 2024/1689) potvrzují: **AI v současném právu ČR ani EU právní osobnost nemá**. Debata o „elektronické osobě" (Drachovská, 2021, ILaw AV ČR) je akademická, v zákoně nenašla odraz.

Důsledek: **nelze udělit plnou moc softwaru**. Z toho plyne, že **software nemůže právně jednat za firmu**. Může jen **připravovat podklady**, které následně schválí a odešle oprávněná osoba.

### 5.2 Jak se to tedy dělá v praxi (ERP, spisové služby)

ERP systémy a spisové služby, které komunikují s ISDS/finanční správou/NEN přes API, fungují technicky jako **prostředek fyzické osoby** — nikoli jako samostatný subjekt. Odpovědnost vždy nese **administrátor (fyzická osoba) a právnická osoba** (firma, statutár). Software je „dlouhé prsty" zmocněné FO.

**To je šablona i pro nás.** Agent může odesílat za firmu pouze tam, kde je to jen „provedení rozhodnutí, které už padlo". **Rozhodnutí „podat tuto nabídku za 187 000 Kč do této VZ" musí být rozhodnutím jednatele**, nikoli samostatné rozhodnutí agenta.

### 5.3 Hand‑off workflow (vzor)

1. Agent stáhne ZD → analýza → triáž → skóre relevance.
2. Agent upozorní jednatele (Slack / e‑mail): „Nová relevantní VZ, deadline T−5 dní."
3. Jednatel rozhodne: interest/pass.
4. Při interest: agent generuje kompletní draft nabídky, validuje, spočítá cenu.
5. Jednatel přehlédne draft, schválí cenu, případně edituje.
6. Jednatel se **sám přihlásí** do NEN/Tender arény, nahraje soubory (nebo je nahraje agent přes jeho session token vytvořený jednatelem), klikne „Podat".
7. Agent archivuje, monitoruje, notifikuje.

V kroku 6 je otevřené, zda agent může technicky nahrát dokumenty do jednatelovy session (token by si agent vyžádal od jednatele v době „práce s NEN"). **To je akceptovatelné**, pokud finální klik „Podat" udělá jednatel vědomě a explicitně.

---

## 6. Odpovědnost — kdo nese důsledky

### 6.1 Směrem ven (k zadavateli, ÚOHS, dalšímu účastníkovi řízení)

**Vždy právnická osoba = Make more s.r.o.** Firma uzavře/nabídne smlouvu a zavazuje se plnit. Že draft připravil AI agent, je vnitřní věc firmy — zadavateli je to irelevantní. Za fakticky nepravdivé čestné prohlášení, podstatnou vadu nabídky, nesoutěžní jednání → **firma**.

### 6.2 Uvnitř firmy (jednatel vs. společnost)

Jednatel odpovídá **s péčí řádného hospodáře** (§ 159 OZ). Pokud schválí nabídku vygenerovanou AI bez řádné kontroly a firmě tím vznikne škoda (např. propadlá jistota, závazek za nerentabilní cenu, pokuta ÚOHS), může mu společnost uplatnit nárok na náhradu škody.

**Ochrana:** interní směrnice definující:
- jaké části AI generuje a jaké musí zkontrolovat člověk,
- formální proces schválení (4‑eye principle u ceny > X Kč),
- logování AI rozhodnutí (audit trail).

### 6.3 Směrem k dodavateli LLM (Anthropic)

Anthropic v Commercial Terms výslovně **vylučuje odpovědnost za výstupy modelu** pro běžné B2B použití (Usage Policies, Section „Your responsibilities"). Claude odpovídá za dostupnost služby (SLA u enterprise), ne za obsahovou správnost. Smluvní escalace na Anthropic při chybě agenta = téměř nulová šance úspěchu.

### 6.4 § 2950 OZ — odborník a rada

Zajímavá úvaha: pokud Make more prodá tento systém třetí firmě jako SaaS („generujeme ti nabídky do VZ"), stává se Make more v očích zákazníka **odborníkem poskytujícím radu za úplatu**. § 2950 OZ pak zavádí **objektivní odpovědnost** za škodu způsobenou neúplnou nebo nesprávnou informací. **To je významné riziko pro fázi 2 (komercializace)** a je nutno ošetřit přes:
- důkladné VOP s omezením odpovědnosti (strop na zaplacené poplatky za 12 měsíců),
- pojištění profesní odpovědnosti (E&O insurance),
- povinnost zákazníka finální kontrolu provést (carve‑out).

⚠️ **NUTNO OVĚŘIT S PRÁVNÍKEM:** Judikatura k § 2950 není pro AI asistované služby ustálená. ÚS III. ÚS 3528/20 řešil omezenou odpovědnost poskytovatele informace, ale ne AI generované dokumenty. Doporučuji konzultaci s firmou ROWAN LEGAL nebo podobně specializovanou.

---

## 7. Archivace (§ 216 ZZVZ) a data residency

### 7.1 Archivační povinnost

§ 216 ZZVZ ukládá **zadavateli** archivaci kompletní dokumentace o zadávacím řízení po dobu **10 let** od ukončení řízení. **Dodavatel** (my) touto povinností z § 216 přímo vázán **není**, ale:
- daňové povinnosti → 5–10 let dle DPH zákona (§ 35 ZoDPH) / AML,
- účetnictví → 5 let (§ 31 ZoÚ),
- doklady ke smlouvě z VZ → doporučená archivace 10 let (paralelně se zadavatelem pro případ přezkumu ÚOHS do 5 let od uzavření smlouvy).

### 7.2 Data residency a Anthropic

Uživatel řekl, že data residency „neřešíme", ale pro pořádek: Anthropic API hostuje v AWS us‑east / us‑west primárně. Evropský region (eu‑central‑1) existuje pro Claude ve vybraných tierech (Bedrock / Vertex). Pro VZ podklady, které obsahují:
- **veřejné informace** (ZD) → žádný problém,
- **obchodní tajemství firmy** (interní cenový sklad, marže) → doporučeno jen do modelu, bez ukládání do trainingu (default off u Anthropic API),
- **osobní údaje** (kontaktní osoby ze ZD, statutáři u reference, atd.) → GDPR, viz § 8.

**Blocker?** Ne, ale do **DPA s Anthropic** (Data Processing Agreement — Anthropic jej nabízí) je to potřeba zanést.

---

## 8. Ostatní právní rizika

### 8.1 GDPR

Nabídky a ZD obsahují osobní údaje (kontaktní osoba zadavatele, statutáři dodavatele, podepisující osoby referencí). Make more je **zpracovatel** (resp. správce) těchto údajů. Je potřeba:
- záznam o činnostech zpracování (čl. 30 GDPR),
- právní titul zpracování (oprávněný zájem / plnění smlouvy),
- zpracovatelská smlouva s Anthropic (DPA),
- lhůta pro uložení (definuje politika).

Nejde o blocker, jde o hygienu.

### 8.2 NIS2 / zákon o kybernetické bezpečnosti

Týká se **zadavatelů** spadajících pod regulované subjekty (energetika, doprava, zdravotnictví, veřejná správa velkých měst). Nás jako **dodavatele IT vybavení do malých VZ (50–500k)** se přímo netýká — nejsme v NIS2 perimetru. **Ale** ZD těchto zadavatelů mohou požadovat bezpečnostní záruky od dodavatele, které je nutno splnit (ISO 27001, audit…). Není to AI blocker, ale compliance blocker u některých VZ.

### 8.3 EU AI Act (Nařízení 2024/1689)

Vstoupilo v platnost 1. 8. 2024. Drtivá část povinností platí od **2. 8. 2026**. Pro nás:
- Náš systém **není vysoce rizikový** ve smyslu AI Actu (Příloha III). Příloha III vyjmenovává vysoce rizikové systémy v bidding/procurementu **pouze na straně zadavatele/veřejné správy**, ne na straně dodavatele generujícího vlastní nabídku.
- Pro uživatele (Make more + potenciálně klienty) platí povinnosti **transparentnosti** (čl. 50 AI Actu) — uživatel musí vědět, že komunikuje s AI / že dokument byl vygenerován AI. To vyřešíme disclaimerem a logováním.

### 8.4 Jistota (§ 41 ZZVZ) a sankce za odstoupení

Pokud nabídka obsahuje jistotu (bankovní záruka / pojištění / složená), **propadá** při odvolání nabídky před uplynutím zadávací lhůty. Pokud agent omylem odešle nabídku, kterou jednatel nechtěl, a pak se z ní stáhne, **firma přijde o jistotu** (typicky 1–2 % odhadované hodnoty, tj. až 10 000 Kč na jednu VZ).

**Důsledek pro design:** Submit flow **musí** být tvrdě hand‑off — preference proti autonomii zde je jednoznačná.

### 8.5 Hospodářská soutěž / antitrust

Pokud se Make more rozhodne servisovat více dodavatelů, kteří spolu soutěží o stejné VZ, ze stejného AI engine — **vzniká riziko signalizace cen a koordinace**. Je to spíš organizační (chinese walls, oddělené tenant instance), ale třeba se nad tím zamyslet u fáze 2.

---

## 9. Shrnutí: SMÍ / NESMÍ / PODMÍNĚNĚ SMÍ

| Úkon | Verdikt | Ošetření / poznámka |
|---|---|---|
| Stažení veřejné ZD (bez přihlášení) | ✅ **SMÍ** | Rozumný rate limit, identifikační User‑Agent |
| Parsování PDF / DOCX | ✅ **SMÍ** | — |
| AI analýza zadávací dokumentace | ✅ **SMÍ** | Disclaimer uživateli o AI původu |
| Generování draft dokumentů (krycí list, čestné prohlášení, technický návrh, cenová nabídka) | ✅ **SMÍ** | Jednatel musí schválit |
| Ocenění z interního cenového skladu | ✅ **SMÍ** | — |
| Triáž a klasifikace ISDS zpráv (čtení) | ✅ **SMÍ** | Pověřená osoba, DIA compliant |
| Monitoring portálů o nových VZ | ✅ **SMÍ** | — |
| Odpověď na ISDS zprávu od ÚOHS / zadavatele | 🟨 **PODMÍNĚNĚ** | Draft smí, odeslání schvaluje jednatel |
| Přihlášení do elektronického nástroje pod session tokenem jednatele | 🟨 **PODMÍNĚNĚ** | Session otevírá a zavírá jednatel, ne agent trvale |
| Upload draftu nabídky do elektronického nástroje | 🟨 **PODMÍNĚNĚ** | Jen v aktivní session jednatele |
| Finální klik „Podat nabídku" v elektronickém nástroji | ❌ **NESMÍ** | Vždy jednatel, vědomý úkon |
| Držení kvalifikovaného certifikátu statutára | ❌ **NESMÍ** | Porušení eIDAS, pravidel CA, trestní riziko |
| Elektronický podpis dokumentu kvalifikovaným certifikátem jménem FO | ❌ **NESMÍ** | Osobní úkon, princip „sole control" |
| Trvalé přihlášení do ISDS / nástroje bez lidského dohledu | ❌ **NESMÍ** | Oproti smyslu autentizace, riziko ztráty lhůt |
| Samostatné rozhodování „podáme / nepodáme nabídku" | ❌ **NESMÍ** | Obchodní rozhodnutí statutára |
| Přijetí smlouvy jménem firmy | ❌ **NESMÍ** | Právní úkon s ekonomickým dopadem |

---

## 10. Doporučení pro architekturu systému

1. **Oddělit „přípravnou vrstvu" od „odesílací vrstvy"**. Přípravná vrstva (99 % práce) běží autonomně v cloudu. Odesílací vrstva je **desktop / browser extension u jednatele**, který jednatel aktivně používá.
2. **Nikdy neukládat credentials jednatele** do elektronických nástrojů v cloudu. Pokud už nutno sdílet session, ať je ephemeral (1‑hodinový token).
3. **Přístup do ISDS** jen přes oficiální API s pověřením jednatele jako administrátora. Read‑only triáž v cloudu OK, write (odeslání) vždy jednatel manuálně.
4. **Kvalifikovaný certifikát** zůstává fyzicky u jednatele (USB token nebo remote QES s vlastní SIM). Agent se ho nikdy nedotkne.
5. **Human‑in‑the‑loop checkpointy**: relevance ZD → cena → finální submit. 3 explicitní potvrzení za VZ.
6. **Logování a audit trail** každého AI rozhodnutí (prompt, output, confidence, downstream akce). 10 let archivace.
7. **Interní směrnice** — rolí pro jednatele a ostatní ověřovatele, SLA na odezvu (aby se nepropadly lhůty), 4‑eye u ceny nad prahem.
8. **Právní review každých 6 měsíců** — ZZVZ se mění (novela 2024/1249/EU o dostupnosti na digitálních produktech cílí na VZ), AI Act najíždí, eIDAS 2.0 (EUDI Wallet) 2026+.

---

## 11. Otevřené otázky pro právníka (jeden ~2h meeting)

1. Lze konstruovat „souhrnné pověření" jednatele pro agenta, kde jednatel jednou za den „dává souhlas s dávkou nabídek < 500k Kč"? Jak by to vypadalo formálně (dokumentace, audit)?
2. U nabídek, kde ZD vyžaduje podepsaný krycí list/čestné prohlášení, je přijatelné předložit PDF podepsaný **pečetí právnické osoby** (eIDAS qualified seal) místo osobním podpisem statutáře? [Očekávám: ne, ale stojí za ověření.]
3. Můžeme v ZD sporných případech (např. „podepsaná osoba oprávněná") spoléhat na fikci podpisu z § 211 odst. 7 ZZVZ, nebo je to riziko vyloučení?
4. Doporučené znění VOP / DPA pro fázi 2 (SaaS pro další firmy) — omezení odpovědnosti, § 2950 OZ carve‑out, pojištění.
5. Jaká je hranice „automatizovaného přijetí" zprávy v ISDS — pokud agent pouze klasifikuje a upozorní, neporušujeme tím Provozní řád DIA?
6. Potřebujeme u agenta notifikaci ÚOOÚ jako „zpracovatele osobních údajů ve velkém měřítku"?

---

## 12. Závěr pro rozhodnutí o rozpočtu

**AI agent pro veřejné zakázky je právně proveditelný v tom rozsahu, který Make more plánuje** — 10–20 VZ denně, hodnota 50–500 tis. Kč, zkrácení z 40–80 h na 4–8 h. Klíč je v tom, že **hodinová úspora leží v přípravě dokumentů, ne v odesílání**. Samotné odeslání je 5–15 minut na VZ (klik, klik, upload, Podat) a právě tam leží legální hranice, kterou respektujeme designem (human‑in‑the‑loop na odesílání).

**Není to blocker. Je to formativní omezení.** Platí pro celý sektor — žádný konkurent (ani zahraniční) to nemůže v ČR dělat „fully hands‑off", dokud se nezmění eIDAS a zákon 300/2008.

Srovnání s trhem: podobné AI tooly pro procurement v EU (Tendex, Bidhive, Vendors.io) všechny fungují ve stejném režimu „assistive, not autonomous" u finálního odeslání. To je průmyslový standard.

**Doporučení:** Pokračovat ve vývoji dle stávajícího plánu. Před první komerční nabídkou (fáze 2 SaaS) udělat formální právní review + pojištění profesní odpovědnosti.

---

**Zdroje (vybrané):**
- [Zákon č. 134/2016 Sb. ZZVZ — Zákony pro lidi](https://www.zakonyprolidi.cz/cs/2016-134)
- [§ 211 ZZVZ — kurzy.cz](https://www.kurzy.cz/zakony/134-2016-zakon-o-zadavani-verejnych-zakazek/paragraf-211/)
- [§ 216 ZZVZ, archivace — LeXikon VZ](https://www.lexikonvz.cz/lexikon/novy-zakon/s-216-uchovavani-dokumentace-o-zadavacim-rizeni-532)
- [Elektronický podpis při zadávání VZ — epravo.cz](https://www.epravo.cz/top/clanky/elektronicky-podpis-pri-zadavani-verejnych-zakazek-117277.html)
- [Povinná elektronizace — MPO](https://mpo.gov.cz/cz/podnikani/dotace-a-podpora-podnikani/oppik-2014-2020/aktualni-informace/povinna-el--komunikace-v-zadavacich-rizenich--v-rezimu-zakona-c--134-2016-sb---o-zadavani-verejnych-zakazek--pro-vsechny-zadavatele-a-dodavatele--240448/)
- [Vybrané aspekty el. komunikace VZ — MT Legal](https://www.mt-legal.com/vybrane-aspekty-elektronicke-komunikace-ve-verejnych-zakazkach/)
- [Provozní řád ISDS — DIA (PDF)](https://info.mojedatovaschranka.cz/info/files/2143_Provozni_rad_ISDS.pdf)
- [Přístupové rozhraní ISDS](https://info.mojedatovaschranka.cz/info/cs/77.html)
- [Pravidla systému NEN — nipez.cz](https://podpora.nipez.cz/en/provozni-dokumentace/latest/pravidla-nen)
- [Tender arena — tenderarena.cz](https://tenderarena.cz/)
- [Kvalifikovaný certifikát — I.CA](https://www.ica.cz/en/qualified-certificate-electronic-signature)
- [ProID — vzdálený kvalifikovaný podpis](https://proid.cz/jak-funguje-kvalifikovany-elektronicky-podpis-a-jak-ho-zridit-s-proid/)
- [EU AI Act — Evropská komise](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai)
- [EU AI Act — Česká asociace umělé inteligence](https://asociace.ai/eu-ai-act/)
- [Umělá inteligence jako subjekt práva — Revue PaT, MUNI](https://journals.muni.cz/revue/article/view/9067)
- [§ 2950 OZ — škoda informací — epravo.cz](https://www.epravo.cz/top/clanky/nahrada-skody-zpusobene-informaci-nebo-radou-odbornika-96346.html)
- [ÚOHS — povinnosti zadavatele při přezkumu](https://uohs.gov.cz/cs/verejne-zakazky/povinnosti-zadavatele-pri-prezkumu-verejne-zakazky.html)
