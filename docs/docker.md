# Docker

Obraz zawiera Python 3.13, Node.js 24 i zależności dekodera FIT. Na hoście
wystarczy Docker Desktop lub Docker Engine z Compose; Python i Node.js nie są
potrzebne. Kontener udostępnia te same polecenia CLI co uruchomienie lokalne.

## Przygotowanie

W katalogu repozytorium:

```sh
export SUUNTO_UID="$(id -u)" SUUNTO_GID="$(id -g)"
mkdir -p .local ../reports ../visualizations
cp -n config.example.json config.json
```

Jeśli konfiguracja już istnieje, zostanie zachowana. W nowym `config.json`
uzupełnij `client_id` aplikacji z Suunto API Zone. Callback powinien pozostać
`http://127.0.0.1:8765/callback` i odpowiadać ustawieniom aplikacji w API Zone.

Zmienne UID/GID ustawiaj w każdej nowej sesji terminala przed uruchamianiem
Compose. Dzięki temu kontener ma dostęp do prywatnych plików użytkownika i
zapisuje wyniki z właściwym właścicielem. Domyślne UID/GID obrazu to `1000:1000`.

## Budowanie i użycie

```sh
docker compose build
docker compose run --rm suunto --help
docker compose run --rm suunto sync --date 2026-01-15 --analysis --brief
```

Zastąp przykładową datę dniem swojej aktywności; `--date` można powtarzać.
Dla wykresów dodaj `--charts`. Obraz ma lokalny tag
`suunto-cloud-training-analysis:local`; budowanie nie publikuje go w rejestrze.

## Autoryzacja

Jeśli projekt ma już zapisane `credentials.json` i `tokens.json` w `.local/`,
kontener korzysta z nich i automatycznie odnawia tokeny. Pierwsze logowanie
można w całości przeprowadzić w kontenerze:

```sh
docker compose run --rm --service-ports suunto oauth
docker compose run --rm suunto access --configure
```

Otwórz wydrukowany link na komputerze z Dockerem i zaloguj się do konta Suunto.
Klucze wpisujesz interaktywnie na niewidocznym wejściu. Zostają zapisane
w lokalnym `.local/`.

Opcja `--service-ports` publikuje callback wyłącznie na `127.0.0.1:8765` hosta.
Wewnątrz kontenera serwer nasłuchuje na `0.0.0.0`, aby przekierowanie portu
działało; kontrola adresu callback, nagłówka Host i OAuth state pozostaje aktywna.
Pozostałe polecenia nie wymagają publikowania portów.

Status bez wypisywania kluczy:

```sh
docker compose run --rm suunto access
```

Po odrzuceniu refresh tokenu ponów polecenie `oauth` z `--service-ports`.

## Dane i poświadczenia

| Ścieżka hosta | Ścieżka kontenera | Dostęp |
| --- | --- | --- |
| `config.json` | `/app/suunto-cloud/config.json` | Odczyt |
| `.local/` | `/app/suunto-cloud/.local/` | Odczyt i zapis |
| `../reports/` | `/app/reports/` | Odczyt i zapis |
| `../visualizations/` | `/app/visualizations/` | Odczyt i zapis |

Usunięcie kontenera przez `--rm` zachowuje dane na hoście. Ścieżki zapisane
w manifestach i JSON-ach wskazują lokalizacje kontenera; tabela pokazuje ich
odpowiedniki na hoście.

Dockerfile kopiuje wyłącznie kod, zależności i licencję. `.dockerignore`
wyklucza lokalną konfigurację, `.local/`, `.env`, `.npmrc`, klucze i dane
treningowe z kontekstu budowania. Compose uruchamia CLI bez uprawnień roota,
z systemem plików obrazu tylko do odczytu i osobnymi montowaniami danych.

Oficjalny Suunto MCP pozostaje zewnętrzną integracją agenta. Obraz obsługuje
bezpośrednie Cloud API i FIT; nie przejmuje autoryzacji MCP z aplikacji hosta.

## Helper projektu

Helper `../skills/suunto-training-analysis/scripts/run-docker.sh` ustawia UID/GID
i katalog Compose. Polecenie `build` przebudowuje obraz aplikacji po zmianie
kodu. Polecenie `charts` odtwarza wykres z istniejącego raportu i próbek FIT,
bez ponownego pobierania danych:

```sh
sh ../skills/suunto-training-analysis/scripts/run-docker.sh build
sh ../skills/suunto-training-analysis/scripts/run-docker.sh charts /app/reports/suunto-2026-01-15-080000.json
```

## Weryfikacja obrazu

```sh
sh scripts/docker/test-image.sh
```

Skrypt buduje etap `test` z testami offline, następnie obraz aplikacji,
sprawdza CLI bez sieci i potwierdza brak konfiguracji oraz danych prywatnych
w obrazie. Nie korzysta z Twoich poświadczeń ani z API Suunto.
