import { constants, closeSync, openSync, writeFileSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphError, sha256 } from './io.mjs';
import { lstatHostSync, fstatHostSync, crossStatIdentity, isPrivateMode } from './host-filesystem.mjs';
import { learningNativeFile } from './learning-native-files.mjs';
import { claudeLearningArgs, runClaudeLearningProtocol } from './learning-native-claude-protocol.mjs';
import { verifyExternalLearningToolchain, externalLearningConfigurationSnapshot, assertClaudeLearningAuthentication } from './learning-external-runner.mjs';

function writeResult(output) {
  const file = path.join(process.cwd(), 'result.json'), before = lstatHostSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== 0n || !isPrivateMode(before))
    throw new GraphError('LEARNING_RESULT_UNSAFE', 'Учебный файл результата заменен.');
  const fd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (crossStatIdentity(fstatHostSync(fd, { bigint: true })) !== crossStatIdentity(before))
      throw new GraphError('LEARNING_RESULT_UNSAFE', 'Учебный файл результата заменен.');
    writeFileSync(fd, output); fsyncSync(fd);
  } finally { closeSync(fd); }
}

async function main() {
  const binding = JSON.parse(process.argv[2]);
  verifyExternalLearningToolchain(binding.toolchain);
  const check = () => {
    if (externalLearningConfigurationSnapshot(process.env) !== binding.snapshot)
      throw new GraphError('LEARNING_PROVIDER_DRIFT', 'Настройки изменились до передачи материала.');
  };
  check(); assertClaudeLearningAuthentication(binding.toolchain.executable, process.env, process.cwd());
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 128 * 1024) throw new GraphError('LEARNING_INPUT_LIMIT', 'Учебный вход превышает лимит.');
    chunks.push(chunk);
  }
  const schemaFile = learningNativeFile(path.join(process.cwd(), 'schema.json'), { content: true, maximum: 32 * 1024 });
  const input = Buffer.concat(chunks).toString('utf8');
  if (schemaFile.hash !== binding.schemaHash || sha256(input) !== binding.inputHash)
    throw new GraphError('LEARNING_PREPARATION_CHANGED', 'Учебный вход или схема изменились.');
  const schema = JSON.parse(schemaFile.bytes.toString('utf8'));
  const { output } = await runClaudeLearningProtocol({
    command: { executable: binding.toolchain.executable, args: claudeLearningArgs(binding), cwd: process.cwd(), env: process.env },
    selection: binding, input, schema,
    expectedConfigurationHash: binding.configurationHash, beforeInput: check, timeoutMs: 115000,
  });
  check(); writeResult(output);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    process.stderr.write(`${error instanceof GraphError ? error.code : 'LEARNING_PROVIDER_FAILED'}\n`); process.exitCode = 1;
  }
}
