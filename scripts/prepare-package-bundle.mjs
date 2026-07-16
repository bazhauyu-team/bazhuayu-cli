import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageJsonPath = path.join(root, 'package.json');
const backupRoot = path.join(root, '.package.prepack-backup');
const browserRuntimeRoot = path.join(root, 'node_modules', '@octopus', 'browser-runtime');
const workflowCoreRoot = path.join(root, 'node_modules', '@octopus', 'workflow-core');
const bpmnRoot = path.join(root, 'node_modules', '@octopus', 'bpmn');
const protectRoot = path.join(root, 'node_modules', '@octopus', 'octopus-protect');
const protectSource = process.env.OCTOPUS_PROTECT_SOURCE_DIR || '';
const bundledProtectVersion = '0.0.0-protected-bundled';
const removedDirsManifestPath = path.join(backupRoot, 'removed-dirs.json');
const createdDirsManifestPath = path.join(backupRoot, 'created-dirs.json');
const removedDirs = [];
const createdDirs = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function backupPathFor(file) {
  return path.join(backupRoot, 'files', path.relative(root, file));
}

function removedPathFor(dir) {
  return path.join(backupRoot, 'removed', path.relative(root, dir));
}

function backupFile(file) {
  if (!fs.existsSync(file)) return;
  const backup = backupPathFor(file);
  if (fs.existsSync(backup)) return;
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(file, backup);
}

function backupRemovedDir(dir) {
  if (!fs.existsSync(dir)) return;
  const relative = path.relative(root, dir);
  const backup = removedPathFor(dir);
  if (!fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.cpSync(dir, backup, { recursive: true });
  }
  if (!removedDirs.includes(relative)) removedDirs.push(relative);
}

function markCreatedDir(dir) {
  const relative = path.relative(root, dir);
  if (!createdDirs.includes(relative)) createdDirs.push(relative);
}

function ensureInstalled(dir, name) {
  if (!fs.existsSync(dir)) {
    throw new Error(`${name} is not installed. Run npm install first.`);
  }
}

function copyProtectPackage() {
  if (fs.existsSync(path.join(protectRoot, 'package.json'))) return;
  if (!protectSource) {
    throw new Error('OCTOPUS_PROTECT_SOURCE_DIR must point to the private @octopus/octopus-protect package before npm pack/publish.');
  }
  if (!fs.existsSync(path.join(protectSource, 'package.json'))) {
    throw new Error(`OCTOPUS_PROTECT_SOURCE_DIR does not contain package.json: ${protectSource}`);
  }
  fs.mkdirSync(path.dirname(protectRoot), { recursive: true });
  fs.rmSync(protectRoot, { recursive: true, force: true });
  fs.cpSync(protectSource, protectRoot, { recursive: true });
  markCreatedDir(protectRoot);
}

function preparePackageManifest() {
  backupFile(packageJsonPath);
  const pkg = readJson(packageJsonPath);
  pkg.dependencies = {
    ...pkg.dependencies,
    '@octopus/octopus-protect': bundledProtectVersion
  };
  pkg.bundledDependencies = Array.from(new Set([
    ...(pkg.bundledDependencies || []),
    '@octopus/octopus-protect'
  ]));
  writeJson(packageJsonPath, pkg);
}

function stripNestedDependencies() {
  for (const packageJson of [
    path.join(browserRuntimeRoot, 'package.json'),
    path.join(workflowCoreRoot, 'package.json'),
    path.join(bpmnRoot, 'package.json'),
    path.join(protectRoot, 'package.json')
  ]) {
    if (!fs.existsSync(packageJson)) continue;
    backupFile(packageJson);
    const pkg = readJson(packageJson);
    pkg.dependencies = {};
    writeJson(packageJson, pkg);
  }

  for (const dir of [
    path.join(browserRuntimeRoot, 'node_modules'),
    path.join(workflowCoreRoot, 'node_modules'),
    path.join(bpmnRoot, 'node_modules')
  ]) {
    if (!fs.existsSync(dir)) continue;
    backupRemovedDir(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

ensureInstalled(browserRuntimeRoot, '@octopus/browser-runtime');
ensureInstalled(workflowCoreRoot, '@octopus/workflow-core');
ensureInstalled(bpmnRoot, '@octopus/bpmn');
copyProtectPackage();
preparePackageManifest();
stripNestedDependencies();
if (removedDirs.length) {
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(removedDirsManifestPath, `${JSON.stringify(removedDirs, null, 2)}\n`);
}
if (createdDirs.length) {
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(createdDirsManifestPath, `${JSON.stringify(createdDirs, null, 2)}\n`);
}
