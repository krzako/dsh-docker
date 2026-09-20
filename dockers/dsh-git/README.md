# DSH Git Bridge

Centralny, lokalny serwer Git służący jako bezpieczny bufor pomiędzy agentem DSH a prawdziwymi repozytoriami na hoście.

Projekt jest przeznaczony do sytuacji, w której:

- prawdziwe repozytoria Git znajdują się na hoście Windows/Linux,
- DSH pracuje w Dockerze i ma już własny persistent workspace/volume,
- agent ma móc commitować i pushować zmiany,
- agent nie powinien mieć bezpośredniego dostępu do prawdziwych repozytoriów,
- użytkownik chce ręcznie przeglądać i przenosić wybrane commity z bridge do prawdziwego repo.

Bridge **nie tworzy, nie montuje i nie konfiguruje workspace DSH**. Komunikacja z DSH odbywa się wyłącznie przez protokół Git po porcie 9418 w prywatnej sieci Dockera.

---

## 1. Architektura

```text
Windows / Linux host

...\projects\backend               prawdziwe repo
        │
        │ tylko podczas add-to-dsh.sh:
        │ read-only mount do krótkotrwałego helper-containera
        ▼
...\dsh-git\repos\backend.git
        ▲
        │ bind mount /repos
        │
┌───────┴────────────────────────────────┐
│ dsh-git                                │
│                                        │
│ git daemon :9418                       │
│ wspólny pre-receive hook               │
│ /repos/backend.git                     │
│ /repos/frontend.git                    │
│ /repos/whatever.git                    │
└───────▲────────────────────────────────┘
        │
        │ git://dsh-git/backend.git
        │ prywatna sieć Docker
        ▼
┌─────────────────────────────────────────┐
│ DSH                                     │
│                                         │
│ TWÓJ ISTNIEJĄCY workspace/volume        │
│   backend/                              │
│   frontend/                             │
│   ...                                   │
└─────────────────────────────────────────┘
```

Z hosta bridge jest dostępny wyłącznie przez localhost:

```text
git://localhost:9418/backend.git
```

Z DSH, po wspólnej sieci Docker:

```text
git://dsh-git/backend.git
```

---

## 2. Co agent może i czego nie może

Dla każdego bare repo skrypt ustawia ochronę po stronie serwera.

Agent może:

- klonować repo,
- fetchować,
- tworzyć lokalne commity,
- tworzyć branche `dsh/*`,
- pushować kolejne commity fast-forward do `dsh/*`.

Agent nie może przez bridge:

- pushować do `main`, `master`, `develop` ani innych branchy poza `dsh/*`,
- tworzyć lub aktualizować tagów,
- usuwać branchy,
- robić force-pusha,
- robić non-fast-forward push,
- wypchnąć nowych commitów z inną tożsamością Git niż skonfigurowana dla projektu.

Przykład dozwolony:

```text
A -- B -- C -- D -- E
              ^    ^
              dsh/task przesuwa się tylko do przodu
```

Przykład blokowany:

```text
A -- B -- C -- D
         \
          X
```

jeżeli `dsh/task` wskazywał już na `D`, a ktoś próbuje przepisać go na `X`.

---

## 3. Ważna granica bezpieczeństwa

DSH **nie może mieć filesystemowego dostępu** do:

- prawdziwego repo,
- katalogu `repos/` bridge,
- całego `C:\projects`,
- `/mnt/c/...` zawierającego prawdziwe repo.

Nie montuj do DSH np.:

```yaml
volumes:
  - C:/projects:/projects
```

ani Docker socketa hosta:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

jeżeli agent miałby dzięki temu możliwość samodzielnego montowania hostowych katalogów.

Centralny bridge chroni prawdziwe repo tylko wtedy, gdy agent nie ma alternatywnej drogi do hostowego filesystemu.

---

# Instalacja centralnego bridge

## 4. Wymagania

Potrzebne są:

- Docker,
- Docker Compose v2 (`docker compose`),
- Git,
- Bash.

