#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = readJson(join(root, 'package.json'));
const tempRoot = mkdtempSync(join(tmpdir(), 'bazhuayu-cli-package-'));
const packDir = join(tempRoot, 'pack');
const prefix = join(tempRoot, 'prefix');
const backupRoot = join(root, '.package.prepack-backup');
const restoreScript = join(root, 'scripts', 'restore-package-after-pack.mjs');

mkdirSync(packDir, { recursive: true });

try {
  const packed = JSON.parse(capture('npm', [
    'pack',
    '--json',
    '--pack-destination',
    packDir
  ], root));
  const filename = packed[0]?.filename;
  if (!filename) throw new Error('npm pack did not report a tarball filename.');

  const tarball = join(packDir, filename);
  run('npm', ['install', '--global', '--prefix', prefix, tarball], tempRoot);

  const globalRoot = capture('npm', ['root', '--global', '--prefix', prefix], tempRoot).trim();
  const installedRoot = join(globalRoot, ...packageJson.name.split('/'));
  const workflowRoot = join(installedRoot, 'node_modules', '@octopus', 'workflow-core');
  const workflowPackage = readJson(join(workflowRoot, 'package.json'));
  if (!workflowPackage.dependencies?.axios || !workflowPackage.dependencies?.jsonpath) {
    throw new Error('Packed workflow-core manifest is missing runtime dependencies.');
  }

  const dependencyProbe = capture(process.execPath, [
    '-e',
    [
      "const workflowRoot = process.argv[1];",
      "const axiosAdapter = require.resolve('axios/lib/adapters/http', { paths: [workflowRoot] });",
      "const jsonpath = require.resolve('jsonpath', { paths: [workflowRoot] });",
      'process.stdout.write(JSON.stringify({ axiosAdapter, jsonpath }));'
    ].join(' '),
    workflowRoot
  ], tempRoot);
  const resolved = JSON.parse(dependencyProbe);
  const nestedAxiosPath = join('@octopus', 'workflow-core', 'node_modules', 'axios');
  if (!resolved.axiosAdapter.includes(nestedAxiosPath)) {
    throw new Error(`workflow-core resolved an unexpected axios adapter: ${resolved.axiosAdapter}`);
  }

  const binary = process.platform === 'win32'
    ? join(prefix, 'octopus.cmd')
    : join(prefix, 'bin', 'octopus');
  const binaryOptions = { shell: process.platform === 'win32' };
  const version = capture(binary, ['--version'], tempRoot, binaryOptions).trim();
  if (version !== packageJson.version) {
    throw new Error(`Packed CLI version mismatch: expected ${packageJson.version}, got ${version || '<empty>'}`);
  }

  const capabilities = JSON.parse(capture(binary, ['capabilities', '--json'], tempRoot, binaryOptions));
  if (!capabilities.ok || capabilities.data?.version !== packageJson.version) {
    throw new Error('Packed CLI capabilities check failed.');
  }

  console.log(`Verified ${filename}: nested workflow dependencies, CLI startup, and capabilities are valid.`);
} finally {
  if (existsSync(backupRoot)) {
    run(process.execPath, [restoreScript], root);
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function capture(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return result.stdout ?? '';
}
