# Suunto Cloud API — pobieranie i analiza treningów

Narzędzie CLI do autoryzacji Suunto Cloud API, pobierania podsumowań i plików
FIT oraz obliczania metryk treningu. Kod, testy i przykładowa konfiguracja są
oddzielone od lokalnych poświadczeń i danych sportowca.

Oficjalny Suunto MCP jest drugim, zewnętrznym źródłem danych. Obecne skrypty
obsługują Cloud API i FIT; połączenie ich wyników z odczytami MCP wykonuje agent
mający dostęp do tej integracji. Repozytorium nie zawiera serwera ani klienta
MCP, jego autoryzacji ani osobistego kontekstu treningowego.

## Wymagania

- Python 3.9 lub nowszy, z dostępną strefą czasową `Europe/Warsaw`.
- macOS lub Linux: blokada odświeżania tokenów korzysta z `fcntl`.
- Node.js oraz `fit-file-parser` do dekodowania FIT i eksportu GPX. Dekoder
  najpierw szuka lokalnego pakietu, następnie biblioteki z SuuntoPlus Editor
  zainstalowanego w rozszerzeniach VS Code.
- Własna aplikacja OAuth i subskrypcja Developer API w Suunto API Zone.

Wszystkie poniższe polecenia wykonuj w katalogu repozytorium `suunto-cloud`.

## Konfiguracja po sklonowaniu repozytorium

Repozytorium zawiera kod i szablon `config.example.json` z placeholderem
Client ID. Rzeczywisty `config.json`, klucze, tokeny oraz pobrane dane pozostają
lokalne, również gdy repozytorium GitHub jest prywatne.

Jeśli nie masz jeszcze lokalnej konfiguracji, w katalogu `suunto-cloud` wykonaj:

```sh
cp -n config.example.json config.json
```

W `config.json` zastąp `YOUR_SUUNTO_CLIENT_ID` swoim Client ID i sprawdź zgodność
`redirect_uri` z ustawieniami aplikacji w Suunto API Zone. Nie dodawaj tam
Client secret ani klucza subskrypcji. `cp -n` zachowuje istniejącą konfigurację.
Autoryzację i zapis kluczy opisuje sekcja „Prywatna konfiguracja”.

Do Git trafiają wyłącznie placeholdery i syntetyczne dane testowe. `.gitignore`
wyklucza konfigurację, cały `.local/`, pliki `.env`, FIT/GPX i raporty.
`.dockerignore` wyklucza te dane również z przyszłego kontekstu budowania
obrazu. `.gitignore` nie usuwa plików, które wcześniej dodano już do Git;
przed pierwszym commitem sprawdź listę plików i zawartość zmian.

## Zwykłe pobranie do analizy

```sh
python3 sync.py --date 2026-01-15 --date 2026-01-16 --analysis --brief
```

Zastąp przykładowe daty dniami swoich aktywności w Europe/Warsaw; `--date` można
powtarzać. Polecenie:

1. Odczytuje zapisane klucze i tokeny, bez pytań o nie.
2. Automatycznie odświeża access token przed wygaśnięciem lub jednokrotnie
   ponawia odczyt po HTTP 401. Zapisuje nowy refresh token, jeśli serwer go zmieni.
3. Pobiera świeżą listę z `/v2/workouts` i sprawdza strukturę odpowiedzi.
4. Dla wskazanych dat zapisuje podsumowania Cloud, oryginalne FIT z
   `/v3/workouts/{workoutKey}/fit` i pełne pomiary w `*.decoded.json`.
5. Zapisuje `.local/sync.json` z datą pobrania, identyfikatorami, sumami SHA-256
   i wynikiem każdego etapu. Nie oznacza niepełnego pobrania jako sukcesu.
6. Z `--analysis` od razu oblicza pauzy, aktywne międzyczasy i statystyki HR,
   zapisując pełną analizę w `*.analysis.json`. Zwraca wyłącznie zwięzły pakiet
   JSON, również zapisany w `.local/analysis.json`, z metrykami Cloud/FIT
   i maksymalnie trzema wcześniejszymi sesjami tego samego sportu do porównania.
