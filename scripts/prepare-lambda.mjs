/**
 * Prepares a Windows-friendly Lambda deploy folder for SAM.
 * Layout mirrors the monorepo so ../../../shared imports keep working.
 * Installs shared deps (zod) at package root node_modules, then removes
 * root package.json so SAM copies the folder as-is (no npm pack).
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'lambda-package');
const serverOut = join(outDir, 'server');
const sharedOut = join(outDir, 'shared');

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

mkdirSync(serverOut, { recursive: true });
mkdirSync(sharedOut, { recursive: true });

cpSync(join(root, 'server', 'src'), join(serverOut, 'src'), { recursive: true });
cpSync(join(root, 'server', 'package.json'), join(serverOut, 'package.json'));

const lockFile = join(root, 'server', 'package-lock.json');
if (existsSync(lockFile)) {
  cpSync(lockFile, join(serverOut, 'package-lock.json'));
}

cpSync(join(root, 'shared'), sharedOut, { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args, cwd, label) {
  console.log(label);
  const result = spawnSync(npm, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status ?? 1);
  }
}

runNpm(['ci', '--omit=dev'], serverOut, 'Installing server production dependencies...');

// Temporary package.json so we can install zod for /var/task/shared imports.
writeFileSync(
  join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'attendance-lambda-package',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: {
        zod: '^4.4.3',
      },
    },
    null,
    2,
  )}\n`,
);

runNpm(['install', '--omit=dev'], outDir, 'Installing shared dependency zod at package root...');

// Remove root manifests so SAM does not run npm pack / rewrite the package.
for (const file of ['package.json', 'package-lock.json']) {
  const path = join(outDir, file);
  if (existsSync(path)) {
    rmSync(path);
  }
}

console.log('Lambda package ready at lambda-package/');
console.log('Next: sam build && sam deploy');
