import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const configPath = () => process.env.SUUNTO_CONFIG_PATH || join(root, 'config.json');
export const configuredPrivateDirectory = () => process.env.SUUNTO_PRIVATE_DIR || join(root, '.local');
export const configuredAuthDirectory = () => process.env.SUUNTO_AUTH_DIR || configuredPrivateDirectory();

export async function readOptionalJson(path, fallback = undefined) {
  const info = await stat(path, { throwIfNoEntry: false });
  if (!info?.isFile()) return fallback;
  return JSON.parse(await readFile(path, 'utf8'));
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readConfig() {
  const config = await readOptionalJson(configPath(), {});
  if (!isObject(config)) throw new TypeError('Invalid Suunto configuration.');
  if (config.client_id == null || config.client_id === '' || config.client_id === 'YOUR_SUUNTO_CLIENT_ID') {
    const saved = await readOptionalJson(join(configuredAuthDirectory(), 'config.json'));
    if (saved !== undefined) {
      if (!isObject(saved)) throw new TypeError('Invalid private Suunto configuration.');
      return { ...saved, ...config, client_id: saved.client_id, redirect_uri: config.redirect_uri || saved.redirect_uri };
    }
  }
  return config;
}

export async function userTimezone() {
  const override = process.env.SUUNTO_TIMEZONE?.trim();
  const name = override || (await readConfig()).timezone;
  if (name != null && typeof name !== 'string') {
    throw new TypeError('The timezone setting must be an IANA time zone name or null.');
  }
  const zone = name?.trim() || process.env.TZ?.trim().replace(/^:+/, '') || undefined;
  if (zone) {
    try {
      if (/^[+-]/.test(zone)) throw new RangeError();
      new Intl.DateTimeFormat('en', { timeZone: zone });
    } catch {
      throw new RangeError('Unknown time zone. Use an IANA name such as America/New_York.');
    }
  }
  return zone;
}

export async function privateWrite(path, data) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, '.' + randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export const privateJson = (path, data) => privateWrite(path, JSON.stringify(data, null, 2) + '\n');

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  return directory;
}

export const privateDirectory = () => ensurePrivateDirectory(configuredPrivateDirectory());
export const authenticationDirectory = () => ensurePrivateDirectory(configuredAuthDirectory());

export class FileLockError extends Error {}

export async function withFileLock(path, operation, wait = true) {
  const file = await open(path, 'a+', 0o600);
  try {
    await file.chmod(0o600);
    // flock locks the open file description inherited as fd 3. Keep our
    // descriptor open throughout the operation to interoperate with 1.4.0.
    await new Promise((resolve, reject) => {
      const process = spawn('flock', wait ? ['-x', '3'] : ['-xn', '3'],
        { stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      process.once('error', reject);
      process.once('exit', code => code === 0 ? resolve() : reject(new FileLockError('Could not acquire the private file lock.')));
    });
    return await operation();
  } finally {
    await file.close();
  }
}

export async function withAuthenticationLock(operation) {
  return withFileLock(join(await authenticationDirectory(), 'auth.lock'), operation);
}

export const artifactTimestamp = local => local.slice(0, 19).replace('T', '-').replaceAll(':', '');
export const cloudArtifactStem = (local, key) =>
  `${artifactTimestamp(local)}-cloud-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
