# Integracja Codex Agent z DSH

Ten plik jest źródłem prawdy dla integracji pełnego agenta Codex z DSH. Wykonanych wpisów nie wolno usuwać ani zmieniać; odkryta praca otrzymuje nowy wpis przed rozpoczęciem implementacji.

## Stan i dowody z repozytoriów

### Obecny DSH

DSH składa aplikację z pluginów Cordis. `AgentRegistry` w `deepseek-harness/packages/core/agent/src/index.ts` udostępnia jeden wymienialny `AgentFactory`, a `Agent` z `deepseek-harness/packages/core/agent/src/runtime-types.ts` jest publicznym kontraktem dla UI, SDK i pozostałych pluginów. Domyślny `AgentLoop` w `deepseek-harness/packages/core/agent-loop/src/index.ts` rejestruje fabrykę, tworzy trwałą sesję DSH i uruchamia `ReactLoopAgent` z `deepseek-harness/packages/core/agent-loop/src/agent.ts`.

Domyślny loop DSH kontroluje turny, kroki, składanie system promptu, `ctx.llm`, `ctx.tools` i retry. Log `Session` jest append-only i stanowi źródło historii widocznej dla modelu; `deriveMessages()` projektuje ją dla kolejnego requestu. `agent/assistant-stream` jest kanałem live, natomiast `assistant/message`, `assistant/attempt`, `tool/*`, `turn/*` i `step/*` są trwałymi faktami. Integracja pełnego Codexa nie może być adapterem `ctx.llm`, bo wtedy loop i tool execution pozostałyby po stronie DSH.

Istniejący `deepseek-harness/packages/subagent/subagent-codex` jest jednorazowym providerem subagenta. Używa oficjalnego app-server przez JSON-RPC/JSONL, ale celowo uruchamia nowy proces, ephemeral thread i jeden turn dla każdego runu, odrzuca interakcje oraz nie przekazuje progresu. Jego `src/wire.ts` i testy są sprawdzonym wzorcem framingu, korelacji requestów, anulowania i kompatybilności z protokołem app-server. Po przełączeniu runtime’u także ten provider używa binarki deployment-owned forka zamiast paczki npm.

### Obecny Codex

Pełny agent loop, narzędzia, shell, filesystem, repozytorium, approvals, compaction i historia należą do Codexa. Oficjalna powierzchnia dla bogatego klienta to `codex app-server`: protokół w `dockers/addons/codex/codex-rs/app-server-protocol`, implementacja w `dockers/addons/codex/codex-rs/app-server`, a schematy można generować dla dokładnej wersji binarnej. Lifecycle to `initialize`/`initialized`, następnie `thread/start` lub `thread/resume`, `turn/start`, eventy `turn/*` i `item/*`, server requests dla approvals/input/tools oraz `turn/interrupt`.

TypeScript SDK w `dockers/addons/codex/sdk/typescript` nie jest właściwą granicą tej integracji. `Thread.runStreamed()` deleguje do `CodexExec`, który uruchamia `codex exec --json` dla każdego turnu. SDK zachowuje thread ID i potrafi resume, ale eksponuje mniejszy zbiór eventów i nie jest klientem pełnego interaktywnego lifecycle approvals. Jest właściwe dla automatyzacji, nie dla klienta produktu zarządzającego historią, zgodami i pełnym streamem.

Oficjalna dokumentacja OpenAI potwierdza ten podział: App Server jest interfejsem dla głębokich integracji z historią, approvals i streamowanymi eventami, natomiast SDK służy głównie automatyzacji.

## Decyzja architektoniczna

### Wybrany wariant

Powstanie plugin/fabryka agenta DSH oparta na długotrwałym procesie `codex app-server --listen stdio://`. W profilu Codex zastępuje domyślny plugin `dsh-agent-loop`; nie montuje się obu fabryk równocześnie. Jeden proces app-server może obsługiwać wiele threadów DSH, a plugin utrzymuje jedną połączeniową sesję JSON-RPC na proces DSH. Każda sesja DSH ma dokładnie jeden trwały Codex thread ID.

Ta granica minimalizuje fork: nie zmieniamy repozytorium Codexa, nie parsujemy tekstu CLI, nie reimplementujemy loopu i nie przekładamy natywnych narzędzi Codexa na `ctx.tools`. Adapter jest klientem publicznego, wersjonowanego protokołu app-server i przypina zgodną wersję runtime. Upgrade Codexa wymaga regeneracji typów/schematów protokołu i uruchomienia kontraktowych testów kompatybilności.

### Odrzucone warianty

1. Adapter LLM w `ctx.llm`: prosty kompozycyjnie, ale pozostawia loop i tools po stronie DSH, więc nie spełnia celu.
2. TypeScript SDK: zachowuje thread ID, lecz uruchamia osobny `codex exec` na turn i ma zbyt wąski kontrakt zdarzeń/interakcji dla pełnego klienta DSH.
3. Osobny app-server per sesja: izoluje awarie, lecz zwiększa RAM/startup i traci reuse połączeń; trwały thread nie wymaga osobnego procesu.
4. WebSocket daemon: umożliwia zewnętrzny proces, ale transport jest oznaczony jako eksperymentalny/unsupported. Stdio jest stabilniejszym lokalnym transportem. Daemon może zostać późniejszym providerem transportu bez zmiany kontraktu agenta.
5. Bezpośrednie osadzenie Rust crates: najsilniej wiąże cykle wydawnicze i ABI/build DSH z wewnętrznym Codexem; app-server już zapewnia oficjalną granicę procesową.

## Granice odpowiedzialności

| Obszar | Właściciel |
|---|---|
| Główny agent loop, reasoning, wybór i wykonanie natywnych tools | Codex |
| Historia modelowa Codexa, compaction i rollout | Codex thread store |
| Trwały transcript/UI DSH i lifecycle widoczny dla klientów | DSH Session |
| Mapowanie identyfikatorów i projekcja eventów | adapter Codex Agent |
| Proces app-server, handshake, korelacja JSON-RPC, restart | adapter Codex Agent |
| Sandbox, approvals i request-user-input wykonania Codexa | Codex; decyzje delegowane przez adapter do usług interakcji DSH |
| Tool definitions natywnego loopu | Codex; DSH nie dołącza `ctx.tools` |
| Prompt/provider cache | Codex i provider modelu |
| Cache projekcji/transcriptu DSH | istniejące pluginy DSH |

DSH Session nie jest źródłem modelowej historii Codexa. Zawiera projekcję zdarzeń potrzebną UI, audytowi i SDK oraz trwałe metadane integracji. Resume zawsze wskazuje Codexowi zapisany thread ID; DSH nie odbudowuje promptu z własnego transcriptu.

## Przepływ danych i lifecycle wiadomości

1. Klient DSH wywołuje `agent.followup()`/`steer()` z identyfikowanym `UserMessage`.
2. Adapter zapisuje zmianę inboxu, rezerwuje jeden DSH turn i publikuje `agent/status=running`.
3. Adapter atomowo zapisuje `turn/start` i `user/message`, następnie wysyła `turn/start` do istniejącego Codex threadu. Tekst i obsługiwane obrazy są mapowane do `UserInput`; metadane DSH nie są wstrzykiwane do początku promptu.
4. Codex wykonuje cały loop. Adapter filtruje eventy po `threadId`/`turnId`, zapisuje trwałe `codex/item/*` fakty i publikuje live delty tekstu/reasoningu/tool outputu.
5. `item/agentMessage/delta` zasila `agent/assistant-stream`; ukończona końcowa wiadomość staje się `assistant/message` w DSH. Natywne command/file/MCP/dynamic-tool items pozostają faktami Codexa, nie są ponownie wykonywane przez `ctx.tools`.
6. `turn/completed` zamyka DSH turn jako completed/max-tokens/error/aborted, zapisuje usage (w tym cached/cache-write tokens), publikuje stream end i przełącza status na idle.
7. Następny `followup()` używa tego samego Codex thread ID. Steering aktywnego runu używa `turn/steer`; anulowanie używa `turn/interrupt` oraz lokalnego AbortSignal.

Adapter serializuje zwykłe follow-upy jednej sesji. Timeout jest opcjonalną polityką pluginu: po limicie wysyła interrupt i zamyka DSH turn jako aborted z jednoznaczną przyczyną. Awaria procesu przerywa aktywne turny; supervisor uruchamia nowy app-server, wykonuje handshake i `thread/resume` dla kolejnej pracy. Side effects sprzed przerwania nie są wycofywane.

## Sesje, trwałość, resume i fork

Mapowanie `DSH SessionId -> Codex thread ID` jest zapisane jako nowy, log-only event sesji DSH przed przyjęciem pierwszego turnu. Event ma wersjonowany payload, dokładną wersję protokołu/runtime i tryb persistent. Utworzenie sesji rozpoczyna nie-ephemeral `thread/start`; resume DSH odczytuje ostatnie wiążące zdarzenie i wywołuje `thread/resume`.

Codex przechowuje rollout/thread store w trwałym `CODEX_HOME`. Docker Compose musi montować ten katalog jako volume. Restart DSH, app-servera lub całego stacka zachowuje możliwość resume tylko wtedy, gdy przetrwają zarówno log DSH z mapowaniem, jak i Codex home. Brak jednego z nich jest jawnym błędem spójności, a nie sygnałem do cichego utworzenia nowego threadu.

Fork DSH powinien wywołać `thread/fork` i zapisać nowy Codex thread ID. Nie wolno seedować Codexa przez serializację historii DSH. Pierwszy etap może odrzucać fork, dopóki fabryka DSH nie otrzyma jawnego hooka fork zamiast zwykłego `CreateAgentOptions.seed`; brak wsparcia musi być głośny.

## Eventy i mapowanie

Adapter zachowuje dwa poziomy:

- standardowe DSH `turn/*`, `user/message`, `assistant/message` i `agent/assistant-stream` zapewniają kompatybilność klientów;
- wersjonowane `codex/thread-bound`, `codex/turn-bound`, `codex/item/started`, `codex/item/updated`, `codex/item/completed`, `codex/usage` oraz `codex/error` zachowują pełne strukturalne fakty bez udawania wywołań DSH tools.

Reasoning summary/text delta jest osobnym blokiem reasoning w live streamie i końcowej wiadomości, jeśli model/protokół go udostępnia. Command output, file diffs, MCP i dynamic tools są mapowane do typowanych Codex item events oraz prezenterów UI. Server requests dla command/file/permissions/user-input/MCP elicitation otrzymują osobny lifecycle z request ID; wynik interakcji jest odsyłany dokładnie raz. Nieznany request failuje zamknięcie, zamiast automatycznie zatwierdzać.

## Cache: fakty, ownership i wymagania

### Cache providera/model API

`dockers/addons/codex/codex-rs/core/src/client.rs` buduje `prompt_cache_key`; dla root thread jest nim trwałe `responses_metadata.session_id`, a wewnętrzne child sessions mogą dzielić affinity rodzica. `build_responses_request()` zawsze przesyła ten klucz i `store: false`. `dockers/addons/codex/codex-rs/core/tests/suite/prompt_cache_key.rs` potwierdza kluczowanie sesją oraz świadome współdzielenie affinity przez ephemeral fork. `prompt_caching.rs` sprawdza stały klucz, tools i identyczny prefiks mimo zmian ustawień dopisywanych jako nowe context items.

Ten cache należy do providera. DSH nie zapisuje KV ani odpowiedzi; zachowuje jedynie ciągłość Codex threadu. Stabilne muszą pozostać: thread/session ID, model/provider, bazowe instrukcje, kolejność i JSON tools, cwd/workspace roots, ustawienia reasoning/output oraz append-only historia. Zmiana tych wartości może nie zmienić cache key, ale zrywa zgodność prefiksu albo WebSocket continuation.

### Cache/continuation Codexa

`ModelClient` żyje przez sesję Codexa. `ModelClientSession` jest turn-scoped, ale Codex przenosi między turnami cache połączenia WebSocket. `responses_request_properties_match()` wymaga identycznych non-input pól: modelu, instrukcji, tools, tool choice, parallel flag, reasoning, store/stream/include, service tier, prompt cache key i text/output schema. Jeśli poprzedni input jest dokładnym prefiksem, Codex wysyła tylko przyrost i `previous_response_id`. Auth owner change, reconnect, niezgodne pola lub błąd resetują continuation. DSH nigdy nie powinien wyliczać ani przesyłać `previous_response_id`.

Po `thread/resume` Codex oznacza restored history; pierwszy request nowego procesu/połączenia jest pełny, bo in-memory response ID i socket nie przeżywają restartu. Trwały prompt cache providera nadal może trafić dzięki temu samemu cache key i identycznemu prefixowi. Po pierwszym pełnym requestcie kolejne requesty mogą znów używać przyrostowego WebSocket continuation.

### Lokalne cache Codexa

Codex utrzymuje także lokalny trwały thread/rollout store, projekcje/indeksy thread store, skills-list cache per cwd oraz pomocnicze artefakty, np. shell snapshots. To cache/stany implementacyjne Codexa w `CODEX_HOME`; DSH ma utrzymywać volume i nie duplikować ich. Repozytorium nie przedstawia ogólnego cache wyników tools, plików, analiz, kompilacji ani odpowiedzi modelu, który DSH miałby kluczować. Zmiany plików są obserwowane przez natywny loop przy kolejnych operacjach.

### Cache DSH

DSH zachowuje tylko własne istniejące cache projekcji sesji/UI oraz trwałe mapowanie identyfikatorów. Nie przechowuje kopii historii modelowej Codexa, tool schemas ani tool results do ponownego wysłania modelowi. Projekcja eventów Codexa w DSH jest audytem/UI, nie wejściem kolejnego requestu.

## Macierz lifecycle cache

| Scenariusz | Reuse | Wymaganie / invalidacja |
|---|---|---|
| Kolejna wiadomość tej samej sesji | pełny prompt-cache; możliwe WS delta | ten sam Codex thread i stabilne non-input fields |
| Zamknięcie i otwarcie sesji DSH | prompt-cache możliwy; pierwsza WS delta nie | trwałe mapowanie i Codex rollout |
| Restart DSH | jak wyżej | trwały log DSH i `CODEX_HOME` |
| Restart app-servera | jak wyżej | `thread/resume`; in-memory socket/response ID przepada |
| Restart Docker Compose | jak wyżej | oba volumes muszą przetrwać |
| Zmiana modelu | dotychczasowy prefix może istnieć, ale request cache dla nowego modelu nie trafia; WS delta reset | jawny settings update, bez nowego threadu |
| Zmiana system/developer promptu | prefiks od miejsca zmiany nie trafia; WS delta reset | dopisywać zmianę natywnym API, nie przepisywać historii |
| Zmiana tools | prefix/WS delta od definicji tools nie trafia | natywne stabilne tools; dynamic tools w deterministycznej kolejności |
| Zmiana repo/cwd | wcześniejszy prefix może być użyty do momentu dopisanego environment update; semantycznie nowy workspace najlepiej nowy thread | stabilne absolutne cwd; jawna zmiana settings |
| Compaction | pre-compaction provider prefix przestaje być pełnym prefiksem; nowy compacted prefix buduje nową bazę | używać `thread/compact/start`, zachować thread ID |
| Resume starej sesji | provider cache możliwy; pierwszy WS request pełny | `thread/resume`, nie rekonstrukcja przez DSH |
| Fork | fork może świadomie dzielić cache affinity rodzica, ale ma nowy thread/session identity | `thread/fork`, zapisać nowy ID |

## Ryzyka i otwarte pytania

- `AgentFactory` jest obecnie pojedynczą fabryką całej kompozycji. Pierwsza wersja wybiera loop per profile; per-session mieszanie DSH i Codex wymaga późniejszego routera fabryk.
- DSH `Session` i Codex rollout są dwiema trwałymi osiami. Zapis mapowania musi poprzedzać user turn; crash pomiędzy `thread/start` a eventem wymaga wykrycia osieroconego threadu, nie automatycznego ponowienia.
- Dokładne struktury app-server zmieniają się. Adapter musi przypinać runtime, generować artefakty kontraktu i failować przy niezgodnej wersji/protokole.
- Dynamic tools app-server są eksperymentalne. Pierwsza wersja nie eksportuje `ctx.tools` do Codexa; Codex używa własnych tools/MCP. Dodanie DSH tools wymaga osobnej, jawnej funkcji z deterministycznym schema i testami cache.
- Approval i request-user-input wymagają mostu do istniejących usług DSH oraz testów wyścigów cancel/dispose. Tryb unattended może być osobną konfiguracją, ale nie może cicho zatwierdzać ryzykownych operacji.
- Obecny UI zna standardowe DSH tool events. Potrzebne są osobne prezentery dla natywnych Codex itemów zamiast fałszywych `tool/call`.
- API app-server wspiera wiele threadów w jednym procesie, ale awaria procesu ma wspólny blast radius. Supervisor musi odrzucić wszystkie aktywne turny i wznowić każdy thread dopiero przy kolejnej pracy.

