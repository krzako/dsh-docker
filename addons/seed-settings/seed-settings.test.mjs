import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  seedSettings,
  deepEqual,
  FLAG_NAME,
  PROVIDER_FLAG_DIR_NAME,
  loadYaml,
  providerFlagName,
  providerFlagPath,
} from './seed-settings.mjs'

const execFileAsync = promisify(execFile)
const yaml = loadYaml()
const SCRIPT_PATH = fileURLToPath(new URL('./seed-settings.mjs', import.meta.url))
const SEED_PATH = fileURLToPath(new URL('../../settings.seed.yaml', import.meta.url))

/** The repository seed text, shared by every fixture. */
const SEED_TEXT = await fsp.readFile(SEED_PATH, 'utf8')
const SEED = yaml.parse(SEED_TEXT)

let home

/** Run one seed pass against the fixture home. */
function runSeed(overrides = {}) {
  return seedSettings({
    seedPath: path.join(home, 'settings.seed.yaml'),
    settingsPath: path.join(home, '.dsh', 'settings.yaml'),
    flagPath: path.join(home, '.dsh', FLAG_NAME),
    ...overrides,
  })
}

/** The fixture settings document text. */
async function readSettings() {
  return fsp.readFile(path.join(home, '.dsh', 'settings.yaml'), 'utf8')
}

/** Whether the completion flag exists in the fixture home. */
async function flagExists() {
  try {
    await fsp.access(path.join(home, '.dsh', FLAG_NAME))
    return true
  } catch {
    return false
  }
}

/** Per-provider flag path inside the fixture home, named from the seed. */
function seedProviderFlagPath(adapter, provider) {
  return providerFlagPath(
    path.join(home, '.dsh', PROVIDER_FLAG_DIR_NAME),
    adapter,
    provider,
    SEED[adapter]?.providers?.[provider],
  )
}

/** Write a settings document into the fixture home. */
async function writeSettings(text) {
  await fsp.mkdir(path.join(home, '.dsh'), { recursive: true })
  await fsp.writeFile(path.join(home, '.dsh', 'settings.yaml'), text)
}

/** A settings document mimicking the pre-seed live environment. */
const EXISTING_SETTINGS = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    llama:
      displayName: LLAMA custom
      apiKeyEnv: LLAMA_API_KEY
      api: openai-completions
      baseURL: http://localhost:3099
      models:
        - id: qwen3.6-35b-mtp
          name: qwen3.6-35b-mtp
agent-default-model:
  provider: llama
  model: qwen3.6-35b-mtp
`

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-seed-test-'))
  // Every fixture home carries a copy of the repository seed document.
  await fsp.writeFile(path.join(home, 'settings.seed.yaml'), SEED_TEXT)
})

describe('first seed on an absent document', () => {
  it('seeds the document verbatim from the seed file and creates the flag', async () => {
    const result = await runSeed()

    assert.equal(result.firstSeed, true)
    assert.equal(result.flagCreated, true)
    assert.equal(result.wroteSettings, true)
    assert.equal(await flagExists(), true)

    const text = await readSettings()
    assert.deepEqual(yaml.parse(text), SEED)
    // The commented retryPolicy block stays a comment and is never active.
    assert.match(text, /^ *# *retryPolicy:$/m)
    assert.ok(!('retryPolicy' in yaml.parse(text)['llm-pi-ai'].providers.llama))
  })

  it('seeds verbatim over an existing but empty document', async () => {
    await writeSettings('')
    const result = await runSeed()
    assert.equal(result.wroteSettings, true)
    assert.deepEqual(yaml.parse(await readSettings()), SEED)
    assert.equal(await flagExists(), true)
  })
})

describe('first seed over an existing document', () => {
  it('applies one-time and always rules, transfers comments, preserves user content', async () => {
    await writeSettings(EXISTING_SETTINGS)
    const result = await runSeed()

    assert.equal(result.firstSeed, true)
    assert.equal(result.flagCreated, true)
    assert.ok(result.ops.length > 0)

    const text = await readSettings()
    const settings = yaml.parse(text)
    const llama = settings['llm-pi-ai'].providers.llama

    // Unknown user section survives.
    assert.deepEqual(settings['ui-onboarding'], { welcomeNoticeVersion: '2026-08-13.1' })
    // First-seed provider fields overwrite stored values.
    assert.equal(llama.displayName, 'llama')
    assert.equal(llama.defaultContextWindow, 131072)
    assert.equal(llama.streamIdleTimeoutMs, 600000)
    // Global sections are replaced with seed values.
    assert.deepEqual(settings['agent-default-model'], { provider: 'llama', model: 'qwen3.8-27b' })
    assert.deepEqual(settings['permission'], SEED.permission)
    assert.deepEqual(settings['ui-theme'], SEED['ui-theme'])
    assert.deepEqual(settings['agent-presets'], SEED['agent-presets'])
    // Always rules applied on the first seed too.
    assert.deepEqual(llama.defaultInput, ['text', 'image'])
    assert.deepEqual(llama.compat, SEED['llm-pi-ai'].providers.llama.compat)
    // Missing models appended; user models kept.
    const ids = llama.models.map((m) => m.id)
    assert.deepEqual(ids, ['qwen3.6-35b-mtp', 'qwen3.8-27b'])
    // ghe provider added whole.
    const ghe = settings['llm-pi-ai'].providers.ghe
    assert.equal(ghe.baseURL, 'http://host.docker.internal:3098/v1')
    assert.equal(ghe.models.length, SEED['llm-pi-ai'].providers.ghe.models.length)
    // The commented retryPolicy block was transferred and stays a comment.
    assert.match(text, /^ *# *retryPolicy:$/m)
    assert.ok(!('retryPolicy' in llama))
  })

  it('does not duplicate a model that already exists with custom options', async () => {
    await writeSettings(EXISTING_SETTINGS.replace('agent-default-model:', `    ghe:
      models:
        - id: auto
        - id: claude-opus-4.7
          myCustomOption: keep-me
