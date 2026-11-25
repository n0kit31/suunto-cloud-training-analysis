import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Language } from '../shared/language.ts';
import type { Provider } from '../shared/providers.ts';
import type { Analysis, CloudIndex, Fields } from './contracts.ts';

export const dataDirectory = resolve(process.env.SUUNTO_WEB_DATA || '/data');
export const uploadDirectory = join(dataDirectory, 'uploads');
export const artifactDirectory = join(dataDirectory, 'artifacts');
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function isId(value: string) {
  return idPattern.test(value);
}

type Kind = 'sync' | 'analyze' | 'interpret';
type JobState = 'queued' | 'running' | 'done' | 'failed' | 'superseded';

export interface Job {
  id: number;
  kind: Kind;
  workout_id: string | null;
  status: JobState;
  cloud: number;
  attempts: number;
  lease: string;
  analysis_version: number | null;
  language: Language;
  provider: Provider;
}

export interface WorkoutRow {
  id: string;
  alias_of: string | null;
  source: 'suunto' | 'fit';
  source_key: string | null;
  started_at: number;
  sport: string;
  distance_m: number | null;
  active_seconds: number | null;
  avg_hr: number | null;
  modified_at: number | null;
  cloud_json: string | null;
  upload_id: string | null;
  fit_sha: string | null;
  status: 'queued' | 'running' | 'ready' | 'failed';
  error: string | null;
  result_json: string | null;
  artifact_id: string | null;
  device_model: string | null;
  analysis_version: number;
}

export function workoutSummary(row: WorkoutRow) {
  return {
    id: row.id, startedAt: row.started_at, sport: row.sport, distanceM: row.distance_m,
    activeSeconds: row.active_seconds, avgHr: row.avg_hr, source: row.source, status: row.status,
    error: row.error,
  };
}

const schema = `
  CREATE TABLE IF NOT EXISTS settings (
    name TEXT PRIMARY KEY, value TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY,
    alias_of TEXT REFERENCES workouts(id),
    source TEXT NOT NULL CHECK (source IN ('suunto', 'fit')),
    source_key TEXT UNIQUE,
    started_at INTEGER NOT NULL,
    sport TEXT NOT NULL,
    distance_m REAL,
    active_seconds REAL,
    avg_hr REAL,
    modified_at INTEGER,
    cloud_json TEXT,
    upload_id TEXT,
    local_hash TEXT UNIQUE,
    fit_sha TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
    error TEXT,
    result_json TEXT,
    artifact_id TEXT,
    analysis_version INTEGER NOT NULL DEFAULT 0,
    interpretation TEXT,
    interpreted_at INTEGER,
    interpreted_version INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workouts_started
    ON workouts(started_at DESC, id) WHERE alias_of IS NULL;
  CREATE INDEX IF NOT EXISTS workouts_sport_started
    ON workouts(sport, started_at DESC, id) WHERE alias_of IS NULL;
  CREATE INDEX IF NOT EXISTS workouts_fit_sha
    ON workouts(fit_sha) WHERE alias_of IS NULL;
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('sync', 'analyze', 'interpret')),
    workout_id TEXT REFERENCES workouts(id),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded')),
    cloud INTEGER NOT NULL CHECK (cloud IN (0, 1)),
    available_at INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease TEXT,
    lease_until INTEGER,
    analysis_version INTEGER,
    error TEXT
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active
    ON jobs(kind, coalesce(workout_id, '')) WHERE status IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS jobs_queued
    ON jobs(priority, id) WHERE status = 'queued';
  CREATE INDEX IF NOT EXISTS jobs_workout
    ON jobs(workout_id, kind, id DESC);
`;

const syncJobsSchema = `
  CREATE TABLE sync_analysis_jobs (
    sync_id INTEGER NOT NULL REFERENCES jobs(id),
    analysis_id INTEGER NOT NULL REFERENCES jobs(id),
    is_new INTEGER NOT NULL CHECK (is_new IN (0, 1)),
    PRIMARY KEY (sync_id, analysis_id)
  ) STRICT;
`;

export class Store {
  private db: DatabaseSync;