Obsługiwane środowiska uruchamiania skryptów:

- Git Bash na Windows,
- MSYS2 Bash na Windows,
- WSL,
- normalny Linux Bash.

Na Windows zakładamy Docker Desktop.

---

## 5. Struktura projektu

```text
dsh-git/
├── .env.example
├── .gitignore
├── README.md
├── add-to-dsh.sh
├── docker-compose.yml
├── repos/
│   └── .gitkeep
├── server/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   └── pre-receive
└── setup.sh
```

`repos/` zawiera wszystkie bare repozytoria obsługiwane przez centralny bridge.

---

## 6. Pierwszy setup

W katalogu projektu:

```bash
./setup.sh
```

`setup.sh` oraz `add-to-dsh.sh` zatrzymują interaktywne okno terminala na końcu (również po błędzie) komunikatem `Press any key to continue...`. Dzięki temu przy uruchamianiu przez skojarzenie pliku / double-click na Windows komunikaty nie znikają od razu. W uruchomieniu nieinteraktywnym pauza jest pomijana.

Przy **pierwszym poprawnym uruchomieniu** skrypt:

1. sprawdza Git, Docker i Docker Compose,
2. tworzy `.env` z `.env.example`, jeśli go nie ma,
3. buduje obraz bridge,
4. uruchamia centralny kontener,
5. tworzy prywatną sieć Docker,
6. wystawia port 9418 na `127.0.0.1`,
7. zapisuje marker `.setup-complete` dopiero po udanym setupie,
8. wypisuje wszystkie istotne endpointy i fragment Compose dla DSH.

Jeżeli setup **już istnieje**, ponowne `./setup.sh` jest ścisłym **no-op**: nie buduje obrazu, nie uruchamia/restartuje kontenera, nie tworzy sieci i nie modyfikuje konfiguracji. Wypisuje `ALREADY EXISTS`, informację że nic nie zmienił oraz ten sam zestaw użytecznych informacji co po pierwszym uruchomieniu.

Samo istnienie `.env` nie oznacza ukończonego setupu. Dzięki temu przerwany lub nieudany pierwszy start można normalnie uruchomić ponownie.

Domyślnie otrzymasz:

```text
Container:         dsh-git
Docker network:    dsh_git
Host endpoint:     git://localhost:9418/<repo>.git
DSH endpoint:      git://dsh-git/<repo>.git
```

---

# Podłączenie DSH

## 7. DSH potrzebuje tylko wspólnej sieci

Bridge **nie potrzebuje znać ścieżki workspace DSH** i nie tworzy żadnego volume dla DSH.

Jeżeli DSH jest w osobnym Compose, dodaj do istniejącego serwisu DSH:

```yaml
services:
  dsh:
    # ... Twoja istniejąca konfiguracja ...

    networks:
      - default
      - dsh_git

networks:
  dsh_git:
    external: true
    name: dsh_git
```

Twoje istniejące:

```yaml
volumes:
  # obecny persistent workspace DSH
```

zostaje bez zmian.

Po zmianie Compose zrestartuj/recreate DSH zgodnie ze swoim normalnym workflow.

Możesz sprawdzić z kontenera DSH, czy DNS bridge działa:

```bash
getent hosts dsh-git
```

---

# Dodawanie projektu

## 8. Najwygodniejszy workflow

Do konkretnego prawdziwego repo kopiujesz **tylko**:

```text
add-to-dsh.sh
```

Przykład:

```text
C:\projects\backend\
├── .git\
├── src\
├── package.json
└── add-to-dsh.sh
```

Uruchamiasz go z Git Bash/MSYS2/WSL/Linux:

```bash
./add-to-dsh.sh
```

Po zakończeniu możesz kopię usunąć:

```bash
rm add-to-dsh.sh
```

Skrypt ustala repo na podstawie miejsca, w którym **sam leży**, a nie na podstawie przypadkowego `pwd`.

---

## 9. Co robi `add-to-dsh.sh`

Dla repo np. `backend`:

1. znajduje root bieżącego Git working tree,
2. ustala nazwę projektu z nazwy katalogu,
3. odczytuje `git user.name`,
4. odczytuje `git user.email`,
5. odczytuje aktualny branch i HEAD,
6. znajduje działający centralny `dsh-git`,
7. wykrywa jego sieć, port, obraz i `/repos`,
8. uruchamia **krótkotrwały helper-container**,
9. helper montuje prawdziwe repo jako **read-only** pod `/source`,
10. helper korzysta z tego samego `/repos` co bridge,
11. tworzy `backend.git` jako bare repo,
12. ustawia ochronę receive-pack,
13. ustawia wspólny `pre-receive` hook,
14. zapisuje oczekiwane `user.name` i `user.email`,
15. pozwala pushować tylko do `dsh/*`,
16. tworzy `git-daemon-export-ok`,
17. dodaje do **prawdziwego repo** nowy remote `dsh` wskazujący na `git://localhost:9418/backend.git`,
18. **nie usuwa, nie zmienia i nie rename'uje istniejącego `origin` ani innych remote'ów**,
19. po dodaniu `dsh` sprawdza, że `origin` ma dokładnie te same fetch/push URL-e co przed uruchomieniem,
20. sprawdza repo przez prywatną sieć Docker,
21. sprawdza endpoint hostowy, jeśli jest osiągalny,
22. wypisuje gotowe komendy do sklonowania repo w Twoim istniejącym workspace DSH.

Po zakończeniu prawdziwe repo nie pozostaje zamontowane ani do DSH, ani do stale działającego bridge.

---

## 10. Co wypisuje skrypt

Przykładowy wynik:

```text
Project root:       C:/projects/backend
Project name:       backend
Current branch:     main
Source HEAD:        abcdef123...
Git identity:       Jan Kowalski <jan@example.com>
Bridge container:   dsh-git
Bridge network:     dsh_git
Bare in bridge:     /repos/backend.git
DSH remote:         git://dsh-git/backend.git
Host remote:        git://localhost:9418/backend.git
Source origin:      git@github.com:example/backend.git
Source dsh:         git://localhost:9418/backend.git

Allowed pushes:     refs/heads/dsh/* only
Delete refs:        BLOCKED
Force/non-FF push:  BLOCKED
Required identity:  Jan Kowalski <jan@example.com>
```

Na końcu dostaniesz również m.in.:

```bash
git clone "git://dsh-git/backend.git" <project-directory>
```

---

# Repo robocze w DSH

## 11. Klonowanie do istniejącego workspace DSH

Bridge nie wie i nie musi wiedzieć, gdzie masz workspace.

Wchodzisz do DSH i klonujesz repo tam, gdzie chcesz, np.:

```bash
cd /twoj/istniejacy/workspace

git clone git://dsh-git/backend.git backend
cd backend
```

Następnie ustaw identity identyczne z prawdziwym repo:

```bash
git config user.name "Jan Kowalski"
git config user.email "jan@example.com"
git config user.useConfigOnly true
```

Skrypt `add-to-dsh.sh` wypisuje dokładne wartości dla danego projektu, więc nie musisz ich szukać.

`user.useConfigOnly=true` sprawia, że jeżeli identity zniknie, Git odmówi commita zamiast zgadywać dane z użytkownika/hostname kontenera.

---

## 12. Pierwszy branch agenta

W working copy DSH:

```bash
git switch -c dsh/task-001
```

Agent pracuje normalnie:

```bash
git add .
git commit -m "Implement task"
git push -u origin dsh/task-001
```

Następne commity:

```bash
git add .
git commit -m "Fix tests"
git push
```

przechodzą, ponieważ są fast-forward.

---

# Ochrona po stronie serwera

## 13. Dlaczego lokalny config agenta nie wystarcza

Agent może zmienić swój lokalny config:

```bash
git config user.name DeepSeek
git config user.email agent@example.com
```

Dlatego identity jest sprawdzane ponownie w `pre-receive` na bridge.

Każde bare repo zawiera config w rodzaju:

