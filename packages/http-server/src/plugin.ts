import type { AnyPluginName, HTTPPlugin, PluginContext, PluginName } from './types.js'

/**
 * Declare a typed plugin name carrying the type of the exports the plugin provides.
 * The name is returned unchanged at runtime.
 */
export function pluginName<Exports>(): <Name extends string>(
  name: Name,
) => PluginName<Name, Exports> {
  return <Name extends string>(name: Name) => name as PluginName<Name, Exports>
}

/**
 * Define an HTTP plugin, inferring its exports from the `setup` return type.
 */
export function definePlugin<
  Name extends string,
  Exports,
  const Deps extends ReadonlyArray<AnyPluginName> = [],
>(plugin: {
  name: PluginName<Name, Exports> | Name
  dependsOn?: Deps
  setup(ctx: PluginContext<Deps>): Exports | Promise<Exports>
}): HTTPPlugin<Name, Exports, Deps> {
  return {
    name: plugin.name as PluginName<Name, Exports>,
    dependsOn: plugin.dependsOn ?? ([] as unknown as Deps),
    setup: plugin.setup,
  }
}