  constructor(directory = dataDirectory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'library.sqlite'), { timeout: 3_000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.transaction(() => {
      const { user_version: version } = this.db.prepare('PRAGMA user_version').get()!;
      if (version === 0) {
        this.db.exec(schema);
      }
      if (version === 0 || version === 1) {
        this.db.exec(syncJobsSchema);
      }
      if (version === 0 || version === 1 || version === 2) {
        this.db.exec(`
          ALTER TABLE jobs ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'pl'));
        `);
      }
      if (typeof version === 'number' && version >= 0 && version < 4) {
        this.db.exec(`
          ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'claude'));
          DROP INDEX jobs_one_active;
          CREATE UNIQUE INDEX jobs_one_active ON jobs(kind, coalesce(workout_id, ''), provider)
            WHERE status IN ('queued', 'running');
          CREATE TABLE interpretations (
            workout_id TEXT NOT NULL REFERENCES workouts(id),
            provider TEXT NOT NULL CHECK (provider IN ('openai', 'claude')),
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            analysis_version INTEGER NOT NULL,
            PRIMARY KEY (workout_id, provider)
          ) STRICT;
          INSERT INTO interpretations(workout_id, provider, text, created_at, analysis_version)
            SELECT id, 'openai', interpretation, coalesce(interpreted_at, started_at), coalesce(interpreted_version, 0)
            FROM workouts WHERE interpretation IS NOT NULL AND interpretation <> '';
        `);
      }
      if (typeof version === 'number' && version >= 0 && version < 5) {
        this.db.exec(`
          ALTER TABLE jobs ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1));
          CREATE INDEX jobs_visible_errors ON jobs(id DESC) WHERE status = 'failed' AND dismissed = 0;
          ALTER TABLE workouts ADD COLUMN device_model TEXT;
          CREATE INDEX workouts_device_backfill ON workouts(started_at DESC)
            WHERE alias_of IS NULL AND device_model IS NULL AND artifact_id IS NOT NULL;
          PRAGMA user_version = 5;
        `);
      }
      if (typeof version === 'number' && version >= 0 && version < 6) {
        this.db.exec(`
          ALTER TABLE workouts ADD COLUMN device_retry_at INTEGER NOT NULL DEFAULT 0;
          UPDATE workouts SET device_model = NULL WHERE device_model = '';
          PRAGMA user_version = 6;
        `);
      } else if (version !== 6) {
        throw new Error('Unsupported database schema.');
      }
    });
  }

