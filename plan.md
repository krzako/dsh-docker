# DSH jako wykonawca Codexa: plan sesji, audytu i odtwarzania

## Status i zasady pracy

To jest obowiązujący plan docelowej integracji. Starsza część [checklist.md](checklist.md) dokumentuje poprzednią architekturę i pozostaje historią wykonanych prac; sprzeczne z niniejszym planem decyzje nie obowiązują nowych zmian. Ten dokument opisuje prace do wykonania, a nie potwierdza, że zostały wykonane.

## Priorytet N195 — dokumentacja bez chińskich plików Markdown

Przed dalszymi krokami integracji usuń z `deepseek-harness` i pozostałych repozytoriów tego workspace wszystkie śledzone chińskie odpowiedniki Markdown (w szczególności `*.zh.md`), odwołania do nich oraz pliki służące wyłącznie parowaniu tych tłumaczeń. Usuń instrukcje, szablony, skrypty i bramki nakazujące ich tworzenie lub aktualizację; przyszłe zmiany dokumentacji nie mają generować chińskich plików Markdown. Zmiana dotyczy dokumentacji, także historycznych chińskich kopii Agent Notes, lecz nie wyłącza istniejących tłumaczeń tekstu interfejsu ani nie usuwa angielskich notatek opisujących dawne decyzje. Zweryfikuj, że linki i podstawowe bramki dokumentacji działają bez tłumaczeń. Wymóg ten ma pierwszeństwo przed wcześniejszymi instrukcjami repozytorium o dwujęzycznej dokumentacji; nie zmieniaj wykonanych wpisów checklisty.

**Nie wolno w checkliście modyfikować już wykonanych kroków**: nie zmieniać ich treści, statusu, numeru ani ich nie usuwać. Przed rozpoczęciem każdej nowo odkrytej pracy trzeba najpierw dopisać nowy, jednoznaczny krok na końcu obowiązującej sekcji w `checklist.md`, bez wstawiania go pomiędzy istniejące kroki. Po wykonaniu kroku należy bezzwłocznie oznaczyć jego własne `[ ]` jako `[x]`, dopiero potem przejść do kolejnego kroku. Nie oznaczać kroku na podstawie samego rozpoczęcia prac; dołączyć w opisie zmiany lub raporcie wynik weryfikacji. Dla kroku wymagającego wcześniejszej decyzji użytkownika dopisać decyzję do planu i checklisty przed implementacją, nie zakładać jej po cichu.

### Commity i atomowość checklisty

Po każdym w pełni wykonanym i zweryfikowanym kroku należy niezwłocznie utworzyć commit obejmujący ten krok i zmianę jego checkboxa `[ ]` → `[x]`. Nie odkładać odhaczania ani commitowania kilku ukończonych kroków na koniec etapu; nie rozpoczynać następnego kroku, dopóki commit poprzedniego nie powstanie. Jeśli podczas pracy nad krokiem A ujawnią się kolejne zadania B, C i D, najpierw dopisać je jako niewykonane pozycje checklisty, a ich dopisanie oraz ewentualną korektę przyszłych kroków uwzględnić w commicie kończącym A. Nie oznaczać B, C ani D jako wykonanych w commicie A. Nie zmieniać zakończonych pozycji checklisty. Do commitu nie włączać niezwiązanych zmian użytkownika.

Zmiana wymagań przekazana przez użytkownika jest osobną pracą planistyczną: jej zmiany w `plan.md`, `AGENTS.md` i/lub `checklist.md` zapisać w **oddzielnym commicie**, nie mieszać z commitem implementującym feature. Jeśli sama zmiana wymagań tworzy krok dokumentacyjny, odhaczyć go w tym samym commicie. Jeśli nowa decyzja zmienia przyszły krok, zaktualizować wyłącznie niewykonane pozycje lub dopisać nowe; ukończonych nie przepisywać.

