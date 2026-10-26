import { createGenerator } from 'ts-json-schema-generator';
import { readFileSync, writeFileSync } from 'node:fs';

// Write only on content change so watchers (tsx watch) don't restart spuriously.
const writeIfChanged = (path: string, text: string) => {
  try {
    if (readFileSync(path, 'utf8') === text) return;
  } catch {
    // Missing file: fall through and write.
  }
  writeFileSync(path, text);
};
const schema = createGenerator({
  path: 'schema/draft/schema.ts',
  tsconfig: 'tsconfig.json',
  type: '*',
  expose: 'export',
  jsDoc: 'extended',
  additionalProperties: false,
  skipTypeCheck: false,
}).createSchema('*');
writeIfChanged(
  'schema/draft/schema.json',
  JSON.stringify(schema, null, 2) + '\n',
);

// Standalone validators keep browsers compatible with script-src 'self': no runtime eval.
const { default: Ajv } = await import('ajv');
const { default: standaloneCode } =
  await import('ajv/dist/standalone/index.js');
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  code: { source: true, esm: true },
});
ajv.addSchema(schema, 'plug');
const roots = [
  'DesignInput',
  'SystemProfile',
  'DesignRecommendation',
  'DemoEvent',
  'SystemDescription',
  'RunnerConfig',
  'SourceResponse',
  'AuthorizedHost',
  'ProbeEvent',
  'OperationManifest',
  'VerificationRecord',
  'WorkspaceIndex',
  'PatternDefinition',
  'WorkflowSpecMetadata',
  'WorkflowTaskMetadata',
];
const validators = standaloneCode(
  ajv,
  Object.fromEntries(roots.map((root) => [root, `plug#/definitions/${root}`])),
);
writeIfChanged(
  'schema/draft/validators.js',
  '// Generated from schema.ts; do not edit.\n' + validators + '\n',
);
writeIfChanged(
  'schema/draft/validators.d.ts',
  "// Generated from schema.ts; do not edit.\nimport type { ValidateFunction } from 'ajv';\n" +
    roots
      .map((root) => `export declare const ${root}: ValidateFunction;`)
      .join('\n') +
    '\n',
);
