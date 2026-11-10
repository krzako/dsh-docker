# Audit usuwania natywnych narzędzi forka Codexa

Ten audyt określa granicę N025. Dotyczy forka w `dockers/addons/codex`, nie narzędzi DSH. Samodzielny Codex CLI utraci natywne funkcje modelowe; jest to świadomy skutek usunięcia ich źródeł. Funkcje wewnętrzne służące prowadzeniu wątku, compaction i obsłudze polecenia użytkownika nie są modelowymi narzędziami i muszą pozostać.

## Miejsca rejestracji i wykonania

- `codex-rs/core/src/tools/spec_plan.rs` rejestruje natywne handlery, MCP, rozszerzenia oraz hosted tool specs. Gałąź DSH `delegated_tools_only` już omija te ścieżki, ale pozostała gałąź nadal je kompiluje. Najpierw trzeba sprowadzić router do katalogu dynamicznego dla wszystkich klientów.
- `codex-rs/core/src/tools/handlers/` ma 70 śledzonych plików. `dynamic.rs` jest niezbędny do callbacku DSH. Pozostałe implementacje i pliki spec/test należą do natywnych funkcji: shell/patch, MCP i jego zasobów, rozszerzeń, wyszukiwania, web/hosted, delegacji, planowania, zgód, pytań oraz kontroli środowiska.
- `codex-rs/core/src/tools/code_mode/` ma 11 śledzonych plików. To alternatywny modelowy interfejs narzędzi; DSH wymusza `Direct`. Jego usunięcie wymaga usunięcia `CodeModeService` ze stanu sesji, uruchamiania i testów.
- `codex-rs/core/src/mcp_tool_exposure.rs` i `McpHandlerCache` obsługują modelowo widoczne MCP. Są zbędne po usunięciu tej rejestracji.
- `codex-rs/core/src/tools/runtimes/` ma 8 śledzonych plików. `apply_patch` jest runtime'em natywnego narzędzia. `unified_exec`, `zsh_fork` i część `mod.rs` są używane również przez `unified_exec/process_manager.rs`, `tasks/user_shell.rs` i odtwarzanie shell snapshot; tych wewnętrznych zależności nie wolno usuwać tylko dlatego, że znajdują się w katalogu `tools`.
- `ToolRegistry`, `ToolRouter`, dynamic handler, serializacja wyników oraz mechanizmy wywołania/odpowiedzi pozostają potrzebne do delegowania funkcji DSH. Nie usuwać ich wraz z natywnymi handlerami.

## Zależności poza katalogiem narzędzi

Bezpośrednie importy natywnych typów występują w `core/src/state/service.rs`, `session/session.rs`, `session/turn.rs`, `mcp_tool_exposure.rs`, `memory_usage.rs`, `unified_exec/process_manager.rs`, `tasks/user_shell.rs` i testach sesji. `core/src/lib.rs` oraz `core-api/src/lib.rs` eksportują `WaitForEnvironmentToolConfig`; test `core/tests/suite/remote_env.rs` używa go. Zmiana jest zatem celowo niekompatybilna z tą częścią samodzielnego API/CLI. W `app-server`, `cli` i `tui` nie znaleziono bezpośrednich importów `tools::handlers`, `tools::runtimes` ani `tools::code_mode`; ich zachowanie może jednak zależeć od publicznego API i testów.

## Partie kompilowalne

1. N070: zastąpić natywny plan narzędzi planem tylko z funkcji dynamicznych, zachowując router i potrzebne typy; usunąć nieużywane ścieżki rejestracji i związane z nimi testy planu.
2. N071: usunąć źródła natywnych handlerów/specyfikacji oraz modelowo widoczne MCP, dostosować stan i eksporty. Zachować `dynamic.rs` oraz wspólną infrastrukturę dispatchera.
3. N072: usunąć Code Mode i runtime'y wyłącznie modelowych narzędzi. Współdzielone wykonanie polecenia użytkownika, przygotowanie środowiska oraz compaction pozostawić lub przenieść poza katalog narzędzi.
4. N025: przeprowadzić końcowy przegląd referencji, build forka i test rzeczywistego DSH app-servera dla katalogu pustego i dynamicznego, odmowy natywnego wywołania oraz compaction. Dopiero wtedy odhaczyć usunięcie źródeł.