`deepseek-harness` i `dockers/addons/codex` są osobnymi repozytoriami Git podłączonymi jako submoduły. Git nie pozwala umieścić ich plików i głównej `checklist.md` dosłownie w jednym obiekcie commitu. Dlatego dla kroku dotykającego submodułu należy najpierw zatwierdzić kod/testy w odpowiednim submodule, a **bez przechodzenia do kolejnego kroku** utworzyć jeden commit głównego repozytorium zawierający wskaźnik(i) na te commity, odhaczony krok checklisty i ewentualne nowo odkryte kroki. Ten commit główny jest atomowym zapisem ukończenia kroku; nie wolno odhaczyć zadania w commicie bez odpowiadającego mu wskaźnika. Dla kroku wyłącznie w głównym repozytorium kod i odhaczenie znajdują się w jednym zwykłym commicie.

## Cel i niezmienne granice

1. Jedna sesja DSH i **jedna pętla agenta**. Codex pozostaje właścicielem budowania promptów, wyboru kolejnego kroku, interpretacji odpowiedzi modelu, własnej historii i compaction. Standardowy agent DSH pozostaje alternatywnym driverem, a nie drugą pętlą uruchomioną obok Codexa.
2. DSH jest wykonawcą woli Codexa: wykonuje każde wywołanie modelu oraz każde narzędzie, stosuje polityki i zgody, zapisuje pełny przebieg, obsługuje eksport i późniejszy import. Nie dopisuje, nie usuwa i nie przestawia semantycznej treści promptu. Dopuszczalna jest jawna translacja *formatu* Responses ↔ Chat Completions; oba faktyczne payloady są zapisywane, a elementy niemapowalne powodują błąd przed wysłaniem.
3. Codex w naszym forku nie wystawia ani nie wykonuje narzędzi natywnych. Jedynym modelowym kanałem narzędzi jest katalog DSH przekazany do Codexa oraz wywołanie zwrotne do DSH. Fizycznie usuwać niepotrzebne implementacje narzędzi forka po sprawdzeniu zależności; niezależnie utrzymać testowaną blokadę ich ekspozycji i wykonania.
4. DSH Session jest źródłem trwałych faktów produktu. Codex może trzymać aktywny kontekst w pamięci i własnym rollout, ale eksport sesji DSH musi wystarczać do utworzenia nowego kontekstu Codexa bez starego `CODEX_HOME` i bez odgrywania dawnych side effects.
5. Wybór agenta jest jawny i trwały dla sesji: `standard`, `codex`, później kolejne drivery. Zmiana agenta oznacza utworzenie nowej sesji z importem/seedem i śladem pochodzenia; przełączanie drivera w środku aktywnego turnu nie wchodzi w zakres tego planu.
6. Istnieje jeden kanoniczny format sesji DSH, niezależny od agenta. Każdy pełny driver agenta musi umieć wyeksportować swój kontekst do tego formatu i zaimportować go jako nową sesję. Nie budować adapterów `Codex → standard`, `standard → Codex` ani innych adapterów dla poszczególnych par.

## Skills w sesjach DSH

W sesjach prowadzonych przez DSH wyłączamy natywne skills forka Codexa, w tym ich automatyczne odkrywanie i dodawanie instrukcji do promptu. Agent korzysta z katalogu i narzędzi DSH. Zmiana `CODEX_HOME` przy imporcie nie może dodawać do kontekstu katalogu skills z nowymi ścieżkami. Nie przenosimy plików natywnych skills jako zależności odtworzenia sesji. Historyczny audyt i zapisany kontekst pozostają pełne; wyłączenie nowych instrukcji nie upoważnia do cichego przepisywania historii.

## Rozstrzygnięcie N001 — uniwersalny transfer sesji

