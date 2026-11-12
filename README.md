# Suunto Cloud API — zapisany dostęp i pobieranie danych

Stan zweryfikowany 11.11.2026: zapisane klucze pozwoliły odświeżyć istniejący
OAuth i pobrać listę oraz FIT biegu 10.11 i spaceru 11.11. Po wykonaniu polecenia
w terminalu użytkownika oba FIT poprawnie zdekodowano, a manifest ma `complete=true`.

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

Poniższe przykłady poleceń wykonuj z katalogu nadrzędnego względem `suunto-cloud`.

## Zwykłe pobranie do analizy

Z katalogu projektu:

```sh
python3 suunto-cloud/sync.py --date 2026-11-10 --date 2026-11-11 --analysis --brief
```

Podaj daty aktywności w Europe/Warsaw; `--date` można powtarzać. Polecenie:

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
   `reports/suunto-RRRR-MM-DD-HHMMSS.md` i `.json`; tekst oceny poza blokiem
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

Od 12.11 długie zapisy z rozłącznymi kilometrowymi okrążeniami mają również
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

To jedna bieżąca paczka listy API (obecnie 50 rekordów), nie eksport całej
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
python3 suunto-cloud/access.py
```

Jednorazowa konfiguracja lub poprawienie kluczy w interaktywnym terminalu:

```sh
python3 suunto-cloud/access.py --configure
```

Skrypt pyta o oba klucze na niewidocznym wejściu. Nie wpisuj ich jako argumentów
polecenia. Można też dodać `--configure` do `sync.py`. Sprawdzenie samego
odświeżania OAuth: `python3 suunto-cloud/access.py --refresh`.

Jeśli Suunto odrzuci refresh token (`invalid_grant`), konieczne jest ponowne
udzielenie dostępu przez przeglądarkę:

```sh
python3 suunto-cloud/oauth.py
```

`oauth.py` wykorzystuje zapisany Client secret. Opcja `--prompt-secret` pozwala
wpisać nowy sekret; po udanym logowaniu zapisuje go z zachowaniem klucza
subskrypcji. Callback działa na `http://127.0.0.1:8765/callback`, zgodnie z
`config.json` i wpisem w profilu API Zone. Konto API Zone może być inne niż
konto sportowca z aplikacji Suunto. Nie zapisuje się hasła konta Suunto.

## Pozostałe polecenia

```sh
python3 suunto-cloud/fetch_workouts.py
python3 suunto-cloud/fetch_track.py --date 2026-11-10
python3 suunto-cloud/fetch_track.py --input /sciezka/do/trening.fit
python3 suunto-cloud/analyze_fit.py suunto-cloud/.local/tracks/2026-11-10-181609.decoded.json
python3 -m unittest discover -s suunto-cloud/tests -v
```

`fetch_workouts.py` pobiera samą listę, a `fetch_track.py` również korzysta
z zapisanej autoryzacji i automatycznego odświeżania. Konwersja FIT wymaga
Node.js oraz lokalnego `fit-file-parser`, dostępnego z zainstalowanego
SuuntoPlus Editor. `decode_fit.cjs` zapisuje pełne pomiary. `fit_to_gpx.cjs`
eksportuje istniejące punkty GPS, bez interpolacji.

Przekierowanie pobrania FIT jest ograniczone do HTTPS w domenach Suunto/Azure
Blob, bez przekazywania do adresu pobrania nagłówków OAuth i subskrypcji.
Nieudane odświeżenie lub nieprawidłowa odpowiedź nie nadpisuje działających tokenów.

## Ograniczenie środowiska agenta

11.11 bezpośrednie żądania sieciowe agenta nadal zatrzymywały się na DNS,
a host dostępu przeglądarkowego był niedostępny. Ten sam skrypt działał
w zwykłym terminalu użytkownika. Zapisanie kluczy i automatyczne odświeżanie
nie usuwa tego ograniczenia środowiska. Użytkownik upoważnił agenta do
uruchomienia powyższego polecenia w jego zwykłej konsoli, jeśli jest dostępne
narzędzie i pozwalają na to uprawnienia środowiska. Dopiero gdy agent nie może
tego wykonać, potrzebne jest uruchomienie przez użytkownika. Kluczy nie trzeba
ponownie podawać. Agent następnie odczytuje lokalne pliki i łączy je z MCP.

Oficjalne informacje: [Suunto — How to start](https://apizone.suunto.com/how-to-start),
[Suunto — FAQ](https://apizone.suunto.com/faq).


## Reguła Codex i forma polecenia — zweryfikowano 12.11.2026

W lokalnym Codex istnieje wąska reguła allow dla prefiksu python3 i pełnej ścieżki sync.py. Aby z niej skorzystać, uruchamiaj bezpośrednio:

```sh
python3 /Users/mkrzyzanowski/Projects/suunto/suunto-cloud/sync.py --date 2026-11-10 --analysis
```

Nie dodawaj do tego wywołania przekierowań powłoki (`>`, `2>`), potoków, zmiennych ani wrappera `zsh -lc`. W teście 12.11 bezpośrednia komenda miała decyzję allow; wersja z przekierowaniami była traktowana jako cała komenda powłoki i nie pasowała do reguły. Uruchomienie prostej komendy z domyślnymi uprawnieniami zakończyło się sukcesem. Wynik jest już zapisywany w `.local/analysis.json`, więc przekierowanie stdout nie jest potrzebne. Parametry daty można zmieniać i powtarzać zgodnie z zakresem analizy.

Przy granular.sandbox_approval=false jawny request require_escalated jest automatycznie odrzucany, zanim trafi do recenzenta Auto-review. Nie zmieniaj tej polityki, aby naprawiać niepasującą formę komendy; stosuj istniejące, zatwierdzone wywołanie. Nie rozszerzaj reguły na całą powłokę ani dowolne skrypty Python. Brak sieci przy innej formie wywołania nie dowodzi awarii DNS ani błędnych kluczy Suunto.
