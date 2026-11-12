#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadParser, privateWrite } = require('./fit_to_gpx.cjs');

async function decode(input, output) {
  if (path.resolve(input) === path.resolve(output)) throw new Error('Różne pliki wejściowy i wyjściowy są wymagane.');
  const Parser = loadParser();
  const parser = new Parser({ force: false, mode: 'list', lengthUnit: 'm', speedUnit: 'm/s' });
  const data = await new Promise((resolve, reject) => parser.parse(fs.readFileSync(input),
    (error, result) => error ? reject(new Error('Nie udało się poprawnie zdekodować FIT.')) : resolve(result)));
  privateWrite(output, JSON.stringify(data, null, 2) + '\n');
  return data;
}

module.exports = { decode };
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write('Użycie: node decode_fit.cjs trening.fit trening.decoded.json\n');
    process.exitCode = 1;
  } else {
    decode(input, output).then(data => {
      process.stdout.write(`Zdekodowano FIT: ${(data.records || []).length} próbek, ${(data.laps || []).length} okrążeń.\n`);
    }).catch(() => {
      process.stderr.write('Nie udało się zdekodować FIT; oryginalny plik pozostaje zapisany.\n');
      process.exitCode = 1;
    });
  }
}
