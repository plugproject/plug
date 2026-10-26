import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';

export type PlugEnvironmentState = 'disabled' | 'ready' | 'incomplete';

export interface PlugFeatureEnvironmentStatus {
  state: PlugEnvironmentState;
  provider: string | null;
  missing: string[];
  issues: string[];
}

export interface PlugEnvironmentStatus {
  /** Deterministic analysis, indexing, interchange and spec reads need no credentials. */
  core: { state: 'ready'; required: [] };
  judgment: PlugFeatureEnvironmentStatus;
  drafting: PlugFeatureEnvironmentStatus;
  review: PlugFeatureEnvironmentStatus;
}

export interface PlugEnvironmentVariable {
  name: string;
  secret: boolean;
  role: 'judgment' | 'drafting' | 'review' | 'deployment' | 'release';
  requiredWhen: string;
}

/** Canonical inventory for setup UIs built on the package. */
export const plugEnvironmentVariables: readonly PlugEnvironmentVariable[] = [
  {
    name: 'TYPESAFE_API_KEY',
    secret: true,
    role: 'judgment',
    requiredWhen: 'Jev typed judgments or cross-checks are enabled.',
  },
  {
    name: 'PLUG_JUDGE_PROVIDER',
    secret: false,
    role: 'judgment',
    requiredWhen:
      'Selects typesafe, anthropic, openai or the explicit test-only stub; inferred from a single configured API key when omitted.',
  },
  {
    name: 'PLUG_JUDGE_MODEL',
    secret: false,
    role: 'judgment',
    requiredWhen: 'Any model-backed judgment is enabled.',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    secret: true,
    role: 'drafting',
    requiredWhen: 'Anthropic supplies a configured model role.',
  },
  {
    name: 'OPENAI_API_KEY',
    secret: true,
    role: 'drafting',
    requiredWhen: 'OpenAI supplies a configured model role.',
  },
  {
    name: 'PLUG_DRAFT_PROVIDER',
    secret: false,
    role: 'drafting',
    requiredWhen:
      'Selects anthropic or openai for fact and request-sample drafting; inferred from a single configured completion API key when omitted.',
  },
  {
    name: 'PLUG_DRAFT_MODEL',
    secret: false,
    role: 'drafting',
    requiredWhen: 'Completion-backed drafting is enabled.',
  },
  {
    name: 'PLUG_REVIEW_PROVIDER',
    secret: false,
    role: 'review',
    requiredWhen:
      'A design critic should differ from PLUG_DRAFT_PROVIDER; otherwise the draft provider is reused.',
  },
  {
    name: 'PLUG_REVIEW_MODEL',
    secret: false,
    role: 'review',
    requiredWhen:
      'A design critic should differ from PLUG_DRAFT_MODEL; otherwise the draft model is reused.',
  },
  {
    name: 'APP_ORIGIN',
    secret: false,
    role: 'deployment',
    requiredWhen: 'The hosted playground is deployed at a public HTTPS origin.',
  },
  {
    name: 'PORT',
    secret: false,
    role: 'deployment',
    requiredWhen:
      'The hosting platform assigns a port; the standalone server defaults to 3000.',
  },
  {
    name: 'TRUST_PROXY_HOPS',
    secret: false,
    role: 'deployment',
    requiredWhen:
      'A verified proxy topology requires an exact non-zero hop count; defaults to 0.',
  },
  {
    name: 'RELEASE_COMMIT',
    secret: false,
    role: 'release',
    requiredWhen:
      'A non-Render deployment should expose release metadata in /healthz.',
  },
  {
    name: 'RENDER_GIT_COMMIT',
    secret: false,
    role: 'release',
    requiredWhen: 'Render supplies release metadata automatically.',
  },
];

const value = (
  env: Record<string, string | undefined>,
  name: string,
): string | undefined => {
  const candidate = env[name]?.trim();
  return candidate ? candidate : undefined;
};

const completionProvider = (
  env: Record<string, string | undefined>,
  explicitName: string,
) =>
  value(env, explicitName) ??
  (value(env, 'ANTHROPIC_API_KEY')
    ? 'anthropic'
    : value(env, 'OPENAI_API_KEY')
      ? 'openai'
      : undefined);

