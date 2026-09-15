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
const SEED_PATH = fileURLToPath(new URL('./settings.seed.yaml', import.meta.url))

/** The repository seed text, shared by every fixture. */
const SEED_TEXT = await fsp.readFile(SEED_PATH, 'utf8')
const SEED = yaml.parse(SEED_TEXT)

/**
 * The seed text with one extra openrouter model, for merge tests that need a
 * seed model a stored document cannot know yet.
 */
const SEED_TEXT_EXTRA_MODEL = SEED_TEXT.replace(
  '        - id: z-ai/glm-5.3-flash\n          name: GLM 5.3 Flash\n          contextWindow: 500000\n          maxTokens: 131072',
  '        - id: z-ai/glm-5.3-flash\n          name: GLM 5.3 Flash\n          contextWindow: 500000\n          maxTokens: 131072\n        - id: z-ai/glm-5.2\n          name: GLM 5.2',
)
assert.notEqual(SEED_TEXT_EXTRA_MODEL, SEED_TEXT)

/**
 * The seed document without the providers an empty environment gates off:
 * what a seed pass stores when no gated key variable holds a value.
 */
function seedWithoutEnvGated() {
  const copy = structuredClone(SEED)
  for (const section of Object.values(copy)) {
    if (!section || typeof section !== 'object' || !section.providers) continue
    for (const [name, provider] of Object.entries(section.providers)) {
      if (provider && provider.apiKeyEnvRequired === true) delete section.providers[name]
    }
  }
  return copy
}
const SEED_NO_KEY = seedWithoutEnvGated()

/** The environment that seeds the copilot provider. */
const COPILOT_KEY = { COPILOT_PROXY_API_KEY: 'test-copilot-key' }

/** The seed's copilot provider without the seed-only marker field. */
function seededCopilot() {
  const provider = structuredClone(SEED['llm-pi-ai'].providers.copilot_proxy)
  delete provider.apiKeyEnvRequired
  return provider
}

let home

/** Run one seed pass against the fixture home. */
function runSeed({ env = {}, ...overrides } = {}) {
  return seedSettings({
    seedPath: path.join(home, 'settings.seed.yaml'),
    settingsPath: path.join(home, '.dsh', 'settings.yaml'),
    flagPath: path.join(home, '.dsh', FLAG_NAME),
    // Deterministic environment: the env-gated provider stays off unless a
    // test passes a key explicitly.
    env,
    ...overrides,
  })
}

/** The fixture settings document text. */
async function readSettings() {
  return fsp.readFile(path.join(home, '.dsh', 'settings.yaml'), 'utf8')
}

/** The fixture credentials document path. */
function credentialsPath() {
  return path.join(home, '.dsh', '.credentials.yaml')
}

