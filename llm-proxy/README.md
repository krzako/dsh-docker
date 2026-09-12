# Proxy Project

Samodzielny proxy kompatybilny z API OpenAI. Uruchamiaj go z tego katalogu:

```powershell
cd proxy-project
node proxy.mjs --help
node proxy.mjs
```

Proxy przekazuje requesty do upstreamu, ale zapisuje na dysku wyłącznie te,
które otrzymały odpowiedź HTTP inną niż `200`. Udane requesty nie trafiają do
katalogu `requests/`.

## Najważniejsze opcje

```powershell
node proxy.mjs --fix-plan
node proxy.mjs --port 8788 --upstream https://llm.domain.com
node proxy.mjs --log .\requests\requests.log --bodies .\requests
```

`--fix-plan` włącza usuwanie przed wysłaniem wiadomości spełniających wszystkie
warunki: `role === "user"`, `content` jest tablicą dokładnie dwóch elementów,
a `content[1].text` zaczyna się od:

```text
<system-reminder>
Your operational mode has changed from plan to build
```

Usunięte wiadomości są od razu pokazywane w konsoli i logu. Jeśli request się
nie powiedzie, dodatkowo trafiają do `requests/<data>_removed_content.json`.

Pełna lista parametrów:

```powershell
node proxy.mjs --help
```

Zmienne środowiskowe: `LLM_PROXY_PORT`, `LLM_PROXY_UPSTREAM`,
`LLM_PROXY_LOG`, `LLM_PROXY_KEY`. Klucz ustawiony przez `LLM_PROXY_KEY` jest
maskowany w nagłówkach i zapisywanych treściach.