const providerStatus = (
  provider: string | undefined,
  allowed: readonly string[],
  keyName: (provider: string) => string,
  model: string | undefined,
  env: Record<string, string | undefined>,
): PlugFeatureEnvironmentStatus => {
  if (!provider)
    return { state: 'disabled', provider: null, missing: [], issues: [] };
  if (provider === 'stub')
    return { state: 'ready', provider, missing: [], issues: [] };
  if (!allowed.includes(provider))
    return {
      state: 'incomplete',
      provider,
      missing: [],
      issues: [`Unsupported provider ${provider}.`],
    };
  const missing = [
    ...(value(env, keyName(provider)) ? [] : [keyName(provider)]),
    ...(model ? [] : ['model']),
  ];
  return {
    state: missing.length ? 'incomplete' : 'ready',
    provider,
    missing,
    issues: [],
  };
};

/** Reports capability readiness without returning or logging any secret value. */
export function inspectPlugEnvironment(
  env: Record<string, string | undefined> = process.env,
): PlugEnvironmentStatus {
  const judgeProvider =
    value(env, 'PLUG_JUDGE_PROVIDER') ??
    (value(env, 'TYPESAFE_API_KEY')
      ? 'typesafe'
      : value(env, 'ANTHROPIC_API_KEY')
        ? 'anthropic'
        : value(env, 'OPENAI_API_KEY')
          ? 'openai'
          : undefined);
  const draftProvider = completionProvider(env, 'PLUG_DRAFT_PROVIDER');
  const reviewProvider =
    value(env, 'PLUG_REVIEW_PROVIDER') ??
    draftProvider ??
    completionProvider(env, 'PLUG_REVIEW_PROVIDER');
  const completionKey = (provider: string) =>
    provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const judgment = providerStatus(
    judgeProvider,
    ['typesafe', 'anthropic', 'openai'],
    (provider) =>
      provider === 'typesafe' ? 'TYPESAFE_API_KEY' : completionKey(provider),
    value(env, 'PLUG_JUDGE_MODEL'),
    env,
  );
  if (judgment.missing.includes('model'))
    judgment.missing[judgment.missing.indexOf('model')] = 'PLUG_JUDGE_MODEL';
  const drafting = providerStatus(
    draftProvider,
    ['anthropic', 'openai'],
    completionKey,
    value(env, 'PLUG_DRAFT_MODEL'),
    env,
  );
  if (drafting.missing.includes('model'))
    drafting.missing[drafting.missing.indexOf('model')] = 'PLUG_DRAFT_MODEL';
  const review = providerStatus(
    reviewProvider,
    ['anthropic', 'openai'],
    completionKey,
    value(env, 'PLUG_REVIEW_MODEL') ?? value(env, 'PLUG_DRAFT_MODEL'),
    env,
  );
  if (review.missing.includes('model'))
    review.missing[review.missing.indexOf('model')] = 'PLUG_REVIEW_MODEL';
  return {
    core: { state: 'ready', required: [] },
    judgment,
    drafting,
    review,
  };
}

const localEnvironment = (
  workspace: string,
  env: Record<string, string | undefined>,
) => {
  const path = join(resolve(workspace), '.env.local');
  const fromFile = existsSync(path)
    ? (parseEnv(readFileSync(path, 'utf8')) as Record<string, string>)
    : {};
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const [name, configured] of Object.entries(env))
    if (configured !== undefined) merged[name] = configured;
  return { path, merged };
};

/** Inspects the process environment plus the workspace's `.env.local`. */
export function inspectWorkspaceEnvironment(
  workspace = '.',
  env: Record<string, string | undefined> = process.env,
): PlugEnvironmentStatus {
  return inspectPlugEnvironment(localEnvironment(workspace, env).merged);
}

export interface PlugSetupPrompt {
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  select(
    message: string,
    options: readonly { value: string; label: string }[],
    defaultValue: string,
  ): Promise<string>;
  input(
    message: string,
    options?: {
      secret?: boolean;
      defaultValue?: string;
    },
  ): Promise<string>;
}

export interface PlugEnvironmentSetupResult {
  action: 'created' | 'updated' | 'unchanged';
  file: string;
  gitignore: 'updated' | 'unchanged';
  written: string[];
  status: PlugEnvironmentStatus;
}

export class PlugEnvironmentSetupError extends Error {}

const ignoresLocalEnvironment = (text: string) =>
  text.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    return (
      !line.startsWith('!') &&
      ['.env.local', '/.env.local', '.env*', '/.env*'].includes(line)
    );
  });

