import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDirectories = ['scripts', 'styles', 'assets', 'templates', 'lang', 'fonts'];

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'viscanon-package-test-'));
  const moduleRoot = join(base, 'source');
  mkdirSync(moduleRoot);
  for (const file of ['README.md', 'module.json', 'package.mjs']) {
    copyFileSync(join(source, file), join(moduleRoot, file));
  }
  for (const dir of runtimeDirectories) {
    if (existsSync(join(source, dir))) cpSync(join(source, dir), join(moduleRoot, dir), {recursive: true});
  }
  t.after(() => rmSync(base, {recursive: true, force: true}));
  return {base, moduleRoot, output: join(base, 'viscanon-bridge.zip')};
}

function members(archive) {
  return JSON.parse(execFileSync('python3', ['-c', `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps({name: archive.read(name).hex() for name in archive.namelist()}))`, archive], {encoding: 'utf8'}));
}

test('the install ZIP includes nested runtime files and no repository files', t => {
  const {moduleRoot, output} = fixture(t);
  mkdirSync(join(moduleRoot, 'assets', 'icons'), {recursive: true});
  writeFileSync(join(moduleRoot, 'assets', 'icons', 'new.svg'), '<svg/>');
  writeFileSync(join(moduleRoot, 'scripts', 'new-feature.mjs'), 'export const ready = true;\n');
  execFileSync(process.execPath, [join(moduleRoot, 'package.mjs'), output]);
  const entries = members(output);
  for (const name of ['README.md', 'module.json', 'scripts/new-feature.mjs', 'assets/icons/new.svg']) {
    assert.equal(Buffer.from(entries[`viscanon-bridge/${name}`], 'hex').toString(), readFileSync(join(moduleRoot, name), 'utf8'));
  }
  assert.equal(Object.keys(entries).some(name => /(?:^|\/)(?:test|\.git|\.github|package\.mjs)(?:\/|$)/.test(name)), false);
});

test('the packager rejects missing manifest entry points and runtime symlinks', t => {
  const {moduleRoot, output} = fixture(t);
  const manifestPath = join(moduleRoot, 'module.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.esmodules = ['scripts/missing.mjs'];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let result = spawnSync(process.execPath, [join(moduleRoot, 'package.mjs'), output], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing manifest entry point/);

  copyFileSync(join(source, 'module.json'), manifestPath);
  symlinkSync(join(moduleRoot, 'README.md'), join(moduleRoot, 'assets', 'unexpected.svg'));
  result = spawnSync(process.execPath, [join(moduleRoot, 'package.mjs'), output], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing symbolic link/);
});
