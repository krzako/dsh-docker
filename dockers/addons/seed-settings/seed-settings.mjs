#!/usr/bin/env node
/**
 * Merge the deployment's settings.seed.yaml into the DSH user settings
 * document ($DSH_HOME/settings.yaml) at every DSH start, and service the
 * host-side reset_api_key.sh flow.
 *
 * Merge contract:
 * - Enforced on EVERY start, with or without the completion flags:
 *   - a provider missing from an adapter's providers map is added whole from
 *     the seed,
 *   - a provider models list that is absent, empty, or null is set from the
 *     seed wholesale, and seed models missing from a stored list are
 *     appended (matched by models[].id; existing entries are never modified),
 *   - a seed provider's compat replaces the stored compat wholesale.
 * - Applied only while the global completion flag (.settings-seed-complete)
 *   does not exist yet (first seed):
 *   - the global sections agent-presets, agent-default-model, permission and
 *     ui-theme are replaced with the seed values,
 *   - commented seed fragments (for example the commented retryPolicy block)
 *     are transferred into settings.yaml while staying comments.
 * - Applied only while the per-provider flag does not exist yet. Each flag
 *   lives in $DSH_HOME/.settings-seed-complete.d/ and is named after the
 *   provider's apiKeyEnv value (for example LLM_PROXY_API_KEY), falling back to
 *   {adapter}_{provider} when the seed provider has no apiKeyEnv. The flag
 *   gates that provider's one-time fields: displayName, apiKeyEnv, api,
 *   baseURL, defaultContextWindow and streamIdleTimeoutMs. Once the flag
 *   exists the seed never overwrites them, so user edits survive restarts;
 *   removing the flag (reset_api_key.sh) makes the next start re-apply the
 *   seeded values, including the API key wiring to the environment variable
 *   passed through docker-compose from the host .env file.
 * - A provider marked `apiKeyEnvRequired: true` (seed metadata, never copied
 *   into settings.yaml) is skipped entirely while its apiKeyEnv variable is
 *   unset or empty: no fields, no models, no flag. Nothing already stored is
 *   ever removed; when the variable later holds a value, the provider seeds
 *   like any other.
 * - A provider marked `apiKeyEnvRequired: true` whose flag is absent has its
 *   credential reference written into the credentials document
 *   ($DSH_HOME/.credentials.yaml): refs.<apiKeyEnv> = the environment value.
 *   The write runs after the settings document was saved and before the
 *   flags; removing the provider flag makes the next start re-write the
 *   reference from the environment. The document is validated against the
 *   credentials-local layout (version 1, refs/records keys, non-empty string
 *   references) and an unparsable or foreign document fails the run before
 *   anything is written.
 * - Providers, models, and sections the seed does not mention are never
 *   removed or overwritten (outside the rules above).
 * - The flags are created only after the merge was fully applied and the
 *   document was saved. The document is replaced atomically (temp file +
 *   rename), so an interrupted run cannot leave a half-written configuration
 *   behind. An unparsable settings.yaml or an invalid seed fails the run
 *   loudly before anything is written; no flag is then created.
 *
 * An absent or empty settings document is seeded verbatim from
 * settings.seed.yaml regardless of the flags: there is no user configuration
 * to protect, and every always-on rule would otherwise re-add the same
 * content piecewise.
 *
 * CLI modes (used by reset_api_key.sh on the host):
 * - --list-adapters: print the seed's adapter names, one per line.
 * - --list-providers --adapter NAME: print the adapter's provider names.
 * - --reset-api-key --adapter NAME --provider NAME: remove that provider's
 *   per-provider flag file inside $DSH_HOME.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Provider fields the seed overwrites on every start. */
const ALWAYS_PROVIDER_FIELDS = ['defaultInput']
/** Provider fields the seed overwrites only while the provider flag is absent. */
const FIRST_SEED_PROVIDER_FIELDS = [
  'displayName',
  'apiKeyEnv',
  'api',
  'baseURL',
  'defaultContextWindow',
  'streamIdleTimeoutMs',
]
/** Global sections the seed replaces only during the first seed. */
const FIRST_SEED_GLOBAL_SECTIONS = [
  'agent-presets',
  'agent-default-model',
  'permission',
  'ui-theme',
]
/** The global completion flag marks the first seed as done. */
export const FLAG_NAME = '.settings-seed-complete'
/** Directory under the settings home holding one flag file per provider. */
export const PROVIDER_FLAG_DIR_NAME = '.settings-seed-complete.d'
/**
 * Seed-provider field marking a provider that is only seeded while its
 * apiKeyEnv variable holds a non-empty value. Seed metadata only: every path
 * that copies seed content into settings.yaml strips it.
 */
const ENV_GATED_FIELD = 'apiKeyEnvRequired'
/** Basename of the credentials document inside the settings home. */
const CREDENTIALS_FILE_NAME = '.credentials.yaml'
/** Credentials layout version this script writes; mirrors credentials-local. */
const CREDENTIALS_DOCUMENT_VERSION = 1

const moduleRequire = createRequire(import.meta.url)

let yamlModule

/**
 * Load the yaml package: an explicit override first, then the script's own
 * dependency, then the copy bundled with the installed DeepSeek Harness. The
 * script ships without node_modules of its own, so the harness copy is the
 * normal in-container source.
 * @returns {typeof import('yaml')} the yaml namespace used for all parsing.
 */