7. Oblicza także mechanikę aktywnych próbek, zmiany HR w kolejnych wolniejszych
   krokach oraz dostępność kanałów SuuntoPlus. Zapisuje raporty danych w
   `../reports/suunto-RRRR-MM-DD-HHMMSS.md` i `.json`; tekst oceny poza blokiem
   `suunto-generated` jest zachowywany przy odświeżaniu raportu.
8. `--brief` zwraca tylko krótki widok z tabelą `lap_columns`/`lap_rows`, bez
   usuwania pełnych danych z `.local/analysis.json` i plików źródłowych.

Domyślna analiza jest **bez wykresów**. Tylko na wyraźną prośbę użytkownika
dodaj `--charts`; powstanie statyczny SVG z HR, tempem i wysokością. Przy tej
operacji usuwane są wyłącznie starsze niż 30 dni wykresy oznaczone jako
wygenerowane przez skrypt, z zachowaniem bieżących plików i pominięciem dowiązań.

Tryb `--analysis` skraca przygotowanie danych do jednego wywołania. Nie trzeba
ponownie czytać wielomegabajtowych próbek ani osobno uruchamiać `analyze_fit.py`,
jeśli pakiet zawiera już potrzebne wyliczenia. Do bardziej szczegółowych pytań
pełne próbki pozostają dostępne. Pobranie listy i FIT nadal jest świeże;
pakiet nie zastępuje sprawdzenia zgodności ID z MCP. Czasy etapów zapisano
w `timings_seconds` manifestu. Bez `--analysis` dotychczasowy tryb działa
bez zmian; `--analysis` nie można łączyć z `--no-decode`.

Długie zapisy z rozłącznymi kilometrowymi okrążeniami mają również
`distance_blocks`: grupy 5 km, dwie równe części pełnych kilometrów i resztę.
HR/moc są ważone aktywnym czasem okrążeń, mechanika liczbą wspólnych próbek;
pokrycie brakujących HR/mocy jest jawne. Nie są to oficjalne połówki zawodów
ani automatyczny test dryfu. Pełny pakiet zapisuje te same agregaty, które
widzi agent w `--brief`, bez potrzeby dodatkowych skryptów.

Pakiet zachowuje także `fit.additional_metrics` z obliczeniami próbek,
`cloud.suuntoplus_apps` (aplikacje, `summaryOutputs`
i opisy kanałów), `cloud.zone_sense` oraz `cloud.rankings`. Wyniki zbiorcze
SuuntoPlus mogą być również w `fit.session`, a pełne przebiegi, np. Marathon
estimator, i definicje ich jednostek pozostają w `*.decoded.json`. Brakujące
wartości pozostają puste; pakiet nie wylicza automatycznie progów ani dryfu HR.

To jedna bieżąca paczka listy API, nie eksport całej
historii. Gdy wybranych dat w niej nie ma, skrypt zgłasza brak. Nie udaje,
że stara lokalna kopia jest świeżym odczytem. FIT zawiera także dane podczas
pauz; do analizy ruchu należy używać zdarzeń timera i czasów aktywnych okrążeń.

Do wspólnej analizy dołącz odczyt oficjalnego Suunto MCP i połącz rekordy według
`workoutId`/`workoutKey`. Nie sumuj dwóch kopii tej samej aktywności. Pełne dane
z FIT uzupełniają podsumowania Cloud i MCP.

## Prywatna konfiguracja

- `config.example.json`: wersjonowany szablon z placeholderem Client ID.
- `config.json`: lokalny Client ID i callback, bez Client secret, poza Git.
- `.local/credentials.json`: Client secret i klucz subskrypcji Developer API.
- `.local/tokens.json`: access token, refresh token i metadane ważności.
- `.local/auth.lock`: blokada serializująca odświeżanie między procesami.