  close() {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setting<T>(name: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE name = ?').get(name);
    return row ? JSON.parse(row.value as string) as T : fallback;
  }

  setSetting(name: string, value: unknown) {
    this.db.prepare(`
      INSERT INTO settings(name, value) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `).run(name, JSON.stringify(value));
  }

  status() {
    const jobs = { queued: 0, running: 0, failed: 0 };
    const counts = this.db.prepare(`
      SELECT status, count(*) AS count FROM jobs
      WHERE status IN ('queued', 'running', 'failed') AND dismissed = 0 GROUP BY status
    `).all() as { status: keyof typeof jobs; count: number }[];
    for (const row of counts) jobs[row.status] = row.count;
    const pending = this.db.prepare(`
      SELECT
        count(*) FILTER (WHERE kind = 'sync') AS scans,
        count(*) FILTER (WHERE kind = 'analyze' AND cloud = 1) AS cloud,
        count(*) FILTER (WHERE kind = 'analyze' AND cloud = 0) AS local
      FROM jobs WHERE status IN ('queued', 'running')
    `).get() as { scans: number; cloud: number; local: number };
    const authorized = this.setting<boolean | null>('authorized', null);
    const blockedUntil = this.setting('cloudBlockedUntil', 0);
    const syncPhase = pending.scans + pending.cloud === 0 ? 'idle'
      : authorized === false && pending.scans === 0 ? 'authorization'
      : blockedUntil > Date.now() ? 'rate-limit'
      : pending.scans > 0 ? 'listing' : 'analyzing';
    return {
      lastSyncedAt: this.setting<number | null>('lastSyncedAt', null),
      lastSyncResult: this.lastSyncResult(),
      authorized,
      interpretationAvailable: this.interpretationAvailable('openai'),
      interpretationAvailability: {
        openai: this.interpretationAvailable('openai'), claude: this.interpretationAvailable('claude'),
      },
      timeZone: this.setting<string | null>('timeZone', null),
      error: this.setting<string | null>('syncError', null),
      jobs,
      trainingWork: {
        syncPhase,
        localPending: pending.local,
        retryAt: syncPhase === 'rate-limit' ? blockedUntil : null,
      },
    };
  }

  jobErrors() {
    return this.db.prepare(`
      SELECT jobs.id, jobs.kind, jobs.provider, jobs.error, jobs.available_at AS scheduledAt,
        coalesce(workouts.alias_of, workouts.id) AS workoutId, workouts.sport
      FROM jobs LEFT JOIN workouts ON workouts.id = jobs.workout_id
      WHERE jobs.status = 'failed' AND jobs.dismissed = 0 ORDER BY jobs.id DESC
    `).all();
  }

  dismissJobErrors(id?: number) {
    if (id === undefined) {
      this.db.prepare("UPDATE jobs SET dismissed = 1 WHERE status = 'failed' AND dismissed = 0").run();
      return;
    }
    this.db.prepare("UPDATE jobs SET dismissed = 1 WHERE id = ? AND status = 'failed' AND dismissed = 0").run(id);
  }

  list(filters: { limit: number; offset: number; sport?: string; from?: number; to?: number }) {
    const conditions = ['alias_of IS NULL'];
    const args: (string | number)[] = [];
    for (const [clause, value] of [
      ['sport = ?', filters.sport],
      ['started_at >= ?', filters.from],
      ['started_at < ?', filters.to],
    ] as const) {
      if (value !== undefined) {
        conditions.push(clause);
        args.push(value);
      }
    }
    const where = conditions.join(' AND ');
    const rows = this.db.prepare(`
      SELECT id, started_at, sport, distance_m, active_seconds, avg_hr, source, status, error
      FROM workouts WHERE ${where} ORDER BY started_at DESC, id LIMIT ? OFFSET ?
    `).all(...args, filters.limit, filters.offset) as unknown as WorkoutRow[];
    const total = this.db.prepare(`SELECT count(*) AS total FROM workouts WHERE ${where}`)
      .get(...args)!.total as number;
    const sports = this.db.prepare(`
      SELECT DISTINCT sport FROM workouts WHERE alias_of IS NULL ORDER BY sport
    `).all().map((row) => row.sport as string);
    return { workouts: rows.map(workoutSummary), total, sports };
  }

  workout(id: string): WorkoutRow | undefined {
    if (!isId(id)) return undefined;
    return this.db.prepare(`
      SELECT * FROM workouts WHERE id = (SELECT coalesce(alias_of, id) FROM workouts WHERE id = ?)
    `).get(id) as WorkoutRow | undefined;
  }

  detail(id: string) {
    const row = this.workout(id);
    if (!row) return undefined;
    const analysis = row.result_json ? JSON.parse(row.result_json) as Analysis : null;
    const interpretations = { openai: this.interpretation(row, 'openai'), claude: this.interpretation(row, 'claude') };
    return {
      ...workoutSummary(row),
      metrics: analysis?.metrics ?? {},
      laps: analysis?.laps ?? [],
      observations: analysis?.observations ?? [],
      chart: Boolean(analysis?.chart && row.artifact_id),
      analysisVersion: row.analysis_version,
      deviceModel: row.device_model || null,
      interpretations,
      interpretation: interpretations.openai.result,
      interpretationStatus: interpretations.openai.status,
      interpretationError: interpretations.openai.error,
    };
  }

  nextDeviceBackfill(now: number) {
    return this.db.prepare(`
      SELECT id, artifact_id FROM workouts
      WHERE alias_of IS NULL AND device_model IS NULL AND artifact_id IS NOT NULL AND device_retry_at <= ?
      ORDER BY started_at DESC LIMIT 1
    `).get(now) as { id: string; artifact_id: string } | undefined;
  }

  finishDeviceBackfill(id: string, artifact: string, model: string | null) {
    this.db.prepare(`
      UPDATE workouts SET device_model = ? WHERE id = ? AND artifact_id = ? AND device_model IS NULL
    `).run(model ?? '', id, artifact);
  }

  deferDeviceBackfill(id: string, artifact: string, retryAt: number) {
    this.db.prepare(`
      UPDATE workouts SET device_retry_at = ? WHERE id = ? AND artifact_id = ? AND device_model IS NULL
    `).run(retryAt, id, artifact);
  }

  private interpretation(workout: WorkoutRow, provider: Provider) {
    const saved = this.db.prepare(`
      SELECT text, created_at, analysis_version FROM interpretations WHERE workout_id = ? AND provider = ?
    `).get(workout.id, provider);
    const lastJob = this.db.prepare(`
      SELECT status, error FROM jobs
      WHERE kind = 'interpret' AND workout_id = ? AND provider = ? AND dismissed = 0 ORDER BY id DESC LIMIT 1
    `).get(workout.id, provider);
    return {
      result: saved ? { text: saved.text, createdAt: saved.created_at, stale: saved.analysis_version !== workout.analysis_version } : null,
      status: lastJob?.status === 'done' ? 'ready' : lastJob?.status,
      error: lastJob?.error,
    };
  }

  private enqueue(kind: Kind, workoutId: string | null, now: number, cloud: boolean, version?: number,
    language: Language = 'en', provider: Provider = 'openai') {
    const existing = this.db.prepare(`
      SELECT id FROM jobs WHERE kind = ? AND workout_id IS ? AND provider = ? AND status IN ('queued', 'running')
    `).get(kind, workoutId, provider);
    if (existing) return { id: Number(existing.id), queued: false };
    this.db.prepare(`
      UPDATE jobs SET status = 'superseded' WHERE kind = ? AND workout_id IS ? AND provider = ? AND status = 'failed'
    `).run(kind, workoutId, provider);
    const priority = kind === 'sync' ? 0 : kind === 'interpret' ? 1 : 2;
    const result = this.db.prepare(`
      INSERT INTO jobs(kind, workout_id, status, cloud, available_at, priority, analysis_version, language, provider)
      VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)
    `).run(kind, workoutId, Number(cloud), now, priority, version ?? null, language, provider);
    return { id: Number(result.lastInsertRowid), queued: true };
  }

  synchronize(now = Date.now()) {
    return this.transaction(() => {
      const job = this.enqueue('sync', null, now, true);
      if (job.queued) {
        this.setSetting('syncError', null);
        this.setSetting('syncErrorCode', null);
      }
      return job;
    });
  }

  syncResult(id: number) {
    const result = this.db.prepare(`
      SELECT sync.status, sync.error, sync.available_at AS scheduledAt,
        count(*) FILTER (WHERE analysis.status IN ('queued', 'running')) AS pending,
        count(*) FILTER (WHERE analysis.status = 'done' AND item.is_new = 1) AS added,
        count(*) FILTER (WHERE analysis.status = 'done' AND item.is_new = 0) AS updated,
        count(*) FILTER (WHERE analysis.status IN ('failed', 'superseded')) AS failed
      FROM jobs AS sync
      LEFT JOIN sync_analysis_jobs AS item ON item.sync_id = sync.id
      LEFT JOIN jobs AS analysis ON analysis.id = item.analysis_id
      WHERE sync.id = ? AND sync.kind = 'sync'
      GROUP BY sync.id
    `).get(id) as { status: JobState; error: string | null; scheduledAt: number; pending: number; added: number;
      updated: number; failed: number } | undefined;
    if (!result) return undefined;
    const { status, error, pending, added, updated, failed } = result;
    return {
      id, scheduledAt: result.scheduledAt,
      status: status === 'superseded' ? 'failed' : status === 'done' && pending > 0 ? 'running' : status,
      error, added, updated, failed,
    };
  }

  private lastSyncResult() {
    const row = this.db.prepare(`
      SELECT sync.id FROM jobs AS sync WHERE sync.workout_id IS NULL AND sync.kind = 'sync'
        AND (sync.status IN ('failed', 'superseded') OR (sync.status = 'done' AND NOT EXISTS (
          SELECT 1 FROM sync_analysis_jobs AS item JOIN jobs AS analysis ON analysis.id = item.analysis_id
          WHERE item.sync_id = sync.id AND analysis.status IN ('queued', 'running')
        )))
      ORDER BY sync.id DESC LIMIT 1
    `).get() as { id: number } | undefined;
    return row ? this.syncResult(row.id) : null;
  }

  observeAuthorization(revision: string | null, now: number) {
    return this.transaction(() => {
      const previous = this.setting<string | null>('authorizationRevision', null);
      const rejected = this.setting<string | null>('syncErrorCode', null) === 'AUTH_REQUIRED';
      const changed = revision !== null && revision !== previous;
      const authorized = revision !== null && (!rejected || changed);
      if (changed) this.setSetting('authorizationRevision', revision);
      if (this.setting<boolean | null>('authorized', null) !== authorized) this.setSetting('authorized', authorized);
      if (authorized && rejected) {
        this.setSetting('syncError', null);
        this.setSetting('syncErrorCode', null);
      }
      if (authorized && this.setting<number | null>('lastSyncedAt', null) === null
          && this.setting<string | null>('bootstrapRevision', null) !== revision) {
        this.enqueue('sync', null, now, true);
        this.setSetting('bootstrapRevision', revision);
      }
    });
  }

  importFit(uploadId: string, hash: string, now = Date.now()) {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT coalesce(alias_of, id) AS id FROM workouts WHERE local_hash = ?
      `).get(hash) ?? this.db.prepare(`
        SELECT id FROM workouts WHERE fit_sha = ? AND source = 'suunto' AND alias_of IS NULL
        ORDER BY started_at DESC LIMIT 1
      `).get(hash);
      if (existing) return { id: String(existing.id), queued: false };
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO workouts(id, source, started_at, sport, upload_id, local_hash, status)
        VALUES (?, 'fit', ?, 'FIT', ?, ?, 'queued')
      `).run(id, now, uploadId, hash);
      this.enqueue('analyze', id, now, false);
      return { id, queued: true };
    });
  }

  retry(id: string, now = Date.now()) {
    return this.transaction(() => {
      const row = this.workout(id);
      if (!row) return undefined;
      const job = this.enqueue('analyze', row.id, now, row.source === 'suunto');
      if (job.queued) {
        this.db.prepare("UPDATE workouts SET status = 'queued', error = NULL WHERE id = ?").run(row.id);
      }
      return job;
    });
  }

  private interpretationAvailable(provider: Provider) {
    return this.setting(provider === 'openai' ? 'interpretationAvailable' : 'claudeAvailable', false);
  }

  setInterpretationAvailable(provider: Provider, available: boolean) {
    this.setSetting(provider === 'openai' ? 'interpretationAvailable' : 'claudeAvailable', available);
  }

  requestInterpretation(id: string, now = Date.now(), language: Language = 'en', provider: Provider = 'openai') {
    return this.transaction(() => {
      const row = this.workout(id);
      if (!row) return { error: 'missing' } as const;
      if (!row.result_json) return { error: 'needs-analysis' } as const;
      if (!this.interpretationAvailable(provider)) return { error: 'unavailable' } as const;
      return this.enqueue('interpret', row.id, now, false, row.analysis_version, language, provider);
    });
  }

  claim(now: number, leaseDuration: number, nextCloudAt = 0): Job | undefined {
    return this.transaction(() => {
      const blockedUntil = Math.max(nextCloudAt, this.setting('cloudBlockedUntil', 0));
      const canAnalyzeCloud = this.setting<boolean | null>('authorized', null) !== false;
      const next = this.db.prepare(`
        SELECT id FROM jobs
        WHERE ((status = 'queued' AND available_at <= ?) OR (status = 'running' AND lease_until <= ?))
          AND (cloud = 0 OR (? >= ? AND (? OR kind = 'sync')))
        ORDER BY priority, id LIMIT 1
      `).get(now, now, now, blockedUntil, Number(canAnalyzeCloud));
      if (!next) return undefined;
      const row = this.db.prepare(`
        UPDATE jobs SET status = 'running', lease = ?, lease_until = ?, attempts = attempts + 1
        WHERE id = ? RETURNING *
      `).get(randomUUID(), now + leaseDuration, next.id) as unknown as Job;
      if (row.kind === 'analyze') {
        this.db.prepare("UPDATE workouts SET status = 'running', error = NULL WHERE id = ?")
          .run(row.workout_id);
      }
      return row;
    });
  }

  extend(job: Job, now: number, leaseDuration: number) {
    return this.db.prepare(`
      UPDATE jobs SET lease_until = ? WHERE id = ? AND lease = ? AND status = 'running' AND lease_until > ?
    `).run(now + leaseDuration, job.id, job.lease, now).changes === 1;
  }

  private owns(job: Job, now: number) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM jobs WHERE id = ? AND lease = ? AND status = 'running' AND lease_until > ?
    `).get(job.id, job.lease, now));
  }

  private finish(job: Job) {
    this.db.prepare("UPDATE jobs SET status = 'done', lease = NULL, lease_until = NULL, error = NULL WHERE id = ?")
      .run(job.id);
  }

  finishSync(job: Job, index: CloudIndex, now: number) {
    return this.transaction(() => {
      if (!this.owns(job, now)) return false;
      const linkAnalysis = this.db.prepare(`
        INSERT OR IGNORE INTO sync_analysis_jobs(sync_id, analysis_id, is_new) VALUES (?, ?, ?)
      `);
      for (const workout of index.workouts.toSorted((a, b) => b.startedAt - a.startedAt)) {
        const existing = this.db.prepare(`
          SELECT id, cloud_json, modified_at FROM workouts WHERE source_key = ?
        `).get(workout.sourceKey) as Pick<WorkoutRow, 'id' | 'cloud_json' | 'modified_at'> | undefined;
        const cloudJson = JSON.stringify(workout.cloud);
        if (existing && existing.modified_at !== null && workout.modifiedAt !== null &&
            existing.modified_at >= workout.modifiedAt) continue;
        if (existing?.cloud_json === cloudJson) continue;
        const id = existing?.id ?? randomUUID();
        this.db.prepare(`
          INSERT INTO workouts(id, source, source_key, started_at, sport, distance_m, active_seconds, avg_hr,
                               modified_at, cloud_json, status)
          VALUES (?, 'suunto', ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
          ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, sport = excluded.sport,
            distance_m = excluded.distance_m, active_seconds = excluded.active_seconds, avg_hr = excluded.avg_hr,
            modified_at = excluded.modified_at, cloud_json = excluded.cloud_json, status = 'queued', error = NULL
        `).run(id, workout.sourceKey, workout.startedAt, workout.sport, workout.distanceM, workout.activeSeconds,
          workout.avgHr, workout.modifiedAt, cloudJson);
        const analysis = this.enqueue('analyze', id, now, true);
        linkAnalysis.run(job.id, analysis.id, Number(!existing));
      }
      this.setSetting('syncWatermark', Math.max(this.setting('syncWatermark', 0), index.highWatermark));
      if (index.timeZone) this.setSetting('timeZone', index.timeZone);
      this.setSetting('authorized', true);
      this.setSetting('lastSyncedAt', now);
      this.setSetting('syncError', null);
      this.setSetting('syncErrorCode', null);
      this.finish(job);
      return true;
    });
  }

  finishAnalysis(job: Job, result: Analysis, cloudJson: string | null, now: number) {
    return this.transaction(() => {
      if (!this.owns(job, now)) return false;
      const row = this.workout(job.workout_id ?? '');
      if (!row || row.id !== job.workout_id) {
        this.finish(job);
        return false;
      }
      if (cloudJson !== row.cloud_json) {
        this.defer(job, null, now);
        return false;
      }
      const { startedAt, sport, distanceM, activeSeconds, avgHr } = result.summary;
      const { metrics, laps, observations, chart } = result;
      this.db.prepare(`
        UPDATE workouts SET started_at = ?, sport = ?, distance_m = ?, active_seconds = ?, avg_hr = ?,
          fit_sha = ?, status = 'ready', error = NULL, result_json = ?, artifact_id = ?, device_model = ?,
          analysis_version = analysis_version + 1 WHERE id = ?
      `).run(startedAt, sport, distanceM, activeSeconds, avgHr, result.fitSha256,
        JSON.stringify({ metrics, laps, observations, chart }), job.lease, result.deviceModel ?? '', row.id);
      const other = row.source === 'suunto' ? this.db.prepare(`
        SELECT id FROM workouts WHERE local_hash = ? AND alias_of IS NULL
      `).get(result.fitSha256) : this.db.prepare(`
        SELECT id FROM workouts WHERE source = 'suunto' AND fit_sha = ? AND alias_of IS NULL
        ORDER BY started_at DESC LIMIT 1
      `).get(result.fitSha256);
      if (other) {
        const cloudId = row.source === 'suunto' ? row.id : other.id;
        const localId = row.source === 'suunto' ? other.id : row.id;
        this.db.prepare('UPDATE workouts SET alias_of = ? WHERE id = ?').run(cloudId, localId);
        this.db.prepare(`
          UPDATE jobs SET status = 'superseded' WHERE workout_id = ? AND status IN ('queued', 'failed')
        `).run(localId);
        this.db.prepare(`
          INSERT OR IGNORE INTO interpretations(workout_id, provider, text, created_at, analysis_version)
            SELECT ?, provider, text, created_at, 0 FROM interpretations WHERE workout_id = ?
        `).run(cloudId, localId);
      }
      if (row.source === 'suunto' && this.setting<string | null>('syncErrorCode', null) === 'RATE_LIMIT') {
        this.setSetting('syncError', null);
        this.setSetting('syncErrorCode', null);
      }
      this.finish(job);
      return true;
    });
  }

  finishInterpretation(job: Job, text: string, now: number) {
    return this.transaction(() => {
      if (!this.owns(job, now)) return false;
      const result = this.db.prepare(`
        INSERT INTO interpretations(workout_id, provider, text, created_at, analysis_version)
          SELECT id, ?, ?, ?, analysis_version FROM workouts
          WHERE id = ? AND alias_of IS NULL AND analysis_version = ?
        ON CONFLICT(workout_id, provider) DO UPDATE SET text = excluded.text,
          created_at = excluded.created_at, analysis_version = excluded.analysis_version
      `).run(job.provider, text, now, job.workout_id, job.analysis_version);
      if (result.changes === 1) {
        this.finish(job);
        return true;
      }
      this.markFailure(job, 'The workout analysis changed. Request a new interpretation.');
      return false;
    });
  }

  analysisInput(id: string, version: number | null) {
    const row = this.workout(id);
    if (!row?.result_json || row.id !== id || row.analysis_version !== version) return null;
    const { metrics, laps, observations } = JSON.parse(row.result_json) as {
      metrics: Fields; laps: Fields[]; observations: string[];
    };
    return {
      sport: row.sport,
      metrics: { ...metrics, distanceM: row.distance_m, activeSeconds: row.active_seconds, avgHr: row.avg_hr },
      laps, observations,
    };
  }

  private markFailure(job: Job, message: string) {
    this.db.prepare(`
      UPDATE jobs SET status = 'failed', lease = NULL, lease_until = NULL, error = ? WHERE id = ?
    `).run(message, job.id);
    if (job.kind === 'analyze') {
      this.db.prepare("UPDATE workouts SET status = 'failed', error = ? WHERE id = ?").run(message, job.workout_id);
    }
  }

  failed(job: Job, failure: { message: string; code: string; retryAfterMs?: number }, now: number) {
    return this.transaction(() => {
      if (!this.owns(job, now)) return;
      const { message, code, retryAfterMs } = failure;
      if (job.cloud && code === 'AUTH_REQUIRED') this.setSetting('authorized', false);
      if (job.kind === 'sync' || (job.cloud && ['AUTH_REQUIRED', 'RATE_LIMIT'].includes(code))) {
        this.setSetting('syncError', message);
        this.setSetting('syncErrorCode', code);
      }
      if (job.cloud && code === 'RATE_LIMIT') {
        const until = now + Math.max(retryAfterMs ?? 60_000, 6_500);
        this.setSetting('cloudBlockedUntil', Math.max(this.setting('cloudBlockedUntil', 0), until));
        this.defer(job, message, until);
        return;
      }
      if (job.cloud && code === 'NETWORK' && job.attempts < 4) {
        this.defer(job, message, now + 15_000 * 2 ** job.attempts);
        return;
      }
      if (job.kind === 'analyze' && job.cloud && code === 'AUTH_REQUIRED') {
        this.defer(job, message, now);
        return;
      }
      this.markFailure(job, message);
    });
  }

  private defer(job: Job, message: string | null, until: number) {
    this.db.prepare(`
      UPDATE jobs SET status = 'queued', lease = NULL, lease_until = NULL, error = ?, available_at = ?
      WHERE id = ?
    `).run(message, until, job.id);
    if (job.kind === 'analyze') {
      this.db.prepare("UPDATE workouts SET status = 'queued', error = ? WHERE id = ?").run(message, job.workout_id);
    }
  }
}
