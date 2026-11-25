import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { authBodyLimit, authSettings, aiSettings } from './auth-channel.ts';
import { providers, providerNames } from '../shared/providers.ts';
import type { AISettingsUpdate, SuuntoSettingsUpdate } from './auth-channel.ts';
import { presentChart } from './chart-language.ts';
import { embedChart, streamEmbeddedChart } from './chart-frame.ts';
import { artifactDirectory, isId, Store, uploadDirectory } from './store.ts';

const maxFitBytes = 64 * 1024 * 1024;
const maxFiles = 10;
const routeScript = fileURLToPath(new URL('../../suunto_cloud/fit/preview_route.cjs', import.meta.url));
const execute = promisify(execFile);
const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;
const chartPolicy = [
  "sandbox allow-scripts allow-downloads", "default-src 'none'", "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'", "img-src data: blob:", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');
const pagePolicy = [
  "default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https://tile.openstreetmap.org",
  "base-uri 'none'", "object-src 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function failure(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

function numeric(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function calendarDay(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = Date.parse(value + 'T00:00:00.000Z');
  return Number.isFinite(start) && new Date(start).toISOString().slice(0, 10) === value ? start : null;
}

function localBoundary(utcDay: number, timeZone: string | undefined) {
  const target = new Date(utcDay).toISOString().slice(0, 10);
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateAt = (time: number) => {
    const parts = format.formatToParts(time);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    return [part('year').padStart(4, '0'), part('month'), part('day')].join('-');
  };
  // Local midnight can shift at DST transitions. Find the first instant of
  // the calendar day without assuming a fixed UTC offset.
  let lower = utcDay - 2 * 86_400_000;
  let upper = utcDay + 2 * 86_400_000;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (dateAt(middle) < target) lower = middle;
    else upper = middle;
  }
  return upper;
}

type UploadResult = { filename: string; id?: string; status: 'queued' | 'duplicate' | 'failed'; error?: string };

function displayName(name: string) {
  return (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'FIT';
}

async function saveUpload(store: Store, file: NodeJS.ReadableStream & { truncated: boolean }, filename: string) {
  const uploadId = randomUUID();
  const path = join(uploadDirectory, uploadId + '.fit');
  const hash = createHash('sha256');
  let header = Buffer.alloc(0);
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
      done(null, chunk);
    },
  });
  let saved = false;
  try {
    await pipeline(file, inspect, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    if (file.truncated) return { filename, status: 'failed', error: 'The FIT file exceeds 64 MiB.' } as const;
    if (header.length < 12 || header.toString('ascii', 8, 12) !== '.FIT') {
      return { filename, status: 'failed', error: 'The selected file is not a workout FIT file.' } as const;
    }
    const job = store.importFit(uploadId, hash.digest('hex'));
    saved = job.queued;
    return { filename, id: job.id, status: saved ? 'queued' : 'duplicate' } as const;
  } finally {
    if (!saved) await rm(path, { force: true }).catch(() => {});
  }
}

async function main() {
  process.umask(0o077);
  const distDirectory = resolve(process.env.SUUNTO_WEB_DIST || 'web/dist');
  const index = await readFile(join(distDirectory, 'index.html'), 'utf8');
  const store = new Store();
  await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
  const app = Fastify();
  app.addHook('onClose', () => store.close());
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!host || !localHost.test(host) || Number(host.split(':').at(-1)) > 65_535) {
      return failure(reply, 403, 'Local access is required.');
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    const expected = new URL('http://' + host).origin;
    if (request.headers['x-suunto-request'] !== '1' || (origin !== undefined && origin !== expected)) {
      return failure(reply, 403, 'This action requires a request from the local app.');
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!request.url.startsWith('/assets/') || reply.statusCode >= 400) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : 500;
    if (status === 413) return failure(reply, 413, 'The upload exceeds the allowed size or number of files.');
    if (status === 415) return failure(reply, 415, 'Choose one or more FIT files.');
    if (typeof status === 'number' && status < 500) return failure(reply, 400, 'The request is invalid.');
    return failure(reply, 500, 'The local application could not complete the request.');
  });
  app.setNotFoundHandler((_request, reply) => failure(reply, 404, 'The requested page was not found.'));

  await app.register(multipart, { limits: { files: maxFiles, fields: 0, parts: maxFiles + 1, fileSize: maxFitBytes } });
  await app.register(fastifyStatic, {
    root: join(distDirectory, 'assets'), prefix: '/assets/', index: false, immutable: true, maxAge: '1y',
  });

  const page = (_request: unknown, reply: FastifyReply) => reply
    .header('Content-Security-Policy', pagePolicy).type('text/html; charset=utf-8').send(index);
  app.get('/', page);
  app.get('/workouts/:id', page);
  app.get('/healthz', () => ({ ok: true }));
  app.get('/api/status', () => store.status());
  app.get('/api/jobs/errors', () => ({ errors: store.jobErrors() }));
  app.delete('/api/jobs/errors', (_request, reply) => {
    store.dismissJobErrors();
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>('/api/jobs/errors/:id', (request, reply) => {
    const id = numeric(request.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return failure(reply, 400, 'The request is invalid.');
    store.dismissJobErrors(id);
    return reply.code(204).send();
  });
  async function settingsResponse(reply: FastifyReply, update?: SuuntoSettingsUpdate) {
    const result = await authSettings(update).catch(() => ({ status: 503, data: undefined }));
    if (result.data) return result.data;
    if (result.status === 400) return failure(reply, 400, 'Check the Suunto client ID, secret and subscription key.');
    return failure(reply, 503, 'Suunto settings are temporarily unavailable. Try again.');
  }
  app.get('/api/suunto/settings', (_request, reply) => settingsResponse(reply));
  app.post<{ Body: SuuntoSettingsUpdate }>('/api/suunto/settings', {
    bodyLimit: authBodyLimit,
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['clientId', 'clientSecret', 'subscriptionKey'],
        properties: {
          clientId: { type: 'string', minLength: 1, maxLength: 512 },
          clientSecret: { type: 'string', maxLength: 512 },
          subscriptionKey: { type: 'string', maxLength: 512 },
        },
      },
    },
  }, (request, reply) => settingsResponse(reply, request.body));
  for (const provider of providers) {
    const name = providerNames[provider];
    const path = `/api/${provider}/settings`;
    async function settingsResponse(reply: FastifyReply, update?: AISettingsUpdate | null) {
      const result = await aiSettings(provider, update).catch(() => ({ status: 503, data: undefined }));
      if (result.data) return result.data;
      if (result.status === 400) return failure(reply, 400, `Enter a valid ${name} API key.`);
      if (result.status === 409) return failure(reply, 409, `The ${name} key is managed by the worker configuration.`);
      return failure(reply, 503, `${name} settings are temporarily unavailable. Try again.`);
    }
    app.get(path, (_request, reply) => settingsResponse(reply));
    app.delete(path, (_request, reply) => settingsResponse(reply, null));
    app.post<{ Body: AISettingsUpdate }>(path, {
      bodyLimit: authBodyLimit,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['apiKey'],
          properties: { apiKey: { type: 'string', minLength: 1, maxLength: 1024 } },
        },
      },
    }, (request, reply) => settingsResponse(reply, request.body));
  }
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/workouts', (request, reply) => {
    const query = request.query;
    const limit = numeric(query.limit, 25, 1, 100);
    const offset = numeric(query.offset, 0, 0, 1_000_000);
    const first = query.from === undefined ? undefined : calendarDay(query.from);
    const last = query.to === undefined ? undefined : calendarDay(query.to);
    if (limit === null || offset === null || first === null || last === null ||
        (first !== undefined && last !== undefined && first > last) ||
        (query.sport !== undefined && (typeof query.sport !== 'string' || query.sport.length > 100))) {
      return failure(reply, 400, 'Invalid workout filters.');
    }
    const timeZone = store.setting<string | undefined>('timeZone', undefined) ?? query.timeZone;
    if (timeZone !== undefined) {
      if (typeof timeZone !== 'string' || timeZone.length > 100) {
        return failure(reply, 400, 'Invalid workout time zone.');
      }
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone });
      } catch {
        return failure(reply, 400, 'Invalid workout time zone.');
      }
    }
    return store.list({
      limit, offset, sport: query.sport || undefined,
      from: first === undefined ? undefined : localBoundary(first, timeZone),
      to: last === undefined ? undefined : localBoundary(last + 86_400_000, timeZone),
    });
  });

  app.get<{ Params: { id: string } }>('/api/workouts/:id', (request, reply) => {
    return store.detail(request.params.id) ?? failure(reply, 404, 'This workout was not found.');
  });
  const routesInProgress = new Map<string, Promise<{ segments: number[][][] | null }>>();
  app.get<{ Params: { id: string }; Querystring: { view?: string } }>('/api/workouts/:id/route', async (request, reply) => {
    const row = store.workout(request.params.id);
    if (!row) return failure(reply, 404, 'This workout was not found.');
    const artifact = row.artifact_id;
    if (!artifact || !isId(artifact)) return { segments: null };
    const view = request.query.view === 'map' ? 'map' : 'preview';
    const routeKey = artifact + ':' + view;
    let route = routesInProgress.get(routeKey);
    if (!route) {
      if (routesInProgress.size >= 2) return failure(reply, 503, 'Route previews are busy.');
      const fitPath = join(artifactDirectory, artifact, 'source.fit');
      route = (async () => {
        const fit = await stat(fitPath, { throwIfNoEntry: false });
        if (!fit?.isFile()) return { segments: null };
        if (fit.size > maxFitBytes) throw new Error('FIT exceeds the size limit.');
        const { stdout } = await execute(process.execPath, ['--max-old-space-size=256', routeScript, fitPath, view], {
          maxBuffer: 256 * 1024, timeout: 20_000,
        });
        return { segments: JSON.parse(stdout) };
      })().finally(() => routesInProgress.delete(routeKey));
      routesInProgress.set(routeKey, route);
    }
    try {
      return await route;
    } catch {
      return failure(reply, 422, 'The workout route could not be read.');
    }
  });
  app.get<{ Params: { id: string }; Querystring: { lang?: string; embed?: string } }>('/api/workouts/:id/chart', async (request, reply) => {
    const row = store.workout(request.params.id);
    if (!row?.artifact_id || !isId(row.artifact_id)) {
      return failure(reply, 404, 'This workout has no chart.');
    }
    const path = join(artifactDirectory, row.artifact_id, 'chart.html');
    const file = await open(path, 'r').catch(() => null);
    if (!file) return failure(reply, 404, 'This workout has no chart.');
    const language = request.query.lang === 'pl' ? 'pl' : 'en';
    const embedded = request.query.embed === '1';
    reply.header('Content-Security-Policy', chartPolicy)
      .header('Content-Language', language).type('text/html; charset=utf-8');
    if (language === 'en' && !row.device_model) return reply.send(embedded ? streamEmbeddedChart(file) : file.createReadStream());
    try {
      const chart = presentChart(await file.readFile('utf8'), row.sport, language, row.device_model);
      return reply.send(embedded ? embedChart(chart) : chart);
    } finally {
      await file.close();
    }
  });

  app.post('/api/sync', (_request, reply) => {
    const job = store.synchronize();
    return reply.code(202).send({ jobId: job.id, queued: job.queued });
  });
  app.get<{ Params: { id: string } }>('/api/sync/:id', (request, reply) => {
    const id = numeric(request.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
    return (id === null ? undefined : store.syncResult(id)) ??
      failure(reply, 404, 'This sync was not found.');
  });
  app.post('/api/import', async (request, reply) => {
    if (!request.isMultipart()) return failure(reply, 415, 'Choose one or more FIT files.');
    const files: UploadResult[] = [];
    try {
      for await (const part of request.files()) {
        const filename = displayName(part.filename);
        if (part.fieldname !== 'files') {
          for await (const _chunk of part.file) { /* Drain the unrecognized file field. */ }
          files.push({ filename, status: 'failed', error: 'Unexpected upload field.' });
          continue;
        }
        files.push(await saveUpload(store, part.file, filename));
      }
    } catch (error) {
      if (!(error instanceof Error) || !('statusCode' in error) || error.statusCode !== 413) throw error;
      if (!files.length) return failure(reply, 413, 'The upload exceeds the allowed size or number of files.');
      return reply.code(202).send({ files, error: 'The upload limit was reached. Remaining files were skipped.' });
    }
    if (!files.length) return failure(reply, 400, 'Choose one or more FIT files.');
    return reply.code(202).send({ files });
  });
  app.post<{ Params: { id: string } }>('/api/workouts/:id/retry', (request, reply) => {
    const job = store.retry(request.params.id);
    if (!job) return failure(reply, 404, 'This workout was not found.');
    return reply.code(202).send({ jobId: job.id, queued: job.queued });
  });
  app.post<{ Params: { id: string }; Querystring: { lang?: string; provider?: string } }>('/api/workouts/:id/interpret', (request, reply) => {
    const language = request.query.lang === 'pl' ? 'pl' : 'en';
    const requested = request.query.provider;
    const provider = requested === undefined ? 'openai' : providers.find((entry) => entry === requested);
    if (!provider) return failure(reply, 400, 'Choose an interpretation provider.');
    const job = store.requestInterpretation(request.params.id, Date.now(), language, provider);
    if ('error' in job) {
      if (job.error === 'missing') return failure(reply, 404, 'This workout was not found.');
      if (job.error === 'needs-analysis') return failure(reply, 409, 'Analyze this workout before interpreting it.');
      return failure(reply, 503, 'Configure an interpretation model first.');
    }
    return reply.code(202).send({ jobId: job.id, queued: job.queued });
  });

  const port = Number(process.env.PORT || 3000);
  await app.listen({ host: process.env.HOST || '127.0.0.1', port });
  for (const event of ['SIGINT', 'SIGTERM'] as const) {
    process.once(event, () => app.close().catch(() => { process.exitCode = 1; }));
  }
}

main().catch(() => {
  console.error('Could not start the Suunto web server.');
  process.exitCode = 1;
});