```ini
[bridge]
    expectedName = Jan Kowalski
    expectedEmail = jan@example.com
    allowedPrefix = dsh/
```

Hook jest wspólny dla wszystkich repo i znajduje się w obrazie kontenera:

```text
/opt/git-hooks/pre-receive
```

Nie znajduje się w `backend.git/hooks`, więc repozytorium nie dostarcza własnej wersji hooka.

---

## 14. Push do `main`

To zostanie odrzucone:

```bash
git push origin HEAD:main
```

Hook akceptuje wyłącznie:

```text
refs/heads/dsh/*
```

---

## 15. Delete branch

To zostanie odrzucone:

```bash
git push origin --delete dsh/task-001
```

Dodatkowo ustawione jest:

```ini
receive.denyDeletes=true
```

---

## 16. Force push / non-fast-forward

To również zostanie odrzucone:

```bash
git push --force
```

Mamy dwie warstwy:

```ini
receive.denyNonFastForwards=true
```

oraz sprawdzenie ancestry w `pre-receive`.

---

# Praca z hosta

## 17. Endpoint localhost

Compose mapuje:

```yaml
ports:
  - "127.0.0.1:9418:9418"
```

Dlatego repo nie jest celowo wystawione na cały LAN.

Z hosta:

```bash
git ls-remote git://localhost:9418/backend.git
```

lub:

```bash
git clone git://localhost:9418/backend.git
```

Możesz dzięki temu współpracować z agentem na `dsh/*` z osobnego clone na Windows/Linux.

---

## 18. Współpraca na tym samym branchu

Agent:

```bash
git switch -c dsh/task-001
git push -u origin dsh/task-001
```

Ty z hostowego working copy bridge:

```bash
git fetch origin
git switch --track origin/dsh/task-001
```

Robisz swoje zmiany:

```bash
git add .
git commit -m "My change"
git push
```

Agent potem:

```bash
git pull --ff-only
```

Jeżeli obaj zrobicie rozbieżne commity, drugi push zostanie odrzucony. To jest zamierzone zachowanie.

---

# Prawdziwe repo

## 19. Remote'y: prawdziwe repo vs bare bridge

W **prawdziwym repo** skrypt zachowuje wszystkie istniejące remote'y. W szczególności `origin` pozostaje bez zmian. Skrypt dodaje tylko:

```text
dsh -> git://localhost:9418/<repo>.git
```

Jeżeli remote `dsh` już istnieje i wskazuje gdzie indziej, pierwsza rejestracja jest przerywana zamiast nadpisywać konfigurację.

Bare repo w bridge nie potrzebuje żadnego remote prowadzącego z powrotem do prawdziwego repo. `git clone --bare` jest używany tylko do skopiowania historii; stale działający bridge nie ma dostępu do ścieżki prawdziwego repo.

Prawdziwy projekt jest podmontowany tylko na czas działania krótkotrwałego helpera i tylko read-only.

---

## 20. Ręczne przenoszenie commitów

To pozostaje celowo poza automatyzacją.

W prawdziwym repo remote `dsh` jest dodawany automatycznie przez `add-to-dsh.sh`. Możesz więc od razu `git fetch dsh`, oglądać `dsh/*`, diffy i robić `cherry-pick` wybranych SHA. Istniejący `origin` pozostaje Twoim normalnym remote'em do prawdziwego GitHub/GitLab.

To jest właściwy „airlock” pomiędzy kodem agenta a prawdziwym repo.

---

# Dirty working tree

## 21. Niezacommitowane pliki

`add-to-dsh.sh` kopiuje historię Git, a nie bieżący stan filesystemu.

Jeżeli masz:

```text
modified: src/foo.ts
untracked: temp.txt
```

to pliki te **nie znajdą się w bare repo**, dopóki nie są częścią commita.

Skrypt wykrywa taki stan i wypisuje ostrzeżenie.

Sam skopiowany `add-to-dsh.sh` nie jest liczony jako „other untracked”.

---

# Ponowne uruchomienie