## Podjęte decyzje

- Użyć oficjalnego app-server przez stdio, ponieważ jest przeznaczony do bogatych klientów i już ma dowód integracyjny w DSH.
- Pozostawić pełny loop, historię modelową, tools i compaction Codexowi.
- Zastąpić fabrykę/loop DSH w profilu zamiast opakowywać Codexa jako LLM provider.
- Utrzymywać jeden app-server na proces pluginu i trwały thread na sesję DSH.
- Zapisywać tylko mapowanie ID i projekcję zdarzeń; nie duplikować historii/prompt cache.
- Nie zmieniać upstream Codexa; przypinać runtime i generować kontrakt protokołu.
- Nie wystawiać tools DSH przez eksperymentalne dynamic tools w pierwszej wersji.

## Checklista implementacyjna

### Research i kontrakty

- [x] Przeczytać instrukcje repozytoriów DSH i Codex.
- [x] Udokumentować domyślny agent loop DSH i jego punkty rozszerzeń.
- [x] Przeanalizować istniejący provider `dsh-subagent-codex`.
- [x] Porównać CLI exec, TypeScript SDK, app-server i bezpośrednie osadzenie Rust.
- [x] Wybrać oficjalną granicę integracji i zapisać uzasadnienie.
- [x] Zidentyfikować API start, resume, fork, turn, steer, interrupt i compact.
- [x] Zidentyfikować eventy tekstu, reasoning, command, file, MCP, usage i błędów.
- [x] Zidentyfikować server requests dla approvals, permissions, input i MCP elicitation.

### Analiza cache

- [x] Zidentyfikować kod generujący `prompt_cache_key`.
- [x] Zidentyfikować własność i trwałość prompt/prefix cache providera.
- [x] Zidentyfikować warunki użycia `previous_response_id` i incremental WebSocket.
- [x] Zidentyfikować reset cache po zmianie auth, reconnect i zmianie pól requestu.
- [x] Zweryfikować stabilność tools i prefixu w testach Codexa.
- [x] Opisać cache lokalne Codexa oraz cache DSH.
- [x] Opisać lifecycle cache dla 12 wymaganych scenariuszy.
- [x] Określić trwałe dane wymagane od DSH.

### Przygotowanie interfejsów

- [x] Dodać wersjonowany typ eventu `codex/thread-bound` do logu DSH.
- [x] Dodać wersjonowane typy eventów Codex turn/item/usage/error.
- [x] Dodać projekcję odczytującą ostatnie wiążące mapowanie Codex threadu.
- [x] Dodać walidację, że dokładnie jedno mapowanie obowiązuje dla lifecycle sesji.
- [x] Dodać testy serializacji i replay nowych eventów.
- [x] Dodać typowany kontrakt klienta app-server niezależny od transportu.
- [x] Dodać typowany kontrakt supervisor/process app-server.
- [x] Dodać wersję protokołu/runtime do konfiguracji i metadanych mapowania.

### Transport app-server

- [x] Wydzielić współdzielony, testowalny transport JSON-RPC z istniejącego providera Codex.
- [x] Zaimplementować handshake `initialize`/`initialized` dla pełnego klienta.
- [x] Zaimplementować routing odpowiedzi, notifications i server requests.
- [x] Zaimplementować filtrowanie eventów po `threadId` i `turnId`.
- [x] Zaimplementować kontrolowane zakończenie i drain procesu.
- [x] Zaimplementować supervisor restartujący proces po awarii.
- [x] Zaimplementować propagację awarii procesu do wszystkich aktywnych turnów.
- [x] Dodać test nieznanej metody/requestu failującej bez automatycznej zgody.
- [x] Dodać test framingu uszkodzonego JSON i przedwczesnego EOF.

### Fabryka i lifecycle agenta

- [x] Dodać rejestr wymiennych driverów pod wspólną fabryką lifecycle, aby provider Codexa nie kopiował create/resume/persistence/rollback z `agent-loop`.
- [x] Utworzyć pakiet `@deepseek-ai/dsh-agent-codex` zgodny z rolą Service Provider.
- [x] Zarejestrować driver Codex przez `ctx.agents.setDriverFactory()` pod wspólną fabryką lifecycle.
- [x] Zaimplementować `CodexAgent` zgodny z publicznym interfejsem `Agent`.
- [x] Zaimplementować create DSH Session oraz persistent `thread/start`.
- [x] Zapisać `codex/thread-bound` przed dopuszczeniem pierwszej wiadomości.
- [x] Zaimplementować resume DSH Session przez `thread/resume`.
- [x] Odrzucać resume bez mapowania lub bez Codex rollout jednoznacznym błędem.
- [x] Zaimplementować `followup`, `steer`, `inject`, `cancel`, `whenIdle` i `runMaintenance`.
- [x] Zaimplementować status idle/running i eventy registry lifecycle.
- [x] Zaimplementować poprawny dispose agenta i wspólnego procesu.
- [x] Zaimplementować serializację wielu follow-upów jednej sesji.
- [x] Zaimplementować równoległe turny różnych Codex threadów.

### Mapowanie wiadomości, streamingu i eventów

- [x] Zmapować tekstowy `UserMessage` DSH na app-server `UserInput`.
- [x] Zmapować obsługiwane obrazy/załączniki bez przepisywania danych do tekstu.
- [x] Zapisać DSH `turn/start` i `user/message` przed `turn/start` Codexa.
- [x] Zmapować `turn/started` na trwałe powiązanie turn ID.
- [x] Zmapować agent-message delta na `agent/assistant-stream`.
- [x] Zmapować reasoning summary/text delta na bloki reasoning.
- [x] Zmapować końcową agent message na `assistant/message` z kompletnym streamem.
- [x] Zmapować Codex item started/updated/completed na trwałe eventy DSH.
- [ ] Zmapować command output delta i status końcowy.
- [ ] Zmapować file change i diff updates.
- [ ] Zmapować MCP, dynamic tool, web search, plan i error items.
- [x] Zmapować usage z cached/cache-write/reasoning tokens.
- [x] Zmapować terminal completed/failed/interrupted na `turn/end`.
- [x] Zagwarantować dokładnie jedno trwałe settlement assistant streamu.

### Interakcje, anulowanie i timeout

- [x] Zmapować command approval na usługę interakcji DSH.
- [x] Zmapować file approval na usługę interakcji DSH.
- [x] Zmapować permission request na politykę uprawnień DSH.
- [x] Zmapować request-user-input na usługę pytań DSH.
- [x] Zmapować MCP elicitation na bezpieczny prompt DSH.
- [x] Zaimplementować dokładnie-jedną odpowiedź i obsługę `serverRequest/resolved`.
- [x] Zaimplementować `turn/interrupt` przy anulowaniu DSH.
- [x] Dodać konfigurowalny timeout turnu bez hardcodowanego tunable.
- [x] Zaimplementować timeout jako interrupt z trwałą przyczyną DSH.
- [ ] Dodać testy wyścigów cancel/terminal/dispose/server-request.

### Cache i session reuse

- [x] Zapewnić stable Codex thread ID dla wszystkich turnów DSH Session.
- [x] Zapewnić stable cwd/workspace roots oraz deterministyczną konfigurację start/resume.
- [x] Nie przekazywać historii DSH ani `previous_response_id` do Codexa.
- [x] Dodać test dwóch wiadomości używających jednego thread ID.
- [x] Dodać test resume po restarcie app-servera używający `thread/resume`.
- [x] Dodać test zachowania `prompt_cache_key` na mockowanym Responses API.
- [x] Dodać test, że tools i statyczny prefix są identyczne między turnami.
- [ ] Dodać test, że zmiana modelu resetuje continuation bez zmiany thread mapping.
- [ ] Dodać test compaction i dalszego turnu w tym samym threadzie.
- [ ] Dodać test jawnego błędu po utracie Codex volume.

### Profile, konfiguracja i Docker

- [x] Dodać opcjonalny bundle/profile patch montujący driver obok domyślnego agent-loop.
- [x] Dodać przypiętą zależność runtime `@openai/codex`.
- [x] Zastąpić runtime z npm binarką budowaną z forka `dockers/addons/codex`.
- [x] Dodać wieloetapowy build Codex CLI z lokalnego forka do obrazu DSH.
- [x] Dodać konfigurowalną i walidowaną ścieżkę binarki Codexa bez fallbacku do hostowego `PATH`.
- [x] Zapisać i zweryfikować provenance forka/commitu używanego przez runtime.
- [x] Usunąć zależność runtime od upstreamowego `@openai/codex` po przełączeniu na fork.
- [x] Przełączyć także jednorazowy `subagent-codex` na wspólną binarkę forka i usunąć jego zależność npm.
- [x] Dodać config model/provider/reasoning/approval/sandbox/cwd/timeout/env.
- [ ] Walidować wzajemnie wykluczające się i niebezpieczne opcje przy load.
- [x] Dodać trwały `CODEX_HOME` volume do Docker Compose.
- [x] Dodać konfigurację ścieżki Codex runtime bez ścieżek maszynowych.
- [x] Dodać smoke test realnej kompozycji przez Loader/profile.
- [x] Potwierdzić, że profil nie montuje dwóch fabryk agentów.
- [x] Włączyć bundle `@deepseek-ai/dsh-agent-codex` do domyślnego profilu `web`.
- [x] Dodać migrację istniejącego domyślnego profilu `web` zachowując profile zmodyfikowane przez użytkownika.
- [x] Zapewnić osiągalność pakietu `agent-codex` z installation anchor CLI.
- [x] Udostępnić trasę pełnego agenta `codex` w selekcji sesji Web bez udawania adaptera LLM.
- [x] Dodać osobną sekcję `agent-codex.providers` o układzie zgodnym z konfiguracją modeli `llm-pi-ai`.
- [x] Dodać opcjonalne `apiFormat` z domyślnym `chat-completions` oraz natywnym trybem `responses`.
- [x] Dodać lokalny gateway Responses dla Codexa z adapterem Chat Completions i rozszerzalnym routingiem formatów.
- [x] Zweryfikować tekst, wywołania narzędzi, wyniki narzędzi, streaming, błędy i natywny proxy Responses.

### UI i SDK DSH

- [ ] Dodać hostowe prezentery natywnych Codex items.
- [ ] Dodać Web karty command/file/MCP/reasoning/progress.
- [ ] Dodać locale-owned copy dla nowych stanów UI.
- [ ] Dodać projekcję eventów Codexa do TypeScript SDK.
- [ ] Dodać projekcję eventów Codexa do Python SDK.
- [ ] Dodać transcript rendering bez prezentowania narzędzi Codexa jako tools DSH.
- [ ] Dodać keyless snapshot streamed response i tool activity.

### Testy końcowe i dokumentacja

- [ ] Dodać unit testy mapowania każdego obsługiwanego eventu.
- [ ] Dodać testy HMR/disposal rejestracji fabryki i projekcji.
- [x] Dodać test integracyjny nowej sesji z mock app-serverem.
- [x] Dodać test integracyjny kontynuacji i resume.
- [x] Dodać test integracyjny approvals oraz request-user-input.
- [x] Dodać test end-to-end z przypiętym prawdziwym Codexem i mock Responses API.
- [x] Uruchomić E2E pełnego agenta i subagenta na binarce z lokalnego forka oraz sprawdzić commit artefaktu.
- [ ] Dodać credentialed e2e oznaczony do self-skip bez sekretu.
- [x] Zaktualizować README pakietu i dokumentację architektury DSH.
- [x] Dodać Agent Note dla decyzji o zewnętrznym ownerze agent loop.
- [ ] Zaktualizować katalog konfiguracji i dokumentację profilu.
- [x] Uruchomić focused testy zmienionych pakietów.
- [x] Uruchomić typecheck dla zmienionych faces.
- [x] Uruchomić lint i wymagane repo gates.
- [x] Sprawdzić końcowy diff pod kątem niezwiązanych zmian.
- [ ] Potwierdzić ręcznie kryterium end-to-end i zaktualizować wszystkie ukończone wpisy.

## Nowy plan: DSH wykonuje model i narzędzia Codexa

Ta sekcja realizuje [plan.md](plan.md) i zastępuje wcześniejsze, sprzeczne decyzje architektoniczne. Poprzednie wpisy są zapisem historycznym; wykonanych (`[x]`) nie wolno zmieniać ani usuwać. Kroki poniżej są nowe i jeszcze niewykonane. Nowo odkryty krok należy **najpierw** dopisać na końcu tej sekcji z kolejnym wolnym identyfikatorem `N...`, bez wstawiania pomiędzy istniejące kroki, a dopiero potem rozpocząć. Po pełnym wykonaniu i weryfikacji kroku należy **bezzwłocznie** zmienić wyłącznie jego `[ ]` na `[x]` i zatwierdzić razem z wynikiem kroku zgodnie z zasadami commitów w `plan.md`. Nie oznaczać całej fazy zbiorczo.

### 0. Decyzje, inwentaryzacja i kontrakty

- [x] N001 — Uzgodnić i zapisać uniwersalny format DSH oraz poziomy wierności importu: Codex → Codex, standard → standard i między agentami; określić gwarantowany stan model-visible oraz ograniczenia opaque provider state.
- [x] N002 — Uzgodnić zakres snapshotu workspace, limit rozmiaru archiwum i zachowanie importu, gdy workspace różni się od źródłowego.
- [x] N003 — Uzgodnić politykę przechowywania pełnych, potencjalnie wrażliwych promptów/wyników, dostęp do archiwów oraz fail-closed przy utracie trwałego audytu.
- [x] N004 — Zinwentaryzować obecne DSH Session/Agent/Tool/LLM/Settings/Export API oraz formaty archiwów; zapisać zgodność starych sesji i nie zmieniać zatwierdzonych generacji JSONL w miejscu.
- [x] N005 — Zinwentaryzować w forku wszystkie ścieżki modelowe (zwykłe, retry, fallback, lokalna/zdalna compaction), natywne narzędzia, promptowe założenia o nich i zależności pozostałych binarek.
- [x] N006 — Zdefiniować wersjonowane identyfikatory i kontrakt korelacji `sessionId/threadId/turnId/stepId/modelAttemptId/toolCallId` z testem spójności przy retry i reconnect.
- [x] N007 — Zdefiniować wersjonowany `AgentDriverState`, pełny kanoniczny kontekst DSH, prywatny snapshot Codexa, manifest archiwum i macierz zgodności importu/eksportu; przygotować walidatory schematów.

### 1. Jedna pętla i trwały wybór agenta

- [x] N008 — Utrwalić identyfikator drivera wybrany przy tworzeniu sesji i oddzielić go od identyfikatora providera/modelu; przetestować resume po zmianie `codex.enabled`.
- [x] N009 — Rozdzielić routing utworzenia nowej sesji, wznowienia i importu oraz wdrożyć wspólną orkiestrację portów eksportu/importu bez adapterów dla par driverów.
- [x] N010 — Zapewnić, że sesja Codexa używa wyłącznie pętli Codexa, a sesja standardowa wyłącznie pętli DSH; dodać test negatywny podwójnego loopu.
- [x] N011 — Zdefiniować tworzenie nowej sesji przy zmianie agenta z durable lineage zamiast przełączania drivera podczas aktywnego turnu.

### 2. Model wykonuje DSH

- [x] N012 — Powiązać każdą prośbę Codexa do lokalnej bramki DSH z uwierzytelnioną sesją, turnem, celem wywołania i próbą; odrzucać nieznane powiązania.
- [x] N013 — Dodać DSH model executor zapisujący oryginalne żądanie Codexa przed wywołaniem providera oraz faktycznie wysłany payload i wynik/usage po nim, bez semantycznej zmiany promptu.
- [x] N014 — Objąć wykonawcą także lokalną/zdalną compaction, fallback i retry; wykazać testem, że żaden request modelowy forka nie omija DSH.
- [x] N015 — Ustalić jednego właściciela retry i idempotencję prób, przenieść cancel/timeout/backpressure przez DSH do upstream i przetestować przerwany stream.
- [x] N016 — Utrzymać `apiFormat` z domyślnym `chat-completions` oraz natywnym `responses`, rozwiązując provider/model/credential z `codex.providers` w chwili próby.
- [x] N017 — Dokończyć semantycznie wierną translację Responses → Chat Completions i odpowiedzi Chat → Responses dla ról, tekstu, function tools/calls/results, błędów, usage i równoległych wywołań.
- [x] N018 — Dodać translację obsługiwanych obrazów i pozostałych zadeklarowanych modalności; przy nieobsługiwanym bloku/feature zwracać jawny błąd, nigdy ciche pominięcie.
- [x] N019 — Przetestować natywne Responses jako wykonanie przez DSH bez semantycznej modyfikacji oraz porównać zapisane żądanie Codexa z faktycznym żądaniem upstream.