Rozszerzamy obecny format DSH Session i jego zwykły eksport ZIP; nie tworzymy osobnego „formatu Codexa”. DSH odpowiada za wersjonowanie, zapis, walidację, manifest, referencje do artefaktów i uruchomienie importu. Każdy pełny driver implementuje ten sam obowiązkowy port `exportPortableContext` / `importPortableContext` (nazwy robocze). Rejestracja drivera bez obsługi obu operacji ma jawnie zawieść. Zmiana agenta zawsze korzysta z jednego przepływu:

```text
agent źródłowy → kanoniczny kontekst/archiwum DSH → agent docelowy → nowa sesja DSH
```

Kanoniczny kontekst przechowuje uporządkowane fakty widoczne dla modelu: wiadomości i bloki treści, obrazy/pliki, wywołania narzędzi wraz z wynikami, efektywny kontekst po compaction oraz informacje potrzebne do wyjaśnienia jego powstania. Zapisuje również pochodzenie instrukcji, model/provider, identyfikatory, błędy i decyzje jako metadane/audyt. Agent docelowy otrzymuje ten sam zestaw faktów i sam składa następny prompt według swoich reguł; DSH nie wstrzykuje mu promptu źródłowego agenta. Import nigdy nie wykonuje ponownie dawnych narzędzi ani wywołań modelu. Każda transformacja, pominięcie nieprzenośnego elementu lub zmiana modelu wymaga jawnego raportu zgodności przed zatwierdzeniem importu; nie wolno uznać cichej utraty danych za sukces.

Dla `Codex → Codex` i `standard → standard` wymagamy odtworzenia całego dostępnego kontekstu do następnego żądania modelowego. Archiwum może zawierać wersjonowany, namespacowany stan prywatny drivera (dla Codexa: pełny przenośny checkpoint compaction), którego inny agent nie musi rozumieć. Przy zmianie typu agenta `Codex ↔ standard` i dla przyszłych agentów obowiązuje pełny przenośny kontekst DSH, nie sam uproszczony transcript; stan prywatny źródła nie jest przenoszony, ale jego model-visible skutki muszą być reprezentowane kanonicznie. Nie obiecujemy identycznych następnych bajtów promptu między różnymi agentami ani ukrytego stanu dostawcy, którego API nigdy nie zwróciło. Wierność i ewentualne ograniczenia są częścią wyniku importu, nie ukrytym szczegółem adaptera.

## Rozstrzygnięcie N002 — workspace przy imporcie

Eksport domyślnie zawiera przenośny kontekst, użyte załączniki oraz manifest/fingerprint workspace, lecz nie kopiuje całego projektu. Użytkownik może jawnie dołączyć migawkę workspace. Nie ma stałego globalnego limitu wielkości archiwum; przetwarzanie jest strumieniowe, a operator może ustawić własne limity zasobów.

| Docelowy workspace | Migawka w archiwum | Zachowanie |
| --- | --- | --- |
| Istnieje | Jest | Pokazać podgląd konfliktów i wybór: zachować obecne pliki albo zastosować migawkę. Zastosowanie wymaga osobnego potwierdzenia i odzyskiwalnej kopii zastępowanych danych. Przy zachowaniu obecnych plików oznaczyć możliwą rozbieżność. |
| Istnieje | Nie ma | Zaimportować kontekst rozmowy bez zmiany plików; pokazać różnicę fingerprintów lub brak możliwości jej sprawdzenia. |
| Nie istnieje | Jest | Utworzyć docelowy workspace z migawki i zaimportować sesję. |
| Nie istnieje | Nie ma | Zaimportować sesję bez odtworzonego projektu; agent wymagający workspace musi dostać nowy workspace przed rozpoczęciem następnego turnu. |

Każdy z czterech wariantów dopuszcza import prawidłowej sesji; ostrzeżenie i raport poziomu wierności są obowiązkowe, gdy stan plików nie odpowiada źródłu. Wybór workspace nie powtarza historycznych narzędzi. Nie rekonstruować projektu z samej rozmowy/audytu w tym zadaniu — zachować to jako osobny, odroczony krok.

## Rozstrzygnięcie N003 — pełny audyt i ochrona archiwum

