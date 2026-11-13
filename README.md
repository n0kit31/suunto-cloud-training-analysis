# Suunto Cloud Training Analysis

Narzędzie CLI do pobierania danych z Suunto Cloud API i analizy plików FIT.
Obsługuje OAuth z automatycznym odświeżaniem tokenów, eksport GPX oraz raporty
JSON i Markdown z międzyczasami, tętnem, tempem, pauzami i mechaniką biegu.
Wykresy SVG są opcjonalne.

Dane z oficjalnego Suunto MCP można dołączyć przez zewnętrzną integrację.
Obecne skrypty pobierają dane z Cloud API; repozytorium nie zawiera klienta MCP.

## Struktura

Kod w `suunto_cloud/` jest podzielony według odpowiedzialności:

| Katalog | Odpowiedzialność |
| --- | --- |
| `authentication/` | OAuth, klucze i autoryzacja zapytań |
| `downloads/` | Pobieranie podsumowań treningów i plików FIT |
| `analysis/` | Obliczenia metryk i przygotowanie pakietu analizy |
| `reporting/` | Raporty Markdown/JSON i wykresy SVG |
| `synchronization/` | Koordynacja pobierania, analizy i raportowania |
| `storage/` | Ścieżki konfiguracji i bezpieczny zapis lokalny |
| `fit/` | Dekoder FIT i eksport GPX w Node.js |

Testy w `tests/` odzwierciedlają ten podział. Obliczenia są niezależne od API
i zapisu plików. Polecenia obsługuje `suunto_cloud/cli.py`.

## Wymagania

Dla uruchomienia lokalnego:

- Python 3.9+ na macOS lub Linuksie, z dostępną strefą `Europe/Warsaw`.
- Node.js i pakiet `fit-file-parser` do dekodowania FIT.
- Aplikacja OAuth oraz subskrypcja Developer API w [Suunto API Zone](https://apizone.suunto.com/how-to-start).

## Konfiguracja

Polecenia wykonuj w katalogu repozytorium. Zainstaluj zależności dekodera FIT
i utwórz lokalną konfigurację:

```sh
npm ci --ignore-scripts --no-audit --no-fund
cp -n config.example.json config.json
```

Wpisz swój `client_id` i sprawdź `redirect_uri` w `config.json`.
Domyślny callback to `http://127.0.0.1:8765/callback`; musi odpowiadać ustawieniom
aplikacji w API Zone. Następnie autoryzuj konto i skonfiguruj klucze:

```sh
python3 -m suunto_cloud oauth
python3 -m suunto_cloud access --configure
```

Klucze podawaj na interaktywnym, niewidocznym wejściu. Lokalna konfiguracja,
tokeny i pobrane dane są wykluczone z Git oraz kontekstu budowania Dockera.

## Użycie

Pobierz i przeanalizuj treningi z wybranego dnia:

```sh
python3 -m suunto_cloud sync --date 2026-01-15 --analysis --brief
```

Daty dotyczą strefy `Europe/Warsaw`; `--date` można powtarzać.
Dodaj `--charts`, aby wygenerować wykres. Surowe dane i analizy są w `.local/`,
raporty w `../reports/`, a wykresy w `../visualizations/`.
Wykresy korzystają z czasu aktywnego treningu: pauzy są wycięte z osi i nie
mają osobnych oznaczeń. Braki pomiarów tempa i wysokości pozostają przerwami w linii.
Linię tętna wygładza wyśrodkowana średnia krocząca 15 s z dostępnych próbek,
liczona osobno dla ciągłych odcinków pomiaru. Luki w tętnie łączone są liniowo
wyłącznie na wykresie, dzięki czemu krzywa jest ciągła. Statystyki HR pochodzą
z danych źródłowych.
Obecna wersja pobiera jedną stronę listy treningów, bez eksportu całej historii.

Istniejący wykres można odtworzyć bez ponownego pobierania danych:

```sh
python3 -m suunto_cloud charts ../reports/suunto-2026-01-15-080000.json
```

Pozostałe polecenia: `workouts`, `track`, `analyze` i `access`.
Pomoc: `python3 -m suunto_cloud --help` lub `python3 -m suunto_cloud sync --help`.
Dotychczasowe `python3 sync.py ...` nadal działa przez mały wrapper zgodności.

## Docker

Dockerfile zawiera środowisko Python/Node.js oraz zależności dekodera FIT.
Compose montuje konfigurację i dane poza obrazem. Przygotowanie katalogów,
UID/GID i autoryzacji opisuje [instrukcja Docker](docs/docker.md).

```sh
docker compose build
docker compose run --rm suunto sync --date 2026-01-15 --analysis --brief
```

## Testy

```sh
python3 -m unittest discover -s tests -t . -v
```

Testy korzystają z danych syntetycznych i nie wymagają połączenia z API.

## Licencja

Copyright (C) 2026 Marcin Krzyżanowski.

Kod projektu jest udostępniany na licencji **GNU GPL v3 lub nowszej**
(`GPL-3.0-or-later`). Pełny tekst znajduje się w pliku [LICENSE](LICENSE).
