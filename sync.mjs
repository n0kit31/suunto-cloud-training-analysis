#!/usr/bin/env node
import { main } from './suunto_cloud/cli.mjs';

process.exitCode = await main(['sync', ...process.argv.slice(2)]);