## 22. Idempotencja / ponowne uruchomienie

Oba skrypty są celowo zachowawcze.

### `setup.sh`

Jeżeli centralny bridge został już poprawnie utworzony, ponowne uruchomienie jest ścisłym **no-op**. Skrypt:

- niczego nie buduje,
- nie odpala `docker compose up`,
- nie restartuje kontenera,
- nie tworzy ani nie zmienia sieci,
- nie przepisuje `.env`,
- wypisuje `ALREADY EXISTS`,
- wypisuje ponownie container/image/network/endpoints oraz fragment Compose dla DSH.

### `add-to-dsh.sh`

Jeżeli `/repos/<projekt>.git` już istnieje i jest poprawnym bare repo, ponowne uruchomienie również jest ścisłym **no-op**. Skrypt **nie**:

- fetchuje ani synchronizuje źródła,
- zmienia refs,
- dopisuje obiektów,
- zmienia hooków,
- zmienia `bridge.expectedName` / `bridge.expectedEmail`,
- zmienia żadnego configu bare repo.

Zamiast tego tylko odczytuje stan i wypisuje ten sam zestaw informacji co po pierwszej rejestracji, plus między innymi:

```text
Result:             ALREADY EXISTS
Changes made:       NO - strict no-op
Source HEAD:        abc123...
Bridge HEAD:        def456...
HEAD relationship:  SAME / DIFFERENT
```

Jeśli HEAD źródła i bridge są różne, zobaczysz dodatkowo jednoznaczny komunikat, że **nic nie zostało automatycznie zsynchronizowane**.

Nie używaj ponownego uruchomienia jako mechanizmu synchronizacji `main` z prawdziwego repo. Aktualizację bridge z prawdziwego repo rób świadomie, własnym workflow.

---

# Nazwy projektów

## 23. Domyślna nazwa

Dla:

```text
C:\projects\backend
```

powstanie:

```text
backend.git
```

i endpoint:

```text
git://dsh-git/backend.git
```

---

## 24. Kolizja nazw

Jeżeli dwa różne projekty nazywają się `backend`, możesz jawnie nadpisać nazwę:

```bash
DSH_BRIDGE_PROJECT_NAME=customer-a-backend ./add-to-dsh.sh
```

Powstanie:

```text
customer-a-backend.git
```

---

# Wiele bridge

## 25. Wybór konkretnego kontenera

Normalnie `add-to-dsh.sh` znajduje jedyny uruchomiony kontener z etykietą:

```text
com.dsh-git.managed=true
```

Jeżeli masz więcej niż jeden:

```bash
DSH_GIT_CONTAINER=my-bridge ./add-to-dsh.sh
```

---

# Git Bash / MSYS2 / WSL

## 26. Git Bash i MSYS2

MSYS potrafi automatycznie przepisywać argumenty takie jak:

```text
/source
/repos
```

na ścieżki Windowsowe.

Skrypty wywołują Docker przez wrapper z:

```text
MSYS_NO_PATHCONV=1
```

oraz używają `cygpath` dla prawdziwej ścieżki źródłowego repo.

Dzięki temu ścieżki wewnątrz kontenera pozostają POSIX-owe, a bind mount źródła dostaje ścieżkę zrozumiałą dla Docker Desktop.

---

## 27. WSL

W WSL skrypt przekazuje ścieżkę źródła w postaci np.:

```text
/mnt/c/projects/backend
```

Docker Desktop z aktywną integracją WSL potrafi obsłużyć taki bind mount.

Bridge i DSH nadal komunikują się przez sieć Docker, nie przez filesystem WSL.

---

## 28. Native Linux

Na Linuxie ścieżki są przekazywane bez konwersji.


---

# Konfiguracja

## 29. `.env`

`setup.sh` automatycznie tworzy `.env` z `.env.example`.

Domyślna konfiguracja:

```env
BRIDGE_CONTAINER=dsh-git
BRIDGE_IMAGE=dsh-git:local
BRIDGE_PORT=9418
BRIDGE_NETWORK=dsh_git
```