### 3. Narzędzia tylko przez DSH

- [x] N020 — Przekazywać Codexowi deterministyczny katalog `ctx.tools.schemas(agent)` z wersją/hash i umożliwić jego odświeżenie między turnami oraz po resume.
- [x] N021 — Rozszerzyć klienta/app-server o obsługę `item/tool/call`, walidację nazwy/schematu/scope oraz korelację z DSH tool call ID.
- [x] N022 — Zapisywać `tool/call` przed wykonaniem, prowadzić DSH policy/approval/guard/timeout, zapisywać `tool/result` przed odesłaniem dokładnie tego wyniku Codexowi.
- [x] N023 — Obsłużyć anulowanie, błąd, odmowę, wielomodalny wynik, wywołania równoległe i reconnect bez ponownego wykonania raz rozstrzygniętego tool call.
- [x] N024 — Dostosować prompty Codexa do narzędzi dostarczanych przez DSH i usunąć założenia o natywnym shell/patch/MCP/web/delegation.
- [ ] N025 — Po audycie zależności fizycznie usunąć natywne implementacje narzędzi z forka, zachowując minimalny mechanizm dynamicznego wywołania DSH i wewnętrzne funkcje compaction.
- [x] N026 — Przetestować brak natywnych schematów w każdym żądaniu modelowym i brak natywnej ścieżki wykonania w dispatcherze, także przy błędnej konfiguracji.

### 4. Audyt i checkpointy kontekstu

- [x] N027 — Zdefiniować wersjonowane zdarzenia DSH dla model request/stream/result/failure, tool/approval, compaction i checkpointu oraz referencje do dużych artefaktów.
- [x] N028 — Dodać trwały, sekwencjonowany kanał Codex → DSH z ACK po zapisie, kursorem, idempotentnym wznowieniem i uzgodnieniem stanu po restarcie.
- [x] N029 — W forku przechwycić pełny efektywny model-visible prompt i wynik każdej próby zwykłej, częściowej, błędnej i ponawianej.
- [x] N030 — W forku objąć lokalną i zdalną compaction: powód, prompt, wejściową historię, odpowiedź modelu i rzeczywiście zainstalowaną historię zastępczą.
- [x] N031 — Zapisać konfigurację wpływającą na kontekst: instrukcje, źródła workspace, model/provider/API format, reasoning, schematy narzędzi i wersję forka/szablonów.
- [x] N032 — Zbudować przenośny `CodexContextSnapshot` po każdym zakończonym turnie i compaction; zweryfikować kompletność oraz hashe jego referencji.
- [x] N033 — Dodać fail-closed dla luki w wymaganym audycie, trwałe potwierdzenie intencji przed wykonaniem i wyniku przed odesłaniem, `outcome unknown` dla niepewnego skutku narzędzia oraz test crash/reconnect bez podwójnych side effects.
- [x] N034 — Wyświetlić pełną kolejność model/compaction/tool/approval/result w Trajectory z identyfikatorami i bez dublowania końcowej wiadomości.

### 5. Eksport, import i przenoszenie między agentami

- [x] N035 — Rozszerzyć standardowy ZIP `Session log`/`/export` o manifest, wersje, logi sesji/potomków, pełny kanoniczny kontekst DSH, niezmienione payloady, załączniki i snapshoty driverów; workspace snapshot pozostaje opcjonalny.
- [x] N036 — Dodać barierę flush/spójny punkt odczytu oraz test braku cichego eksportu z brakującym blobem, nieciągłą sekwencją lub nieukończonym checkpointem.
- [ ] N037 — Zapisać w manifeście provenance workspace, fingerprint i informację o kompletności opcjonalnej migawki oraz poziomie wierności możliwego importu dla każdego wariantu workspace.
- [x] N038 — Zbudować bezpieczny walidator/import preview ZIP: wersje, hashe, kontrola zasobów bez stałego globalnego limitu rozmiaru, ścieżki, zip bomb, brakujące referencje, wymagane modele i credentials.
- [ ] N039 — Zaimplementować import do nowej DSH Session z nowymi ID i lineage; nie odgrywać historycznych narzędzi, zgód ani requestów modelowych.
- [x] N040 — Dodać w forku API utworzenia nowego Codex threadu z wersjonowanego `CodexContextSnapshot`, bez zależności od starego `CODEX_HOME`.
- [x] N041 — Przetestować Codex → Codex export/import po usunięciu starego Codex volume, porównując efektywny kontekst przed eksportem i po imporcie, a następnie wykonać nowy turn.
- [x] N042 — Zaimplementować i przetestować standard → standard import z zachowaniem model-visible historii DSH i bez ponownego wykonania wcześniejszych działań.
- [ ] N043 — Zaimplementować import pełnego kanonicznego kontekstu DSH Codex ↔ standard przez porty driverów, bez adapterów dla par, z jawnym raportem zgodności stanu prywatnego.
- [x] N044 — Obsłużyć stare archiwa bez snapshotu jako jawny tryb transcript-only albo odmowę wiernego importu; nigdy nie zgłaszać fałszywego pełnego odtworzenia.
- [ ] N045 — Dodać GUI importu: walidacja/podgląd, hasło dla szyfrowanego archiwum, wybór docelowego agenta, modelu/workspace, decyzja o zastosowaniu migawki i potwierdzenie raportu zgodności; otworzyć nową sesję po sukcesie.

### 6. Modele Codexa w GUI i integracja produktu

- [x] N046 — Zadeklarować `codex.providers` jako konfigurowalną rodzinę providerów dla Settings → Models, niezależną od `llm-pi-ai`.
- [x] N047 — Rozszerzyć istniejący edytor modeli o Codex: provider ID/display name, baseURL, API key przez credentials, lista modeli, parametry i opcjonalne `apiFormat`.
- [x] N048 — Zapewnić dodawanie, edycję, usuwanie i walidację modeli Codexa z zachowaniem niewidocznych pól settings oraz ochroną przed konfliktami równoległej edycji.
- [x] N049 — Po zmianie settings odświeżać katalog/picker i przyszłe turny bez zmieniania aktywnej próby; przetestować wybór standard/Codex i izolację ich konfiguracji.
- [ ] N050 — Zaktualizować UI, locale, TypeScript SDK i Python SDK dla drivera, zdarzeń audytu, eksportu/importu i poziomu wierności.

### 7. Integracja, bezpieczeństwo i zamknięcie

