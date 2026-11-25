import type { Provider } from '../../shared/providers';
import { useEffect, useState } from 'react';

export type Status = {
  lastSyncedAt: number | null;
  authorized: boolean | null;
  interpretationAvailability: Record<Provider, boolean>;
  timeZone?: string | null;
  jobs: { queued: number; running: number; failed: number };
  trainingWork?: {
    syncPhase: 'idle' | 'listing' | 'analyzing' | 'rate-limit' | 'authorization';
    localPending: number;
    retryAt: number | null;
  };
  error: string | null;
};

export type SyncResult = {
  status: 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  added: number;
  updated: number;
  failed: number;
};

export type JobFailure = {
  id: number;
  kind: 'sync' | 'analyze' | 'interpret';
  provider: Provider;
  error: string | null;
  scheduledAt: number;
  workoutId: string | null;
  sport: string | null;
};

export type Workout = {
  id: string;
  startedAt: number;
  sport: string;
  distanceM: number | null;
  activeSeconds: number | null;
  avgHr: number | null;
  source: 'suunto' | 'fit';
  status: 'queued' | 'running' | 'ready' | 'failed';
  error?: string | null;
};

export type Measurements = Record<string, unknown>;
export type Lap = {
  index: number;
  distanceM: number | null;
  activeSeconds: number | null;
  avgHr: number | null;
} & Measurements;

export type Workouts = { workouts: Workout[]; total: number; sports: string[] };
export type Detail = Workout & {
  metrics: Measurements;
  laps: Lap[];
  observations: string[];
  chart: boolean;
  deviceModel: string | null;
  interpretations: Record<Provider, {
    result: { text: string; createdAt: number; stale: boolean } | null;
    status?: string;
    error?: string | null;
  }>;
};

export type ImportResult = {
  files: { filename: string; status: 'queued' | 'duplicate' | 'failed'; error?: string }[];
  error?: string;
};

type Resource<T> = { data?: T; error?: string; loading: boolean; revision?: number };

const errorLabels: Record<string, string> = {
  'Invalid workout filters.': 'Sprawdź zakres dat i wybrany sport.',
  'This workout was not found.': 'Nie znaleziono tego treningu.',
  'The requested page was not found.': 'Nie znaleziono tej strony.',
  'The upload exceeds the allowed size or number of files.': 'Możesz przesłać do 10 plików FIT po 64 MiB każdy.',
  'The upload limit was reached. Remaining files were skipped.': 'Osiągnięto limit przesyłania. Pozostałe pliki zostały pominięte.',
  'The FIT file exceeds 64 MiB.': 'Plik FIT przekracza limit 64 MiB.',
  'The selected file is not a workout FIT file.': 'Wybrany plik nie jest plikiem treningu FIT.',
  'Choose one or more FIT files.': 'Wybierz co najmniej jeden plik FIT.',
  'A FIT file is unavailable for this activity.': 'Suunto nie udostępniło pliku FIT dla tej aktywności.',
  'The FIT could not be analyzed. Local uploads require one workout session.': 'Nie udało się przeanalizować pliku. Import przyjmuje FIT z jedną sesją.',
  'Suunto rate limit reached. Try again later.': 'Osiągnięto limit Suunto. Spróbuj ponownie później.',
  'Complete Suunto authorization and verify the API subscription.': 'Dokończ autoryzację Suunto i sprawdź subskrypcję API.',
  'Connect Suunto and try synchronizing again.': 'Dokończ autoryzację Suunto i ponów synchronizację.',
  'Suunto authorization or the API subscription needs attention.': 'Sprawdź autoryzację Suunto i subskrypcję API.',
  'Could not reach Suunto.': 'Nie udało się połączyć z Suunto.',
  'Suunto is temporarily unavailable.': 'Suunto jest chwilowo niedostępne.',
  'Suunto is temporarily unreachable.': 'Suunto jest chwilowo niedostępne.',
  'The workout operation could not be completed.': 'Nie udało się zakończyć zadania dla treningu.',
  'The local application could not complete the request.': 'Aplikacja nie mogła wykonać operacji. Spróbuj ponownie.',
  'Enter a valid Claude API key.': 'Wpisz poprawny klucz API Claude.',
  'The Claude key is managed by the worker configuration.': 'Ustawienia klucza Claude są zarządzane przez konfigurację workera.',
  'Claude settings are temporarily unavailable. Try again.': 'Ustawienia Claude są chwilowo niedostępne. Spróbuj ponownie.',
  'Choose an interpretation provider.': 'Wybierz dostawcę interpretacji.',
  'Enter a valid OpenAI API key.': 'Wpisz poprawny klucz API OpenAI.',
  'The OpenAI key is managed by the worker configuration.': 'Ustawienia klucza OpenAI są zarządzane przez konfigurację workera.',
  'OpenAI settings are temporarily unavailable. Try again.': 'Ustawienia OpenAI są chwilowo niedostępne. Spróbuj ponownie.',
  'Invalid workout time zone.': 'Sprawdź strefę czasową.',
  'The request is invalid.': 'Żądanie jest nieprawidłowe.',
  'Local access is required.': 'Otwórz aplikację lokalnie.',
  'This action requires a request from the local app.': 'Wykonaj tę akcję w lokalnej aplikacji.',
  'Analyze this workout before interpreting it.': 'Przeanalizuj trening przed interpretacją.',
  'Configure an interpretation model first.': 'Najpierw skonfiguruj model do interpretacji.',
  'Interpretation could not be generated. Try again later.': 'Nie udało się przygotować interpretacji. Spróbuj ponownie później.',
  'OpenAI API quota is unavailable. Check your API credit balance and spending limits.': 'Brak dostępnego limitu OpenAI API. Sprawdź saldo środków i limity wydatków na platformie OpenAI.',
  'Claude API credit balance is too low. Check billing in Claude Console.': 'Saldo środków Claude API jest za niskie. Sprawdź rozliczenia w Claude Console.',
  'Claude rejected the API key. Check your key in Claude Console and update it in app settings.': 'Claude odrzuciło klucz API. Sprawdź klucz w Claude Console i zaktualizuj go w ustawieniach aplikacji.',
  'The workout analysis changed. Request a new interpretation.': 'Analiza treningu się zmieniła. Zleć nową interpretację.',
  'The previous request was interrupted. Request a new interpretation.': 'Poprzednie zadanie przerwano. Zleć nową interpretację.',
  'Suunto has no FIT file for this workout.': 'Suunto nie udostępniło pliku FIT dla tej aktywności.',
  'This FIT file is unreadable or is not a supported single-session workout.':
    'Plik FIT jest nieczytelny lub nie zawiera obsługiwanej pojedynczej sesji.',
  'The workout job could not finish.': 'Nie udało się zakończyć zadania dla treningu.',
  'The workout could not be analyzed.': 'Nie udało się przeanalizować treningu.',
  'The Python analyzer did not return a result.': 'Analizator nie zwrócił wyniku.',
  'The Python analyzer returned an invalid workout.': 'Analizator zwrócił nieprawidłowe dane treningu.',
  'Suunto returned an invalid activity list.': 'Suunto zwróciło nieprawidłową listę aktywności.',
  'Unexpected upload field.': 'Nieoczekiwane pole w przesyłanych danych.',
  'This workout has been replaced by its matching Suunto activity.': 'Ten trening połączono z odpowiadającą mu aktywnością Suunto.',
  'The workout source is missing.': 'Brakuje danych źródłowych treningu.',
  'The analysis is missing a stored artifact.': 'Brakuje pliku wygenerowanego przez analizę.',
  'Suunto has limited requests. Import will resume automatically.': 'Osiągnięto limit Suunto. Import wznowi się automatycznie.',
};

