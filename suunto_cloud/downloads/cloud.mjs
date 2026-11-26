import { localTimestamp } from '../timezones.mjs';
import { isObject } from '../storage/local.mjs';
import { HttpError, jsonResponse, limitedBody, request } from './http.mjs';

const workoutsUrl = 'https://cloudapi.suunto.com/v2/workouts';
const fitUrl = 'https://cloudapi.suunto.com/v3/workouts/';
const pageSize = 50;
const maxPageSize = 1000;
const maxPages = 500;
export const fitMaxBytes = 64 * 1024 * 1024;

function authHeaders(token, subscription, accept) {
  return { Authorization: 'Bearer ' + token, 'Ocp-Apim-Subscription-Key': subscription, Accept: accept };
}

export async function fetchWorkouts(token, subscription, query = {}, fetcher = fetch) {
  const url = new URL(workoutsUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return jsonResponse(await request(url, { headers: authHeaders(token, subscription, 'application/json') }, fetcher));
}

export function workoutRecords(data) {
  if (isObject(data) && data.error != null) {
    throw new TypeError('Cloud API returned an error in JSON; the response was not saved as workouts.');
  }
  const records = isObject(data) ? data.payload : data;
  if (!Array.isArray(records) || !records.every(isObject)) throw new TypeError('Unrecognized workout list response structure.');
  return records;
}

export function dateCutoff(day, zone) {
  const noon = Date.parse(day + 'T00:00:00Z');
  let from = noon - 2 * 86400000;
  let to = noon + 2 * 86400000;
  // Find the beginning of the local calendar day across DST changes.
  while (from < to) {
    const middle = Math.floor((from + to) / 2);
    if (localTimestamp(middle, zone).slice(0, 10) < day) from = middle + 1;
    else to = middle;
  }
  return from;
}

export async function paginatedWorkouts(fetchPage, cutoff = null) {
  const first = await fetchPage({});
  let page = workoutRecords(first);
  let size = pageSize;
  let until = null;
  const seen = new Map();
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const modified = page.map(workout => workout.lastModified);
    if (page.length >= size || until !== null) {
      if (!modified.every((value, index) => Number.isSafeInteger(value) && (!index || value <= modified[index - 1]))) {
        throw new TypeError('Unexpected Cloud API modification times; cannot continue paging safely.');
      }
      if (until !== null && modified.length && modified[0] >= until) {
        throw new TypeError('Cloud API ignored the pagination cursor.');
      }
    }
    for (const workout of page) {
      const key = workout.workoutKey;
      if (typeof key !== 'string' || !key) throw new TypeError('Workout list is missing a workout key.');
      if (!seen.has(key)) seen.set(key, workout);
    }
    const oldest = modified.at(-1);
    if (page.length < size || (cutoff !== null && oldest < cutoff)) {
      return { error: null, payload: [...seen.values()],
        metadata: { ...first.metadata, workoutcount: String(seen.size), pages: pageNumber } };
    }
    const next = oldest + 1; // The API excludes the cursor itself.
    if (next === until) {
      if (size === maxPageSize) throw new TypeError('Workout pagination stalled at one modification time.');
      size = Math.min(size * 2, maxPageSize);
    } else {
      until = next;
      size = pageSize;
    }
    if (pageNumber < maxPages) page = workoutRecords(await fetchPage({ until, limit: size }));
  }
  throw new TypeError('Workout pagination reached its page limit.');
}

export function chooseWorkout(records, selectedDate = null, workoutKey = null, zone = undefined) {
  const matches = workoutKey ? records.filter(row => row.workoutKey === workoutKey) :
    records.filter(row => row.extensionTypes?.includes('LOCATIONSTREAM') &&
      (!selectedDate || localTimestamp(row.startTime, zone).slice(0, 10) === selectedDate));
  if (!matches.length) throw new TypeError('No workout with a GPS track found in the saved list.');
  if ((selectedDate || workoutKey) && matches.length !== 1) {
    throw new TypeError('Multiple workouts found; select a specific --workout-key from workouts.json.');
  }
  const chosen = matches.reduce((latest, row) => row.startTime > latest.startTime ? row : latest);
  if (typeof chosen.workoutKey !== 'string' || !/^[a-fA-F0-9]{24}$/.test(chosen.workoutKey)) {
    throw new TypeError('Invalid workoutKey in the saved API response.');
  }
  return chosen;
}

export async function fetchFit(workoutKey, token, subscription, fetcher = fetch) {
  if (typeof workoutKey !== 'string' || !/^[a-fA-F0-9]{24}$/.test(workoutKey)) {
    throw new TypeError('Invalid workoutKey in the saved API response.');
  }
  let response = await request(fitUrl + workoutKey + '/fit',
    { headers: authHeaders(token, subscription, 'application/octet-stream') }, fetcher);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const target = URL.parse(response.headers.get('location') ?? '');
    await response.body?.cancel();
    if (!target || target.protocol !== 'https:' || target.username || target.password ||
        !(target.hostname.endsWith('.blob.core.windows.net') || target.hostname.endsWith('.suunto.com'))) {
      throw new TypeError('Unsupported FIT download redirect.');
    }
    response = await request(target, { headers: { Accept: 'application/octet-stream' } }, fetcher);
  }
  if (!response.ok) throw new HttpError(response);
  const data = await limitedBody(response, fitMaxBytes + 1);
  if (data.length > fitMaxBytes) throw new TypeError('Response exceeded the 64 MiB limit.');
  if (data.length < 12 || data.toString('ascii', 8, 12) !== '.FIT') {
    throw new TypeError('Suunto did not return a binary FIT file; the response was not saved as a track.');
  }
  return data;
}