Nie ma tutaj żadnej zmiennej opisującej workspace DSH. Bridge nie potrzebuje tej wiedzy.

---

# Diagnostyka

## 30. Czy bridge działa?

```bash
docker ps --filter label=com.dsh-git.managed=true
```

Logi:

```bash
docker logs dsh-git
```

---

## 31. Lista bare repo

Z katalogu projektu bridge:

```bash
ls repos
```

lub:

```bash
docker exec dsh-git find /repos -maxdepth 1 -type d -name '*.git' -print
```

---

## 32. Test endpointu z hosta

```bash
git ls-remote git://localhost:9418/backend.git
```

---

## 33. Test endpointu z sieci Docker

Możesz użyć obrazu bridge jako helpera:

```bash
docker run --rm \
  --network dsh_git \
  --entrypoint git \
  dsh-git:local \
  ls-remote git://dsh-git/backend.git
```

---

## 34. Sprawdzenie konfiguracji ochronnej

```bash
docker exec dsh-git \
  git --git-dir=/repos/backend.git config --list
```

Interesujące wpisy:

```text
receive.denydeletes=true
receive.denynonfastforwards=true
core.hookspath=/opt/git-hooks
bridge.expectedname=...
bridge.expectedemail=...
bridge.allowedprefix=dsh/
```

---

# Aktualizacja bridge

## 35. Zmiana Dockerfile/hooka

Po zmianie plików w `server/`:

```bash
docker compose up -d --build
```

Bare repo pozostają w hostowym katalogu:

```text
repos/
```

więc rebuild obrazu ich nie usuwa.

---

# Backup

## 36. Co backupować

Najważniejszy jest katalog:

```text
repos/
```

Każdy `*.git` jest kompletnym bare repozytorium.

Workspace DSH nie należy do tego projektu i jego backup pozostaje częścią Twojej istniejącej konfiguracji DSH.

---

# Usuwanie / zatrzymywanie

## 37. Zatrzymanie bridge

```bash
docker compose down
```

Nie usuwa to bare repo z `repos/`.

Ponowne uruchomienie:

```bash
docker compose up -d
```

---

# Ograniczenia

## 38. `git://` nie ma uwierzytelniania

Klasyczny `git daemon` nie oferuje normalnego mechanizmu użytkownik/hasło.

Dlatego:

- port hostowy jest przypięty tylko do `127.0.0.1`,
- DSH korzysta z prywatnej sieci Docker,
- bezpieczeństwo pushy wymuszają hook i receive settings.

Każdy kontener mający dostęp do sieci `dsh_git` może potencjalnie czytać eksportowane repo bridge. Przy centralnym bridge jest to świadomy kompromis.

---

## 39. Bridge nie jest sejfem na jedyną kopię danych

Traktuj `repos/*.git` jako bufor roboczy pomiędzy agentem a prawdziwym repo.

Prawdziwe repo pozostaje źródłem, które kontrolujesz ręcznie.

---

# TL;DR

Jednorazowo:

```bash
cd dsh-git
./setup.sh
```

Podłącz istniejący DSH do:

```text
dsh_git
```

bez zmieniania jego workspace volume.

Dla każdego projektu:

```bash
cp /path/to/dsh-git/add-to-dsh.sh /path/to/project/
cd /path/to/project
./add-to-dsh.sh
rm add-to-dsh.sh
```

Po pierwszym udanym uruchomieniu prawdziwe repo ma np.:

```text
origin  <Twój dotychczasowy GitHub/GitLab>
dsh     git://localhost:9418/backend.git
```

Skrypt wypisze np.:

```text
git://dsh-git/backend.git
```

W swoim **istniejącym** workspace DSH:

```bash
git clone git://dsh-git/backend.git backend
cd backend

git config user.name "..."
git config user.email "..."
git config user.useConfigOnly true

git switch -c dsh/task-001
git push -u origin dsh/task-001
```

I tyle. Centralny bridge nie musi wiedzieć nic o lokalizacji workspace DSH.