export const errorLabel = (message: string) => errorLabels[message] ?? message;

export function messageFromError(error: unknown) {
  if (error instanceof TypeError) return 'Nie można połączyć się z lokalną aplikacją. Sprawdź, czy Docker Compose działa.';
  return error instanceof Error ? errorLabel(error.message) : 'Wystąpił błąd. Spróbuj ponownie.';
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = payload?.error?.message ?? payload?.message ?? payload?.error;
    const fallback = response.status === 404 ? 'Nie znaleziono tego treningu.' : 'Nie udało się wykonać operacji.';
    throw new Error(typeof message === 'string' ? message : fallback);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function submit<T>(url: string, body?: FormData) {
  return request<T>(url, { method: 'POST', body, headers: { 'X-Suunto-Request': '1' } });
}

export function submitJson<T>(url: string, values: Record<string, string>) {
  return request<T>(url, {
    method: 'POST',
    body: JSON.stringify(values),
    headers: { 'X-Suunto-Request': '1', 'Content-Type': 'application/json' },
  });
}

export function remove<T>(url: string) {
  return request<T>(url, { method: 'DELETE', headers: { 'X-Suunto-Request': '1' } });
}

export function useResource<T>(url: string | null, revision: number, interval: number): Resource<T> {
  const [snapshot, setSnapshot] = useState<Resource<T> & { url: string }>({ url: '', loading: true });

  useEffect(() => {
    if (!url) return;
    const target = url;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function refresh() {
      try {
        const data = await request<T>(target, { signal: controller.signal });
        if (!controller.signal.aborted) setSnapshot({ url: target, loading: false, data, revision });
      } catch (error) {
        if (!controller.signal.aborted) {
          setSnapshot((previous) => ({
            url: target,
            loading: false,
            revision,
            data: previous.url === target ? previous.data : undefined,
            error: messageFromError(error),
          }));
        }
      } finally {
        if (!controller.signal.aborted && interval > 0) timer = setTimeout(refresh, interval);
      }
    }

    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, revision, interval]);

  return snapshot.url === url ? snapshot : { loading: Boolean(url) };
}
