import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Language } from '../../shared/language';
export type { Language } from '../../shared/language';

type Values = Record<string, string | number>;
export type Translate = (message: string, values?: Values) => string;
const preference = 'suunto-web-language';

const english: Record<string, string> = {
  'Lista aktywności': 'Activity List',
  'Aktywności': 'Activities',
  'Aktywność': 'Activity',
  'Język interfejsu': 'Interface language',
  'Brak połączenia z aplikacją': 'App unavailable',
  'Suunto połączone': 'Suunto connected',
  'Połącz z Suunto': 'Connect Suunto',
  'Sprawdzanie połączenia': 'Checking connection',
  'Ustawienia aplikacji': 'App settings',
  'Sekcje ustawień': 'Settings sections',
  'Ustawienia {provider}': '{provider} settings',
  'Stan biblioteki': 'Library status',
  'Pasujące treningi': 'Matching activities',
  'Treningi w bibliotece': 'Activities in library',
  'Ostatnia synchronizacja': 'Last sync',
  'Zadania w kolejce lub w toku': 'Queued or running tasks',
  'Błędy: {count}': 'Errors: {count}',
  'Błędy zadań': 'Job errors',
  'Wczytywanie błędów…': 'Loading errors…',
  'Brak błędów zadań.': 'No job errors.',
  'Synchronizacja Suunto': 'Suunto sync',
  'Wynik ostatniej synchronizacji': 'Last sync result',
  'Analiza treningu': 'Activity analysis',
  'Usuń błąd': 'Remove error',
  'Wyczyść listę błędów': 'Clear errors',
  'Zamknij': 'Close',
  'Dystans': 'Distance',
  'Czas aktywny': 'Active time',
  'Śr. tętno': 'Avg HR',
  'Filtry treningów': 'Activity filters',
  'Sport': 'Sport',
  'Wszystkie sporty': 'All sports',
  'Od': 'From',
  'Do': 'To',
  'Wyczyść': 'Clear',
  'Wyczyść filtry': 'Clear filters',
  'Dodano do kolejki': 'Queued',
  'Już w bibliotece': 'Already in library',
  'Import nie powiódł się': 'Import failed',
  'Pobierz nowe treningi': 'Fetch new activities',
  'Uruchamianie synchronizacji…': 'Starting sync…',
  'Pobieranie z Suunto…': 'Fetching from Suunto…',
  'Analizowanie treningów…': 'Analyzing activities…',
  'Oczekiwanie na limit Suunto': 'Waiting for Suunto rate limit',
  'Uruchomiono synchronizację z Suunto.': 'Suunto sync started.',
  'Synchronizacja z Suunto już trwa.': 'Suunto sync is already running.',
  'Pliki dodane do analizy ({count}).': 'Files queued for analysis ({count}).',
  'Wybrane pliki nie zostały dodane.': 'The selected files could not be added.',
  'Wybrane pliki są już w bibliotece.': 'The selected files are already in your library.',
  'Przejdź do treści': 'Skip to content',
  'Wróć do listy treningów': 'Back to activity list',
  'Szczegóły treningu': 'Activity details',
  'Wczytywanie treningu…': 'Loading activity…',
  'Odśwież': 'Refresh',
  'Dodano trening do ponownej analizy.': 'Activity queued for reanalysis.',
  'Dodano interpretację do kolejki.': 'Interpretation queued.',
  'Wysyłanie plików…': 'Uploading files…',
  'Importuj FIT': 'Import FIT',
  'Treningi pojawią się na liście w miarę zapisywania.': 'Activities will appear as they are saved.',
  'Synchronizacja wznowi się po {date}.': 'Sync will resume after {date}.',
  'Analizowanie zaimportowanych plików FIT…': 'Analyzing imported FIT files…',
  'Zapisz dane API w ustawieniach Suunto i dokończ logowanie OAuth. Pierwszy import rozpocznie się automatycznie.':
    'Save your API credentials in Suunto settings and complete OAuth sign-in. The first import starts automatically.',
  'Wczytywanie biblioteki…': 'Loading library…',
  'Biblioteka jest niedostępna': 'Library unavailable',
  'Brak treningów dla tych filtrów': 'No activities match these filters',
  'Import w toku': 'Import in progress',
  'Biblioteka jest pusta': 'Your library is empty',
  'Treningi pojawią się po pobraniu metadanych.': 'Activities will appear after their details are downloaded.',
  'Pobierz treningi z Suunto albo wybierz pliki FIT z dysku.': 'Fetch activities from Suunto or choose FIT files from disk.',
  'Strony treningów': 'Activity pages',
  '{start}–{end} z {total}': '{start}–{end} of {total}',
  'Liczba wyników: {total}': 'Results: {total}',
  'Poprzednia strona': 'Previous page',
  'Następna strona': 'Next page',
  'Poprzednia': 'Previous',
  'Następna': 'Next',
  'W kolejce': 'Queued',
  'Analizowanie': 'Analyzing',
  'Gotowe': 'Ready',
  'Błąd analizy': 'Analysis failed',
  'Plik FIT': 'FIT file',
  'Maksymalne tętno': 'Maximum heart rate',
  'Suma podejść': 'Total ascent',
  'Suma zejść': 'Total descent',
  'Czas całkowity': 'Elapsed time',
  'Czas pauz': 'Paused time',
  'Średnia moc': 'Average power',
  'Maksymalna moc': 'Maximum power',
  'Energia': 'Energy',
  'Temperatura': 'Temperature',
  'Obciążenie (hrTSS)': 'Training load (hrTSS)',
  'Czas regeneracji': 'Recovery time',
  'Tempo': 'Pace',
  'Maks. tętno': 'Max HR',
  'Śr. moc': 'Avg power',
  'Podejścia': 'Ascent',
  'Okrążenia': 'Laps',
  'Tabela okrążeń': 'Lap table',
  'Okrążenie': 'Lap',
  'Interpretacja': 'Interpretation',
  'Interpretacja w toku…': 'Generating interpretation…',
  'Ponów interpretację': 'Retry interpretation',
  'Zaktualizuj interpretację': 'Update interpretation',
  'Wygeneruj ponownie': 'Generate again',
  'Zinterpretuj trening': 'Interpret activity',
  'Opis pojawi się po zakończeniu zadania.': 'The interpretation will appear when it is ready.',
  'Nie udało się przygotować interpretacji.': 'Could not generate the interpretation.',
  'Poprzednia wersja analizy': 'Previous analysis version',
  'Po kliknięciu wybrane metryki i okrążenia trafią do {provider}. Plik FIT, GPS i dane konta pozostaną lokalnie.':
    'Generating an interpretation sends selected measurements and laps to {provider}. The FIT file, GPS, and account data stay local.',
  'Dodaj klucz API {provider}, aby generować interpretacje treningów.':
    'Add a {provider} API key to generate activity interpretations.',
  'Średnie tętno': 'Average heart rate',
  'Średnie tempo': 'Average pace',
  'Średnia kadencja': 'Average cadence',
  'ud./min': 'bpm',
  'obr./min': 'rpm',
  'kroków/min': 'steps/min',
  'Podstawowe metryki': 'Key metrics',
  'Trening czeka na analizę': 'Activity queued for analysis',
  'Analiza jest w toku': 'Analysis in progress',
  'Wyniki zaktualizują się po zakończeniu pracy.': 'Results will update when analysis is complete.',
  'Nie udało się przeanalizować treningu': 'Could not analyze the activity',
  'Zlecanie analizy…': 'Queueing analysis…',
  'Ponów analizę': 'Retry analysis',
  'Wykresy': 'Charts',
  'Interaktywne wykresy treningu': 'Interactive activity charts',
  'W danych tej aktywności brakuje pomiarów do wyświetlenia wykresów.': 'This activity has no measurements to plot.',
  'Pomiary i obserwacje': 'Measurements and observations',
  'Zapisano ustawienia Suunto.': 'Suunto settings saved.',
  'Klucz API {provider}': '{provider} API key',
  'Utwórz klucz w {provider}': 'Create a key on {provider}',
  'Tworząc klucz Claude, przypisz go do jednego obszaru roboczego.': 'When creating a Claude key, scope it to one workspace.',
  'Zapisano klucz API {provider}.': '{provider} API key saved.',
  'Usuń zapisany klucz': 'Remove saved key',
  'Usuwanie klucza API': 'API key removal',
  'Usunąć zapisany klucz API {provider} z aplikacji?': 'Remove the saved {provider} API key from the app?',
  'Usuń klucz': 'Remove key',
  'Anuluj': 'Cancel',
  'Usunięto klucz API {provider} z aplikacji.': '{provider} API key removed from the app.',
  'Wpisz poprawny klucz API OpenAI.': 'Enter a valid OpenAI API key.',
  'Klucz API {provider} jest ustawiony w konfiguracji workera.': 'The {provider} key is set in the worker configuration.',
  'Klucz API {provider} ustawia się w konfiguracji workera.': 'Set the {provider} API key in the worker configuration.',
  'Wpisz poprawny klucz API Claude.': 'Enter a valid Claude API key.',
  'Ustawienia klucza Claude są zarządzane przez konfigurację workera.': 'The Claude key is managed by the worker configuration.',
  'Ustawienia Claude są chwilowo niedostępne. Spróbuj ponownie.': 'Claude settings are temporarily unavailable. Try again.',
  'Wybierz dostawcę interpretacji.': 'Choose an interpretation provider.',
  'Ustawienia klucza OpenAI są zarządzane przez konfigurację workera.': 'The OpenAI key is managed by the worker configuration.',
  'Ustawienia OpenAI są chwilowo niedostępne. Spróbuj ponownie.': 'OpenAI settings are temporarily unavailable. Try again.',
  'Zamknij ustawienia': 'Close settings',
  'Wczytywanie ustawień…': 'Loading settings…',
  'Ponów': 'Try again',
  'Klucz subskrypcji Developer API': 'Developer API subscription key',
  'Zapisany · wpisz, aby zmienić': 'Saved · enter to change',
  'Zapisywanie…': 'Saving…',
  'Zapisz': 'Save',
  'Aby zalogować się na konto Suunto, uruchom polecenie OAuth w terminalu.': 'Run the OAuth command in the terminal to sign in to Suunto.',
  'Adres przekierowania w API Zone to': 'The redirect URL in API Zone is',
  'Sprawdź identyfikator, sekret i klucz subskrypcji Suunto.': 'Check the Suunto client ID, secret, and subscription key.',
  'Ustawienia Suunto są chwilowo niedostępne. Spróbuj ponownie.': 'Suunto settings are temporarily unavailable. Try again.',
  'Nie znaleziono tej synchronizacji.': 'This sync was not found.',
  'Dodano {added}, zaktualizowano {updated}.': 'Added {added}, updated {updated}.',
  'Synchronizacja z Suunto nie powiodła się.': 'Suunto sync failed.',
  'Nie udało się przeanalizować wszystkich treningów. Liczba błędów ({count}).': 'Some activities could not be analyzed ({count} failed).',
  'Synchronizacja zakończona.': 'Sync complete.',
  'Synchronizacja zakończona. Brak nowych lub zmienionych treningów.': 'Sync complete. No new or updated activities.',
  'Zamknij powiadomienie': 'Dismiss notification',
  'Nie można połączyć się z lokalną aplikacją. Sprawdź, czy Docker Compose działa.':
    'Cannot connect to the local app. Check that Docker Compose is running.',
  'Wystąpił błąd. Spróbuj ponownie.': 'Something went wrong. Try again.',
  'Nie udało się wykonać operacji.': 'The operation could not be completed.',
  'Sprawdź zakres dat i wybrany sport.': 'Check the date range and selected sport.',
  'Nie znaleziono tego treningu.': 'This activity was not found.',
  'Nie znaleziono tej strony.': 'This page was not found.',
  'Możesz przesłać do 10 plików FIT po 64 MiB każdy.': 'You can upload up to 10 FIT files of 64 MiB each.',
  'Osiągnięto limit przesyłania. Pozostałe pliki zostały pominięte.': 'The upload limit was reached. Remaining files were skipped.',
  'Plik FIT przekracza limit 64 MiB.': 'The FIT file exceeds 64 MiB.',
  'Wybrany plik nie jest plikiem treningu FIT.': 'The selected file is not an activity FIT file.',
  'Wybierz co najmniej jeden plik FIT.': 'Choose one or more FIT files.',
  'Suunto nie udostępniło pliku FIT dla tej aktywności.': 'Suunto has no FIT file for this activity.',
  'Nie udało się przeanalizować pliku. Import przyjmuje FIT z jedną sesją.': 'The FIT could not be analyzed. Uploads require one workout session.',
  'Osiągnięto limit Suunto. Spróbuj ponownie później.': 'Suunto rate limit reached. Try again later.',
  'Dokończ autoryzację Suunto i sprawdź subskrypcję API.': 'Complete Suunto authorization and check your API subscription.',
  'Dokończ autoryzację Suunto i ponów synchronizację.': 'Complete Suunto authorization and try syncing again.',
  'Sprawdź autoryzację Suunto i subskrypcję API.': 'Check your Suunto authorization and API subscription.',
  'Nie udało się połączyć z Suunto.': 'Could not reach Suunto.',
  'Suunto jest chwilowo niedostępne.': 'Suunto is temporarily unavailable.',
  'Nie udało się zakończyć zadania dla treningu.': 'The activity task could not be completed.',
  'Aplikacja nie mogła wykonać operacji. Spróbuj ponownie.': 'The local app could not complete the request. Try again.',
  'Sprawdź strefę czasową.': 'Check the time zone.',
  'Żądanie jest nieprawidłowe.': 'The request is invalid.',
  'Otwórz aplikację lokalnie.': 'Local access is required.',
  'Wykonaj tę akcję w lokalnej aplikacji.': 'Perform this action in the local app.',
  'Przeanalizuj trening przed interpretacją.': 'Analyze the activity before interpreting it.',
  'Najpierw skonfiguruj model do interpretacji.': 'Configure an interpretation model first.',
  'Nie udało się przygotować interpretacji. Spróbuj ponownie później.': 'Could not generate the interpretation. Try again later.',
  'Brak dostępnego limitu OpenAI API. Sprawdź saldo środków i limity wydatków na platformie OpenAI.':
    'OpenAI API quota is unavailable. Check your API credit balance and spending limits.',
  'OpenAI odrzuciło klucz API. Sprawdź klucz na platformie OpenAI i zaktualizuj go w ustawieniach aplikacji.':
    'OpenAI rejected the API key. Check your key in OpenAI Platform and update it in app settings.',
  'Saldo środków Claude API jest za niskie. Sprawdź rozliczenia w Claude Console.':
    'Claude API credit balance is too low. Check billing in Claude Console.',
  'Claude odrzuciło klucz API. Sprawdź klucz w Claude Console i zaktualizuj go w ustawieniach aplikacji.':
    'Claude rejected the API key. Check your key in Claude Console and update it in app settings.',
  'Analiza treningu się zmieniła. Zleć nową interpretację.': 'The analysis changed. Request a new interpretation.',
  'Poprzednie zadanie przerwano. Zleć nową interpretację.': 'The previous request was interrupted. Request a new interpretation.',
  'Plik FIT jest nieczytelny lub nie zawiera obsługiwanej pojedynczej sesji.':
    'The FIT file is unreadable or does not contain a supported single session.',
  'Nie udało się przeanalizować treningu.': 'Could not analyze the activity.',
  'Analizator nie zwrócił wyniku.': 'The analyzer did not return a result.',
  'Analizator zwrócił nieprawidłowe dane treningu.': 'The analyzer returned invalid activity data.',
  'Suunto zwróciło nieprawidłową listę aktywności.': 'Suunto returned an invalid activity list.',
  'Nieoczekiwane pole w przesyłanych danych.': 'Unexpected upload field.',
  'Ten trening połączono z odpowiadającą mu aktywnością Suunto.': 'This activity was merged with its matching Suunto activity.',
  'Brakuje danych źródłowych treningu.': 'The activity source is missing.',
  'Brakuje pliku wygenerowanego przez analizę.': 'An output file from the analysis is missing.',
  'Osiągnięto limit Suunto. Import wznowi się automatycznie.': 'Suunto rate limit reached. Import will resume automatically.',
};

function storedLanguage(): Language {
  try {
    return localStorage.getItem(preference) === 'pl' ? 'pl' : 'en';
  } catch {
    return 'en';
  }
}

type LanguageState = { language: Language; setLanguage: (language: Language) => void; t: Translate };
const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(storedLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(preference, language);
    } catch {
      // The current page still switches language if browser storage is unavailable.
    }
  }, [language]);

  const value = useMemo<LanguageState>(() => ({
    language, setLanguage,
    t: (message, values) => {
      const translated = language === 'en' && Object.hasOwn(english, message) ? english[message] : message;
      return values ? translated.replace(/\{(\w+)\}/g, (key, name) => String(values[name] ?? key)) : translated;
    },
  }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const state = useContext(LanguageContext);
  if (!state) throw new Error('The language provider is missing.');
  return state;
}