DSH utrwala dokładną treść promptów, odpowiedzi i wyników narzędzi bez automatycznej redakcji: ukryte zmiany treści zniszczyłyby możliwość odtworzenia i weryfikacji sesji. Odrębne magazyny credentials i nagłówki autoryzacji nie są częścią eksportu, ale sekret wpisany przez użytkownika lub narzędzie w treści pozostaje w archiwum. Eksport jawny wymaga czytelnego ostrzeżenia; użytkownik może wybrać szyfrowanie archiwum hasłem. Hasło jest używane tylko podczas bieżącego eksportu/importu, nie trafia do logu, telemetryki ani settings. Operacje eksportu/importu oraz gotowy plik udostępniać wyłącznie użytkownikowi uprawnionemu do źródłowej/docelowej sesji; nie tworzyć publicznego URL archiwum.

Trwały audyt jest warunkiem wykonania: przed wywołaniem modelu lub narzędzia zapis intencji musi być potwierdzony, a wynik nie może zostać odesłany agentowi przed potwierdzeniem jego zapisu. Przy błędzie, luce sekwencji lub niedostępności magazynu zatrzymać kolejne wywołania i zgłosić awarię, bez pozorowania powodzenia. Narzędzie mogło wykonać nieodwracalny skutek przed awarią zapisu wyniku; stan oznaczyć jako `outcome unknown`, nie powtarzać automatycznie. Awaria opcjonalnego `CODEX_LOG_REQUESTS` nie jest awarią wymaganego audytu i nie blokuje sesji.

## Rozstrzygnięcie N061 — format archiwum szyfrowanego hasłem

Nieszyfrowany eksport pozostaje zwykłym, kanonicznym ZIP DSH. Opcjonalny eksport szyfrowany to dokładnie strumień bajtów tego ZIP zaszyfrowany do **binarnego age v1 z jednym odbiorcą `scrypt`**, zapisywany jako `.zip.age`. Nie dodajemy własnego nagłówka DSH ani drugiego formatu zawartości; po odszyfrowaniu importer przetwarza ten sam ZIP i manifest co przy eksporcie jawnym. Import rozpoznaje format po bajtach, nie po rozszerzeniu pliku. Zakres tej decyzji obejmuje hasło, nie klucze publiczne, ASCII armor ani mieszaną listę odbiorców.