const appendLine = (text: string, line: string) =>
  `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;

const safeInput = (input: string, name: string) => {
  const trimmed = input.trim();
  if (!trimmed) throw new PlugEnvironmentSetupError(`${name} cannot be empty.`);
  if (/[\0\r\n]/.test(trimmed))
    throw new PlugEnvironmentSetupError(`${name} must be one line.`);
  return trimmed;
};

const envLine = (name: string, configured: string) =>
  `${name}=${JSON.stringify(configured)}`;

const upsertEnvironment = (
  existing: string,
  updates: Record<string, string>,
) => {
  let text = existing;
  if (!text)
    text =
      '# Plug local configuration. This file may contain secrets; never commit it.\n';
  for (const [name, configured] of Object.entries(updates)) {
    const line = envLine(name, configured);
    const pattern = new RegExp(`^(?:export\\s+)?${name}=.*$`, 'gm');
    const present = pattern.test(text);
    pattern.lastIndex = 0;
    text = present ? text.replace(pattern, line) : appendLine(text, line);
  }
  return text.endsWith('\n') ? text : `${text}\n`;
};

/**
 * Guided setup for package consumers. The caller owns the prompt surface; Plug
 * writes only the selected workspace's ignored `.env.local`.
 */
export async function setupPlugEnvironment(options: {
  workspace?: string;
  env?: Record<string, string | undefined>;
  prompt: PlugSetupPrompt;
}): Promise<PlugEnvironmentSetupResult> {
  const workspace = resolve(options.workspace ?? '.');
  const { path, merged } = localEnvironment(
    workspace,
    options.env ?? process.env,
  );
  const initialExists = existsSync(path);
  const initialFile = initialExists ? readFileSync(path, 'utf8') : '';
  const gitignorePath = join(workspace, '.gitignore');
  let gitignore = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, 'utf8')
    : '';
  let gitignoreAction: PlugEnvironmentSetupResult['gitignore'] = 'unchanged';
  let storagePrepared = ignoresLocalEnvironment(gitignore);
  const updates: Record<string, string> = {};
  const set = (name: string, configured: string) => {
    updates[name] = configured;
    merged[name] = configured;
  };
  const prepareStorage = async () => {
    if (storagePrepared) return;
    const accepted = await options.prompt.confirm(
      'Add .env.local to .gitignore before Plug stores local credentials?',
      true,
    );
    if (!accepted)
      throw new PlugEnvironmentSetupError(
        'Plug did not write credentials because .env.local is not ignored.',
      );
    gitignore = appendLine(gitignore, '.env.local');
    writeFileSync(gitignorePath, gitignore);
    gitignoreAction = 'updated';
    storagePrepared = true;
  };

  const initial = inspectPlugEnvironment(merged);
  if (
    initial.judgment.state !== 'ready' &&
    (await options.prompt.confirm(
      'Configure optional Jev typed judgments and cross-checks?',
      false,
    ))
  ) {
    await prepareStorage();
    const alreadyTypeSafe = initial.judgment.provider === 'typesafe';
    const apiKey =
      value(merged, 'TYPESAFE_API_KEY') ??
      safeInput(
        await options.prompt.input('TypeSafe API key', { secret: true }),
        'TYPESAFE_API_KEY',
      );
    const model =
      alreadyTypeSafe && value(merged, 'PLUG_JUDGE_MODEL')
        ? value(merged, 'PLUG_JUDGE_MODEL')!
        : safeInput(
            await options.prompt.input('Exact Jev model ID'),
            'PLUG_JUDGE_MODEL',
          );
    set('PLUG_JUDGE_PROVIDER', 'typesafe');
    if (!value(merged, 'TYPESAFE_API_KEY')) set('TYPESAFE_API_KEY', apiKey);
    set('PLUG_JUDGE_MODEL', model);
  }

  const afterJudgment = inspectPlugEnvironment(merged);
  if (
    (afterJudgment.drafting.state !== 'ready' ||
      afterJudgment.review.state !== 'ready') &&
    (await options.prompt.confirm(
      'Configure an optional completion provider for drafting and design review?',
      false,
    ))
  ) {
    await prepareStorage();
    const existingProvider = ['anthropic', 'openai'].includes(
      afterJudgment.drafting.provider ?? '',
    )
      ? afterJudgment.drafting.provider!
      : ['anthropic', 'openai'].includes(afterJudgment.review.provider ?? '')
        ? afterJudgment.review.provider!
        : value(merged, 'OPENAI_API_KEY')
          ? 'openai'
          : 'anthropic';
    const provider = await options.prompt.select(
      'Completion provider',
      [
        { value: 'anthropic', label: 'Anthropic' },
        { value: 'openai', label: 'OpenAI' },
      ],
      existingProvider,
    );
    if (!['anthropic', 'openai'].includes(provider))
      throw new PlugEnvironmentSetupError(
        `Unsupported completion provider ${provider}.`,
      );
    const keyName =
      provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const apiKey =
      value(merged, keyName) ??
      safeInput(
        await options.prompt.input(
          provider === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key',
          { secret: true },
        ),
        keyName,
      );
    const existingDraftModel =
      afterJudgment.drafting.provider === provider
        ? value(merged, 'PLUG_DRAFT_MODEL')
        : undefined;
    const draftModel =
      existingDraftModel ??
      safeInput(
        await options.prompt.input('Exact drafting model ID'),
        'PLUG_DRAFT_MODEL',
      );
    const existingReviewModel =
      afterJudgment.review.provider === provider
        ? value(merged, 'PLUG_REVIEW_MODEL')
        : undefined;
    const reviewModel = safeInput(
      await options.prompt.input('Exact review model ID', {
        defaultValue: existingReviewModel ?? draftModel,
      }),
      'PLUG_REVIEW_MODEL',
    );
    if (!value(merged, keyName)) set(keyName, apiKey);
    set('PLUG_DRAFT_PROVIDER', provider);
    set('PLUG_DRAFT_MODEL', draftModel);
    set('PLUG_REVIEW_PROVIDER', provider);
    set('PLUG_REVIEW_MODEL', reviewModel);
  }

  const written = Object.keys(updates);
  if (!written.length)
    return {
      action: 'unchanged',
      file: path,
      gitignore: gitignoreAction,
      written,
      status: inspectPlugEnvironment(merged),
    };
  writeFileSync(path, upsertEnvironment(initialFile, updates), { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    action: initialExists ? 'updated' : 'created',
    file: path,
    gitignore: gitignoreAction,
    written,
    status: inspectPlugEnvironment(merged),
  };
}

class TerminalSetupPrompt implements PlugSetupPrompt {
  private muted = false;
  private readonly output = process.stdout;
  private readonly relay = new Writable({
    write: (chunk, _encoding, callback) => {
      if (!this.muted) this.output.write(chunk, callback);
      else callback();
    },
  });
  private readonly reader = createInterface({
    input: process.stdin,
    output: this.relay,
    terminal: true,
  });

  close() {
    this.reader.close();
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
    for (;;) {
      const answer = (await this.reader.question(message + suffix))
        .trim()
        .toLowerCase();
      if (!answer) return defaultValue;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      this.output.write('Enter yes or no.\n');
    }
  }

  async select(
    message: string,
    options: readonly { value: string; label: string }[],
    defaultValue: string,
  ): Promise<string> {
    this.output.write(`${message}:\n`);
    options.forEach((option, index) =>
      this.output.write(
        `  ${index + 1}. ${option.label}${option.value === defaultValue ? ' (default)' : ''}\n`,
      ),
    );
    for (;;) {
      const answer = (
        await this.reader.question('Choose a number [Enter for default]: ')
      ).trim();
      if (!answer) return defaultValue;
      const selected = options[Number(answer) - 1];
      if (selected) return selected.value;
      this.output.write(`Enter a number from 1 to ${options.length}.\n`);
    }
  }

  async input(
    message: string,
    options: { secret?: boolean; defaultValue?: string } = {},
  ): Promise<string> {
    for (;;) {
      let answer: string;
      if (options.secret) {
        this.output.write(`${message}: `);
        this.muted = true;
        try {
          answer = await this.reader.question('');
        } finally {
          this.muted = false;
          this.output.write('\n');
        }
      } else {
        const suffix = options.defaultValue
          ? ` [${options.defaultValue}] `
          : ': ';
        answer = await this.reader.question(message + suffix);
      }
      const configured = answer.trim() || options.defaultValue;
      if (configured) return configured;
      this.output.write('A value is required.\n');
    }
  }
}

/** Terminal prompt used by `plug setup` and available to Node SDK consumers. */
export async function promptForPlugEnvironment(
  options: {
    workspace?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<PlugEnvironmentSetupResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new PlugEnvironmentSetupError(
      'Interactive setup needs a terminal. Set the documented variables directly or run plug setup in a terminal.',
    );
  const prompt = new TerminalSetupPrompt();
  try {
    return await setupPlugEnvironment({ ...options, prompt });
  } finally {
    prompt.close();
  }
}