/** The fixture credentials document text, or undefined when it is absent. */
async function readCredentials() {
  try {
    return await fsp.readFile(credentialsPath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Write a credentials document into the fixture home. */
async function writeCredentials(text) {
  await fsp.mkdir(path.join(home, '.dsh'), { recursive: true })
  await fsp.writeFile(credentialsPath(), text, { mode: 0o600 })
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
    llm_proxy:
      displayName: llm_proxy custom
      apiKeyEnv: LLM_PROXY_API_KEY
      api: openai-completions
      baseURL: http://llm-proxy:9090
      models:
        - id: qwen3.6-35b-a3b
          name: qwen3.6-35b-a3b
agent-default-model:
  provider: llm_proxy
  model: qwen3.6-35b-a3b
`

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-seed-test-'))
  // Every fixture home carries a copy of the repository seed document.
  await fsp.writeFile(path.join(home, 'settings.seed.yaml'), SEED_TEXT)
})

describe('first seed on an absent document', () => {
  it('seeds the document from the seed file while no gated key is set', async () => {
    const result = await runSeed()

    assert.equal(result.firstSeed, true)
    assert.equal(result.flagCreated, true)
    assert.equal(result.wroteSettings, true)
    assert.equal(await flagExists(), true)

    const text = await readSettings()
    assert.deepEqual(yaml.parse(text), SEED_NO_KEY)
    // The commented retryPolicy block stays a comment and is never active.
    assert.match(text, /^ *# *retryPolicy:$/m)
    assert.ok(!('retryPolicy' in yaml.parse(text)['llm-pi-ai'].providers.llm_proxy))
  })

  it('seeds over an existing but empty document', async () => {
    await writeSettings('')
    const result = await runSeed()
    assert.equal(result.wroteSettings, true)
    assert.deepEqual(yaml.parse(await readSettings()), SEED_NO_KEY)
    assert.equal(await flagExists(), true)
  })
})

describe('first seed over an existing document', () => {
  it('applies one-time and always rules, transfers comments, preserves user content', async () => {
    await writeSettings(EXISTING_SETTINGS)
    const result = await runSeed({ env: COPILOT_KEY })

    assert.equal(result.firstSeed, true)
    assert.equal(result.flagCreated, true)
    assert.ok(result.ops.length > 0)

    const text = await readSettings()
    const settings = yaml.parse(text)
    const llm_proxy = settings['llm-pi-ai'].providers.llm_proxy

    // The env-gated provider stays out while its key variable is empty.
    assert.equal(settings['llm-pi-ai'].providers.openrouter, undefined)
    // Unknown user section survives.
    assert.deepEqual(settings['ui-onboarding'], { welcomeNoticeVersion: '2026-08-13.1' })
    // First-seed provider fields overwrite stored values.
    assert.equal(llm_proxy.displayName, 'llm_proxy')
    assert.equal(llm_proxy.defaultContextWindow, 131072)
    assert.equal(llm_proxy.streamIdleTimeoutMs, 600000)
    // Global sections are replaced with seed values.
    assert.deepEqual(settings['agent-default-model'], { provider: 'llm_proxy', model: 'qwen3.8-27b' })
    assert.deepEqual(settings['permission'], SEED.permission)
    assert.deepEqual(settings['ui-theme'], SEED['ui-theme'])
    assert.deepEqual(settings['agent-presets'], SEED['agent-presets'])
    // Always rules applied on the first seed too.
    assert.deepEqual(llm_proxy.defaultInput, ['text', 'image'])
    assert.deepEqual(llm_proxy.compat, SEED['llm-pi-ai'].providers.llm_proxy.compat)
    // Missing models appended; user models kept.
    const ids = llm_proxy.models.map((m) => m.id)
    assert.deepEqual(ids, ['qwen3.6-35b-a3b', 'qwen3.8-27b'])
    // copilot_proxy provider added whole.
    const copilot_proxy = settings['llm-pi-ai'].providers.copilot_proxy
    assert.equal(copilot_proxy.baseURL, 'http://copilot-proxy:9091/v1')
    assert.deepEqual(copilot_proxy.headers, { 'x-proxy-source': 'deepseek-harness' })
    assert.deepEqual(copilot_proxy.compat, {
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: 'openrouter',
    })
    assert.equal(copilot_proxy.models.length, SEED['llm-pi-ai'].providers.copilot_proxy.models.length)
    // The commented retryPolicy block was transferred and stays a comment.
    assert.match(text, /^ *# *retryPolicy:$/m)
    assert.ok(!('retryPolicy' in llm_proxy))
  })

  it('does not duplicate a model that already exists with custom options', async () => {
    await writeSettings(EXISTING_SETTINGS.replace('agent-default-model:', `    copilot_proxy:
      models:
        - id: auto
        - id: claude-opus-4.7
          myCustomOption: keep-me
agent-default-model:`))
    await runSeed({ env: COPILOT_KEY })

    const settings = yaml.parse(await readSettings())
    const copilotProxyModels = settings['llm-pi-ai'].providers.copilot_proxy.models
    const opus = copilotProxyModels.find((m) => m.id === 'claude-opus-4.7')
    assert.equal(opus.myCustomOption, 'keep-me')
    assert.equal(copilotProxyModels.filter((m) => m.id === 'claude-opus-4.7').length, 1)
    // Other seed models were appended.
    assert.ok(copilotProxyModels.some((m) => m.id === 'gpt-5.6-sol'))
  })
})

describe('runs after the flag exists', () => {
  beforeEach(async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed({ env: COPILOT_KEY })
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
    assert.deepEqual(settings['llm-pi-ai'].providers.llm_proxy.defaultInput, ['text', 'image'])
  })

  it('replaces compat every run and keeps the seed as the source of truth', async () => {
    await writeSettings((await readSettings()).replace('thinkingFormat: chat-template', 'thinkingFormat: maybe'))
    const result = await runSeed()
    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.deepEqual(settings['llm-pi-ai'].providers.llm_proxy.compat, SEED['llm-pi-ai'].providers.llm_proxy.compat)
  })

  it('appends missing seed models and never touches existing ones', async () => {
    // Add a custom option to an existing seed model and drop a seed model.
    const seeded = yaml.parse(await readSettings())
    const copilotModels = seeded['llm-pi-ai'].providers.copilot_proxy.models
    copilotModels.find((m) => m.id === 'auto').renamed = true
    seeded['llm-pi-ai'].providers.copilot_proxy.models = copilotModels.filter((m) => m.id !== 'gpt-5.6-terra')
    await writeSettings(yaml.stringify(seeded))

    const result = await runSeed({ env: COPILOT_KEY })
    assert.equal(result.changed, true)

    const settings = yaml.parse(await readSettings())
    const copilotProxyModels = settings['llm-pi-ai'].providers.copilot_proxy.models
    assert.equal(copilotProxyModels.find((m) => m.id === 'auto').renamed, true)
    assert.deepEqual(
      copilotProxyModels.find((m) => m.id === 'gpt-5.6-terra'),
      SEED['llm-pi-ai'].providers.copilot_proxy.models.find((m) => m.id === 'gpt-5.6-terra'),
    )
  })

  it('re-adds a provider the user deleted, whole from the seed', async () => {
    let text = await readSettings()
    text = text.replace(/    copilot_proxy:\n(      .*\n|\n)+/, '')
    await writeSettings(text)

    const result = await runSeed({ env: COPILOT_KEY })
    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.deepEqual(settings['llm-pi-ai'].providers.copilot_proxy, seededCopilot())
  })

  it('preserves user-only providers, models, and one-time fields', async () => {
    let text = await readSettings()
    text = text.replace('      displayName: llm_proxy', '      displayName: my llm_proxy')
    text = text.replace('defaultContextWindow: 131072', 'defaultContextWindow: 999')
    text = text.replace('    copilot_proxy:', '    my-own:\n      displayName: My Own\n      models:\n        - id: my-own-model\n    copilot_proxy:')
    text = text.replace('model: qwen3.8-27b', 'model: my-own-model')
    text = text.replace('preference: dark', 'preference: light')
    await writeSettings(text)

    const result = await runSeed()
    const settings = yaml.parse(await readSettings())
    const llm_proxy = settings['llm-pi-ai'].providers.llm_proxy

    // One-time fields keep the user's edits after the flag exists.
    assert.equal(llm_proxy.displayName, 'my llm_proxy')
    assert.equal(llm_proxy.defaultContextWindow, 999)
    assert.equal(settings['agent-default-model'].model, 'my-own-model')
    assert.equal(settings['ui-theme'].preference, 'light')
    // User-only provider and model survive.
    assert.deepEqual(settings['llm-pi-ai'].providers['my-own'].models, [{ id: 'my-own-model' }])
    assert.ok(llm_proxy.models.some((m) => m.id === 'qwen3.8-27b'))
    assert.equal(result.firstSeed, false)
  })

  it('never re-activates the commented retryPolicy block', async () => {
    const result = await runSeed()
    assert.equal(result.changed, false)
    const text = await readSettings()
    assert.match(text, /^ *# *retryPolicy:$/m)
    assert.ok(!('retryPolicy' in yaml.parse(text)['llm-pi-ai'].providers.llm_proxy))
  })

  it('re-seeds when the document was deleted while the flag exists', async () => {
    await fsp.unlink(path.join(home, '.dsh', 'settings.yaml'))
    const result = await runSeed()
    assert.equal(result.firstSeed, false)
    assert.equal(result.flagCreated, false)
    assert.equal(await flagExists(), true)
    const expected = structuredClone(SEED_NO_KEY)
    // Its provider flag proves the credential was already persisted, so a
    // deleted settings document restores the route without needing the secret
    // to return to the process environment.
    expected['llm-pi-ai'].providers.copilot_proxy = seededCopilot()
    assert.deepEqual(yaml.parse(await readSettings()), expected)
  })
})

describe('env-gated openrouter provider', () => {
  const OPENROUTER_KEY = { OPENROUTER_API_KEY: 'sk-or-live' }
  const OPENROUTER_FLAG = () => seedProviderFlagPath('llm-pi-ai', 'openrouter')

  it('is skipped entirely while its key variable is empty', async () => {
    await writeSettings(EXISTING_SETTINGS)

    const result = await runSeed({ env: { OPENROUTER_API_KEY: '' } })

    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.equal(settings['llm-pi-ai'].providers.openrouter, undefined)
    assert.equal(existsSync(OPENROUTER_FLAG()), false)
    assert.equal(await readCredentials(), undefined)
  })

  it('adds the provider to an existing document once the key appears', async () => {
    await writeSettings(EXISTING_SETTINGS)

    const result = await runSeed({ env: OPENROUTER_KEY })

    assert.equal(result.changed, true)
    const openrouter = yaml.parse(await readSettings())['llm-pi-ai'].providers.openrouter
    // Seed metadata never reaches the settings document.
    assert.equal(openrouter.apiKeyEnvRequired, undefined)
    assert.equal(openrouter.apiKeyEnv, 'OPENROUTER_API_KEY')
    assert.deepEqual(openrouter.models, SEED['llm-pi-ai'].providers.openrouter.models)
    assert.ok(existsSync(OPENROUTER_FLAG()))
    // The key is stored as a credential reference on the first seed.
    assert.deepEqual(yaml.parse(await readCredentials()), {
      version: 1,
      refs: { OPENROUTER_API_KEY: 'sk-or-live' },
    })
    const stat = await fsp.stat(credentialsPath())
    assert.equal(stat.mode & 0o777, 0o600)
  })

  it('merges seed models into a stored openrouter config without overwriting entries', async () => {
    await writeSettings(EXISTING_SETTINGS.replace('agent-default-model:', [
      '    openrouter:',
      '      apiKeyEnv: OPENROUTER_API_KEY',
      '      api: openai-completions',
      '      baseURL: https://openrouter.ai/api/v1',
      '      models:',
      '        - id: z-ai/glm-5.3-flash',
      '          name: My GLM',
      '          contextWindow: 1',
      '          maxTokens: 2',
      '        - id: my-own/openrouter-model',
      '          name: My Own',
      'agent-default-model:',
    ].join('\n')))

    const result = await runSeed({ env: OPENROUTER_KEY, seedText: SEED_TEXT_EXTRA_MODEL })

    assert.equal(result.changed, true)
    const openrouter = yaml.parse(await readSettings())['llm-pi-ai'].providers.openrouter
    // Stored entries keep their values and order; missing seed models are appended.
    assert.deepEqual(openrouter.models, [
      { id: 'z-ai/glm-5.3-flash', name: 'My GLM', contextWindow: 1, maxTokens: 2 },
      { id: 'my-own/openrouter-model', name: 'My Own' },
      { id: 'z-ai/glm-5.2', name: 'GLM 5.2' },
    ])
  })

  it('keeps merging models after the flag exists and leaves stored credentials alone', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed({ env: OPENROUTER_KEY })

    // The user deletes the seed model and rotates the stored credential.
    const text = (await readSettings())
      .replace('        - id: z-ai/glm-5.3-flash\n          name: GLM 5.3 Flash\n          contextWindow: 500000\n          maxTokens: 131072\n', '')
    await writeSettings(text)
    await writeCredentials((await readCredentials()).replace('sk-or-live', 'user-rotated-key'))

    const result = await runSeed({ env: OPENROUTER_KEY })
    assert.equal(result.changed, true)

    const openrouter = yaml.parse(await readSettings())['llm-pi-ai'].providers.openrouter
    assert.deepEqual(openrouter.models, SEED['llm-pi-ai'].providers.openrouter.models)
    // The provider flag gates the reference write: the stored key survives.
    assert.match(await readCredentials(), /user-rotated-key/)
  })

  it('re-writes the stored key from the environment when the flag is removed', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed({ env: OPENROUTER_KEY })
    await writeCredentials((await readCredentials()).replace('sk-or-live', 'user-rotated-key'))
    await fsp.unlink(OPENROUTER_FLAG())

    await runSeed({ env: { OPENROUTER_API_KEY: 'sk-or-rotated' } })

    const credentials = yaml.parse(await readCredentials())
    assert.equal(credentials.refs.OPENROUTER_API_KEY, 'sk-or-rotated')
    assert.ok(existsSync(OPENROUTER_FLAG()))
  })

  it('preserves comments and other references in the credentials document', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await writeCredentials([
      '# Managed by hand; keep this comment.',
      'version: 1',
      'refs:',
      '  DEEPSEEK_API_KEY: keep-me',
      '',
    ].join('\n'))

    await runSeed({ env: OPENROUTER_KEY })

    const text = await readCredentials()
    assert.match(text, /# Managed by hand; keep this comment./)
    const refs = yaml.parse(text).refs
    assert.equal(refs.DEEPSEEK_API_KEY, 'keep-me')
    assert.equal(refs.OPENROUTER_API_KEY, 'sk-or-live')
  })

  it('is idempotent with the key present', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed({ env: OPENROUTER_KEY })
    const settingsBefore = await readSettings()
    const credentialsBefore = await readCredentials()

    const result = await runSeed({ env: OPENROUTER_KEY })

    assert.equal(result.changed, false)
    assert.equal(await readSettings(), settingsBefore)
    assert.equal(await readCredentials(), credentialsBefore)
  })

  it('fails loud on an unparsable credentials document without writing or flagging', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await writeCredentials('refs: [broken\n')

    await assert.rejects(
      () => runSeed({ env: OPENROUTER_KEY }),
      /invalid credentials document/,
    )
    assert.equal(existsSync(OPENROUTER_FLAG()), false)
    assert.equal(await readCredentials(), 'refs: [broken\n')
    // The settings document write happens only after the credentials parse.
    assert.equal(await readSettings(), EXISTING_SETTINGS)
  })

  it('refuses a credentials document this script cannot own', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await writeCredentials('version: 2\nrefs: {}\n')

    await assert.rejects(
      () => runSeed({ env: OPENROUTER_KEY }),
      /unsupported version/,
    )
    assert.equal(existsSync(OPENROUTER_FLAG()), false)
  })
})

describe('env-gated copilot provider', () => {
  const COPILOT_FLAG = () => seedProviderFlagPath('llm-pi-ai', 'copilot_proxy')

  it('is skipped entirely while its key variable is empty', async () => {
    await writeSettings(EXISTING_SETTINGS)

    const result = await runSeed({ env: {} })

    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.equal(settings['llm-pi-ai'].providers.copilot_proxy, undefined)
    assert.equal(existsSync(COPILOT_FLAG()), false)
    assert.equal(await readCredentials(), undefined)
  })

  it('adds the provider whole once its key appears', async () => {
    await writeSettings(EXISTING_SETTINGS)

    await runSeed({ env: COPILOT_KEY })

    const settings = yaml.parse(await readSettings())
    assert.deepEqual(settings['llm-pi-ai'].providers.copilot_proxy, seededCopilot())
    assert.ok(existsSync(COPILOT_FLAG()))
    assert.deepEqual(yaml.parse(await readCredentials()), {
      version: 1,
      refs: { COPILOT_PROXY_API_KEY: 'test-copilot-key' },
    })
  })

  it('keeps a seeded copilot provider when the key is later empty', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed({ env: COPILOT_KEY })

    const result = await runSeed({ env: {} })

    assert.equal(result.changed, false)
    const settings = yaml.parse(await readSettings())
    assert.deepEqual(settings['llm-pi-ai'].providers.copilot_proxy, seededCopilot())
  })

  it('updates a seeded copilot provider after its key leaves the environment', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed({ env: COPILOT_KEY })

    let text = await readSettings()
    text = text.replace(/      headers:\n        x-proxy-source: deepseek-harness\n/, '')
    text = text.replace(/      compat:\n        sendSessionAffinityHeaders: true\n        sessionAffinityFormat: openrouter\n/, '')
    await writeSettings(text)

    const result = await runSeed({ env: {} })

    assert.equal(result.changed, true)
    const copilot = yaml.parse(await readSettings())['llm-pi-ai'].providers.copilot_proxy
    assert.deepEqual(copilot.headers, { 'x-proxy-source': 'deepseek-harness' })
    assert.deepEqual(copilot.compat, {
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: 'openrouter',
    })
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
    await runSeed({ env: { COPILOT_PROXY_API_KEY: 'test-copilot-key', OPENROUTER_API_KEY: 'sk-or-live' } })
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
      COPILOT_PROXY_API_KEY: '',
      OPENROUTER_API_KEY: '',
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
    await writeSettings('a: [unclosed\n')
    const env = {
      ...process.env,
      COPILOT_PROXY_API_KEY: '',
      OPENROUTER_API_KEY: '',
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
    await runSeed({ env: COPILOT_KEY })
  })

  it('creates one flag file per seeded provider, named after its apiKeyEnv', async () => {
    const flagDir = path.join(home, '.dsh', PROVIDER_FLAG_DIR_NAME)
    const files = (await fsp.readdir(flagDir)).sort()
    assert.deepEqual(files, ['COPILOT_PROXY_API_KEY', 'LLM_PROXY_API_KEY'])
  })

  it('creates the gated provider flag only while its key is set', async () => {
    const flagDir = path.join(home, '.dsh', PROVIDER_FLAG_DIR_NAME)
    await runSeed({ env: { OPENROUTER_API_KEY: 'sk-or-live' } })
    const files = (await fsp.readdir(flagDir)).sort()
    assert.deepEqual(files, ['COPILOT_PROXY_API_KEY', 'LLM_PROXY_API_KEY', 'OPENROUTER_API_KEY'])
  })

  it('names flags after apiKeyEnv, falling back to {adapter}_{provider}', () => {
    assert.equal(providerFlagName('llm-pi-ai', 'llm_proxy', SEED['llm-pi-ai'].providers.llm_proxy), 'LLM_PROXY_API_KEY')
    assert.equal(providerFlagName('llm-pi-ai', 'openrouter', SEED['llm-pi-ai'].providers.openrouter), 'OPENROUTER_API_KEY')
    assert.equal(providerFlagName('llm-pi-ai', 'local', { api: 'openai-completions' }), 'llm-pi-ai_local')
    assert.equal(providerFlagName('llm-pi-ai', 'local', undefined), 'llm-pi-ai_local')
    assert.equal(providerFlagName('llm-pi-ai', 'local', { apiKeyEnv: 'bad/name' }), 'llm-pi-ai_local')
  })

  it('re-applies one-time fields only for the provider whose flag was removed', async () => {
    let text = await readSettings()
    text = text.replace('      displayName: llm_proxy', '      displayName: my llm_proxy')
    text = text.replace('baseURL: http://copilot-proxy:9091/v1', 'baseURL: http://example.internal:1/v1')
    text = text.replace('model: qwen3.8-27b', 'model: qwen3.6-35b-a3b')
    await writeSettings(text)
    await fsp.unlink(seedProviderFlagPath('llm-pi-ai', 'copilot_proxy'))

    const result = await runSeed({ env: COPILOT_KEY })
    assert.equal(result.changed, true)

    const settings = yaml.parse(await readSettings())
    const providers = settings['llm-pi-ai'].providers
    // llm_proxy's flag still exists: its one-time edit survives.
    assert.equal(providers.llm_proxy.displayName, 'my llm_proxy')
    // copilot_proxy's flag was removed: the seed re-applied its one-time fields.
    assert.equal(providers.copilot_proxy.baseURL, 'http://copilot-proxy:9091/v1')
    assert.equal(providers.copilot_proxy.apiKeyEnv, 'COPILOT_PROXY_API_KEY')
    // Global sections stay untouched (global flag still present).
    assert.equal(settings['agent-default-model'].model, 'qwen3.6-35b-a3b')
    // The copilot_proxy flag was recreated after the successful pass.
    assert.ok(existsSync(seedProviderFlagPath('llm-pi-ai', 'copilot_proxy')))
  })
})

describe('CLI list and reset modes', () => {
  /** CLI environment pointing at the fixture home and the repository seed. */
  const cliEnv = () => ({
    ...process.env,
    COPILOT_PROXY_API_KEY: '',
    OPENROUTER_API_KEY: '',
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
    assert.deepEqual(providers.stdout.trim().split('\n').sort(), ['copilot_proxy', 'llm_proxy', 'openrouter'])
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
    await runSeed({ env: COPILOT_KEY })
    const args = [SCRIPT_PATH, '--reset-api-key', '--adapter', 'llm-pi-ai', '--provider', 'llm_proxy']

    const removed = await execFileAsync(process.execPath, args, { env: cliEnv() })
    assert.match(removed.stdout, /Removed api-key flag: .*LLM_PROXY_API_KEY/)
    assert.ok(!existsSync(seedProviderFlagPath('llm-pi-ai', 'llm_proxy')))
    assert.ok(existsSync(seedProviderFlagPath('llm-pi-ai', 'copilot_proxy')))

    const again = await execFileAsync(process.execPath, args, { env: cliEnv() })
    assert.match(again.stdout, /No api-key flag present/)
  })

  it('re-applies the reset provider one-time fields on the next seed run', async () => {
    await writeSettings(EXISTING_SETTINGS)
    await runSeed()
    await execFileAsync(
      process.execPath,
      [SCRIPT_PATH, '--reset-api-key', '--adapter', 'llm-pi-ai', '--provider', 'llm_proxy'],
      { env: cliEnv() },
    )

    let text = await readSettings()
    text = text.replace('      displayName: llm_proxy', '      displayName: user renamed')
    await writeSettings(text)

    const result = await runSeed()
    assert.equal(result.changed, true)
    const settings = yaml.parse(await readSettings())
    assert.equal(settings['llm-pi-ai'].providers.llm_proxy.displayName, 'llm_proxy')
  })
})
