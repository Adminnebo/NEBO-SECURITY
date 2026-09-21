import { randomBytes } from 'node:crypto';
import { mkdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword, normalizeUsername, displayName } from '../worker/auth.js';

// Passwords are generated locally and written only to ignored .key.txt files.
// No secret is placed in arguments, stdout, tracked source, or a build artifact.
async function main() {
  const options = { username: 'admin', name: 'Administrador', 'output-dir': process.cwd() };
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run admin:config -- --username admin --name Administrador --output-dir DIRECTORY');
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!Object.hasOwn(options, key) || !args[i].startsWith('--') || !args[i + 1]) throw new Error('Invalid arguments. Use --help.');
    options[key] = args[i + 1];
  }
  const username = normalizeUsername(options.username);
  if (!username) throw new Error('Username must have 3-40 letters, numbers, dots, hyphens or underscores.');
  const name = displayName(options.name, username);
  const output = path.resolve(options['output-dir']);
  await mkdir(output, { recursive: true });
  const loginFile = path.join(output, 'NEBO-ADMIN-POSTGRES.key.txt');
  const secretFile = path.join(output, 'NEBO-BOOTSTRAP-POSTGRES.key.txt');
  for (const file of [loginFile, secretFile]) {
    try { await access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('An output file already exists. Choose a different --output-dir; existing credentials were preserved.');
  }
  const password = randomBytes(24).toString('base64url');
  const bootstrap = { username, displayName: name, passwordHash: await hashPassword(password) };
  await writeFile(loginFile, `NEBO AI - SECURITY / PostgreSQL\nUsuario: ${username}\nContraseña: ${password}\n\nAcceso: /login\nAdministración: /account\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(secretFile, JSON.stringify(bootstrap) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created administrator access file: ' + loginFile);
  console.log('Created JSON value for NEBO_BOOTSTRAP_ADMIN_JSON: ' + secretFile);
  console.log('Set the secret in Railway Variables. This only creates an administrator in an uninitialized database.');
}

main().catch(error => {
  console.error(error.code ? 'Could not write access files: ' + error.code : error.message);
  process.exitCode = 1;
});
