import { mkdirSync, readFileSync, lstatSync } from 'node:fs';
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

// A fixed allowlist keeps .git, .github, releases and build scripts out of install ZIPs.
const files = [
  'README.md',
  'module.json',
  'scripts/bridge-core.mjs',
  'scripts/viscanon-bridge.mjs',
  'styles/bridge.css',
  'assets/viscanon-mark-white.svg'
];
for (const file of files) {
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${file}`);
  }
  if (!lstatSync(path).isFile()) throw new Error(`Missing module file: ${file}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
const repository = 'https://github.com/stephenczaja/viscanon-foundry';
if (manifest.id !== 'viscanon-bridge' || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(manifest.version)) {
  throw new Error('Unexpected module ID or version.');
}
if (manifest.url !== repository
  || manifest.manifest !== 'https://raw.githubusercontent.com/stephenczaja/viscanon-foundry/main/module.json'
  || manifest.download !== `${repository}/releases/download/v${manifest.version}/viscanon-bridge.zip`) {
  throw new Error('Manifest URLs must point to this version in the public repository.');
}
if (JSON.stringify(manifest.esmodules) !== JSON.stringify(['scripts/viscanon-bridge.mjs'])
  || JSON.stringify(manifest.styles) !== JSON.stringify(['styles/bridge.css'])
  || manifest.socket !== true || manifest.readme !== 'README.md') {
  throw new Error('Unexpected module entry points.');
}
for (const file of files.filter(file => file.endsWith('.mjs'))) {
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
