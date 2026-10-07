import type { AnyHTTPPlugin } from './types.js'

export type PluginGraphErrorParams = { plugin: string; message: string }

export class PluginGraphError extends Error {
  #plugin: string

  constructor(params: PluginGraphErrorParams) {
    super(params.message)
    this.name = 'PluginGraphError'
    this.#plugin = params.plugin
  }

  get plugin(): string {
    return this.#plugin
  }
}

/**
 * Validate the plugin graph and return the plugins in dependency order.
 * Plugins keep their input order when the dependencies allow it.
 */
export function sortPlugins(plugins: Array<AnyHTTPPlugin>): Array<AnyHTTPPlugin> {
  const names = new Set<string>()
  for (const plugin of plugins) {
    if (names.has(plugin.name)) {
      throw new PluginGraphError({
        plugin: plugin.name,
        message: `Plugin '${plugin.name}' has a duplicate name`,
      })
    }
    names.add(plugin.name)
  }
  for (const plugin of plugins) {
    for (const dependency of plugin.dependsOn) {
      if (!names.has(dependency)) {
        throw new PluginGraphError({
          plugin: plugin.name,
          message: `Plugin '${plugin.name}' depends on missing plugin '${dependency}'`,
        })
      }
    }
  }

  const placed = new Set<string>()
  const sorted: Array<AnyHTTPPlugin> = []
  let remaining = plugins
  while (remaining.length > 0) {
    const next = remaining.find((plugin) => plugin.dependsOn.every((name) => placed.has(name)))
    if (next == null) {
      const involved = remaining.map((plugin) => `'${plugin.name}'`).join(', ')
      throw new PluginGraphError({
        plugin: remaining[0]?.name ?? '',
        message: `Plugin dependency cycle detected among ${involved}`,
      })
    }
    placed.add(next.name)
    sorted.push(next)
    remaining = remaining.filter((plugin) => plugin !== next)
  }
  return sorted
}