- [ ] N051 — Dodać testy kontraktowe i integracyjne obu API, tool calls, compaction, zmiany modelu, reconnect, abort, równoległości i braku dwóch pętli.
- [ ] N052 — Dodać testy archiwum/importu z wrażliwymi danymi: pełna treść promptów/wyników bez redakcji, brak odrębnych wartości credentials/Authorization, ostrzeżenie, kontrola dostępu i brak path traversal.
- [ ] N053 — Dodać keyless snapshoty sesji i testy rzeczywistej kompozycji forka z mock providerem; każdą próbę Docker prowadzić na `dsh-test`, nie głównej instancji.
- [ ] N054 — Zaktualizować README, dokumentację architektury, schemat settings, Agent Note i instrukcje operatora eksportu/importu zgodnie z konwencjami obu podrepozytoriów.
- [ ] N055 — Uruchomić właściwe testy/typecheck/lint/build dla zmienionych pakietów i forka, zachować wyniki oraz zweryfikować, że ZIP wystarcza do nowego Codex turnu bez starego volume.
- [ ] N056 — Przejrzeć końcowy diff i checklistę, potwierdzić wszystkie kryteria z `plan.md`, pozostawić niewykonane kroki otwarte zamiast oznaczać je zbiorczo.
- [x] N057 — Utrwalić regułę commitowania po każdym kroku, łącznego odhaczania i dopisywania odkrytych zadań oraz osobnych commitów zmian wymagań; opisać sposób dla submodułów w `plan.md` i `AGENTS.md`.
- [x] N058 — Wprowadzić obowiązkowe porty eksportu i importu kanonicznego stanu sesji DSH dla każdego pełnego drivera agenta, z walidacją zgodności przy rejestracji.
- [x] N059 — Dodać test zgodności portów z przykładowym trzecim agentem, bez adapterów specyficznych dla par agentów.
- [ ] N060 — Przetestować zmianę standard → Codex → standard poprzez dwa transfery kanonicznego formatu DSH, zachowanie historii model-visible i brak powtórzenia side effects.
- [x] N061 — Wybrać i udokumentować interoperacyjny format opcjonalnego szyfrowania archiwum hasłem, z uwierzytelnieniem, obsługą strumieniową i bez utrwalania hasła.
- [ ] N062 — Zaimplementować opcjonalny eksport szyfrowany i import z hasłem przez wspólne API/GUI; sprawdzić poprawne i błędne hasło, uszkodzenie danych oraz zgodność eksportu jawnego.
- [ ] N063 — W osobnym przyszłym zadaniu rozważyć rekonstrukcję projektu z historii sesji bez migawki; nie implementować jej w bieżącym planie.
- [ ] N064 — Wdrożyć autoryzację eksportu/importu i dostępu do pliku, ostrzeżenie przed jawnym eksportem oraz brak hasła w logu, telemetryce i settings.
- [x] N065 — Dostosować keyless snapshoty przypiętych historycznych generacji sesji do nowego trwałego zdarzenia wyboru drivera bez modyfikowania starych JSONL; odświeżyć i zweryfikować oczekiwane wyniki TypeScript SDK i Python SDK po zmianie sekwencji, oddzielając wcześniejszy drift fixture od zmiany drivera.
- [ ] N066 — Dodać jawnie konfigurowaną per model obsługę remote compaction V2 dla Codexa tylko przy zgodnym natywnym Responses upstream; utrzymać lokalną compaction jako bezpieczny default, uwzględnić zmianę ustawień między turnami i przetestować realną ścieżkę z forkiem.
- [x] N067 — Przenieść instrukcję o własności narzędzi z `developerInstructions` ustawianych przez DSH do promptu składanego przez fork Codexa w trybie narzędzi delegowanych; DSH ma pozostać wykonawcą bez modyfikacji instrukcji modelu.
- [x] N068 — W forku utrwalić dla wątków DSH tryb katalogu wyłącznie delegowanych narzędzi i usunąć wszystkie natywne schematy oraz wykonawców z aktywnego routera; potwierdzić buildem i testem rzeczywistego procesu przed fizycznym usuwaniem modułów N025.
- [x] N069 — Zmapować zależności natywnych implementacji narzędzi w forku, oddzielić kod modelowo dostępnych handlerów od wewnętrznych mechanizmów pętli/compaction i ustalić kompilowalne partie fizycznego usuwania dla N025.
- [x] N070 — Sprowadzić plan narzędzi forka do dynamicznego katalogu hosta dla wszystkich klientów; usunąć natywne ścieżki rejestracji i ich testy planu bez naruszania wspólnego dispatchera.
- [ ] N071 — Fizycznie usunąć źródła natywnych handlerów/specyfikacji, MCP tool exposure i zbędne eksporty API; zachować dynamic handler oraz testowany dispatcher DSH.
- [ ] N072 — Usunąć modelowy Code Mode i runtime'y tylko dla natywnych narzędzi, zachowując wewnętrzne wykonanie poleceń użytkownika, shell snapshot oraz compaction; potwierdzić buildem.
- [x] N073 — Dodać do protokołu forka typowane metody Codex → DSH `dshAudit/append` i `dshAudit/cursor` z odpowiedzią ACK/kursorem, wersją i testami zgodności JSON-RPC.
- [x] N074 — Dodać po stronie DSH walidowany odbiornik zdarzeń N027, który potwierdza sekwencję dopiero po trwałym zapisie, rozpoznaje idempotentne ponowienia i odrzuca lukę lub konflikt.
- [x] N075 — Dodać w forku trwałą kolejkę sekwencyjnych zdarzeń, odczyt kursora DSH, odtwarzanie po restarcie i zatrzymanie pracy przy braku ACK; zweryfikować crash/reconnect przed odhaczeniem N028.
- [x] N076 — Usunąć wcześniejszy błąd `clippy::expect_used` w `codex-rs/core/src/client.rs` blokujący celowany lint forka, a następnie zweryfikować `just clippy` dla zmienionych crate'ów.
- [x] N077 — Usunąć niezależny od wyboru drivera drift historycznych fixture strumienia modelu w keyless snapshotach, bez przepisywania przypiętych JSONL i bez maskowania zmian treści odpowiedzi.
- [x] N078 — Osobno zaktualizować drift sidecarów promptów i schematów narzędzi keyless SDK oraz sprawdzić pełny przebieg snapshotów po tej zmianie, bez mieszania go z przesunięciem sekwencji wyboru drivera.
- [x] N079 — Ustabilizować keyless scenariusz `subagent-dsh-sdk-diagnostic` względem zdarzeń `session-log-deepseek/delivery-accepted` i ich referencji sekwencji, bez pomijania rzeczywistych luk dostawy.
- [x] N080 — Odświeżyć bieżące, nieprzypięte fixture headless po trwałym zdarzeniu wyboru drivera i ich referencje sekwencji, zachowując przypięte historyczne generacje JSONL bez zmian.
- [x] N081 — Osobno zsynchronizować sidecary promptów i schematów narzędzi headless z aktualnymi szablonami oraz zweryfikować pełny keyless suite bez maskowania różnic sesji.
- [x] N082 — Wyjaśnić i odświeżyć niezwiązany z numeracją drivera wynik `cordis-inspect-jsdoc`, zachowując w snapshocie pełną treść odpowiedzi narzędzia bez jej maskowania.
- [x] N083 — Dodać projekcję model-visible historii standardowego agenta do kanonicznego kontekstu DSH (wiadomości, narzędzia, referencje załączników i efektywny stan po compaction), z odmową przy aktywnym turnie lub niemapowalnym bloku; przetestować ją przed podłączeniem obowiązkowego portu N058.
- [x] N084 — Dodać czystą projekcję importu kanonicznego kontekstu DSH do wiadomości standardowego agenta, z zachowaniem kolejności efektywnej historii, osobnym przekazaniem instrukcji, resolverem pełnych referencji załączników i jawnym błędem przy niemapowalnej treści; bez tworzenia sesji ani ponawiania narzędzi (przygotowanie N042).
- [x] N085 — Wspólnemu transferowi agentów dodać jawny model docelowy: odrzucać model niedostępny u celu, raportować zmianę modelu jako ostrzeżenie wymagające potwierdzenia, przekazywać wybór portowi importu i nie przenosić prywatnego checkpointu przy zmianie modelu; przetestować niezależnie od par agentów.
- [x] N086 — Podłączyć projekcje N083/N084 do standardowych portów `AgentTransferSourcePort` i `AgentTransferTargetPort`: eksport tylko zakończonej sesji, deklaracja katalogu modeli, przygotowanie importu z lineage i modelem docelowym bez publikacji nowej sesji ani side effects; sprawdzić przez wspólny `prepareAgentTransfer`.
- [x] N087 — Z przygotowanego importu standardowego agenta zbudować walidowany seed logu nowej DSH Session z zachowaniem kolejności wiadomości i par tool call/result, bez wykonywania dawnych narzędzi; instrukcje zwrócić osobno zamiast po cichu zmieniać ich rolę (przygotowanie N042).
- [x] N088 — Poprowadzić jawny wybór docelowego drivera importu przez publiczną fabrykę `ctx.agents.create` aż do rejestru driverów; odrzucać konflikt z utrwalonym wyborem w seedzie i potwierdzić testem, że import nie zależy od bieżącej polityki nowej sesji (przygotowanie N039/N042).
- [x] N089 — Utrwalić w nagłówku nowej DSH Session odrębne lineage importu (źródłowa sesja/driver oraz identyfikator transferu), bez utożsamiania go z `parentSession` forka; walidować metadane i zgodność jawnej trasy importu przed publikacją oraz przetestować ponowny odczyt.
- [x] N090 — Dodać do sekcji system promptu DSH jawny tryb literalny bez interpolacji `{{...}}`, potrzebny do wiernego instalowania instrukcji importowanej sesji standardowej; zachować dotychczasowe renderowanie domyślne i przetestować oba tryby.
- [x] N091 — Zsynchronizować dokumentowane bloki `type-equiv` dla `SessionHeader` i `CreateSessionOptions` po dodaniu lineage importu w N089, bez naprawiania niezwiązanych driftów innych pakietów w tym samym kroku.
- [x] N092 — Dla standard → standard wyodrębnić z kanonicznej projekcji dokładną instrukcję systemową, odrzucać instrukcje niemapowalne do standardowego promptu i utrwalić literalny tekst w nagłówku seeda nowej sesji; sprawdzić odczyt po serializacji, również dla `{{...}}`.
- [x] N093 — Podłączyć przygotowany standard → standard import do fabryki nowej sesji DSH z lineage, literalnym system promptem, odtworzeniem go po resume i prepublikacyjną odmową konfliktu instrukcji; przetestować nowy turn z pełną historią bez historycznych wykonań modelu lub narzędzia (przygotowanie N042).
- [x] N094 — Zaktualizować zastane asercje testów `agent-loop` zakładające pusty log nowej sesji, aby uwzględniały trwałe `agent/driver-selected` bez osłabiania testów kolejności inbox/turn; osobno sprawdzić zgłaszane przez pełny suite nieobsłużone odrzucenia cyklu życia.
- [x] N095 — Zdiagnozować i naprawić nieobsłużone odrzucenia przy równoczesnym dispose właściciela/fabryki i tworzeniu agenta w `scope-lifecycle`; zachować gwarancje rollback/quiescence i uruchomić pełny suite `agent-loop`.
- [x] N096 — Wspólnemu rejestrowi agentów dodać typowany, effect-scoped rejestr sparowanych portów transferu po `driverId`, z walidacją tożsamości, odmową duplikatu i odczytem bez adapterów dla par; podłączenie standardowego i Codex drivera pozostawić do N058.
- [x] N097 — Umożliwić asynchroniczny odczyt aktualnego katalogu modeli przez docelowy port transferu na etapie preview i ponownie przy commit, aby standardowy driver mógł pobierać modele z `ctx.llm` bez nieaktualnego cache; zachować sprawdzanie wybranego modelu przed utworzeniem sesji.
- [x] N098 — Przenieść rozwiązane referencje załączników do wspólnego wejścia importu transferowego zamiast zamykać je na stałe w porcie; zarejestrować parę portów standardowego drivera w `AgentLoop` z bieżącym katalogiem `ctx.llm`, sprawdzić zmiany katalogu, załączniki i wygaszenie rejestracji po unload.
- [x] N099 — Rozszerzyć źródłowy port standardowego drivera o odczyt zakończonej sesji z trwałego magazynu, gdy nie jest już aktywna w `SessionStore`, z barierą spójności i bez ponownego uruchamiania agenta; potrzebne do eksportu starych sesji w N035/N058.
- [x] N100 — Wprowadzić sąsiednią generację formatu Session dla trwałego `importLineage`: zapisać i odczytać je w fizycznym nagłówku bez nadpisywania v2, dodać migrację v2 → v3 oraz test zachowania lineage po zamknięciu i ponownym otwarciu JSONL.
- [x] N101 — Zsynchronizować standardowy eksport ZIP z bieżącym fizycznym nagłówkiem Session po N100, w tym `importLineage`, bez gubienia metadanych i z testem eksportu/importu pochodzenia.
- [x] N102 — Wyjaśnić i naprawić keyless replay headless, w którym zapisany `assistant/message` zawiera poprawną odpowiedź, ale `stdout` procesu pozostaje pusty; nie modyfikować historycznych fixture ani nie pomijać asercji odpowiedzi.
- [x] N103 — Dla turnów z narzędziami delegowanymi do DSH pominąć natywne przygotowanie rekomendacji i wyszukiwanie narzędzi przed zbudowaniem routera; potwierdzić, że model nadal dostaje wyłącznie aktualny katalog hosta, również przy włączonych natywnych feature flags.
- [x] N104 — Usunąć nieużywany po N070 cache ekspozycji narzędzi MCP, jego stan sesji i testy oraz sprawdzić kompilację `codex-core`; aktywne połączenia MCP potrzebne do funkcji wewnętrznych pozostawić do osobnego przeglądu N071.
- [x] N105 — Dodać test publicznej ścieżki app-servera potwierdzający, że rzeczywisty request modelowy zawiera dokładnie dynamiczny katalog hosta i ani jednego natywnego schematu dla zwykłego wątku; uruchomić celowany test `codex-app-server`.
- [x] N106 — Po wyłączeniu natywnego tool search nie wystawiać ani nie rejestrować dynamicznych narzędzi oznaczonych `defer_loading`; host może udostępnić je później jako bezpośrednie. Zachować zgodność `exposeToContext:false`, przetestować brak takiego schematu i ścieżki wykonania oraz udokumentować zachowanie.
- [x] N107 — Usunąć osieroconą politykę ekspozycji natywnych narzędzi MCP z planera forka po N070/N104, bez usuwania runtime MCP używanego poza modelowym planem; sprawdzić kompilację `codex-core`.
- [x] N108 — Usunąć testowy most dodający narzędzia rozszerzeń do modelowego planu Codexa, jego martwą funkcję zbierania executorów i test natywnej ekspozycji; pozostawić aktywne API rozszerzeń poza katalogiem modelu i sprawdzić `codex-core`.
- [x] N109 — Zaktualizować testy routera, które po N070/N106 nadal oczekują natywnych lub odroczonych narzędzi, na kontrakt bezpośredniego katalogu hosta i zweryfikować cały moduł testów routera.
- [x] N110 — Usunąć osierocony natywny `ExtensionToolAdapter` i jego testy po odłączeniu od planu modelowego; pozostawić API rozszerzeń używane poza modelowym routerem i sprawdzić kompilację `codex-core`.
- [x] N111 — Przenieść testy sesji z testowego buildera natywnych narzędzi na dynamiczny katalog hosta, zachować test fatalnego błędu niezgodnego payloadu i usunąć osierocone funkcje testowego składania natywnego planu; zweryfikować celowane testy `codex-core`.
- [x] N112 — Usunąć martwy blok rejestracji natywnych shell/MCP/utility/collaboration oraz hosted web z planera forka po N111, zachowując aktywny dynamiczny plan i sprawdzając testy core oraz publiczny request app-servera.
- [x] N113 — Usunąć nieużywane modelowe handlery `current_time`, `sleep`, `test_sync`, `get_context_remaining`, `new_context_window` i `plan` oraz ich eksporty, nie usuwając wewnętrznych funkcji sesji/compaction; sprawdzić `codex-core`.
- [x] N114 — Usunąć osierocone modelowe handlery `list_available_plugins_to_install`, `request_user_input_async` i `send_message_to_user_async` z forka, zachowując niezależne interakcje app-servera; sprawdzić kompilację i testy routera.
- [x] N115 — Usunąć osierocone specyfikacje modelowych narzędzi `get_context_remaining`, `list_available_plugins_to_install`, `new_context_window`, `plan` i `test_sync` wraz z testem specyfikacji; sprawdzić kompilację `codex-core`.
- [x] N116 — Usunąć modelowy handler i schemat `request_user_input` z ich testami, zachowując niezależny protokół interakcji oraz TUI/app-server; sprawdzić `codex-core`.
- [x] N117 — Usunąć osierocony modelowy `request_plugin_install` (handler, specyfikację i ich testy), nie naruszając niezależnego lifecycle pluginów; sprawdzić `codex-core`.
- [x] N118 — Usunąć nieużywany modelowy `view_image` (handler, specyfikację i ich testy), zachowując niezależną obsługę obrazów użytkownika i zdarzenia protokołu; sprawdzić `codex-core`.
- [x] N119 — Usunąć osierocone modelowe handlery i specyfikacje odczytu zasobów MCP (`list`/`templates`/`read`) wraz z testami, zachowując połączenia MCP służące funkcjom wewnętrznym; sprawdzić `codex-core`.
- [x] N120 — Usunąć niedostępną po N070/N106 rejestrację `tool_search` w planerze oraz cache wyszukiwania ze stanu sesji, bez zmiany bezpośredniego katalogu hosta; sprawdzić `codex-core`.
- [x] N121 — Usunąć osierocony modelowy `tool_search` (handler, specyfikację i ich testy) po usunięciu rejestracji N120, zachowując dynamiczny dispatcher hosta; sprawdzić `codex-core`.
- [x] N122 — Usunąć osierocony modelowy handler MCP i jego testy oraz przestarzały test routera zależny od tego handlera, bez usuwania wewnętrznych połączeń MCP; sprawdzić `codex-core`.
- [x] N123 — Usunąć nieaktywny modelowy `request_permissions` handler i jego dwa testy wywołania, zachowując niezależny mechanizm zgód sesji i jego testy; sprawdzić `codex-core`.
- [x] N124 — Usunąć osierocony schemat modelowego `request_permissions` i jego test po N123, zachowując współdzielony schemat uprawnień dla narzędzia shell; sprawdzić `codex-core`.
- [x] N125 — Odłączyć nieosiągalną rejestrację modelowego Code Mode z planera narzędzi przy stałym trybie `Direct`, bez usuwania jeszcze współdzielonego runtime’u; sprawdzić katalog hosta i `codex-core`.
- [x] N126 — Usunąć martwy builder modelowych executorów Code Mode i jego pomocnicze funkcje z planera po N125; zachować bezpośredni katalog hosta i sprawdzić `codex-core`.
- [x] N127 — Uprościć model-visible plan do bezpośrednich specyfikacji hosta, usuwając martwe filtry i augmentację Code Mode przy stałym `Direct`; potwierdzić testem routera i publicznym requestem app-servera.
- [x] N128 — Wyłączyć niezależny prewarm natywnego hosta Code Mode przy starcie sesji forka, skoro modelowy tryb jest stale `Direct`; zachować prewarm modelu/auth i sprawdzić `codex-core`.
- [x] N129 — Usunąć osierocony modelowy handler i schemat `exec` Code Mode po N125–N127, bez naruszania wewnętrznego runtime’u; sprawdzić `codex-core`.
- [x] N130 — Usunąć osierocony modelowy handler i schemat `wait` Code Mode wraz z testami wyłącznie tej natywnej ścieżki, zachowując wspólny dispatcher i sprawdzając `codex-core`.
- [x] N131 — Usunąć martwe uruchamianie workera Code Mode przy każdej próbie modelowej w forku po stałym trybie `Direct`, bez zmiany wspólnego runtime’u; sprawdzić `codex-core`.
- [x] N132 — Uogólnić trwałą kolejkę audytu app-servera z faktu `context/config` na dowolny fakt N027 z zapisem, wznowieniem od kursora i ACK DSH, zachowując istniejący preflight; przetestować kolejność i idempotencję.
- [x] N133 — Usunąć osierocony wrapper uruchamiania workera Code Mode i warunek `requires_code_mode_worker` po N131, zachowując testy samego wewnętrznego brokera; sprawdzić `codex-core`.
- [x] N134 — Zatrzymać eksport aktywnej sesji, gdy bariera `SessionStore.flush` zwraca `false`, zamiast czytać potencjalnie nieaktualny log; sprawdzić trasę główną i eksport potomka testami.
- [x] N135 — Przekazać z app-servera do rdzenia forka uchwyt obowiązkowego audytu przypisany do turnu DSH, zamrozić go w `TurnContext` przed samplingiem i sprawdzić brak dziedziczenia przez inne turny; przygotować N029 bez zmiany protokołu publicznego.
- [x] N136 — W obu transportach Responses forka zapisać pełny logiczny request `model/request` do obowiązkowego audytu przed wysłaniem próby modelowej, z tym samym attempt ID co bramka DSH i osobnym wpisem dla każdego retry; nie uruchamiać modelu bez ACK.
- [x] N137 — Zapisywać sparsowane zdarzenia strumienia i terminalny wynik każdej próby modelowej Codexa do obowiązkowego audytu przed ich przekazaniem pętli, zachowując kolejność i fail-closed przy braku ACK; przetestować rezultat i błąd zapisu.
- [x] N138 — Zapisywać do obowiązkowego audytu `model/failure` dla błędów transportu HTTP/WS, błędów strumienia, EOF bez completion i anulowania, z dotychczasowymi częściowymi wynikami; potwierdzić fail-closed i korelację próby testami.
- [x] N139 — Rozstrzygnąć i wyeliminować nieaudytowane ponowienia HTTP ukryte wewnątrz `codex-api` dla bramki DSH: każda faktyczna próba musi mieć osobny attempt ID i fakt albo retry ma należeć wyłącznie do DSH; potwierdzić testem odpowiedzi 503 i sprawdzić ścieżkę WebSocket.
- [x] N140 — Zapisać obowiązkowy `compaction/request` dla lokalnej i zdalnej compaction przed wywołaniem modelu, z istniejącym compaction ID, powodem, surową historią wejściową i pełnym efektywnym promptem; obsłużyć lokalne trim/retry i zdalny fallback bez utraty kolejności.
- [x] N141 — Zapisać `compaction/result` lub `compaction/failure` dla lokalnej i zdalnej compaction po wyniku modelu, w tym fallback i przerwanie, z powiązaniem do compaction ID i bez pomijania częściowych prób modelowych.
- [x] N142 — Utrwalić `compaction/installed` z dokładną historią zastępczą po przypisaniu ID i przed dopuszczeniem dalszej pracy, z bezpiecznym rozstrzygnięciem błędu między ACK audytu a instalacją historii oraz testem fail-closed i zgodności checkpointu.
- [x] N143 — Dodać do obowiązkowego kanału audytu bezpieczne, hashowane artefakty dla dużych promptów, historii, mediów i checkpointów zamiast nieograniczonego inline JSON, z walidacją referencji, trwałością przed ACK i testem brakującego bloba przy eksporcie.
- [x] N144 — Dodać sprawdzalny, fail-closed zapis rollout items dla checkpointu compaction w sesji DSH, bez uznawania błędu `LiveThread.append_items` za sukces; przetestować awarię zapisu i zachować dotychczasowy tryb best-effort dla innych wywołań.
- [x] N145 — Zdefiniować i wdrożyć odzyskiwalne rozstrzygnięcie okna awarii między zmianą żywej historii/rolloutu a ACK `compaction/installed`: trwały stan pending, uzgodnienie po restarcie i brak kontynuacji przy rozbieżności; dopiero potem zamknąć N142 testem crash/reconnect.
- [x] N146 — Zaktualizować nieaktualny test `deferred_executor_compaction_preserves_then_updates_environment_once`, który oczekuje usuniętego modelowego `request_user_input`: zachować sprawdzenie compaction i zmian stanu zdalnego środowiska przez obecny katalog dynamiczny; potwierdzić bez timeoutu.
- [x] N147 — Rozszerzyć obowiązkowy kontrakt audytu DSH o `compaction/pending` z przygotowaną historią zastępczą oraz walidację pary `pending` → `installed` po ID i treści; po odtworzeniu sesji blokować wszystkie inne fakty do czasu rozstrzygnięcia pending, z testami restartu i konfliktu.
- [x] N148 — W forku przygotować ostateczne ID historii compaction przed zmianą stanu, wysłać i potwierdzić `compaction/pending` przed instalacją, a po trwałym zapisie rolloutu wysłać zgodny `compaction/installed`; w obu wariantach compaction przetestować kolejność, dokładną historię i fail-closed przy odmowie ACK.
- [x] N149 — Zapisać DSH `compactionId` w metadanych trwałej historii zastępczej Codexa, tak aby checkpoint rolloutu można było jednoznacznie powiązać z `compaction/pending` po restarcie; nie zmieniać model-visible treści, zachować odczyt starszych rolloutów i sprawdzić serializację oraz zgodność audytu.
- [x] N150 — Udostępnić app-serverowi z rdzenia Codexa odczyt statusu trwałego checkpointu dla konkretnego DSH `compactionId`: `installed` tylko przy identycznej historii i bez późniejszych model-visible zmian, `absent` przy braku checkpointu, `conflict` przy rozbieżności; przetestować błędy magazynu oraz stare rollouts.
- [x] N151 — Rozszerzyć kontrakt audytu DSH o końcowe `compaction/aborted` dla nieinstalowanego checkpointu: wymagaj zgodnego `compactionId` i historii z `pending`, zachowaj powód oraz odblokuj kolejne fakty dopiero po trwałym ACK; przetestuj restart, konflikt i brak pending.
- [x] N152 — Dodać do `compaction/pending` opcjonalną wstecznie kompatybilną kotwicę SHA-256 trwałego rolloutu sprzed instalacji; nowy abort automatyczny wymaga kotwicy, starszy nierozstrzygnięty pending pozostaje fail-closed.
- [x] N153 — W forku Codexa zapisywać kotwicę poprzedniego trwałego rolloutu w fakcie `compaction/pending` oraz udostępnić odczyt i porównanie tej kotwicy przy recovery; przetestować zgodność po ponownym wczytaniu oraz awarie magazynu.
- [x] N154 — Dodać po stronie DSH sesyjny, weryfikowany magazyn artefaktów audytu z ograniczonymi chunkami transferu, trwałym ACK po zapisie i wznowieniem/idempotencją bez ścieżek z payloadu.
- [x] N155 — W forku Codexa offloadować duże payloady audytu do hashowanych artefaktów przed faktem, utrwalać je w spoołu i wysyłać chunkami z uzgodnieniem po reconnect; nie gubić treści ani nie uznawać niepotwierdzonego bloba.
- [x] N156 — Przed ACK faktu audytu w DSH sprawdzać istnienie, sumę i własność sesyjną każdej referencji artefaktu; przy braku albo rozbieżności zatrzymać strumień i przetestować restart.
- [x] N157 — W standardowym eksporcie ZIP ująć wszystkie referencje artefaktów audytu bez duplikacji i odmówić eksportu przy brakującym lub uszkodzonym blobie; przetestować pełną treść i brak cichego pominięcia.
- [x] N158 — Dla każdej próby modelowej zapisać w trwałym audycie DSH rozwiązaną trasę provider/model oraz efektywny `apiFormat` z migawki settings użytej do wykonania, bez wartości credentials; przetestować zmianę settings między próbami.
- [x] N159 — W forku rozszerzyć fakt `context/config` o bezpieczny snapshot instrukcji i ich źródeł, workspace, modelu/reasoning, schematów narzędzi oraz identyfikatorów wersji forka i szablonów; rozróżnić bazę threadu od żądań turnu i przetestować brak credentials.
- [x] N160 — W forku udostępnić odczyt źródła checkpointu obejmujący adnotowaną efektywną historię, zachowane fakty kontekstu i trwały rollout po barierze flush, z hashem rolloutu i odmową przy zmianie historii podczas odczytu; przetestować spójność oraz błąd magazynu.
- [x] N161 — Przekazać zaakceptowaną, pozbawioną credentials konfigurację `context/config` z preflight app-servera do uchwytu audytu danego turnu, bez ponownego odczytu zmiennych settings; przetestować niezmienność i izolację kolejnych turnów jako źródło przyszłego checkpointu.
- [x] N162 — Zbudować w forku wersjonowany payload przenośnego checkpointu z N160/N161: efektywną historią, zachowanym kontekstem, audytowaną konfiguracją i łańcuchem compaction z rolloutu; odmówić przy braku lub duplikacji ID compaction i przetestować zawartość bez zależności od ścieżki rolloutu.
- [x] N163 — Rozszerzyć kontrakt prywatnego checkpointu DSH o wersję V2 produkowaną przez fork, zachowując jawne rozpoznanie V1; walidować pola i referencje compaction przed opakowaniem w kanoniczny format, z testami błędnych danych oraz aktualizacją pary README.
- [x] N164 — Przy przyjęciu i eksporcie checkpointu V2 zweryfikować rzeczywiste SHA-256 efektywnej historii i rolloutu oraz kompletność powiązanych faktów compaction i artefaktów, a nie tylko składnię hashy; dodać międzyjęzykowy fixture serializacji forka Rust → DSH.
- [x] N165 — Po zakończeniu turnu DSH w forku utrwalić wersjonowany checkpoint N162 jako wymagany fakt audytu i czekać na ACK przed `TurnComplete`; przy błędzie źródła albo zapisu zgłosić błąd turnu, bez udawania sukcesu; dodać celowane testy faktu i awarii.
- [x] N166 — Po potwierdzonym `compaction/installed` zapisać osobny checkpoint V2 dla lokalnej i zdalnej compaction, z identyfikatorem różnym od końcowego checkpointu turnu i ACK przed dalszą pracą modelu; przetestować identyfikatory oraz błędny ACK.
- [x] N167 — Ujednolicić kanoniczne kodowanie JSON (w tym liczb zmiennoprzecinkowych) między hashowaniem forka Rust a weryfikacją DSH dla faktycznego payloadu audytu, nie bezpośredniej serializacji struktury; dodać międzyjęzykowy test rzeczywistej ścieżki.
- [x] N168 — Zastąpić buforowanie całego artefaktu checkpointu przy ACK i eksporcie strumieniową walidacją, z testem dużego checkpointu i bez wprowadzania stałego limitu archiwum.
- [x] N169 — Usuwać osierocone prywatne pliki tymczasowe walidacji checkpointów po awarii procesu, bez naruszania aktywnych walidacji; przetestować restart i brak pozostawienia jawnych promptów w katalogu tymczasowym.
- [x] N170 — Wprowadzić do niezależnego snapshotu Trajectory uporządkowaną projekcję trwałych faktów `codex/audit-v1` z ID i korelacją turnu, bez dodawania ich do transcriptu Chat; przetestować replay i strony historii jako przygotowanie N034.
- [x] N171 — Pokazać fakty audytu Codexa jako chronologiczną, lokalizowaną listę w Trajectory z typem operacji, identyfikatorami i podglądem surowego faktu wraz z referencjami do artefaktów; nie renderować drugiej odpowiedzi końcowej ani nie mieszać tej listy z Chat; przetestować widok i paginację.
- [x] N172 — W szczegółach faktu Trajectory odczytywać i weryfikować pełną treść artefaktów audytu Codexa przez autoryzowaną trasę sesji, z ładowaniem na żądanie, obsługą błędu i testem bez ujawniania danych innej sesji.
- [x] N173 — Dla kanonicznego eksportu N035 przygotować strumieniowe wyliczanie rozmiaru i SHA-256 każdego wpisu ZIP oraz końcowy manifest V1 bez buforowania dużych załączników, z testem błędu po przerwanym strumieniu.
- [x] N174 — Podłączyć manifest N173, `driver-state`, kanoniczny kontekst i opcjonalny prywatny snapshot do eksportu przez obowiązkowy port źródłowego drivera; jawnie odmówić przenośnego eksportu bez portu zamiast tworzyć pozornie kompletne archiwum.
- [x] N175 — Przy eksporcie przenośnym sprawdzić, że każda referencja załącznika w kanonicznym kontekście ma odpowiadający jej wpis ZIP z pełnymi bajtami; odmówić domknięcia archiwum przy brakującej lub nieobsługiwanej referencji.
- [x] N176 — Przed ukończeniem ZIP walidować w każdym zawartym logu ciągłość sekwencji audytu Codexa, niepowtarzalność event ID oraz domknięcie `compaction/pending`; odrzucić archiwum z luką lub niedokończonym checkpointem.
- [x] N177 — Dla przenośnego eksportu porównać trwały log korzenia przed i po odczycie kontekstu ze źródłowego portu; przy zmianie odmówić ZIP przed strumieniowaniem i przetestować wyścig z dopisaniem zdarzenia.
- [x] N178 — Dodać czystą projekcję itemów `ResponseItemEnvelope` z checkpointu Codexa V2 do kanonicznych itemów DSH: tekst, reasoning i function calls mapować jawnie, wyniki narzędzi tylko ze znanym outcome, a niemapowalne pola zachować jako `opaque` bez cichej utraty.
- [x] N179 — Z trwałych zdarzeń `codex/tool-call-bound` i `tool/result` zbudować walidowaną mapę `codexCallId → outcome` dla projekcji N178; nie uznawać niepowiązanego, podwójnego lub nierozstrzygniętego wyniku za sukces.
- [x] N180 — Z checkpointu Codexa V2 i audytowanych outcome złożyć w kolejności pełną projekcję aktywnej `effectiveHistory` na itemy kanoniczne, walidując checkpoint i zachowując niemapowalne dane jako `opaque`; nie przedstawiać tego etapu jako pełnego kontekstu historycznego ani nie rejestrować jeszcze portu eksportu.
- [x] N181 — Z walidowanego rolloutu V2 wydobyć wszystkie historyczne `response_item` i zainstalowane `replacementHistory` jako itemy kanoniczne o identyfikatorach rozłącznych z aktywną historią, zachowując kolejność i referencje wyjść compaction; nie rekonstruować ani nie odgrywać dawnych side effects.
- [x] N182 — Powiązać każdą zainstalowaną compaction checkpointu V2 z kompletnym, uporządkowanym łańcuchem trwałych faktów request/result lub failure, pending i installed; dopuścić legalne retry, rozwiązać pełne payloady i odrzucić brak, konflikt lub niewłaściwą kolejność przed projekcją kanonicznej ancestry.
- [x] N183 — Z walidowanych grup audytu N182 zbudować kanoniczne itemy wejścia, pełnych promptów i wyników każdej próby oraz relacje `PortableCompactionV1` do wyjść N181; tryb local/remote odczytać wyłącznie z utrwalonej implementacji i odrzucić brak lub konflikt metadanych, bez wykonywania historycznych prób.
- [x] N184 — Złożyć N180–N183 w jeden walidowany `PortableAgentBundleV1` Codexa z rozłącznymi ID, kompletną aktywną historią, relacjami compaction, trwałym `AgentDriverStateV1` i prywatnym checkpointem V2; testować odmowę przy złym driverze lub niespójnej relacji, bez podłączania jeszcze źródłowego portu.
- [x] N185 — Rozdzielić w ocenie zgodności importu `opaque` z aktywnej historii od nieaktywnej provenance compaction: nie dopuszczać cichej utraty tej drugiej, ale nie blokować wiernego same-driver importu z kompatybilnym prywatnym checkpointem; przetestować ostrzeżenia i błędy dla innych driverów.
- [x] N186 — Wybrać z trwałej, zakończonej sesji Codexa dokładnie końcowy checkpoint V2 ostatniego udanego turnu i jego pełny uporządkowany strumień audytu; odrzucić obcy thread, aktywny/nieudany turn, lukę sekwencji, duplikat ID i niedomkniętą compaction przed odczytem artifactu.
- [x] N187 — Dodać odczyt JSON payloadów audytu i checkpointu z magazynu attachmentów wyłącznie po potwierdzonej sesyjnej recepcie artifactu, weryfikując media type, rozmiar i SHA-256; odrzucać obcą sesję, brak, uszkodzenie i nieprawidłowy JSON, bez ścieżek z payloadu.
- [x] N188 — Rozszerzyć wspólny port transferu i eksport ZIP o strumieniowe przenoszenie dużego kontekstu/checkpointu bez materializacji całego artifactu w pamięci, z walidacją referencji i konfigurowalną polityką zasobów zamiast stałego globalnego limitu archiwum.
- [x] N189 — Wyprowadzić `AgentDriverStateV1` źródłowej sesji Codexa z trwałego thread binding i ostatniego audytowanego upstream model route zakończonego turnu, niezależnie od bieżących settings; odmówić przy braku lub błędnej trasie i przetestować zmianę modelu między turnami.
- [x] N190 — Połączyć w jednym źródłowym odczycie zakończonej sesji Codexa N186/N187/N189, weryfikację checkpointu względem audytu i projekcje N179–N184; zwracać zweryfikowany `PortableAgentBundleV1` bez rejestracji portu lub wykonania side effects, z testem pełnego przepływu i uszkodzonego artifactu.
- [x] N191 — Usunąć pełne `JSON.stringify` kanonicznego kontekstu i prywatnego checkpointu w eksporterze ZIP: kodować ich JSON partiami do mierzonego strumienia, zachowując identyczne bajty, obsługę dużych pojedynczych stringów i test kompletności manifestu po przerwaniu. Jest to etap N188; sam bundle źródłowy nadal wymaga osobnego strumieniowego portu.
- [x] N192 — Dodać do przenośnego eksportu ZIP opcjonalną, walidowaną politykę operatora dla maksymalnego rozmiaru jednego wpisu i łącznych nieskompresowanych bajtów, egzekwowaną podczas strumieniowego odczytu przed emisją nadmiarowego chunku; brak konfiguracji nie nakłada stałego limitu archiwum. Sprawdzić błędy i brak końcowego manifestu po przekroczeniu.
- [x] N193 — Naprawić generator katalogu konfiguracji dla istniejącego pakietu JS-only `export-conversation-pdf` bez `src/index.ts`, zachowując wymóg klasyfikacji pakietów; następnie wygenerować katalog obejmujący pola polityki ZIP z N192 i sprawdzić jego świeżość. Nie edytować ręcznie wygenerowanego katalogu.
- [x] N194 — Naprawić błąd hostowego typechecku w teście `manifest-stream.host.spec.ts` ujawniony po N192: zawęzić strumieniowy wariant `SessionLogZipEntry` w asynchronicznym odczycie, bez zmiany zachowania testu; ponownie uruchomić pełny host typecheck.
- [x] N195 — Priorytet: usunąć wszystkie chińskie odpowiedniki Markdown w workspace (w tym historyczne `*.zh.md` DSH), instrukcje ich tworzenia i wymóg dwujęzycznych par, wraz z nieużywanymi sidecarami i linkami; zachować lokalizacje UI, sprawdzić brak chińskich kopii oraz działanie dokumentacji, commitować submoduły i odhaczenie zgodnie z planem. Dopiero po tym wrócić do N194 i reszty zadań.
- [x] N196 — Naprawić zastany dryf pełnych bramek dokumentacyjnych niezwiązany z N195: metadane i strukturę `agent-codex/README.md`, hard-wrap `export-conversation-pdf/README.md`, brakujące JSDoc katalogu Cordis oraz nieaktualne bloki `type-equiv` w `docs/subsystems`; po naprawie uruchomić pełny `doc-sync` bez osłabiania bramek. N195 potwierdził niezależnie build strony, linki, archiwum i 249 testów.
- [x] N197 — Usunąć pozostałe historyczne sugestie tworzenia par chińskich Markdown z szablonów i referencji skillu `dsh-doc` oraz martwe testowe metadane `counterpart`, zachowując sprawdzenie angielskiej dokumentacji.
- [x] N198 — Naprawić pozostały zastany dryf ujawniony przez pełny `doc-sync` po N196: katalog grafów, Cordis inspect, klienta, narzędzi, persistence i ścieżek tsconfig oraz kompletność około 60 eksportowanych JSDoc; ponowić wszystkie 31 bramek bez wyłączeń.
- [x] N199 — W ramach N188 dodać strumieniowy zapis kanonicznego kontekstu V1 po pojedynczych itemach i referencjach, z walidacją struktury, unikalności ID i odwołań w trakcie konsumpcji, bez materializacji całej tablicy itemów; sprawdzić identyczność bajtów JSON i błędy po częściowym strumieniu. Samo podłączenie portu źródłowego i checkpointu pozostaje w N188.
- [x] N200 — Zdiagnozować zastane ~570 błędów repozytoryjnego `pnpm run lint` ujawnionych przy N199, oddzielić błędy aktywnego forka od wyłączonych pakietów/testów upstream i przywrócić pełną zieloną bramkę bez wyłączania reguł; N199 potwierdza lokalnie lint swoich zmienionych plików.
- [x] N201 — W ramach N188 podłączyć strumieniowy kontekst N199 do generatora wpisów przenośnego ZIP jako alternatywę dla rezydentnego bundle; podczas jednorazowego odczytu walidować referencje załączników wobec wcześniej zmierzonych wpisów i odmawiać końcowego manifestu przy błędnym itemie lub brakującym pliku. Produkcyjne porty źródłowe pozostają osobnym etapem.
- [x] N202 — W ramach N188 rozszerzyć wspólny port źródłowy o opcjonalny jednorazowy strumień kontekstu i podłączyć go do produkcyjnego endpointu eksportu ZIP, zachowując rezydentny fallback dla istniejących driverów; sprawdzić barierę spójności przed konsumowaniem strumienia i brak końcowego manifestu przy błędzie strumienia. Implementacje źródłowe i checkpoint strumieniowy pozostają następnymi etapami.
- [x] N203 — W ramach N188 dodać do standardowego drivera prawdziwy producent `PortableAgentContextStreamV1` z zamrożonego odczytu Session, bez tworzenia pełnej tablicy projektowanych itemów; podłączyć go do portu N202 i porównać bajty eksportu z rezydentnym V1 dla historii, compaction i załączników. Codex i prywatny checkpoint pozostają osobnymi etapami.
- [x] N204 — Zaostrzyć N175: przy referencji pliku w kanonicznym kontekście sprawdzać nie tylko digest, ale także dokładną znormalizowaną nazwę wpisu ZIP, jeśli kontekst ją zawiera; zachować obsługę referencji bez nazwy i odmówić końcowego manifestu przy rozbieżności, zarówno dla kontekstu rezydentnego, jak i strumieniowego.
- [x] N205 — W ramach N188 wydzielić z kodowego resolvera artefaktów Codexa sesyjnie autoryzowany strumień surowych bajtów z weryfikacją rozmiaru i SHA-256 po pełnym odczycie, bez buforowania całego payloadu; użyć go w dotychczasowym resolverze JSON i przetestować pełną treść, obcą recepcję, ucięcie i uszkodzenie. Podłączenie go do strumieniowego checkpointu pozostaje następnym etapem.
- [x] N206 — W ramach N188 dopuścić w strumieniowym bundle prywatny checkpoint jako zweryfikowane przez źródło bajty JSON kontekstu z metadanymi, długością i SHA-256; opakować go w kanoniczny wpis `agent/private-snapshot.json` bez pełnego bufora, ponownie sprawdzić długość/hash podczas konsumpcji i odmówić manifestu przy ucięciu lub zmianie. Źródło Codexa i semantyczna walidacja jego checkpointu pozostają następnym etapem.
- [x] N207 — W ramach N188 zbudować źródło `PortablePrivateSnapshotStreamV1` dla artefaktowego checkpointu Codexa V2: przed zwróceniem go zweryfikować istniejącym strumieniowym walidatorem i audytem, odczytać rewizję runtime z walidowanego payloadu, a do ZIP udostępnić drugi sesyjnie autoryzowany odczyt tych samych bajtów; przetestować zgodność, uszkodzenie, brak config i zmianę Session. Pełny strumieniowy kontekst Codexa pozostaje osobnym etapem.
- [x] N208 — W ramach N188 udostępnić callbackowy odczyt pola i tablic zweryfikowanego checkpointu V2 z prywatnego spoolu tylko podczas życia walidacji, bez ujawniania ścieżki i bez pełnego parsowania tablic; zachować cleanup po sukcesie/błędzie oraz dotychczasowe API walidatora. Przetestować iterację danych i brak pozostawionego spoolu po awarii callbacku.
- [x] N209 — W ramach N188 projektować zweryfikowaną aktywną `effectiveHistory` Codexa z iteratora N208 po jednym kanonicznym itemie, z tym samym mapowaniem Responses, opaque i audytowanych outcome co rezydentny V2; przetestować równość z dotychczasową projekcją i błąd pojedynczego nieprawidłowego itemu bez zachowania pełnej tablicy.
- [x] N210 — W ramach N188 projektować historyczne `response_item` i replacement histories z dwóch zweryfikowanych iteratorów rolloutu i compaction bez tablicy wszystkich itemów; zachować indeksy, audytowane outcome oraz uporządkowane referencje wyjść, odmówić przy brakującej/nadmiarowej compaction i porównać z rezydentną projekcją V2.
- [x] N211 — W ramach N188 rozwiązywać trwałe request/result/failure/pending/installed dla kolejnych compaction checkpointu V2 z iteratora bez gromadzenia wszystkich grup audytu; zachować walidację treści, kolejności, ID i zgodność z rezydentną projekcją, przetestować odmowę dla błędnej grupy po częściowym strumieniu.
- [x] N212 — W ramach N188 projektować kanoniczną ancestry po jednej zweryfikowanej grupie audytu compaction i odpowiadających jej referencjach wyjść rolloutu, bez tablicy wszystkich grup i itemów; zachować identyczne ID, tryb, provenance, walidację brakujących lub nadmiarowych grup i test zgodności z projekcją rezydentną.
- [x] N213 — W ramach N188 dodać callbackowy iterator zweryfikowanego prywatnego spoolu checkpointu V2, utrzymujący plik wyłącznie podczas faktycznej konsumpcji itemów i usuwający go po EOF, błędzie lub przerwaniu iteratora; współdzielić z istniejącym odczytem walidację, przetestować brak wycieku spoolu i identyczność danych.
- [x] N214 — W ramach N188 złożyć strumieniowy `PortableAgentStreamBundleV1` źródłowej sesji Codexa z jednego zakończonego odczytu faktów, zweryfikowanego checkpointu i iteratorów aktywnej historii, rolloutu oraz ancestry; zachować dokładny prywatny snapshot, referencje i barierę zmiany Session, porównać kanoniczne bajty z rezydentnym bundle dla sesji bez i z compaction. Sama rejestracja portu pozostaje osobnym krokiem.
- [x] N215 — W ramach N188 dodać źródłowy `AgentTransferSourcePort` Codexa korzystający z rezydentnego odczytu na potrzeby import preview oraz strumieniowego bundle na potrzeby ZIP, z dokładną kontrolą ID rozwiązanej Session i testami obu dróg; nie rejestrować go bez odpowiadającego portu docelowego.
- [x] N216 — Przygotować docelowy `AgentTransferTargetPort` Codexa dla kanonicznego V1: deklarować rzeczywisty katalog modeli i zgodne prywatne rewizje, walidować świeże ID, lineage, route i checkpoint V2, zwracać wyłącznie nieopublikowane przygotowanie bez tworzenia threadu lub odgrywania side effects; przetestować zgodność, zmienione modele i odmowy. Rejestracja oraz właściwe odtworzenie threadu pozostają osobnymi krokami.
- [x] N217 — W forku Codexa dodać odczyt i walidację prywatnego checkpointu V2 przed importem: wersji, konfiguracji, obu hashy, tożsamości i kolejności compaction względem rolloutu; odrzucać uszkodzony snapshot bez tworzenia threadu. Pokryć poprawny round-trip i negatywne przypadki testami. Jest to etap N040, nie samo odtworzenie sesji.
- [x] N218 — W forku Codexa dodać kontrolowaną instalację zweryfikowanego checkpointu V2 do świeżego `ContextManager`: dokładną efektywną historię, retained context i wersję, zachowując bezpieczne unieważnienie cache kontekstu; nie odgrywać rolloutu ani wykonywać historycznych działań. Przetestować stan przed następnym turnem oraz odmowę przy niezweryfikowanym wejściu. Jest to etap N040, bez API app-server.
- [x] N219 — W forku Codexa podłączyć checkpoint V2 do prepublikacyjnej ścieżki tworzenia nowego threadu z niezależnym `CODEX_HOME`: przyjąć tylko świeży start, zweryfikować snapshot przed side effects, zainstalować aktywny kontekst przed pierwszym turnem i odrzucić błędny import bez rejestracji threadu. Przetestować utworzenie i odmowę. Jest to etap N040; ekspozycja app-server i wznowienie z DSH po restarcie pozostają dalszymi krokami.
- [x] N220 — Udostępnić w eksperymentalnym `thread/start` app-server opcjonalny prywatny checkpoint Codexa V2, walidować go przed efektami ubocznymi startu i kierować do ścieżki N219; odmówić połączenia z `sessionStartSource=clear`. Wygenerować schematy eksperymentalne i przetestować protokół oraz start/odmowę. Jest to etap N040; podłączenie klienta DSH i weryfikacja kontynuacji pozostają osobnymi krokami.
- [x] N221 — Dodać w kliencie app-server DSH typowaną ścieżkę `thread/start` z prywatnym checkpointem V2, bez zmiany zwykłego startu; przekazać dokładne bajty/strukturę zweryfikowanego checkpointu i obsłużyć odmowę protokołu, z testem klienta. To przygotowanie podłączenia portu docelowego Codexa.
- [x] N222 — Podłączyć docelowy port transferu Codexa do N221: po walidacji kanonicznego bundle i wyboru modelu tworzyć nową DSH Session oraz świeży Codex thread z prywatnym checkpointem, zachować lineage i odmówić bez publikacji częściowego importu; bez odgrywania dawnych działań. Sprawdzić testem orkiestracji.
- [x] N223 — Przetestować pełny Codex → Codex transfer przez format DSH po usunięciu starego `CODEX_HOME`: porównać efektywny model-visible kontekst przed eksportem i po imporcie, wykonać nowy turn oraz sprawdzić odtworzenie po restarcie klienta DSH bez użycia starego threadu. Dopiero po tym ocenić odhaczenie N040/N041.
- [x] N224 — Uzupełnić mock `CodexAppServer` w teście supervisora o typowaną metodę `startThreadFromCheckpoint` z N221 i ponowić hostowy typecheck testów przed zakończeniem N223.
- [x] N225 — Przygotować opt-in test N223 na rzeczywistym Codex CLI: przenieść deklarowaną rewizję forka do procesu, przejść kanoniczny transfer i testować nową turę oraz resume bez starego `CODEX_HOME`; sprawdzić typy/lint i jasno pozostawić N223 otwarte, dopóki test nie przejdzie na właściwej binarce.
- [ ] N226 — Zaimplementować i przetestować wszystkie cztery warianty obecności docelowego workspace i snapshotu z N002: zachowanie obecnych plików albo zastosowanie snapshotu po osobnym potwierdzeniu; utworzenie workspace z snapshotu; import rozmowy bez workspace z ostrzeżeniem i wymaganiem przygotowania workspace przed kolejnym turnem. Pokazać konflikty i poziom wierności, nie nadpisywać plików bez odzyskiwalnej kopii.
- [ ] N227 — Zapewnić transakcyjne domknięcie importu archiwum: błędy walidacji, odszyfrowania, materializacji snapshotu lub utworzenia sesji mają sprzątać staging i nie pozostawiać opublikowanej częściowej sesji ani threadu; awarie po nieodwracalnym efekcie muszą być jawnie raportowane. Przetestować awarie na każdym etapie i brak odgrywania historycznych side effects.
- [ ] N228 — Uzupełnić implementację N062 o testy interoperacyjności `.zip.age` z niezależną implementacją age/rage oraz błędne hasło, modyfikację i ucięcie danych; ograniczyć koszt `scrypt` z nagłówka importu według konfigurowalnej polityki zasobów i potwierdzić, że staging nie jest akceptowany przed uwierzytelnionym końcem strumienia. Sprawdzić, że hasło nie trafia do logów, telemetryki ani settings.
- [x] N229 — W ramach N071 usunąć nieużywaną fabrykę hosted web-search specs oraz możliwość wstrzykiwania hosted specs do tool routera, skoro produkcyjny fork buduje wyłącznie dynamiczny katalog DSH; zachować parsowanie i prezentację historycznych/web-search items. Zweryfikować publiczny request i testy `codex-core` bez hosted specs.
- [x] N230 — W ramach N071 wydzielić z handlera modelowego `apply_patch` współdzielony shell-interceptor do wewnętrznego modułu runtime, następnie usunąć handler/specyfikację/testy/eksport natywnego narzędzia; zachować parser, runtime powłoki i wewnętrzne `apply_patch` CLI nadal używane przez fork. Potwierdzić brak referencji do usuniętego handlera i uruchomić celowane testy `codex-core`.
- [x] N231 — W ramach N071 usunąć niezarejestrowaną już implementację native tool `wait_for_environment` i jej wewnętrzny re-export, pozostawiając tymczasowo publiczny typ konfiguracyjny dla kompatybilności istniejących klientów; sprawdzić brak produkcyjnej rejestracji i kompilację/test dynamicznego katalogu.
- [x] N232 — Naprawić pełny build CLI forka ujawniony przy N223: uzupełnić wyczerpującą obsługę `DshAuditArtifact` w klientach `codex-exec` i TUI, zachowując jawną odmowę wymaganego audytu poza hostem DSH; zweryfikować build rzeczywistej binarki i celowane testy klienta.
- [x] N233 — Naprawić błędną konfigurację modelu w rzeczywistym teście N223: rozdzielić identyfikator modelu portu transferu (`id`) od opcji fabryki agenta (`model`) przy create/resume; potwierdzić uruchomienie rzeczywistej sesji i celowany lint. Nie uznawać samej naprawy fixture za dowód całego transferu.
- [x] N234 — Naprawić błąd pierwszego rzeczywistego turnu N223: klient DSH ma jawnie tworzyć zwykłe i importowane wątki z pełną historią `legacy`, ponieważ checkpoint wymaga trwałego rolloutu niedostępnego przez `load_history` trybu `paginated`; ujawnić terminalny powód błędu w asercji, zachować fail-closed i sprawdzić testem klienta oraz rzeczywistego procesu.
- [x] N235 — Naprawić odtworzenie kontekstu checkpointu w forku ujawnione przez N223: po imporcie nie dopisywać ponownie niezmienionych instrukcji i środowiska do zachowanej historii; odtworzyć właściwe metadane bazowe kontekstu i zachować jawne zmiany rzeczywistego workspace; potwierdzić celowanym testem oraz rzeczywistym importem, oddzielając rzeczywistą zmianę katalogu skills od błędnej reiniekcji. Trwałość po restarcie pozostaje osobnym krokiem.
- [x] N236 — Zapewnić trwałe odtworzenie importowanego checkpointu po restarcie klienta/procesu Codexa: nowy rollout musi zachować pełny kontekst importu i jego metadane, bez odgrywania historycznych narzędzi; w N223 porównać wiadomości po resume, nie tylko końcową odpowiedź mocka.
- [x] N237 — Wyłączyć natywne skills forka we wszystkich sesjach DSH, wraz z odkrywaniem i wstrzykiwaniem instrukcji, zgodnie z decyzją użytkownika; korzystać z katalogu i narzędzi DSH. Sprawdzić zwykły start, import i resume z odrębnymi CODEX_HOME oraz brak nowych instrukcji skills, zachowując pełną historię.
- [x] N238 — Doprowadzić do uruchomienia pełnego zestawu testów forka zleconego przez użytkownika po N235: uzupełnić brakujące zależności środowiska (pierwsza wykryta: ALSA/alsa.pc), ponowić `just test`, sklasyfikować błędy i zachować rzeczywisty wynik bez wyłączania testów.
- [ ] N239 — Ustabilizować środowisko pełnych testów po N238: odizolować CODEX_SQLITE_HOME i wpływ ustawień hosta, zweryfikować ograniczenia mountów WSL, zgodność cech artefaktu V8 oraz kompletność runtime/pluginów GStreamer; ponowić właściwe niezielone testy bez osłabiania sandboxu produktu.
- [ ] N240 — Rozliczyć 416 niezielonych wyników pełnego zestawu N238: oddzielić testy nieaktualnej ekspozycji natywnych narzędzi od rzeczywistych regresji (m.in. klasyfikacja TLS, snapshoty TUI i pamięć), zaktualizować lub usunąć wyłącznie testy usuniętych funkcji po sprawdzeniu zależności i zachować pokrycie katalogu DSH oraz mechanizmów wewnętrznych; nie uznawać całej bramki za zieloną na podstawie testów celowanych.
- [x] N241 — Zaktualizować nieaktualne oczekiwania sekwencji audytu w dwóch próbach `real-product.spec.ts` (pełny turn przez Chat Completions i Responses): sprawdzić wszystkie trwałe rekordy/ACK i ich ciągłość po dodaniu artefaktów, zamiast oczekiwać wyłącznie dwóch rekordów; zachować sprawdzenie obu formatów i kompletności audytu.
- [x] N242 — Dodać jawny wewnętrzny rekord trwałego kontekstu importu w historii forka oraz obsługę jego odczytu i rekonstrukcji; zachować dokładną aktywną historię i retained context bez udawania compaction, odgrywania narzędzi ani usuwania źródłowego provenance. Zweryfikować serializację, trwałość i rekonstrukcję z późniejszymi turnami.
- [x] N243 — Podłączyć rekord N242 do instalacji checkpointu DSH z propagacją błędów append/persist/flush przed zwróceniem sukcesu; w rzeczywistym teście N223 porównać pełny kontekst po restarcie klienta i sprawdzić ponowny eksport importowanej sesji. Dopiero po dowodzie rozliczyć nadrzędne N236 i N223.
- [ ] N244 — Obsłużyć migrację historii zawierającej importowany kontekst i późniejszy rollback do paginowanego magazynu forka; przeliczyć aktywne wiadomości i retained context bez przywracania cofniętych turnów. Do czasu tej obsługi migracja takiej kombinacji ma kończyć się czytelnym błędem; sesje DSH używają historii legacy.