[Specyfikacja age v1](https://c2sp.org/age@v1.0.0) definiuje losową sól `scrypt` dla każdego pliku, uwierzytelniony nagłówek oraz strumieniowy payload ChaCha20-Poly1305 w blokach 64 KiB z uwierzytelnionym blokiem końcowym. To pozwala przetwarzać archiwum bez globalnego limitu rozmiaru i odrzucać uszkodzenie lub ucięcie strumienia. Implementacja ma używać utrzymywanej, zgodnej biblioteki albo wydzielonego helpera, nie własnej implementacji kryptografii; testy interoperacyjności muszą sprawdzić zapis i odczyt przez niezależną implementację age/rage oraz błędne hasło, modyfikację i ucięcie. [Referencyjne age](https://github.com/FiloSottile/age) obsługuje tryb hasła i wskazuje interoperacyjną implementację rage.

Hasło przekazujemy tylko do bieżącej operacji przez pamięć procesu lub prywatny kanał IPC, nigdy przez argument CLI, zmienną środowiskową, plik tymczasowy, settings, Session, log ani telemetrykę. Biblioteka może trzymać je w pamięci do zakończenia operacji, lecz DSH nie przechowuje go po niej. Parametr pracy `scrypt` przy eksporcie ma bezpieczny domyślny poziom dobrany do docelowego środowiska; importer ogranicza koszt podany w nagłówku konfigurowalną polityką zasobów, by nie przyjmować arbitralnie drogiego pliku. Nie wprowadzamy stałego globalnego limitu wielkości ZIP. Odszyfrowane bajty pozostają w prywatnym stagingu; import preview ani zatwierdzenie nie może uznać archiwum za prawidłowe przed weryfikacją ostatniego uwierzytelnionego bloku i zwykłą walidacją ZIP/manifestu. Staging po błędzie usuwa importer bez naruszania istniejącej sesji ani workspace.

Nie wybieramy szyfrowania poszczególnych wpisów ZIP: ujawniałoby strukturę/nazwy i komplikowało wspólną walidację manifestu. Nie projektujemy też własnej koperty AES/Argon2, ponieważ gotowy format age ma specyfikację i niezależne implementacje. Ta decyzja nie oznacza, że szyfrowanie lub import są już wdrożone; wykonanie i testy należą do N062.

## Stan wyjściowy i punkty integracji

- `deepseek-harness/packages/core/agent-codex/src/model-gateway.ts`: Codex już wysyła żądania do uwierzytelnionej bramki DSH. Domyślny Chat Completions idzie przez adapter DSH i jest zamieniany na strumień Responses dla Codexa; natywny Responses jest proxy. Bramka nie ma jednak trwałej korelacji z sesją/turnem ani kompletnego zapisu modelowego. `CODEX_LOG_REQUESTS` to opcjonalna diagnostyka, nie źródło importu.
- `deepseek-harness/packages/core/agent-codex/src/agent.ts`: driver zapisuje powiązanie threadu i projekcję itemów, ale `item/tool/call` obecnie odrzuca. Jeden DSH step obejmuje dziś cały turn Codexa.
- `deepseek-harness/packages/core/tools/src/index.ts`: `schemas(agent)` i `execute(...)` są miejscami pozyskania schematów, polityki, zgód i wyników. `agent-loop` pokazuje wzór trwałych `tool/call` i `tool/result`.
- `dockers/addons/codex/codex-rs/app-server-protocol`: istnieją eksperymentalne dynamic tools, a `thread/resume.history` przyjmuje historię, lecz żadne z nich samo nie rozwiązuje odtworzenia pełnego stanu.
- `dockers/addons/codex/codex-rs/rollout-trace`: opcjonalny, best-effort ślad części żądań/odpowiedzi i checkpointów. Lokalna compaction omija go; trzeba zaprojektować wymagany, trwały strumień niezależny od diagnostyki.
- `deepseek-harness/packages/session-query/session-log-export`: obecny eksport ZIP zawiera JSONL sesji, potomne sesje i załączniki, ale nie manifest ani przenośny stan Codexa. Importera ZIP jeszcze nie ma.
- `deepseek-harness/packages/client/ui-settings-models`: istniejący edytor bazuje na deklaracjach konfigurowalnych providerów LLM, dlatego `codex.providers` nie pojawia się w nim automatycznie, mimo że sekcja `codex` już istnieje w settings.

## Przepływ docelowy

```text
Klient → DSH Session (user/message) → Codex app-server
Codex: składa pełne żądanie modelowe / compaction
  → DSH model executor: trwały request → provider API → trwały wynik/stream
  → Codex: interpretuje odpowiedź i aktualizuje własny kontekst
  → jeśli tool call: DSH zapisuje call → policy/approval → wykonuje → zapisuje result
  → Codex dostaje dokładnie ten wynik, który DSH zapisał
  → Codex: następny request lub odpowiedź końcowa
  → DSH: kończy turn i zapisuje checkpoint kontekstu Codexa
```

Wymagany jest jeden identyfikator korelacyjny od DSH `sessionId` przez `codexThreadId`, `turnId`, `stepId`, `modelAttemptId` i `toolCallId` do requestu upstream. Dla prób przerwanych zachować otrzymane części wyniku i przyczynę zakończenia. DSH pokazuje live stream, ale dopiero rozstrzygnięcie Codexa staje się odpowiedzią końcową sesji; unikamy podwójnego wyświetlania tekstu.

## Faza 1 — kontrakty i wybór drivera

Zdefiniować wersjonowany kontrakt `AgentDriverState`: identyfikator agenta, wersja, wybrany provider/model, obowiązkowe porty importu/eksportu kanonicznego kontekstu DSH, powiązanie z sesją i lineage. Zapisać wybór drivera przy tworzeniu sesji, nie odgadywać go później z nazwy modelu ani aktualnego `enabled`. Rozdzielić routing nowej sesji, wznowienie istniejącej i utworzenie sesji z importu. Każdy przyszły pełny driver musi implementować oba porty oraz raportować zgodność importu; wersjonowany stan prywatny jest dodatkowym rozszerzeniem dla wiernego wznowienia tego samego drivera. Standardowy i Codex driver muszą współistnieć w jednej kompozycji bez dwóch pętli na sesję.

## Faza 2 — DSH wykonuje model

Rozszerzyć lokalną bramkę, a nie tworzyć od razu drugi transport. Codex przekazuje pełne żądanie oraz uwierzytelnione metadane sesji, turnu, celu (`inference`/`compaction`) i próby. DSH waliduje trasę z `codex.providers`, zapisuje oryginalne żądanie, wywołuje model, zapisuje faktycznie wysłany payload, odpowiedź/chunki/usage i zwraca Codexowi strumień w oczekiwanym formacie. DSH nie uruchamia własnego `ReactLoopAgent` ani nie modyfikuje modelowych instrukcji.

`apiFormat` pozostaje opcjonalne z domyślnym `chat-completions`. Dla Chat Completions adapter tłumaczy semantycznie wspierane wiadomości, role, function tools/calls/results, równoległe calle, błędy i usage na/z Responses. Obrazy i inne modalności są dopuszczane tylko wtedy, gdy zarówno model, jak i adapter potwierdzają obsługę. Nie wolno pomijać reasoning, narzędzia lub bloku treści po cichu. Dla natywnego Responses DSH przekazuje żądanie bez semantycznych zmian i zachowuje odpowiedź; oba formaty korzystają z tego samego audytu. Wszystkie żądania modelowe Codexa, także compaction i ewentualne fallback/retry, muszą przejść tę granicę. Retry ma jednego właściciela i idempotentny identyfikator próby; przerwanie i backpressure przechodzą do upstream.

## Faza 3 — narzędzia DSH jako jedyne narzędzia Codexa

Przy każdym turnie Codex otrzymuje deterministycznie uporządkowane schematy `ctx.tools.schemas(agent)`; zmiana katalogu między turnami jest obsługiwana, a wersja/hash schematów trafia do śladu. Forkowi trzeba dodać aktualizację dynamicznych narzędzi przy turnie/resume oraz prompt informujący o narzędziach dostarczonych przez DSH. Dynamiczny call z parametrami Codexa przechodzi przez scope i politykę `ctx.tools.execute`, a DSH zapisuje call przed dispatch i dokładny wynik przed odesłaniem do Codexa. Zachować błędy, odmowy, anulowanie, timeout, multimodalne wyniki i kolejność równoległych wywołań. Ponowienie po zerwaniu połączenia nie może wykonać tego samego narzędzia drugi raz.

Po audycie zależności usunąć natywne implementacje shell/patch/MCP/web/hosted/delegation oraz inne modelowo dostępne narzędzia z naszego forka. Pozostawić tylko minimalną infrastrukturę protokołu i obsługę narzędzi delegowanych do DSH; test requestu modelowego i dispatchera musi wykazać brak ścieżki wykonania natywnego toola. Funkcje Codexa wewnętrzne dla pętli/compaction, które nie są narzędziami modelu, pozostają.

## Faza 4 — wymagany ślad i przenośny kontekst

W forku przechwycić kompletny model-visible request po złożeniu promptu oraz wynik dla każdej próby (także błędu i przerwania), a osobno faktyczny request/response upstream po translacji DSH. Dla lokalnej i zdalnej compaction zapisać powód, prompt, wejściową historię, wynik modelu i zainstalowaną historię zastępczą. Zapis obejmuje konfigurację wpływającą na prompt: instrukcje system/developer, model, wysiłek reasoning, schematy narzędzi, wersje szablonów, workspace/źródła instrukcji i wersję forka. Nie obiecywać ukrytego reasoning/stanu serwera, którego API nie udostępnia.

Nowy trwały kanał zdarzeń Codex → DSH ma numery sekwencji, idempotentne ponowienie od kursora i potwierdzenie po zapisie DSH. Duże JSON, media i checkpointy trzymać jako hashowane artefakty powiązane z sesją, a w JSONL zapisywać referencje i relacje. Ustalić spójny punkt zapisu: przy awarii audytu nowa praca modelu/narzędzia nie może postępować z nieodtwarzalną luką. Po restarcie uzgodnić kursor i aktywny rollout; nie tworzyć po cichu nowej historii. Diagnostyczne `CODEX_LOG_REQUESTS` może pozostać opcjonalne, ale nie bierze udziału w gwarancji eksportu.

Zdefiniować wersjonowany `CodexContextSnapshot` po każdej zakończonej turze i compaction: efektywna model-visible historia, stan compaction, identyfikatory odpowiedzi jako provenance, konfiguracja i komplet referencji do artefaktów. Po imporcie pierwszy request musi zawierać pełny kontekst; nie wolno używać starego `previous_response_id` ani zakładać, że stary WebSocket lub provider-side state nadal istnieje. Snapshot musi być przenośny między instalacjami; ścieżki lokalne oraz `CODEX_HOME` są tylko metadanymi/provenance, nie zależnościami potrzebnymi do odtworzenia. Weryfikator sprawdza kompletność i hash przed eksportem/importem.

## Faza 5 — eksport DSH i import bez odgrywania działań

Rozszerzyć zwykły `Session log`/`/export` ZIP o wersjonowany manifest, log DSH, potomne sesje, załączniki, zdarzenia audytu, payloady modelu i narzędzi, kanoniczny kontekst przenośny oraz ostatni poprawny snapshot prywatny agenta. Eksport najpierw ustanawia barierę flush/snapshot, a potem tworzy spójny odczyt; brakujący blob, niespójna sekwencja lub nieukończony snapshot ma zakończyć eksport błędem. Każdy agent eksportuje przez ten sam port do tego samego formatu DSH. Domyślnie nie kopiować całego workspace; jego migawka jest opcjonalnym trybem eksportu. Nie przerabiać treści promptów i wyników narzędzi na potrzeby audytu/archiwum. Nie eksportować odrębnych wartości credentials ani surowych Authorization headers, chyba że użytkownik sam wprowadził je do treści; wówczas archiwum wymaga ostrzeżenia. Użytkownik może wybrać eksport szyfrowany hasłem, a import musi obsługiwać takie archiwum po podaniu hasła; hasła nie zapisywać w sesji ani konfiguracji. Eksport nieszyfrowany pozostaje świadomą opcją użytkownika. Dostęp do archiwów ograniczyć do uprawnionego użytkownika sesji.

Zbudować importer ZIP i szyfrowanego wariantu z trybem walidacji/podglądu, ochroną przed path traversal/zip bomb, weryfikacją wersji/hashów/referencji i mapowaniem nowych identyfikatorów. Nie narzucać stałego globalnego limitu rozmiaru archiwum; stosować strumieniowe przetwarzanie, kontrolę zużycia zasobów oraz opcjonalne limity konfigurowane przez operatora. Import tworzy **nową** sesję i nowe powiązanie drivera, nigdy nie wznawia obcego `threadId` ani nie wykonuje dawnych narzędzi. Orkiestrator DSH waliduje kanoniczny format i wywołuje obowiązkowy port docelowego drivera; nie zawiera przełączników dla par agentów. Dla Codex → Codex dodać w forku jawne API utworzenia threadu z `CodexContextSnapshot` i test kontynuacji po usunięciu starego `CODEX_HOME`. Dla standard → standard odtworzyć trwałą historię zgodnie z formatem DSH. Dla Codex ↔ standard oraz przyszłych agentów importować pełny kanoniczny kontekst DSH jako nową, powiązaną sesję, z jawnym raportem zgodności prywatnego stanu; prywatnego stanu jednego drivera nie udawać stanem drugiego. Nierozpoznany format lub niedostępny model ma wywołać jasny błąd albo jawnie zatwierdzoną zmianę konfiguracji. Credentials zawsze rozwiązywać ponownie w docelowym środowisku.

Odtworzenie kontekstu modelowego nie jest gwarancją identycznej przyszłej odpowiedzi modelu. Dalsze narzędzia mogą również zobaczyć inny stan plików: manifest musi opisać workspace, jego fingerprint oraz kompletność ewentualnej migawki. Tryb „wierne wznowienie środowiska” wymaga zgodnego workspace albo zastosowania dołączonej migawki; pozostałe warianty są jawnie oznaczone jako wznowienie konwersacji, nie całego środowiska, zgodnie z macierzą N002.

## Faza 6 — GUI, Trajectory, SDK i testy

W Settings → Models udostępnić `codex.providers` tak samo jak zwykłe modele: dodanie/usunięcie providera, API key przez credentials, URL, nazwa, lista modeli, parametry modeli i `apiFormat` z domyślnym Chat Completions. Zachować oddzielne ustawienia `llm-pi-ai` i `codex`; edytor powinien używać wspólnych komponentów, ale zapisywać do właściwej sekcji. Zmiana GUI/settings ma natychmiast odświeżać katalog wyboru modeli i przyszłe turny, nie zmieniać modelu w aktywnej próbie. Ekran tworzenia/importu sesji ma wybór drivera oraz trybu importu.

Trajectory pokazuje uporządkowane żądania modelowe, compaction, tool call, zgodę, wynik, błędy i korelację z turą; transcript nie duplikuje strumieni. TypeScript/Python SDK oraz lokalizacje otrzymują nowe kontrakty. Testy obejmują oba formaty API, wiele turnów, zmianę modelu i narzędzi, równoległe calle, awarie/retry/anulowanie, compaction lokalną/zdalną, eksport/import między restartami i bez starego volume, neutralny import między agentami, brak natywnych narzędzi oraz brak drugiej pętli. Testy kontenerowe i ręczne prowadzić na **instancji testowej**, nie głównej.

## Kryteria zakończenia i decyzje do zamknięcia przed implementacją

- Po wyeksportowaniu sesji Codexa i usunięciu jej starego runtime state da się zaimportować ZIP, utworzyć nowy thread i kontynuować rozmowę; test porównuje model-visible stan przed eksportem i po imporcie, z udokumentowanymi wyjątkami dotyczącymi opaque provider state.
- Każdy request modelu i każdy tool call widoczny w teście da się znaleźć po identyfikatorze w DSH Session i w ZIP; błąd trwałego zapisu jest jawny i blokuje dalszy niezaudytowany krok.
- Żaden natywny tool Codexa nie trafia do modelu ani nie może się wykonać. Dodanie toola DSH nie wymaga implementacji w forku Codexa.
- Modele Codexa są edytowalne w GUI na równi ze standardowymi, a import do innego drivera zachowuje oznaczenie pochodzenia i poziomu wierności.
- Przed kodowaniem domknąć zachowanie przy odmiennym workspace i awarii trwałego audytu, a także kompatybilność starych archiwów (domyślnie tylko neutralny transcript, bez obietnicy wiernego stanu) i zakres zmian w pozostałych binarkach forka po usunięciu narzędzi. Potwierdzone: workspace snapshot jest opcjonalny, brak stałego globalnego limitu archiwum, audyt zachowuje pełną treść, a eksport/import może używać hasła.
