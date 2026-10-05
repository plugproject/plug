import { createGenerator } from 'ts-json-schema-generator';
import { writeFileSync } from 'node:fs';
const schema = createGenerator({
  path: 'schema/draft/schema.ts',
  tsconfig: 'tsconfig.json',
  type: '*',
  expose: 'export',
  jsDoc: 'extended',
  additionalProperties: false,
  skipTypeCheck: false,
}).createSchema('*');
writeFileSync(
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
  'WorkspaceIndex',
  'PatternDefinition',
  'WorkflowSpecMetadata',
  'WorkflowTaskMetadata',
];
const validators = standaloneCode(
  ajv,
  Object.fromEntries(roots.map((root) => [root, `plug#/definitions/${root}`])),
);
writeFileSync(
  'schema/draft/validators.js',
  '// Generated from schema.ts; do not edit.\n' + validators + '\n',
);
writeFileSync(
  'schema/draft/validators.d.ts',
  "// Generated from schema.ts; do not edit.\nimport type { ValidateFunction } from 'ajv';\n" +
    roots
      .map((root) => `export declare const ${root}: ValidateFunction;`)
      .join('\n') +
    '\n',
);
