# Third-party notices

The project's code is licensed under GPL-3.0-or-later. Third-party components
retain their own copyright notices and licenses.

## FIT decoder dependencies

The versions below are recorded in `package-lock.json`. Installation with
`npm ci` retains the original license files in each package directory under
`node_modules/`; the Docker image includes those directories unchanged.

| Package | Version | License |
| --- | --- | --- |
| fit-file-parser | 1.20.0 | MIT |
| buffer | 5.7.1 | MIT |
| base64-js | 1.5.1 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |

In the Docker image, the original notices are under
`/app/suunto-cloud/node_modules/<package>/LICENSE*`.

## Container runtime

Node.js is copied from the official `node:24-bookworm-slim` image. Its matching
license file, including notices for bundled third-party components, is copied
with the executable to `/usr/local/share/doc/node/LICENSE`. See the
[upstream Node.js license](https://github.com/nodejs/node/blob/main/LICENSE).

Python and operating-system packages come from the upstream
`python:3.13-slim-bookworm` image and Debian packages. Their existing license
notices are retained in the image.

The project license does not replace the licenses of these components.