export function loadYaml() {
  if (yamlModule !== undefined) return yamlModule
  const attempts = []
  if (process.env.SETTINGS_SEED_YAML_MODULE) attempts.push(process.env.SETTINGS_SEED_YAML_MODULE)
  attempts.push('yaml')
  attempts.push('/opt/deepseek-harness/node_modules/yaml')
  try {
    const pnpmRoot = '/opt/deepseek-harness/node_modules/.pnpm'
    const newest = readdirSync(pnpmRoot).filter((d) => /^yaml@\d/.test(d)).sort().pop()
    if (newest) attempts.push(path.join(pnpmRoot, newest, 'node_modules', 'yaml'))
  } catch {
    // The harness pnpm store is optional; the other attempts cover it.
  }
  let lastError
  for (const attempt of attempts) {
    try {
      yamlModule = moduleRequire(attempt)
      return yamlModule
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `settings-seed: cannot load the yaml package (tried: ${attempts.join(', ')}): ${lastError?.message}`,
  )
}

/** Whether a parsed value is a plain object (map), not an array or null. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a CST node is the yaml library's map node. */
function isMapNode(node) {
  return node?.constructor?.name === 'YAMLMap'
}

/** Whether a CST collection item is a key/value pair with the given key. */
function isPairWithKey(key) {
  return (item) => item?.constructor?.name === 'Pair' && item.key?.value === key
}

/**
 * Structural equality for parsed YAML values. Map key order is irrelevant;
 * everything else compares recursively.
 * @param {unknown} a - left value.
 * @param {unknown} b - right value.
 * @returns {boolean} whether both values are structurally equal.
 */
export function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length
      && keys.every((key) => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * Parse a YAML document, failing loud with line information on syntax errors.
 * @param {typeof import('yaml')} yaml - yaml namespace.
 * @param {string} text - document text.
 * @param {string} label - human-readable source name for error messages.
 * @returns {import('yaml').Document} the parsed, comment-preserving document.
 */
function parseDocument(yaml, text, label) {
  const document = yaml.parseDocument(text, { prettyErrors: true })
  if (document.errors.length > 0) {
    const details = document.errors.map((error) => {
      const at = error.linePos?.[0]
      return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
    }).join('; ')
    throw new Error(`settings-seed: invalid ${label}: ${details}`)
  }
  return document
}

/**
 * Parse the seed document and validate its root is a map of sections.
 * @param {typeof import('yaml')} yaml - yaml namespace.
 * @param {string} text - seed text.
 * @returns {{ document: import('yaml').Document, root: Record<string, unknown> }} parsed document and its JS value.
 */
function parseSeedDocument(yaml, text) {
  const document = parseDocument(yaml, text, 'settings seed file')
  const root = document.toJS() ?? {}
  if (!isPlainObject(root)) {
    throw new Error('settings-seed: the settings seed file must be a map of namespace sections')
  }
  return { document, root }
}

/**
 * Parse one settings document and validate its root is a map of sections.
 * @param {typeof import('yaml')} yaml - yaml namespace.
 * @param {string} text - document text.
 * @param {string} label - human-readable source name for error messages.
 * @returns {{ document: import('yaml').Document, root: Record<string, unknown> }} parsed document and its JS value.
 */
function parseSettingsDocument(yaml, text, label) {
  const document = parseDocument(yaml, text, label)
  const root = document.toJS() ?? {}
  if (!isPlainObject(root)) {
    throw new Error(`settings-seed: ${label} must be a map of namespace sections`)
  }
  return { document, root }
}

/**
 * Replace a file atomically: write a sibling temp file, fsync it, then rename.
 * @param {string} filePath - destination path.
 * @param {string} content - full file content.
 * @param {number} mode - destination file mode.
 */
async function atomicWrite(filePath, content, mode) {
  const directory = path.dirname(filePath)
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const tempPath = path.join(directory, `.${path.basename(filePath)}.seed-tmp-${process.pid}`)
  const handle = await fsp.open(tempPath, 'w', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tempPath, filePath)
  } catch (error) {
    // Best-effort temp cleanup; the rename failure itself is reported.
    try { await fsp.unlink(tempPath) } catch { /* nothing else can reach the temp file */ }
    throw error
  }
}

/**
 * Create one completion flag. Exclusive create, so a concurrent run cannot
 * duplicate it.
 * @param {string} flagPath - flag file path.
 * @param {(message: string) => void} log - progress sink.
 * @returns {Promise<boolean>} whether this call created the flag.
 */
async function createFlag(flagPath, log) {
  await fsp.mkdir(path.dirname(flagPath), { recursive: true, mode: 0o700 })
  try {
    await fsp.writeFile(
      flagPath,
      `settings seed completed at ${new Date().toISOString()}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    log(`created completion flag: ${flagPath}`)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

/**
 * Read a text file, returning undefined when it does not exist.
 * @param {string} filePath - file to read.
 * @param {string} label - human-readable source name for error messages.
 * @returns {Promise<string | undefined>} file text or undefined when absent.
 */
async function readOptional(filePath, label) {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error(`settings-seed: cannot read ${label} at ${filePath}: ${error.message}`)
  }
}

/**
 * Reject adapter/provider names that cannot form a safe flag file name.
 * @param {string} adapter - adapter (settings namespace) name.
 * @param {string} provider - provider name.
 */
function assertFlagNameSafe(adapter, provider) {
  for (const [label, value] of [['adapter', adapter], ['provider', provider]]) {
    if (typeof value !== 'string' || value.length === 0 || /[\\/]/.test(value) || value.includes('\0')) {
      throw new Error(`settings-seed: ${label} name ${JSON.stringify(value ?? null)} cannot be used in a flag file name`)
    }
  }
}

/**
 * Flag file name gating one adapter/provider pair's one-time seed fields.
 * The name follows the provider's credential environment variable (its
 * apiKeyEnv value, for example LLM_PROXY_API_KEY); providers without a usable
 * apiKeyEnv fall back to {adapter}_{provider}.
 * @param {string} adapter - adapter (settings namespace) name.
 * @param {string} provider - provider name.
 * @param {Record<string, unknown> | undefined} seedProvider - the seed provider map.
 * @returns {string} flag file name.
 */
export function providerFlagName(adapter, provider, seedProvider = undefined) {
  const apiKeyEnv = isPlainObject(seedProvider) ? seedProvider.apiKeyEnv : undefined
  if (typeof apiKeyEnv === 'string' && apiKeyEnv.length > 0
    && !/[\\/]/.test(apiKeyEnv) && !apiKeyEnv.includes('\0')) {
    return apiKeyEnv
  }
  assertFlagNameSafe(adapter, provider)
  return `${adapter}_${provider}`
}

/**
 * Flag file path gating one adapter/provider pair's one-time seed fields.
 * @param {string} apiFlagDir - per-provider flag directory.
 * @param {string} adapter - adapter (settings namespace) name.
 * @param {string} provider - provider name.
 * @param {Record<string, unknown> | undefined} seedProvider - the seed provider map.
 * @returns {string} absolute flag file path.
 */
export function providerFlagPath(apiFlagDir, adapter, provider, seedProvider = undefined) {
  return path.join(apiFlagDir, providerFlagName(adapter, provider, seedProvider))
}

/**
 * Collect the seed's adapter sections: top-level sections carrying a
 * `providers` map. The section key is the adapter (settings namespace) name.
 * @param {Record<string, unknown>} seedRoot - JS value of the seed document.
 * @returns {[string, Record<string, unknown>][]} adapter name and section pairs, in seed order.
 */
export function findAdapterSections(seedRoot) {
  return Object.entries(seedRoot).filter((entry) => isPlainObject(entry[1]?.providers))
}

/**
 * Read a seed provider's key value from the environment: the non-empty value
 * of its apiKeyEnv variable, or undefined when the variable is unset, empty,
 * or unusable as a flag file name.
 * @param {Record<string, unknown> | undefined} seedProvider - the seed provider map.
 * @param {NodeJS.ProcessEnv} env - environment variables.
 * @returns {string | undefined} the environment key value.
 */
function providerApiKeyEnvValue(seedProvider, env) {
  if (!isPlainObject(seedProvider)) return undefined
  const name = seedProvider.apiKeyEnv
  if (typeof name !== 'string' || name.length === 0 || /[\/]/.test(name) || name.includes('\0')) return undefined
  const value = env[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Whether a seed provider is marked apiKeyEnvRequired and its key variable is
 * empty or unset, so the merge must skip the provider entirely.
 * @param {Record<string, unknown> | undefined} seedProvider - the seed provider map.
 * @param {NodeJS.ProcessEnv} env - environment variables.
 * @returns {boolean} whether the provider stays out of this pass.
 */
function isEnvGatedOff(seedProvider, env) {
  return isPlainObject(seedProvider)
    && seedProvider[ENV_GATED_FIELD] === true
    && providerApiKeyEnvValue(seedProvider, env) === undefined
}

/**
 * Remove seed metadata fields from a cloned provider map node so they never
 * reach settings.yaml.
 * @param {import('yaml').CST.Node} providerNode - cloned provider map node (mutated).
 */
function stripSeedMetadata(providerNode) {
  if (!isMapNode(providerNode)) return
  const index = providerNode.items.findIndex(isPairWithKey(ENV_GATED_FIELD))
  if (index >= 0) providerNode.items.splice(index, 1)
}

/**
 * Apply the merge rules to an existing, parsed settings document. The
 * document is mutated in place through the comment-preserving CST; seed
 * content is inserted as cloned nodes so seed comments travel with it.
 * @param {import('yaml').Document} document - parsed settings document (mutated).
 * @param {import('yaml').Document} seedDocument - parsed seed document.
 * @param {Record<string, unknown>} settingsRoot - JS value of the settings document at entry; refreshed after inserts that make it stale.
 * @param {Record<string, unknown>} seedRoot - JS value of the seed document.
 * @param {boolean} globalFirstSeed - whether the global completion flag is still absent.
 * @param {(adapter: string, provider: string, seedProvider: Record<string, unknown>) => boolean} isProviderFirstSeed - whether the provider's one-time fields may be applied.
 * @param {{adapter: string, provider: string, apiKeyEnv: string, value: string}[]} credentialsPending - sink collecting credential reference writes decided during the pass.
 * @param {NodeJS.ProcessEnv} env - environment variables, read for apiKeyEnv-gated providers.
 * @param {string[]} ops - change log sink; one entry per applied change.
 * @param {(message: string) => void} log - progress sink for non-change notes.
 */
function applyMerge(document, seedDocument, settingsRoot, seedRoot, globalFirstSeed, isProviderFirstSeed, credentialsPending, env, ops, log) {
  const adapterSections = findAdapterSections(seedRoot)
  if (adapterSections.length === 0) {
    throw new Error('settings-seed: the seed has no adapter sections with a providers map; nothing to merge')
  }

  for (const [adapterName, seedSection] of adapterSections) {
    const providersPath = [adapterName, 'providers']
    const seedProvidersNode = seedDocument.getIn(providersPath, true)

    // Providers marked apiKeyEnvRequired stay out of the merge entirely
    // while their key variable is empty or unset.
    const active = []
    for (const [name, seedProvider] of Object.entries(seedSection.providers)) {
      if (isEnvGatedOff(seedProvider, env)) {
        log(`provider ${adapterName}/${name}: skipped while ${seedProvider.apiKeyEnv} is not set`)
        continue
      }
      active.push([name, seedProvider, seedProvidersNode.items.find(isPairWithKey(name))])
    }
    if (active.length === 0) continue

    // Ensure the provider directory exists before touching providers.
    let providersNode = document.getIn(providersPath, true)
    if (providersNode !== undefined && !isMapNode(providersNode)) {
      throw new Error(`settings-seed: ${adapterName}.providers exists in settings.yaml but is not a map`)
    }
    if (providersNode === undefined) {
      // Clone only the active providers; seed metadata never travels along.
      const activeNames = new Set(active.map(([name]) => name))
      const wholesale = seedProvidersNode.clone()
      wholesale.items = wholesale.items
        .filter((item) => item?.constructor?.name === 'Pair' && activeNames.has(item.key?.value))
      for (const item of wholesale.items) stripSeedMetadata(item.value)
      document.setIn(providersPath, wholesale)
      ops.push(`${adapterName}.providers: created from seed (all providers added)`)
      providersNode = document.getIn(providersPath, true)
      // The wholesale insert made the entry-time JS value stale.
      settingsRoot = document.toJS() ?? {}
    }

    for (const [name, seedProvider, seedProviderPair] of active) {
      // Register the provider's flag status up front so a provider added
      // whole from the seed also gets its flag created.
      const providerFirstSeed = isProviderFirstSeed(adapterName, name, seedProvider)
      const apiKeyEnvValue = providerApiKeyEnvValue(seedProvider, env)
      if (providerFirstSeed && apiKeyEnvValue !== undefined) {
        credentialsPending.push({
          adapter: adapterName,
          provider: name,
          apiKeyEnv: /** @type {string} */ (seedProvider.apiKeyEnv),
          value: apiKeyEnvValue,
        })
      }
      const providerPath = [adapterName, 'providers', name]
      const existingPair = providersNode.items.find(isPairWithKey(name))

      if (existingPair === undefined) {
        const added = seedProviderPair.clone()
        stripSeedMetadata(added.value)
        providersNode.items.push(added)
        ops.push(`provider ${adapterName}/${name}: added from seed`)
        continue
      }
      const providerNode = existingPair.value
      if (!isMapNode(providerNode)) {
        throw new Error(`settings-seed: provider "${adapterName}/${name}" exists in settings.yaml but is not a map`)
      }
      const existing = settingsRoot[adapterName]?.providers?.[name]
      if (!isPlainObject(existing)) {
        throw new Error(`settings-seed: provider "${adapterName}/${name}" exists in settings.yaml but did not parse to a map`)
      }
      /** Clone a named value node out of the seed provider, keeping its styling. */
      const seedValueNode = (key) => seedProviderPair.value.items.find(isPairWithKey(key))?.value

      // One-time provider fields: the seed overwrites stored values once,
      // until the provider's own flag exists.
      if (providerFirstSeed) {
        for (const field of FIRST_SEED_PROVIDER_FIELDS) {
          if (!(field in seedProvider)) continue
          if (deepEqual(existing[field], seedProvider[field])) continue
          document.setIn([...providerPath, field], seedValueNode(field).clone())
          ops.push(`provider ${adapterName}/${name}.${field}: set from seed (first seed for provider)`)
        }
      }

      // defaultInput: the seed always wins.
      for (const field of ALWAYS_PROVIDER_FIELDS) {
        if (!(field in seedProvider)) continue
        if (deepEqual(existing[field], seedProvider[field])) continue
        document.setIn([...providerPath, field], seedValueNode(field).clone())
        ops.push(`provider ${adapterName}/${name}.${field}: forced from seed`)
      }

      // models: an absent, empty, or null models list is set from the seed
      // wholesale; otherwise every seed model whose id is missing is
      // appended, and stored models are never touched or reordered.
      if (Array.isArray(seedProvider.models)) {
        const storedModels = existing.models
        if (storedModels === undefined || storedModels === null
          || (Array.isArray(storedModels) && storedModels.length === 0)) {
          document.setIn([...providerPath, 'models'], seedValueNode('models').clone())
          ops.push(`provider ${adapterName}/${name}.models: set from seed`)
        } else if (!Array.isArray(storedModels)) {
          log(`provider ${adapterName}/${name}.models is not a list in settings.yaml; leaving it untouched`)
        } else {
          const storedIds = new Set(storedModels.map((model) => isPlainObject(model) ? model.id : undefined))
          const missing = seedProvider.models.filter((model) => {
            if (!isPlainObject(model) || model.id === undefined) {
              log(`provider ${adapterName}/${name}: a seed model without an id cannot be matched; skipped`)
              return false
            }
            return !storedIds.has(model.id)
          })
          if (missing.length > 0) {
            const seedModelsNode = seedValueNode('models')
            const storedModelsNode = providerNode.items.find(isPairWithKey('models')).value
            for (const model of missing) {
              const seedItem = seedModelsNode.items.find((item) => item.get?.('id') === model.id)
              storedModelsNode.items.push(seedItem !== undefined ? seedItem.clone() : document.createNode(model))
            }
            ops.push(`provider ${adapterName}/${name}.models: added ${missing.map((model) => model.id).join(', ')}`)
          }
        }
      }

      // compat: the seed replaces the whole section. On the first seed the
      // entire key/value pair is swapped so the seed's commented fragments
      // (attached to the compat key as commentBefore) are transferred while
      // staying comments; afterwards only the value is swapped, so stored
      // comments are never re-imposed.
      if ('compat' in seedProvider) {
        const seedCompatPair = seedProviderPair.value.items.find(isPairWithKey('compat'))
        const compatChanged = !deepEqual(existing.compat, seedProvider.compat)
        if (globalFirstSeed) {
          const existingIndex = providerNode.items.findIndex(isPairWithKey('compat'))
          if (existingIndex >= 0) providerNode.items[existingIndex] = seedCompatPair.clone()
          else providerNode.items.push(seedCompatPair.clone())
          ops.push(`provider ${adapterName}/${name}.compat: ${compatChanged ? 'replaced' : 'confirmed'} from seed (first seed)`)
        } else if (compatChanged) {
          const existingIndex = providerNode.items.findIndex(isPairWithKey('compat'))
          if (existingIndex >= 0) providerNode.items[existingIndex].value = seedCompatPair.value.clone()
          else providerNode.items.push(seedCompatPair.clone())
          ops.push(`provider ${adapterName}/${name}.compat: replaced from seed`)
        }
      }
    }
  }

  // First-seed-only global sections: the seed replaces them wholesale.
  if (globalFirstSeed) {
    for (const section of FIRST_SEED_GLOBAL_SECTIONS) {
      if (!(section in seedRoot)) continue
      if (deepEqual(settingsRoot[section], seedRoot[section])) continue
      document.setIn([section], seedDocument.getIn([section], true).clone())
      ops.push(`${section}: replaced from seed (first seed)`)
    }
  }
}

/**
 * Parse the credentials document a pending reference write will edit and
 * validate it against the credentials-local layout (version 1, refs/records
 * keys, non-empty string references) so an unusable document fails the run
 * before anything is written. An absent or empty document starts a fresh one.
 * @param {typeof import('yaml')} yaml - yaml namespace.
 * @param {string} credentialsPath - credentials document path.
 * @returns {Promise<import('yaml').Document>} the parsed or freshly created document.
 */
async function prepareCredentialsDocument(yaml, credentialsPath) {
  const text = await readOptional(credentialsPath, 'credentials document')
  if (text === undefined || text.trim().length === 0) {
    // A fresh version-1 document; the refs map is added block-style by the
    // reference writes below.
    return parseDocument(yaml, 'version: 1\n', 'fresh credentials document')
  }
  const document = parseDocument(yaml, text, 'credentials document')
  const root = document.toJS() ?? {}
  if (!isPlainObject(root)) {
    throw new Error(`settings-seed: credentials document ${credentialsPath} must be a map`)
  }
  const keys = Object.keys(root)
  if (keys.length === 0) return document
  if (!('version' in root)) {
    throw new Error(`settings-seed: credentials document ${credentialsPath} lacks "version: 1"; refusing to edit it`)
  }
  if (root.version !== CREDENTIALS_DOCUMENT_VERSION) {
    throw new Error(`settings-seed: credentials document ${credentialsPath} declares unsupported version ${JSON.stringify(root.version)}`)
  }
  for (const key of keys) {
    if (key !== 'version' && key !== 'refs' && key !== 'records') {
      throw new Error(`settings-seed: credentials document ${credentialsPath} has unknown top-level key "${key}"`)
    }
  }
  if (root.refs !== undefined && root.refs !== null && !isPlainObject(root.refs)) {
    throw new Error(`settings-seed: credentials document ${credentialsPath} has a non-map "refs" section`)
  }
  for (const [key, value] of Object.entries(root.refs ?? {})) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`settings-seed: credentials document ${credentialsPath} has an unusable "${key}" reference`)
    }
  }
  return document
}

/**
 * Write the pending credential references into the prepared credentials
 * document and persist it atomically with owner-only permissions. Runs after
 * the settings document was saved and before any flag is created, so a failed
 * write leaves every flag absent and the next start retries the whole pass.
 * @param {{
 *   credentialsPending: {adapter: string, provider: string, apiKeyEnv: string, value: string}[],
 *   credentialsDocument: import('yaml').Document | undefined,
 *   credentialsPath: string,
 *   log: (message: string) => void,
 * }} state - merge outcome.
 */
async function writeCredentials(state) {
  const { credentialsPending, credentialsDocument, credentialsPath, log } = state
  if (credentialsPending.length === 0) return
  let changed = false
  for (const entry of credentialsPending) {
    if (credentialsDocument.getIn(['refs', entry.apiKeyEnv]) === entry.value) continue
    credentialsDocument.setIn(['refs', entry.apiKeyEnv], entry.value)
    changed = true
    log(`credentials ${credentialsPath}: set ${entry.apiKeyEnv} (${entry.adapter}/${entry.provider})`)
  }
  if (!changed) return
  await atomicWrite(credentialsPath, credentialsDocument.toString(), 0o600)
  log(`saved ${credentialsPath}`)
}

/**
 * Persist the merge result and create the completion flags. Flags are only
 * ever created after the document and credentials writes succeeded, so a
 * failed run leaves every flag absent and the next start retries the full
 * seed.
 * @param {{
 *   firstSeed: boolean,
 *   flagPath: string,
 *   providerFlagsPending: {adapter: string, provider: string, path: string}[],
 *   ops: string[],
 *   outputText: string | undefined,
 *   settingsPath: string,
 *   log: (message: string) => void,
 * }} state - merge outcome.
 * @returns {Promise<{changed: boolean, wroteSettings: boolean, ops: string[], firstSeed: boolean, flagCreated: boolean, providerFlagsCreated: string[]}>} what the pass did.
 */
async function finishSeed(state) {
  const { firstSeed, flagPath, providerFlagsPending, ops, outputText, settingsPath, log } = state
  if (ops.length > 0) {
    await atomicWrite(settingsPath, outputText, 0o600)
    for (const op of ops) log(op)
    log(`saved ${settingsPath} (${ops.length} change(s))`)
  } else {
    log('settings document already matches the seed; nothing to change')
  }
  await writeCredentials(state)
  let flagCreated = false
  if (firstSeed) flagCreated = await createFlag(flagPath, log)
  const providerFlagsCreated = []
  for (const pending of providerFlagsPending) {
    if (await createFlag(pending.path, log)) providerFlagsCreated.push(`${pending.adapter}/${pending.provider}`)
  }
  return { changed: ops.length > 0, wroteSettings: ops.length > 0, ops, firstSeed, flagCreated, providerFlagsCreated }
}

/**
 * Run one seed pass.
 * @param {{
 *   seedPath: string,
 *   settingsPath: string,
 *   flagPath: string,
 *   apiFlagDir?: string,
 *   credentialsPath?: string,
 *   seedText?: string,
 *   settingsText?: string,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (message: string) => void,
 * }} options - paths, optional text overrides for tests, and a progress sink.
 * @returns {Promise<{changed: boolean, wroteSettings: boolean, ops: string[], firstSeed: boolean, flagCreated: boolean, providerFlagsCreated: string[]}>} what the pass did.
 */
export async function seedSettings(options) {
  const { seedPath, settingsPath, flagPath, log = () => {} } = options
  const yaml = loadYaml()
  const env = options.env ?? process.env
  const apiFlagDir = options.apiFlagDir ?? path.join(path.dirname(settingsPath), PROVIDER_FLAG_DIR_NAME)
  const credentialsPath = options.credentialsPath
    ?? env.SETTINGS_SEED_CREDENTIALS_FILE
    ?? path.join(path.dirname(settingsPath), CREDENTIALS_FILE_NAME)

  // 1. Read and parse the seed; an invalid seed stops everything.
  const seedText = options.seedText ?? await (async () => {
    const text = await readOptional(seedPath, 'settings seed file')
    if (text === undefined) throw new Error(`settings-seed: settings seed file not found at ${seedPath}`)
    return text
  })()
  const { document: seedDocument, root: seedRoot } = parseSeedDocument(yaml, seedText)

  // 2. Read and parse the stored document; a corrupt document stops
  //    everything before any write or flag creation.
  let settingsText = options.settingsText
  if (settingsText === undefined) settingsText = await readOptional(settingsPath, 'settings document')
  const hasContent = settingsText !== undefined && settingsText.trim().length > 0

  // 3. The flags decide whether one-time seed rules still apply.
  const globalFirstSeed = !existsSync(flagPath)
  const providerFlagsPending = []
  const isProviderFirstSeed = (adapter, provider, seedProvider) => {
    const flagFile = providerFlagPath(apiFlagDir, adapter, provider, seedProvider)
    if (!existsSync(flagFile)) {
      providerFlagsPending.push({ adapter, provider, path: flagFile })
      return true
    }
    return false
  }

  // 4. Apply per-provider rules and, on the first seed, global sections. An
  //    absent or empty document behaves like an empty map: the merge then
  //    adds every seed piece from clones, which keeps the seed comments in
  //    place while still honoring the per-provider environment gate.
  let document
  let settingsRoot
  if (hasContent) {
    ;({ document, root: settingsRoot } = parseSettingsDocument(yaml, settingsText, `settings document ${settingsPath}`))
  } else {
    document = new yaml.Document({})
    settingsRoot = {}
  }

  // Global sections are protected by the global flag, but an absent or
  // empty document has no user content to protect, so they are applied
  // regardless: the re-seed of a deleted document must stay complete.
  const globalApply = globalFirstSeed || !hasContent

  const ops = []
  const credentialsPending = []
  applyMerge(document, seedDocument, settingsRoot, seedRoot, globalApply, isProviderFirstSeed, credentialsPending, env, ops, log)

  // 5. Parse the credentials document before anything is written: an
  //    unparsable or foreign one fails the run loudly with no document saved
  //    and no flag created.
  const credentialsDocument = credentialsPending.length > 0
    ? await prepareCredentialsDocument(yaml, credentialsPath)
    : undefined

  // 6. Save; 7. only a fully successful pass creates the flags.
  return finishSeed({
    firstSeed: globalFirstSeed,
    flagPath,
    providerFlagsPending,
    credentialsPending,
    credentialsDocument,
    credentialsPath,
    ops,
    outputText: ops.length > 0 ? document.toString() : undefined,
    settingsPath,
    log,
  })
}

/**
 * Resolve the seed/settings/flag paths from the environment. Container
 * defaults match the Docker deployment: the seed ships at /opt/dsh-seed and
 * the user document lives under $DSH_HOME (default /home/node/.dsh).
 * @param {NodeJS.ProcessEnv} env - environment variables.
 * @returns {{seedPath: string, settingsPath: string, flagPath: string, apiFlagDir: string}} resolved paths.
 */
export function resolvePaths(env = process.env) {
  const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const settingsPath = env.DSH_SETTINGS_FILE || path.join(dshHome, 'settings.yaml')
  return {
    seedPath: env.SETTINGS_SEED_FILE || '/opt/dsh-seed/settings.seed.yaml',
    settingsPath,
    flagPath: env.SETTINGS_SEED_FLAG_FILE || path.join(dshHome, FLAG_NAME),
    apiFlagDir: env.SETTINGS_SEED_FLAG_DIR || path.join(path.dirname(settingsPath), PROVIDER_FLAG_DIR_NAME),
    credentialsPath: env.SETTINGS_SEED_CREDENTIALS_FILE || path.join(path.dirname(settingsPath), CREDENTIALS_FILE_NAME),
  }
}

/**
 * Read and parse the seed from disk.
 * @param {string} seedPath - seed file path.
 * @returns {Promise<Record<string, unknown>>} the seed's JS value.
 */
async function readSeedRoot(seedPath) {
  const yaml = loadYaml()
  const text = await readOptional(seedPath, 'settings seed file')
  if (text === undefined) throw new Error(`settings-seed: settings seed file not found at ${seedPath}`)
  return parseSeedDocument(yaml, text).root
}

/**
 * List the seed's adapters, one per line.
 * @param {{seedPath: string}} paths - resolved paths.
 * @param {(message: string) => void} log - output sink.
 * @returns {Promise<number>} exit code.
 */
async function runListAdapters(paths, log) {
  const adapters = findAdapterSections(await readSeedRoot(paths.seedPath)).map(([name]) => name)
  if (adapters.length === 0) throw new Error('settings-seed: the seed has no adapter sections with a providers map')
  for (const adapter of adapters) log(adapter)
  return 0
}

/**
 * List one adapter's providers, one per line.
 * @param {{seedPath: string}} paths - resolved paths.
 * @param {{adapter: string | undefined}} parsed - parsed CLI arguments.
 * @param {(message: string) => void} log - output sink.
 * @returns {Promise<number>} exit code.
 */
async function runListProviders(paths, parsed, log) {
  if (parsed.adapter === undefined) throw new Error('settings-seed: --list-providers requires --adapter NAME')
  const sections = findAdapterSections(await readSeedRoot(paths.seedPath))
  const section = sections.find(([name]) => name === parsed.adapter)
  if (section === undefined) {
    throw new Error(`settings-seed: unknown adapter '${parsed.adapter}'; known adapters: ${sections.map(([name]) => name).join(', ')}`)
  }
  for (const provider of Object.keys(section[1].providers)) log(provider)
  return 0
}

/**
 * Remove one adapter/provider flag file so the next start re-applies the
 * provider's seeded settings.
 * @param {{apiFlagDir: string}} paths - resolved paths.
 * @param {{adapter: string | undefined, provider: string | undefined}} parsed - parsed CLI arguments.
 * @param {(message: string) => void} log - output sink.
 * @returns {Promise<number>} exit code.
 */
async function runResetApiKey(paths, parsed, log) {
  if (parsed.adapter === undefined) throw new Error('settings-seed: --reset-api-key requires --adapter NAME')
  if (parsed.provider === undefined) throw new Error('settings-seed: --reset-api-key requires --provider NAME')
  const sections = findAdapterSections(await readSeedRoot(paths.seedPath))
  const section = sections.find(([name]) => name === parsed.adapter)
  if (section === undefined) {
    throw new Error(`settings-seed: unknown adapter '${parsed.adapter}'; known adapters: ${sections.map(([name]) => name).join(', ')}`)
  }
  if (!(parsed.provider in section[1].providers)) {
    throw new Error(`settings-seed: adapter '${parsed.adapter}' has no provider '${parsed.provider}'; known providers: ${Object.keys(section[1].providers).join(', ')}`)
  }
  const seedProvider = section[1].providers[parsed.provider]
  const flagFile = providerFlagPath(paths.apiFlagDir, parsed.adapter, parsed.provider, seedProvider)
  if (!existsSync(flagFile)) {
    log(`No api-key flag present for ${parsed.adapter}/${parsed.provider}; nothing to remove.`)
    return 0
  }
  unlinkSync(flagFile)
  log(`Removed api-key flag: ${flagFile}`)
  log('The seed re-applies this provider\'s settings (including its API key from the environment) on the next container start.')
  return 0
}

const USAGE = `Usage: seed-settings.mjs [--help] [--list-adapters]
                         [--list-providers --adapter NAME]
                         [--reset-api-key --adapter NAME --provider NAME]

Default (no mode flag): merge settings.seed.yaml into the DSH settings
document at every start.

Modes:
  --list-adapters    print the seed's adapter names, one per line
  --list-providers   print the adapter's provider names, one per line
  --reset-api-key    remove the provider's flag file (named after its
                     apiKeyEnv, e.g. LLM_PROXY_API_KEY) so the next start
                     re-applies its seeded settings (including the API
                     key wiring to the environment)

Options:
  --adapter NAME     adapter (settings namespace) name, e.g. llm-pi-ai
  --provider NAME    provider name, e.g. llm_proxy

Environment overrides:
  SETTINGS_SEED_FILE         seed document (default /opt/dsh-seed/settings.seed.yaml)
  DSH_HOME                   harness home (document at $DSH_HOME/settings.yaml)
  DSH_SETTINGS_FILE          settings document (default $DSH_HOME/settings.yaml)
  SETTINGS_SEED_FLAG_FILE    first-seed completion flag (default $DSH_HOME/.settings-seed-complete)
  SETTINGS_SEED_FLAG_DIR     per-provider flag directory (default $DSH_HOME/.settings-seed-complete.d)
  SETTINGS_SEED_CREDENTIALS_FILE  credentials document (default $DSH_HOME/.credentials.yaml)
  SETTINGS_SEED_YAML_MODULE  explicit path of the yaml package
`

/**
 * CLI entry point.
 * @param {string[]} argv - command-line arguments.
 * @param {NodeJS.ProcessEnv} env - environment variables.
 * @param {(message: string) => void} log - progress sink; stdout is data for the list modes.
 * @param {(message: string) => void} errorLog - error sink, kept off stdout.
 * @returns {Promise<number>} process exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  log = (message) => console.log(message),
  errorLog = (message) => console.error(message),
) {
  let parsed
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    errorLog(`[settings-seed] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (parsed.mode === 'help') {
    log(USAGE)
    return 0
  }
  const paths = resolvePaths(env)
  try {
    switch (parsed.mode) {
      case 'list-adapters': return await runListAdapters(paths, log)
      case 'list-providers': return await runListProviders(paths, parsed, log)
      case 'reset-api-key': return await runResetApiKey(paths, parsed, log)
      default: return await runSeedMode(paths, log)
    }
  } catch (error) {
    errorLog(`[settings-seed] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/**
 * Run the default seed mode.
 * @param {{seedPath: string, settingsPath: string, flagPath: string, apiFlagDir: string}} paths - resolved paths.
 * @param {(message: string) => void} log - output sink.
 * @returns {Promise<number>} exit code.
 */
async function runSeedMode(paths, log) {
  log(`[settings-seed] merging ${paths.seedPath} into ${paths.settingsPath}`)
  const result = await seedSettings({ ...paths, log: (message) => log(`[settings-seed] ${message}`) })
  log(`[settings-seed] done: ${result.changed ? 'changed' : 'no changes'}, first seed: ${result.firstSeed ? 'yes' : 'no (flag present)'}`)
  return 0
}

/**
 * Parse CLI arguments into a mode and its options.
 * @param {string[]} argv - command-line arguments.
 * @returns {{mode: string, adapter: string | undefined, provider: string | undefined}} parsed arguments.
 */
function parseCliArgs(argv) {
  const parsed = { mode: 'seed', adapter: undefined, provider: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') parsed.mode = 'help'
    else if (arg === '--list-adapters') parsed.mode = 'list-adapters'
    else if (arg === '--list-providers') parsed.mode = 'list-providers'
    else if (arg === '--reset-api-key') parsed.mode = 'reset-api-key'
    else if (arg === '--adapter') parsed.adapter = requireArgValue(argv, ++i, arg)
    else if (arg === '--provider') parsed.provider = requireArgValue(argv, ++i, arg)
    else throw new Error(`settings-seed: unknown argument '${arg}' (see --help)`)
  }
  return parsed
}

/**
 * Read the value following an option, failing loud when it is missing.
 * @param {string[]} argv - command-line arguments.
 * @param {number} index - index of the value.
 * @param {string} option - option name for the error message.
 * @returns {string} the option value.
 */
function requireArgValue(argv, index, option) {
  const value = argv[index]
  if (value === undefined) throw new Error(`settings-seed: ${option} requires a value`)
  return value
}

/* Direct invocation guard: run the CLI only when executed, not when imported. */
const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) process.exitCode = await main()
