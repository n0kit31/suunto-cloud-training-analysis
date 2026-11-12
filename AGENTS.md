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
