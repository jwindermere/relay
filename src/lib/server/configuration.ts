import { readFile } from 'node:fs/promises';

export async function loadFileBackedEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  for (const name of names) {
    const fileVariable = `${name}_FILE`;
    const file = environment[fileVariable];
    if (!file) continue;
    if (environment[name]) {
      throw new Error(`${name} and ${fileVariable} must not both be set`);
    }

    const value = (await readFile(file, 'utf8')).replace(/[\r\n]+$/, '');
    if (!value) throw new Error(`${fileVariable} points to an empty secret`);
    environment[name] = value;
    delete environment[fileVariable];
  }
}
