import { readFile } from 'node:fs/promises';
import { isObject } from './local.mjs';

export async function readSleep(path, required = false) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw error;
  }
  const payload = JSON.parse(raw);
  if (!isObject(payload) || !Array.isArray(payload.data)) {
    throw new TypeError('Sleep input requires an object with a data array of Suunto 247 samples.');
  }
  if (!payload.data.every(isObject)) throw new TypeError('Invalid sleep sample structure.');
  return payload;
}