Pliki autoryzacji mają `0600`, katalog `.local` ma `0700`, a `.gitignore` wyklucza
cały `.local`. To lokalne pliki ograniczone uprawnieniami właściciela, nie
szyfrowany magazyn. Sekretów nie należy kopiować do raportów, pamięci ani logów.
Zmienne `SUUNTO_CLIENT_SECRET` i `SUUNTO_SUBSCRIPTION_KEY` mogą nadpisywać
zapisane wartości dla bieżącego procesu.

Status bez ujawniania kluczy i bez zapytań sieciowych:

```sh
python3 access.py
```

Przy pierwszym uruchomieniu autoryzuj konto przez przeglądarkę:

```sh
python3 oauth.py
```

Skrypt poprosi o Client secret aplikacji i zapisze tokeny lokalnie. Następnie
skonfiguruj oba klucze w interaktywnym terminalu:

```sh
python3 access.py --configure
```

Skrypt pyta o oba klucze na niewidocznym wejściu. Nie wpisuj ich jako argumentów
polecenia. Można też dodać `--configure` do `sync.py`. Sprawdzenie samego
odświeżania OAuth: `python3 access.py --refresh`.

Jeśli Suunto odrzuci refresh token (`invalid_grant`), konieczne jest ponowne
udzielenie dostępu przez przeglądarkę:

```sh
python3 oauth.py
```

`oauth.py` wykorzystuje zapisany Client secret. Opcja `--prompt-secret` pozwala
wpisać nowy sekret; po udanym logowaniu zapisuje go z zachowaniem klucza
subskrypcji. Callback działa na `http://127.0.0.1:8765/callback`, zgodnie z
`config.json` i wpisem w profilu API Zone. Konto API Zone może być inne niż
konto sportowca z aplikacji Suunto. Nie zapisuje się hasła konta Suunto.

## Pozostałe polecenia

```sh
python3 fetch_workouts.py
python3 fetch_track.py --date 2026-01-15
python3 fetch_track.py --input /sciezka/do/trening.fit
python3 analyze_fit.py .local/tracks/RRRR-MM-DD-HHMMSS.decoded.json
python3 -m unittest discover -s tests -v
```

Testy używają danych syntetycznych i mocków; nie wymagają konta Suunto,
poświadczeń ani połączenia z API. Nie zastępują testu integracji z API
i rzeczywistym dekoderem FIT.

`fetch_workouts.py` pobiera samą listę, a `fetch_track.py` również korzysta
z zapisanej autoryzacji i automatycznego odświeżania. Konwersja FIT wymaga
Node.js oraz lokalnego `fit-file-parser`, dostępnego z zainstalowanego
SuuntoPlus Editor. `decode_fit.cjs` zapisuje pełne pomiary. `fit_to_gpx.cjs`
eksportuje istniejące punkty GPS, bez interpolacji.

Przekierowanie pobrania FIT jest ograniczone do HTTPS w domenach Suunto/Azure
Blob, bez przekazywania do adresu pobrania nagłówków OAuth i subskrypcji.
Nieudane odświeżenie lub nieprawidłowa odpowiedź nie nadpisuje działających tokenów.

## Katalogi danych

Kod odczytuje `config.json` i zapisuje `.local/` względem katalogu skryptów.
Raporty powstają w `../reports/`, a wykresy w `../visualizations/`, obok
katalogu repozytorium. Lokalny skill i `TRAINING.md` nie są częścią repozytorium.

Konfiguracja, dane i tokeny nie należą do obrazu aplikacji. Przy uruchamianiu
w kontenerze wymagają osobnych montowań, w tym zapisywalnego miejsca na tokeny
odnawiane przez OAuth. `.dockerignore` przygotowuje wykluczenia danych
prywatnych; repozytorium nie zawiera jeszcze Dockerfile ani konfiguracji Compose.

Oficjalne informacje: [Suunto — How to start](https://apizone.suunto.com/how-to-start),
[Suunto — FAQ](https://apizone.suunto.com/faq).