- [ ] N245 — Rozliczyć bramkę `just fix --tests` po N242: automatyczne usuwanie re-exportów native handlers jako nieużywanych w bibliotece powoduje 53 błędy kompilacji testów. Uporządkować zależności i zakres testów w ramach usuwania natywnych narzędzi, bez przywracania ich ekspozycji w sesjach DSH; zweryfikować Clippy bez niepowiązanych poprawek.
- [x] N246 — Wyjaśnić ostrzeżenie `failed to flush rollout after emitting terminal turn event: thread ... not found` zaobserwowane w rzeczywistym teście N243 przy zamykaniu klienta. Sprawdzić kolejność terminalnego zdarzenia, bariery trwałości i dispose; odróżnić bezpieczny cleanup od utraty zapisu, zachowując fail-closed i test restartu.
- [x] N247 — Usunąć produkcyjną rejestrację rozszerzenia standalone web search z app-server po potwierdzeniu, że aktywny router korzysta wyłącznie z dynamicznych narzędzi DSH. Zachować historyczne WebSearchCall; sprawdzić testy app-server. Usunięcie samego crate i jego zależności testowych pozostaje osobnym krokiem.
- [x] N248 — Fizycznie usunąć crate ext/web-search i zależności Cargo/Bazel po rozliczeniu jego trzech konsumentów w testach core; zachować testy transportu Responses Lite, wewnętrzne mechanizmy pamięci i parsowanie historycznych WebSearchCall. Zaktualizować lockfile i zweryfikować odpowiednie testy oraz pełny zestaw forka.
- [x] N249 — W ramach N240 rozliczyć testy app-server w suite/v2/web_search.rs po usunięciu natywnego standalone web search: usunąć nieaktualne oczekiwania wykonania tego narzędzia i zależne fixtures, zachowując obsługę oraz testy historycznych WebSearchCall i powiadomień. Zweryfikować testy app-server bez rozszerzania modelowego katalogu forka.
- [x] N250 — W ramach N239 zabezpieczyć wspólny fixture TestAppServer przed dziedziczeniem CODEX_SQLITE_HOME hosta, z zachowaniem jawnych testowych overrides. Przy N249 omyłkowo uruchomiono pakiet bez wyłączenia tej zmiennej, a fixture izolował tylko CODEX_HOME; przebieg przerwano i ponowiono z env -u CODEX_SQLITE_HOME. Sprawdzić izolację rzeczywistym testem procesu i nie usuwać ani nie naprawiać po cichu danych hosta.
- [x] N251 — Domknąć lukę N188 w strumieniowym eksporcie Codexa: resolver audytu compaction nadal używa Buffer.concat/JSON.parse dla inputHistory, prompt i result. Usunąć materializowanie całych dużych artefaktów tych pól przy walidacji i projekcji ancestry, zachowując identyczny kanoniczny kontekst, audyt, referencje i cleanup; dopiero po tym oraz weryfikacji produkcyjnej ścieżki ocenić zamknięcie N188.
- [x] N252 — W ramach N038 dodać walidację manifestu względem kompletnego inwentarza faktycznie zmierzonych payloadów: dokładne ścieżki, liczby bajtów i SHA-256, odmowa brakujących, nadmiarowych i powtórzonych wpisów oraz błędnego manifestu. Sprawdzić kompletne i uszkodzone archiwum; ten etap nie zastępuje parsera ZIP, kontroli zasobów podczas dekompresji ani semantycznego import preview.
- [x] N253 — Rozliczyć uruchamianie bramek DSH przez pnpm w submodule: automatyczna instalacja przed skryptem zatrzymuje się w install-lefthook na core.worktree z common config. Zachować poprawną konfigurację submodułu i hooks; do czasu naprawy raportować uruchomienia bramek z verify-deps-before-run=warn jako wykonane bez automatycznej reinstalacji zależności.
- [x] N254 — W ramach N251 usunąć materializowanie effectiveHistory z artefaktów pending/installed podczas walidacji checkpointu: obliczać dsh-json-v1 po elementach tablicy z pełną weryfikacją obu odczytów i propagacją błędów; zachować zgodność resolverów rezydentnych i sprawdzić produkcyjny port źródłowy. Prompt, result i projekcja ancestry pozostają w N251.
- [x] N255 — W ramach N251 zastosować strumieniowy digest pending/installed także w walidatorze grup compaction używanym przez projekcję ancestry, aby eksport nie wczytywał ponownie tych historii w całości po walidacji checkpointu. Zachować porównanie rezydentne dla zwykłych resolverów, odmowę rozbieżności i propagację błędów odczytu; zweryfikować zgodność grup i eksportu.
- [x] N256 — W ramach N251 przenieść inputHistory prób compaction w strumieniowym eksporcie na odczyt po elementach: zweryfikować cały artefakt każdej próby, zachować tylko czytnik, a wejście ostatniej próby projektować bez tablicy wszystkich elementów. Zachować identyczny kontekst, numery ID, odmowę po błędzie i cleanup przy przerwaniu; prompty i wyniki pozostają osobnym zakresem N251.
- [x] N257 — W ramach N251 rozszerzyć wspólny port strumieniowy i eksporter kontekstu o pojedynczy element opaque z uprzednio zwalidowanym JSON przekazywanym jako bajty z SHA-256 i rozmiarem. Zachować format PortableAgentContextV1 na dysku, kontrolę ID/referencji i fail-closed przy zmianie/przerwaniu strumienia; przygotować test rzeczywistego ZIP. Producent promptów/wyników Codexa pozostaje do podłączenia w N251.
- [x] N258 — W ramach N251 podłączyć prompt/result/failure details prób compaction do transportu opaque JSON z N257. Przed ujawnieniem strumienia zweryfikować pełną składnię pojedynczej wartości, bezstratność JSON, ownership/receipt oraz metadane implementacji promptu; zachować pełne próby i kanoniczny kontekst, także błędy i anulowanie. Dopiero po dowodzie rozliczyć N251 i ocenić N188.
- [x] N259 — W ramach N200 rozliczyć zastane błędy lintu w archive.host.spec.ts ujawnione podczas N257 (styl funkcji, no-confusing-void-expression i zbędne asercje typów), bez wyłączania reguł i zmiany zachowania prób archiwum.
- [x] N260 — W ramach N188 usunąć rezydentny odczyt artefaktu context/config w walidacji strumieniowego checkpointu: porównać pełną semantyczną wartość z contextConfig checkpointu bez Buffer.concat/JSON.parse całego artefaktu, zachować kontrolę własności/receipt i odmowę różnic; przetestować kolejność kluczy, duże instrukcje oraz uszkodzenie. Metadane checkpointu i pojedyncze itemy mogą nadal zajmować pamięć; nie przedstawiać tego jako stałego limitu RAM całej sesji.
- [x] N261 — W ramach N038 dodać odczyt ZIP z katalogu centralnego przez utrzymywaną bibliotekę: sekwencyjnie mierzyć rozpakowane payloady, weryfikować CRC/rozmiary i manifest N252, odrzucać niebezpieczne/powtórzone/konfliktujące ścieżki, symlinki, szyfrowanie ZIP i nieobsługiwane metody. Stosować opcjonalne limity operatora podczas dekompresji, bez stałego limitu archiwum; zapewnić cleanup i anulowanie. Ten etap nie publikuje sesji/workspace i nie zastępuje semantycznego preview.
- [x] N262 — W ramach N038 zbudować semantyczny preview zweryfikowanego archiwum: odczytać manifestowe logi, driver state i kanoniczny kontekst, zweryfikować ich zgodność oraz referencje, a zgodność agenta/modelu ocenić przez wspólne porty transferu. Zachować prywatny staging i kontrolę ponownego odczytu; nie publikować sesji, threadu ani workspace. Rozstrzygnąć brakujące credentials jako wymagania preview, bez eksportowania sekretów.
- [x] N263 — Przygotować N262 przez odczyt wybranych payloadów z prywatnego ZIP na podstawie uprzednio zweryfikowanego manifestu: ponownie sprawdzić cały kontener i inwentarz, odmówić zmiany manifestu lub payloadów, nie ujawniać częściowego wyniku oraz zachować limity/anulowanie/cleanup. Buforować tylko wybrane dane potrzebne rezydentnemu preview, bez ekstrakcji workspace i publikacji sesji.
- [x] N264 — W ramach N262 zweryfikować kompletne logi manifestowego ZIP przez istniejący katalog formatów sesji, bez naprawy uciętego ogona: sprawdzić tożsamość root, unikalność ID, spójne drzewo dołączonych potomków i źródłowy workspace. Raportować migracje starszych formatów jawnie; korzystać z ponownie zweryfikowanego odczytu N263 i nie publikować sesji ani workspace. Pełny preview kontekstu, referencji i wymagań docelowego agenta pozostaje w N262.
- [x] N265 — Usunąć wykrytą przy N262 utratę lineage w eksporcie standardowego agenta: przenieść header.importLineage do kanonicznego source.lineage w obu portach eksportu, zachować brak pola dla sesji bez lineage i zweryfikować ponowny eksport zaimportowanej sesji. Nie przepisywać historycznych logów.
- [x] N266 — W ramach N262 wczytać kanoniczny bundle i driver state przez zweryfikowany ZIP: sprawdzić schematy V1, tożsamość źródła względem manifestu/logu, pełną zgodność driver state z context.source, trwały wybór drivera oraz lineage z nagłówkiem. Zweryfikować kopertę prywatnego checkpointu i jego właściciela bez interpretowania prywatnego formatu innego agenta. Odmawiać niejednoznacznych dodatkowych deklaracji stanów; zachować pełne treści i brak publikacji. Walidacja audytu/referencji oraz ocena docelowego agenta pozostają w N262.
- [x] N267 — W ramach N262 współdzielić z eksporterem kontrolę sekwencji/receipt/referencji audytu Codexa i zastosować ją do wszystkich odtworzonych logów preview. Każdy wskazany blob musi mieć poprzedzający receipt w tej samej sesji i zgodny manifestowy wpis attachment z dokładnym SHA-256 oraz rozmiarem. Testować obce/brakujące/późne receipts, luki, duplikaty i niezakończoną compaction; nie zastępować tym walidacji wnętrza checkpointu ani pełnej projekcji kontekstu.
- [x] N268 — W ramach N262 zweryfikować wszystkie wskazane w logach checkpointy V2 przez istniejący walidator Codexa, z resolverem ograniczonym do receipt-owned artefaktów tego logu i ponownie zweryfikowanego ZIP. Sprawdzić wewnętrzne digests, konfigurację i zainstalowane compaction, błędny/ucięty JSON oraz anulowanie. Nie tworzyć threadu ani sesji; opisać rezydentny koszt odczytu pojedynczego artefaktu preview.
- [x] N269 — Naprawić wykrytą przy N262 niezgodność eksportu obrazów z manifestem: rzeczywisty AttachmentId ma prefiks sha256:, a ścieżka media/<id> zawierała zabroniony dwukropek. Współdzielić bezpieczne wyznaczanie ścieżki obrazu między eksporterem i kontrolą kanonicznych referencji, zachować niezmieniony identyfikator w kontekście/logu i sprawdzić rzeczywisty endpoint portable ZIP z SHA-256 obrazu oraz walidatorem kontenera.
- [x] N270 — W ramach N262 zweryfikować zwykłe referencje załączników wszystkich logów i kanonicznego kontekstu względem manifestu: ścieżki, rodzaj attachment, rozmiary z logów i SHA-256 dla identyfikatorów content-addressed. Współdzielić skanowanie nośników z eksporterem, odrzucać sprzeczne metadane tego samego obrazu/pliku zamiast ukrywać je deduplikacją i uwzględnić zagnieżdżone wyniki narzędzi. Nie publikować bajtów ani normalizować historycznych treści.
- [x] N271 — W ramach N262 rozszerzyć wspólny port źródłowy o obowiązkową projekcję odłączonej sesji archiwalnej z przekazanym czytnikiem artefaktów. Standard i Codex mają używać swoich istniejących projekcji bez odwołania do żywej sesji, lokalnego magazynu ani starego CODEX_HOME. Dodać wspólne porównanie pełnego bundle z archiwum, wykrywające rozbieżne itemy/compaction i prywatny checkpoint, bez adapterów par agentów; sprawdzić izolację źródła oraz podłączenie walidacji archiwum.
- [x] N272 — W ramach N262 połączyć walidację ZIP, bundle i projekcji źródłowej z oceną zgodności docelowego drivera/modelu przez wspólny port importCapabilities. Zwracać raport zgodności bez wywoływania importu, tworzenia sesji ani wykonywania efektów; sprawdzić odmowę uszkodzonego źródła przed odczytem targetu oraz anulowanie. Gotowość credentials pozostaje osobnym wymaganiem N262.
- [x] N273 — W ramach N262 dodać odczyt stanu uwierzytelnienia modelu w usłudze LLM i jej adapterach DeepSeek/pi-ai, bez zwracania wartości credentials i bez requestu modelowego. Odczyt ma używać bieżącej konfiguracji właściciela routingu oraz describe credentials lub środowiska uruchomienia; rozróżnić brak skonfigurowanego klucza, jego obecność, uwierzytelnienie własne dostawcy i niezweryfikowany adapter. Stan obecności nie oznacza potwierdzonej ważności klucza.
- [x] N274 — W ramach N200 rozliczyć typowany lint testów LLM ujawniony przy N273: llm-deepseek jest wyłączony z agregatu hosta i jego testy otrzymują error typed value dla importów Node/settings/Loader; catalog.spec.ts pi-ai zawiera dwie zbędne asercje as never. Zapewnić właściwy program typów testów i usunąć wyłącznie potwierdzone zbędne asercje, bez wyłączania reguł lint.
- [x] N275 — W ramach N262 podłączyć odczyt uwierzytelnienia do wspólnego portu targetu i zbiorczego preview archiwum: standard deleguje do LLM, Codex odczytuje swoją aktualną konfigurację bramki. Preview ma wskazywać brakujące i niezweryfikowane credentials bez wartości sekretów, bez wywołania modelu/importu i bez uznawania obecności klucza za potwierdzoną ważność; sprawdzić anulowanie i brak skutków ubocznych.
- [x] N276 — W ramach N226 dodać odczytowy podgląd decyzji workspace dla czterech kombinacji istniejącego katalogu docelowego i migawki w zweryfikowanym archiwum. Odczytać obecność katalogu bez jego tworzenia, zwrócić opcje zachowania plików/zastosowania migawki/importu samego kontekstu, jawne ograniczenia wierności oraz wymóg osobnego potwierdzenia i kopii przy istniejącym workspace. Brak fingerprintu nie może oznaczać zgodności; błędy dostępu nie mogą udawać nieistniejącego workspace. Materializacja, porównanie konfliktów i transakcja pozostają w N226/N227.
- [x] N277 — W ramach N226 dodać do preview porównanie plików opcjonalnej migawki ze wskazanym workspace: odróżnić nowe, identyczne i zmienione pliki oraz konflikty typów/rodziców, bez zapisu i podążania za dowiązaniami. Porównywać rozmiar i strumieniowy SHA-256, propagować błędy dostępu/anulowanie i nie uznawać samej zgodności plików migawki za zgodność całego workspace. Zastosowanie migawki, kopia i ponowna kontrola przed zapisem pozostają w N226/N227.
- [x] N278 — W ramach N226/N227 przygotować pliki migawki strumieniowo w prywatnym stagingu, z ponowną walidacją całego ZIP względem manifestu preview przed udostępnieniem katalogu konsumentowi. Nie pisać do docelowego workspace; tworzyć pliki wyłącznie ekskluzywnie, zachować limity operatora i sprzątać pliki/uchwyty po błędzie, anulowaniu oraz zakończeniu konsumenta. Sprawdzić puste pliki, uszkodzenie także poza migawką i brak publikacji częściowego wyniku.
- [x] N279 — Naprawić wykrytą podczas przeglądu N036 utratę kontroli metadanych zwykłych załączników między logiem root i potomkami: eksporter nie może nadpisywać sprzecznych rozmiarów ani metadanych obrazów podczas scalania per-log map. Współdzielić kontrolę na całym zbiorze logów, zachować deduplikację zgodnych referencji i sprawdzić odmowę całego strumienia eksportu w obu formatach.
- [x] N280 — W ramach N036 przed końcowym manifestem portable ZIP ponownie potwierdzić trwałą treść wszystkich wyeksportowanych logów oraz zestaw potomków. Zachować strumieniowe przetwarzanie i tylko digests logów, odrzucić zmianę root/potomka, brak logu, błąd flush i zmianę drzewa po rozpoczęciu strumienia; nie kończyć poprawnego ZIP z niespójnym odczytem. Po testach wraz z wcześniejszymi dowodami ocenić zamknięcie N036.
- [x] N281 — W ramach N035/N064 podłączyć przenośny ZIP do przycisku Session log i /export przez wspólny dialog: przed jakimkolwiek pobraniem ostrzec o pełnej nieszyfrowanej treści, zaoferować główną akcję portable oraz jawny transcript-only log i wymagać świadomego wyboru. Zamknięcie ostrzeżenia nie pobiera pliku; zachować izolację przeglądarek, deduplikację aktywnych pobrań i locale UI. Nie uznawać tego za wdrożenie szyfrowania ani pełnej autoryzacji importu.
- [x] N282 — W ramach N037 wyliczać wersjonowany fingerprint zawartości workspace przy eksporcie portable i porównywać go w preview importu. Hash ma zależeć od względnych ścieżek, bajtów plików, pustych katalogów i treści dowiązań bez ich dereferencji; nie od ścieżki hosta ani czasu modyfikacji. Zachować stare manifesty bez oznaczenia algorytmu jako niezweryfikowane, jawnie opisać niedostępny workspace, propagować anulowanie i wykryte zmiany podczas skanowania. Nie utożsamiać zgodnych bajtów z pełnym odtworzeniem metadanych środowiska.
- [x] N283 — W ramach N035 ustawić portable jako domyślny format HTTP eksportu bez parametru format; zachować wyłącznie jawne format=log dla transcript-only. Brak utrwalonego drivera lub portu eksportu ma dawać odmowę bez cichego fallbacku. Sprawdzić GET/HEAD, jawny log, błędny format i rzeczywistą kompozycję aplikacji.
- [x] N284 — W ramach N038 podłączyć uwierzytelniony POST preview archiwum: strumieniowo przyjąć ZIP do prywatnego stagingu, zastosować konfigurowalne limity operatora, dobrać port źródłowy dopiero po walidacji tożsamości archiwum i zwrócić zgodność modelu/credentials/workspace przez istniejący walidator. Nie publikować sesji ani tokenu importu; sprzątać staging po sukcesie, błędzie i anulowaniu. Sprawdzić endpoint w rzeczywistej kompozycji oraz brak efektów historycznych. Szyfrowanie i zatwierdzenie importu pozostają odrębnymi krokami.
- [x] N285 — W ramach N039 udostępnić tworzenie agenta z przygotowanego importu przez wspólny, obowiązkowy port publikacji zarejestrowanego drivera. Standard i Codex mają używać swoich istniejących funkcji i wspólnej fabryki; rejestr ma odmawiać niepełnych portów. Zachować jawne ograniczenia same-driver, ownership uchwytu, lineage, setup i anulowanie; przetestować dispatch bez rozgałęzień po nazwie agenta. Nie uznawać tego za pełną transakcję archiwum ani transfer między różnymi agentami.
- [x] N286 — Przygotować wymagane przez N039/N227 dokładne przywracanie obrazów archiwalnych przez port attachment store: zweryfikować digest, rozmiar, media type i pełny decode zgodnie z polityką operatora, zachować oryginalne bajty/referencję bez normalizacji oraz atomowo opublikować obiekt. Backend bez tej możliwości ma jawnie odmówić. Sprawdzić deduplikację, błędne dane, limity i anulowanie przed publikacją; późniejszy import archiwum ma korzystać z tego portu zamiast saveImage.
- [x] N287 — W ramach N039/N227 przygotować prywatny strumieniowy staging załączników ZIP przed przywracaniem do magazynów: pełna walidacja archiwum i zgodność manifestu przed przekazaniem plików konsumentowi, mapowanie ścieżek archiwum na pliki stagingu, cleanup przy sukcesie/błędzie/anulowaniu oraz limity operatora. Współdzielić mechanizm z istniejącym stagingiem snapshotu bez publikowania sesji lub nadpisywania workspace. Sprawdzić duże i puste załączniki, uszkodzenie także poza wybraną kategorią oraz brak publikacji przed końcową walidacją.
- [x] N288 — W ramach N039/N227 przywracać zalogowane obrazy, pliki i bloby audytu ze zweryfikowanego stagingu ZIP przez port attachment store: obrazy dokładnie przez restoreImage, pliki i audyt strumieniowo przez saveFileStream, z kontrolą zwróconych referencji. Nie publikować sesji ani nie usuwać współdzielonych obiektów po częściowym błędzie; jawnie opisać tę granicę transakcji. Sprawdzić dokładne bajty, deduplikację, błędy backendu, uszkodzenie archiwum, anulowanie i cleanup.
- [x] N289 — Usunąć kolizje rozwiązywania załączników w imporcie kanonicznym: ten sam digest może wystąpić jako obraz i plik albo jako pliki o różnych nazwach. Identyfikować rozwiązaną referencję pełną tożsamością kanoniczną (id, media type, opcjonalna nazwa), zachować jawne kontrole zgodności i sprawdzić projekcję bez nadpisywania referencji. Przygotować mapę z zalogowanych referencji archiwum z czytelną odmową brakujących lub niejednoznacznych danych.
- [x] N290 — W ramach N227 zapewnić trwałą, nieopublikowaną transakcję tworzenia importowanej sesji: istniejąca fabryka zapisuje seed przed startem drivera, a błąd startu zamyka uchwyt bez usunięcia materializowanej sesji. Zbadać backendy i dodać wspólny kontrakt staging/commit/rollback oraz wdrożyć go w obsługiwanych backendach i fabryce importu. Audyt przed skutkiem zewnętrznym musi pozostać trwały; częściowa sesja nie może być widoczna jako ukończony import. Testy mają obejmować awarię startu/publikacji, cleanup, współbieżność, restarty i jawne błędy rollbacku.
- [x] N291 — W ramach N039 połączyć walidację/projekcję archiwum, zgodność modelu, zatwierdzenie ostrzeżeń, rozwiązanie i przywrócenie załączników oraz wspólny port publikacji w koordynator importu do nowego ID. Najpierw obsłużyć jawną opcję zachowania istniejącego workspace bez jego modyfikacji; pozostałe opcje jawnie odmawiać do wdrożenia N226. Sprawdzić rzeczywisty ZIP → nową sesję, lineage, kontekst, brak historycznych efektów, ponowną kontrolę workspace/modelu i cleanup po błędzie.
- [x] N292 — W ramach N227 dodać odczytowy raport i bezpieczną procedurę odzyskiwania porzuconych transakcji importu po awarii procesu. N290 pozostawia je trwale ukryte i z zarezerwowanym ID; nie wolno automatycznie wznawiać częściowej sesji ani usuwać niepewnego audytu. Zdefiniować i sprawdzić warunki jawnego cleanup/recovery przy braku żywego właściciela oraz raportowanie nieznanego skutku.
- [x] N293 — W ramach N051–N055 zdiagnozować blokadę rzeczywistego testu przeglądarkowego navigation-panes na kliknięciu Search sessions: przycisk ma widoczną geometrię, lecz Playwright nie kończy sprawdzania stabilności, a screenshot przekracza timeout. Rozstrzygnąć środowisko/renderowanie Chromium i stan aplikacji, przywrócić wiarygodny test pobrania/importu ZIP oraz udokumentować ograniczenia; nie uznawać wydzielonego testu backendu N292 za zaliczenie scenariusza UI.
- [x] N294 — W ramach N035/N037/N226 uzupełnić metadane opcjonalnego snapshotu o jawny spis katalogów, w tym pustych, i odtwarzać je w prywatnym stagingu. Zachować walidację starszych archiwów bez spisu, jednoznacznie ograniczyć ich wierność oraz odrzucać niebezpieczne, powtórzone i sprzeczne ścieżki. Sprawdzić strukturę po ekstrakcji, zgodność fingerprintu i cleanup; nie traktować tego jako wdrożenia eksportu snapshotu lub jego zastosowania w workspace.
- [x] N295 — W ramach N035/N037 podłączyć opcjonalny snapshot workspace do strumieniowego eksportu ZIP oraz jawnego wyboru HTTP/GUI. Uwzględnić wszystkie zwykłe pliki i katalogi (także puste), metadane N294, spójny fingerprint i kontrolę zmian podczas odczytu; dla dowiązań i nieobsługiwanych obiektów jawnie odmówić zamiast pomijać dane lub dereferencjonować ścieżki. Zachować domyślny eksport bez workspace, limity operatora, pełną treść i ostrzeżenie przed eksportem jawnym; sprawdzić prawdziwy download oraz walidację/staging uzyskanego ZIP.
- [x] N296 — Zaktualizować przestarzały test route.host.spec.ts żądający domyślnego eksportu bez zarejestrowanego drivera i oczekujący log-only ZIP: od N283 domyślny format jest portable i poprawnie odmawia takiej sesji kodem 409. Zachować test jawnego format=log oraz osobno potwierdzić odmowę portable; nie osłabiać kontraktu produktu.
- [x] N297 — W ramach N226 uzupełnić preview konfliktów o zadeklarowane katalogi snapshotu, w tym puste: obecny workspaceFiles porównuje tylko payloady plikowe i pomija konflikt pusty katalog → istniejący plik/dowiązanie. Ujednolicić raport wpisów z jawnym typem plik/katalog, zaktualizować konsumentów oraz przetestować HTTP preview w rzeczywistej kompozycji. Nie utożsamiać zgodnego typu katalogu ze zgodnością jego zawartości ani nie wdrażać przy tym zapisu workspace.
- [x] N298 — W ramach N226/N227 podłączyć apply-snapshot do importu przy nieistniejącym docelowym workspace: pełna walidacja i prywatny staging przed zapisem, ekskluzywne utworzenie katalogu i plików, zachowanie pustych katalogów oraz kontrola odtworzonej zawartości przed publikacją nowej sesji. Przy zwykłym błędzie/anulowaniu wycofać wyłącznie własne, niezmienione dane; przy zmianie tożsamości lub cudzej treści zachować dane i jawnie zgłosić błąd rollbacku. Istniejący workspace nadal odmawia zastosowania snapshotu do wdrożenia osobnego potwierdzenia i kopii. Przetestować prawdziwy ZIP → nowy workspace → nową sesję bez historycznych efektów. Recovery po awarii procesu pozostaje osobnym N299.
- [x] N299 — W ramach N227 zapewnić trwały opis i recovery transakcji materializacji workspace po przerwaniu procesu: powiązać utworzone dane z nowym ID sesji, zachować niepewne efekty, rozpoznawać przerwanie przed/po publikacji i nie usuwać zmienionych plików użytkownika. Sprawdzić SIGKILL/restart i jawny raport outcome unknown; nie utożsamiać cleanup po zwykłym wyjątku N298 z atomową transakcją obejmującą awarię procesu.
- [x] N300 — Przygotować zależność N299: dodać do współdzielonego atomic-write jawną opcję trwałego zapisu (fsync payloadu i publikacja namespace z gwarancją właściwą platformie), zachowując dotychczasowy domyślny kontrakt bez fsync. Sprawdzić propagację błędów przed/po rename i cleanup, nie udawać wycofania już opublikowanego pliku. Windows ma używać utrzymywanego w repo Koffi i natywnego write-through, bez pozorowanego fsync katalogu. Zaktualizować zależności, dokumentację i testy; dopiero potem oprzeć na tym journal importu workspace.
- [x] N301 — W ramach N227 usunąć niejednoznaczny wynik importu po udanej publikacji sesji, gdy końcowy cleanup prywatnego stagingu snapshotu zgłosi błąd. Obecne withDshWorkspaceSnapshot obejmuje callback publikujący sesję, a jego finally może następnie odrzucić operację. Przenieść zawodny cleanup przed commit publikacji albo zwrócić jawny wynik publikacji z informacją o pozostawionym stagingu; nie usuwać opublikowanej sesji ani nie przedstawiać sukcesu publikacji jako bezpiecznie wycofanej próby. Przetestować awarię cleanup po rzeczywistym commit.
- [x] N302 — W ramach N226 przygotować odzyskiwalną kopię istniejącego workspace przed zastosowaniem snapshotu: prywatny katalog poza workspace, pełna strumieniowa kopia zwykłych plików i katalogów (w tym ukrytych/pustych), trwały manifest powiązany z importId i sesją, fingerprint oraz ponowna kontrola źródła. Odrzucać dowiązania i obiekty specjalne bez cichego pomijania, nie zmieniać plików źródłowych i nie przedstawiać częściowej kopii jako gotowej. Przetestować błędy, anulowanie, zmiany źródła i inspekcję kopii po restarcie; zastosowanie kopii/snapshotu pozostaje w N303.
- [x] N303 — Podłączyć zastosowanie snapshotu do istniejącego workspace z N226 przez osobne potwierdzenie zastąpienia i gotową kopię N302. Zachować dane dodane/zmienione po preview, trwały audyt intencji i recovery, jawnie rozdzielić publikację sesji od cleanup. Przetestować rzeczywistą kompozycję, błędy przed/po zmianie plików i przerwanie procesu; nie zamykać N226 bez wariantu context-only oraz N227 bez pełnego dowodu transakcyjności.
- [x] N304 — Przygotować zależność bezpiecznego zastąpienia/rollbacku workspace N303: atomowe przeniesienie ścieżki bez zastępowania istniejącego celu. Zwykłe rename po sprawdzeniu ENOENT ma wyścig i może nadpisać pliki/katalog utworzony przez użytkownika; użyć natywnej operacji no-replace na wspieranych platformach, odmówić przy braku wsparcia lub zmianie woluminu, nie stosować fallbacku copy/delete. Sprawdzić konflikty, realną operację Linux i kontrakty pozostałych platform, propagację błędów oraz stan po błędzie bariery trwałości.
- [ ] N305 — Domknąć wariant context-only z N226: import prawidłowego kontekstu bez istniejącego workspace i bez snapshotu musi utworzyć nową sesję z lineage oraz jawnym statusem braku workspace. Agent wymagający katalogu nie może uruchomić kolejnego turnu przed jawnym wyborem/przygotowaniem workspace; zachować ten stan po restarcie i nie wykonywać historycznych efektów. Sprawdzić realną kompozycję obu driverów, nie podstawiać po cichu cwd procesu ani starego workspace źródła. Dopiero z kompletem czterech wariantów ocenić N226/N037.
- [x] N306 — W ramach N064 zweryfikować na rzeczywistej aplikacji istniejące bramki uwierzytelnienia i Host/Origin dla eksportu GET/HEAD (portable, log-only, workspace) oraz POST preview: brak/błędne cookie, obcy Origin/Host i cross-site mają odmawiać przed ujawnieniem archiwum lub walidacją uploadu. Potwierdzić poprawne żądania właściciela i brak publikacji sesji/modelu/narzędzi przy odmowie. Opisać aktualny zakres właściciela instancji; nie uznawać tego za domknięcie autoryzacji przyszłego commit importu, szyfrowania lub modelu wielu użytkowników.
- [x] N307 — W ramach N200 nadać zachowanym testom upstream wyłączonym z agregatu hosta właściwy program TypeScript do typowanego lint: sprawdzić źródło błędów error typed value, zachować reguły lint i wyłączenie tych pakietów z produktu. Zweryfikować objęte pliki bez maskowania rzeczywistych błędów i odnotować pozostałe diagnostyki.
- [x] N308 — W ramach N200 rozliczyć aktualne diagnostyki aktywnego kodu i rzeczywiste ostrzeżenia testów po poprawieniu programów typów N307; sprawdzić utrzymanie semantyki audytu i uruchomić pełną bramkę lint przed zamknięciem N200.
- [ ] N309 — Rozliczyć 11 diagnostyk workspace constraints wykrytych przy N307: deklaracja publikowanych plików agent-codex oraz status wydania i metadane export-conversation-pdf. Sprawdzić faktyczną rolę pakietów i zawartość artefaktów przed zmianą manifestów; nie uznawać bramki za zieloną na podstawie lint.
- [x] N310 — Zaktualizować przestarzałe oczekiwanie wersji sesji w teście llm-replay „never rewrites a projected source fixture while migrating it in memory”: porównanie oczekuje V2, a obowiązująca migracja zwraca V3. Zachować dowód niezmienności źródłowego pliku i pełną treść replay; sprawdzić aktualny kontrakt migracji przed korektą testu.
- [x] N311 — Zweryfikować zależność N305 na rzeczywistym forku: odtworzyć checkpoint do nowego CODEX_HOME przy jawnej, lecz nieistniejącej ścieżce workspace, sprawdzić brak automatycznego utworzenia katalogu i requestu modelowego podczas importu, następnie przygotować workspace i porównać kontekst kontynuacji oraz wznowienie po restarcie DSH. Dowód ma rozstrzygnąć, czy potrzebne jest odraczanie thread/start; nie zastępuje trwałej blokady turnu i UI context-only z N305.
- [ ] N312 — Sprawdzić i domknąć trwałość oraz ponowny eksport importowanej sesji Codexa przed pierwszym nowym turnem: publisher przekazuje checkpoint do thread/start, lecz port źródłowy wymaga checkpointu audytu sesji docelowej. Zachować kanoniczny kontekst i prywatny stan w DSH tak, aby świeży import (także context-only) dawał się wyeksportować po restarcie bez pierwszego requestu modelowego i bez starego CODEX_HOME. Nie fabrykować historycznych faktów audytu pod nową tożsamością.
- [ ] N313 — Sprawdzić automatyczne pobieranie featured plugins i tworzenie shell snapshot w sesjach DSH, ujawnione w logu N311. Ustalić osiągalność i zależności; wyłączyć zbędne efekty natywnego runtime bez naruszania pętli, compaction ani parsowania historii. Zweryfikować brak dodatkowej aktywności przy imporcie na rzeczywistym procesie.