agent-default-model:`))
    await runSeed()

    const settings = yaml.parse(await readSettings())
    const gheModels = settings['llm-pi-ai'].providers.ghe.models
    const opus = gheModels.find((m) => m.id === 'claude-opus-4.7')
    assert.equal(opus.myCustomOption, 'keep-me')
    assert.equal(gheModels.filter((m) => m.id === 'claude-opus-4.7').length, 1)
    // Other seed models were appended.
    assert.ok(gheModels.some((m) => m.id === 'gpt-5.6-sol'))
  })
})

describe('runs after the flag exists', () => {
  beforeEach(async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed()
  })

  it('is idempotent: a second run changes nothing', async () => {
    const before = await readSettings()
    const result = await runSeed()
    assert.equal(result.changed, false)
    assert.equal(result.flagCreated, false)
    assert.equal(await readSettings(), before)
  })

  it('forces defaultInput back to the seed value', async () => {
    await writeSettings((await readSettings()).replace(/defaultInput: \[ ?text, ?image ?\]/, 'defaultInput: [text]'))
    const result = await runSeed()
    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.deepEqual(settings['llm-pi-ai'].providers.llama.defaultInput, ['text', 'image'])
  })

  it('replaces compat every run and keeps the seed as the source of truth', async () => {
    await writeSettings((await readSettings()).replace('thinkingFormat: chat-template', 'thinkingFormat: maybe'))
    const result = await runSeed()
    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.deepEqual(settings['llm-pi-ai'].providers.llama.compat, SEED['llm-pi-ai'].providers.llama.compat)
  })

  it('appends missing seed models and never touches existing ones', async () => {
    let text = await readSettings()
    // Add a custom option to an existing seed model and drop a seed model.
    text = text.replace('        - id: auto\n', '        - id: auto\n          renamed: true\n')
    text = text.replace('        - id: gpt-5.6-terra\n', '')
    await writeSettings(text)

    const result = await runSeed()
    assert.equal(result.changed, true)

    const settings = yaml.parse(await readSettings())
    const gheModels = settings['llm-pi-ai'].providers.ghe.models
    assert.equal(gheModels.find((m) => m.id === 'auto').renamed, true)
    assert.ok(gheModels.some((m) => m.id === 'gpt-5.6-terra'))
  })

  it('re-adds a provider the user deleted, whole from the seed', async () => {
    let text = await readSettings()
    text = text.replace(/    ghe:\n(      .*\n|\n)+/, '')
    await writeSettings(text)

    const result = await runSeed()
    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.deepEqual(settings['llm-pi-ai'].providers.ghe, SEED['llm-pi-ai'].providers.ghe)
  })

  it('preserves user-only providers, models, and one-time fields', async () => {
    let text = await readSettings()
    text = text.replace('      displayName: llama', '      displayName: my llama')
    text = text.replace('defaultContextWindow: 131072', 'defaultContextWindow: 999')
    text = text.replace('    ghe:', '    my-own:\n      displayName: My Own\n      models:\n        - id: my-own-model\n    ghe:')
    text = text.replace('model: qwen3.8-27b', 'model: my-own-model')
    text = text.replace('preference: dark', 'preference: light')
    await writeSettings(text)

    const result = await runSeed()
    const settings = yaml.parse(await readSettings())
    const llama = settings['llm-pi-ai'].providers.llama

    // One-time fields keep the user's edits after the flag exists.
    assert.equal(llama.displayName, 'my llama')
    assert.equal(llama.defaultContextWindow, 999)
    assert.equal(settings['agent-default-model'].model, 'my-own-model')
    assert.equal(settings['ui-theme'].preference, 'light')
    // User-only provider and model survive.
    assert.deepEqual(settings['llm-pi-ai'].providers['my-own'].models, [{ id: 'my-own-model' }])
    assert.ok(llama.models.some((m) => m.id === 'qwen3.8-27b'))
    assert.equal(result.firstSeed, false)
  })

  it('never re-activates the commented retryPolicy block', async () => {
    const result = await runSeed()
    assert.equal(result.changed, false)
    const text = await readSettings()
    assert.match(text, /^ *# *retryPolicy:$/m)
    assert.ok(!('retryPolicy' in yaml.parse(text)['llm-pi-ai'].providers.llama))
  })

  it('re-seeds verbatim when the document was deleted while the flag exists', async () => {
    await fsp.unlink(path.join(home, '.dsh', 'settings.yaml'))
    const result = await runSeed()
    assert.equal(result.firstSeed, false)
    assert.equal(result.flagCreated, false)
    assert.equal(await flagExists(), true)
    assert.deepEqual(yaml.parse(await readSettings()), SEED)
  })
})

describe('failure handling', () => {
  it('fails loud on an unparsable settings document without writing or flagging', async () => {
    await writeSettings('llm-pi-ai:\n  providers: [broken\n')
    await assert.rejects(() => runSeed(), /invalid settings document/)
    assert.equal(await flagExists(), false)
    assert.equal(await readSettings(), 'llm-pi-ai:\n  providers: [broken\n')
  })

  it('fails loud when the seed file is missing', async () => {
    await assert.rejects(
      () => runSeed({ seedPath: path.join(home, 'no-such-seed.yaml') }),
      /not found/,
    )
    assert.equal(await flagExists(), false)
  })

  it('fails loud when the seed has no llm-pi-ai.providers map', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await assert.rejects(
      () => runSeed({ seedText: 'ui-theme:\n  preference: dark\n' }),
      /providers map/,
    )
    assert.equal(await flagExists(), false)
  })
})

describe('atomicity', () => {
  it('leaves no temp files behind', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed()
    const files = await fsp.readdir(path.join(home, '.dsh'))
    assert.ok(!files.some((f) => f.includes('.seed-tmp-')), `unexpected temp files: ${files.join(', ')}`)
  })

  it('writes the document with owner-only permissions', async () => {
    await runSeed()
    const stat = await fsp.stat(path.join(home, '.dsh', 'settings.yaml'))
    assert.equal(stat.mode & 0o777, 0o600)
    const flag = await fsp.stat(path.join(home, '.dsh', FLAG_NAME))
    assert.equal(flag.mode & 0o777, 0o600)
  })
})

describe('deepEqual helper', () => {
  it('ignores map key order and distinguishes arrays', () => {
    assert.equal(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true)
    assert.equal(deepEqual([1, 2], [2, 1]), false)
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false)
  })
})

describe('CLI smoke test', () => {
  it('runs end-to-end with environment overrides and creates the flag', async () => {
    const env = {
      ...process.env,
      SETTINGS_SEED_FILE: SEED_PATH,
      DSH_HOME: path.join(home, '.dsh'),
    }
    const first = await execFileAsync(process.execPath, [SCRIPT_PATH], { env })
    assert.match(first.stdout, /done: changed/)
    assert.equal(await flagExists(), true)

    const second = await execFileAsync(process.execPath, [SCRIPT_PATH], { env })
    assert.match(second.stdout, /done: no changes/)
  })

  it('exits non-zero on a broken settings document', async () => {
    await writeSettings(':::broken:::\n')
    const env = {
      ...process.env,
      SETTINGS_SEED_FILE: SEED_PATH,
      DSH_HOME: path.join(home, '.dsh'),
    }
    await assert.rejects(
      () => execFileAsync(process.execPath, [SCRIPT_PATH], { env }),
      (error) => error.code === 1 && /ERROR/.test(error.stderr + error.stdout),
    )
    assert.equal(await flagExists(), false)
  })
})

describe('per-provider flags', () => {
  beforeEach(async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed()
  })

  it('creates one flag file per provider, named after its apiKeyEnv', async () => {
    const flagDir = path.join(home, '.dsh', PROVIDER_FLAG_DIR_NAME)
    const files = (await fsp.readdir(flagDir)).sort()
    assert.deepEqual(files, ['GHE_API_KEY', 'LLAMA_API_KEY'])
  })

  it('names flags after apiKeyEnv, falling back to {adapter}_{provider}', () => {
    assert.equal(providerFlagName('llm-pi-ai', 'llama', SEED['llm-pi-ai'].providers.llama), 'LLAMA_API_KEY')
    assert.equal(providerFlagName('llm-pi-ai', 'local', { api: 'openai-completions' }), 'llm-pi-ai_local')
    assert.equal(providerFlagName('llm-pi-ai', 'local', undefined), 'llm-pi-ai_local')
    assert.equal(providerFlagName('llm-pi-ai', 'local', { apiKeyEnv: 'bad/name' }), 'llm-pi-ai_local')
  })

  it('re-applies one-time fields only for the provider whose flag was removed', async () => {
    let text = await readSettings()
    text = text.replace('      displayName: llama', '      displayName: my llama')
    text = text.replace('baseURL: http://host.docker.internal:3098/v1', 'baseURL: http://example.internal:1/v1')
    text = text.replace('model: qwen3.8-27b', 'model: qwen3.6-35b-mtp')
    await writeSettings(text)
    await fsp.unlink(seedProviderFlagPath('llm-pi-ai', 'ghe'))

    const result = await runSeed()
    assert.equal(result.changed, true)

    const settings = yaml.parse(await readSettings())
    const providers = settings['llm-pi-ai'].providers
    // llama's flag still exists: its one-time edit survives.
    assert.equal(providers.llama.displayName, 'my llama')
    // ghe's flag was removed: the seed re-applied its one-time fields.
    assert.equal(providers.ghe.baseURL, 'http://host.docker.internal:3098/v1')
    assert.equal(providers.ghe.apiKeyEnv, 'GHE_API_KEY')
    // Global sections stay untouched (global flag still present).
    assert.equal(settings['agent-default-model'].model, 'qwen3.6-35b-mtp')
    // The ghe flag was recreated after the successful pass.
    assert.ok(existsSync(seedProviderFlagPath('llm-pi-ai', 'ghe')))
  })
})

describe('CLI list and reset modes', () => {
  /** CLI environment pointing at the fixture home and the repository seed. */
  const cliEnv = () => ({
    ...process.env,
    SETTINGS_SEED_FILE: SEED_PATH,
    DSH_HOME: path.join(home, '.dsh'),
  })

  it('lists adapters and providers, one per line', async () => {
    const adapters = await execFileAsync(process.execPath, [SCRIPT_PATH, '--list-adapters'], { env: cliEnv() })
    assert.equal(adapters.stdout.trim(), 'llm-pi-ai')
    const providers = await execFileAsync(
      process.execPath,
      [SCRIPT_PATH, '--list-providers', '--adapter', 'llm-pi-ai'],
      { env: cliEnv() },
    )
    assert.deepEqual(providers.stdout.trim().split('\n').sort(), ['ghe', 'llama'])
  })

  it('exits non-zero for an unknown adapter or provider', async () => {
    await assert.rejects(
      () => execFileAsync(process.execPath, [SCRIPT_PATH, '--list-providers', '--adapter', 'nope'], { env: cliEnv() }),
      (error) => error.code === 1 && /unknown adapter/.test(error.stderr + error.stdout),
    )
    await assert.rejects(
      () => execFileAsync(
        process.execPath,
        [SCRIPT_PATH, '--reset-api-key', '--adapter', 'llm-pi-ai', '--provider', 'nope'],
        { env: cliEnv() },
      ),
      (error) => error.code === 1 && /no provider/.test(error.stderr + error.stdout),
    )
  })

  it('removes only the selected provider flag via --reset-api-key', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed()
    const args = [SCRIPT_PATH, '--reset-api-key', '--adapter', 'llm-pi-ai', '--provider', 'llama']

    const removed = await execFileAsync(process.execPath, args, { env: cliEnv() })
    assert.match(removed.stdout, /Removed api-key flag: .*LLAMA_API_KEY/)
    assert.ok(!existsSync(seedProviderFlagPath('llm-pi-ai', 'llama')))
    assert.ok(existsSync(seedProviderFlagPath('llm-pi-ai', 'ghe')))

    const again = await execFileAsync(process.execPath, args, { env: cliEnv() })
    assert.match(again.stdout, /No api-key flag present/)
  })

  it('re-applies the reset provider one-time fields on the next seed run', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed()
    await execFileAsync(
      process.execPath,
      [SCRIPT_PATH, '--reset-api-key', '--adapter', 'llm-pi-ai', '--provider', 'llama'],
      { env: cliEnv() },
    )

    let text = await readSettings()
    text = text.replace('      displayName: llama', '      displayName: user renamed')
    await writeSettings(text)

    const result = await runSeed()
    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.equal(settings['llm-pi-ai'].providers.llama.displayName, 'llama')
  })
})
