import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(repository, 'skymp-backend');
const server = resolve(repository, 'build', 'dist', 'server');
const target = resolve(server, 'backend');
const compiler = resolve(backend, 'node_modules', 'typescript', 'bin', 'tsc');

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [compiler, '-p', 'tsconfig.json'], { cwd: backend, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`Backend build exited with ${code}`)));
});

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of ['dist', 'package.json', 'modules.lock.json', 'README.md', 'MIGRATION.md', 'backend.config.schema.json']) {
  await cp(resolve(backend, name), resolve(target, name), { recursive: true });
}

const example = JSON.parse(await readFile(resolve(backend, 'backend.config.example.json'), 'utf8'));
example.supervisor.cwd = '.';
await writeFile(resolve(target, 'backend.config.example.json'), `${JSON.stringify(example, null, 2)}\n`);

await writeFile(resolve(server, 'launch_managed_server.bat'), [
  '@echo off', 'setlocal', 'cd /d "%~dp0"',
  'node backend\\dist\\main.js --config backend.config.json',
  'set EXIT_CODE=%ERRORLEVEL%', 'endlocal & exit /b %EXIT_CODE%', '',
].join('\r\n'));
await writeFile(resolve(server, 'launch_managed_server.sh'), [
  '#!/usr/bin/env sh', 'set -eu', 'cd "$(dirname "$0")"',
  'exec node backend/dist/main.js --config backend.config.json', '',
].join('\n'), { mode: 0o755 });
console.log(`Managed backend packaged in ${target}`);
