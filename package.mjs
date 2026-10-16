import { mkdirSync, readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const outputArgument = process.argv[2];
if (!outputArgument || !isAbsolute(outputArgument) || !outputArgument.endsWith('.zip')) {
  throw new Error('Usage: node package.mjs /absolute/output/viscanon-bridge.zip');
}
const output = resolve(outputArgument);
const outputRelative = relative(root, output);
if (outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`) && !isAbsolute(outputRelative)) {
  throw new Error('Choose an output path outside this repository.');
}

// Include every runtime file in these module directories. A directory allowlist
// excludes tests, repository metadata, and release tooling without silently
// dropping new runtime scripts or images from an install ZIP.
const runtimeDirectories = ['scripts', 'styles', 'assets', 'templates', 'lang', 'fonts'];
const collectFiles = (relativePath) => {
  if (relativePath.split('/').some(part => part.startsWith('.'))) {
    throw new Error(`Refusing hidden runtime path: ${relativePath}`);
  }
  const path = join(root, relativePath);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${relativePath}`);
  if (stat.isFile()) return [relativePath];
  if (!stat.isDirectory()) throw new Error(`Unsupported runtime path: ${relativePath}`);
  return readdirSync(path).sort().flatMap(name => collectFiles(`${relativePath}/${name}`));
};
const files = [
  'README.md',
  'module.json',
  ...runtimeDirectories.flatMap(dir => existsSync(join(root, dir)) ? collectFiles(dir) : [])
];
if (files.length <= 2) throw new Error('No module runtime files found.');
for (const file of ['README.md', 'module.json']) {
  if (!lstatSync(join(root, file)).isFile()) throw new Error(`Missing module file: ${file}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
const repository = 'https://github.com/stephenczaja/viscanon-foundry';
if (manifest.id !== 'viscanon-bridge' || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(manifest.version)) {
  throw new Error('Unexpected module ID or version.');
}
if (manifest.url !== repository
  || manifest.manifest !== 'https://foundry.viscanon.com/module.json'
  || manifest.download !== `${repository}/releases/download/v${manifest.version}/viscanon-bridge.zip`) {
  throw new Error('Manifest URLs must point to the branded stable manifest and this versioned public release.');
}
if (!Array.isArray(manifest.esmodules) || manifest.esmodules.length === 0
  || !Array.isArray(manifest.styles) || manifest.styles.length === 0
  || manifest.socket !== true || manifest.readme !== 'README.md') {
  throw new Error('Unexpected module entry points.');
}
for (const file of [...manifest.esmodules, ...manifest.styles, manifest.readme]) {
  if (!files.includes(file)) throw new Error(`Missing manifest entry point: ${file}`);
}
for (const file of files.filter(file => /\.[cm]?js$/.test(file))) {
  execFileSync(process.execPath, ['--check', join(root, file)], {stdio: 'inherit'});
}

mkdirSync(dirname(output), {recursive: true});
execFileSync('python3', ['-c', `import json, pathlib, sys, zipfile
root, output, files = pathlib.Path(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3])
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for relative in files:
        info = zipfile.ZipInfo('viscanon-bridge/' + pathlib.Path(relative).as_posix(), (2026, 10, 9, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (root / relative).read_bytes())
`, root, output, JSON.stringify(files)], {stdio: 'inherit'});
console.log(output);
