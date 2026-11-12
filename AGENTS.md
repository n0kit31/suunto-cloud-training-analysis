# Repozytorium i dane prywatne

- Prywatne repozytorium GitHub obejmuje ten katalog (`suunto-cloud`).
- Dla commitów w tym repozytorium używaj adresu `marcin@it-krzyzanowski.pl`
  ustawionego lokalnie w Git (`user.email`); zachowaj globalne ustawienia Git.
- Nie dodawaj do Git ani nie wysyłaj żadnych rzeczywistych kluczy, sekretów,
  access tokenów, refresh tokenów ani nagłówków autoryzacji. Dotyczy to również
  dokumentacji, przykładów, testów, logów i obrazów Dockera.
- W przykładach używaj wyłącznie jednoznacznych placeholderów lub danych
  syntetycznych. `config.example.json` jest szablonem; rzeczywisty `config.json`
  oraz cały `.local/` pozostają lokalne i są ignorowane przez Git.
- Zachowuj istniejącą konfigurację i tokeny. Nie zastępuj ich placeholderami.
- FIT-y, GPX-y, raporty oraz osobisty kontekst `TRAINING*.md` pozostają poza repo.
- Przed commitem lub pushem sprawdź pliki przeznaczone do wysłania pod kątem
  sekretów. Nie wypisuj znalezionych wartości w terminalu ani w odpowiedzi.
- `.gitignore` i `.dockerignore` muszą wykluczać dane prywatne. Nie obchodź tych
  reguł przez `git add -f` ani kopiowanie sekretów do innej lokalizacji w repo.

# Struktura kodu

- Kod aplikacji jest w `suunto_cloud/`, podzielony według odpowiedzialności;
  testy w `tests/` odzwierciedlają te same obszary.
- Obliczenia w `analysis/fit.py`, `analysis/metrics.py` i `analysis/packet.py`
  pozostają niezależne od sieci, poświadczeń i zapisu plików.
- Polecenia uruchamiaj przez `python3 -m suunto_cloud <polecenie>` z katalogu
  repozytorium. Rootowy `sync.py` zachowuje zgodność z istniejącym workflow.
- Konfiguracja i `.local/` nadal znajdują się w katalogu repozytorium;
  nie przenoś ich wraz z modułami ani nie twórz kopii poświadczeń.

# Docker

- Dockerfile kopiuje wyłącznie kod, metadane zależności i licencję; konfiguracja
  oraz `.local/` są montowane przy uruchomieniu i nie należą do obrazu.
- Compose uruchamia CLI jako użytkownik hosta wskazany przez `SUUNTO_UID` oraz
  `SUUNTO_GID`; przed pracą z istniejącymi plikami ustaw je z `id -u` i `id -g`.
- Callback OAuth kontenera może słuchać na `0.0.0.0` tylko przy publikacji portu
  na loopback hosta. Domyślne uruchomienie poza kontenerem pozostaje na loopback.
- Etap `test` Dockerfile uruchamia testy offline; końcowy etap `app` nie zawiera
  katalogu testów. Nie deklaruj udanego buildu bez jego faktycznej weryfikacji.
