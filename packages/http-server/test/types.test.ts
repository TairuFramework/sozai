import { describe, expect, expectTypeOf, test } from 'vitest'

import { type AnyHTTPPlugin, definePlugin, pluginName } from '../src/index.js'

const DB = pluginName<{ query(): number }>()('test:db')
const CACHE = pluginName<Map<string, string>>()('test:cache')

describe('plugin typing', () => {
  test('setup return type becomes the export type', () => {
    const plugin = definePlugin({ name: DB, setup: () => ({ query: () => 1 }) })
    expectTypeOf(plugin.name).toEqualTypeOf<typeof DB>()
    expect(plugin.dependsOn).toEqual([])
  })

  test('use accepts declared dependencies only', () => {
    definePlugin({
      name: 'test:consumer',
      dependsOn: [DB],
      setup(ctx) {
        expectTypeOf(ctx.use(DB)).toEqualTypeOf<{ query(): number }>()
        // @ts-expect-error CACHE is not declared in dependsOn
        ctx.use(CACHE)
      },
    })
  })

  test('typed plugins are assignable to AnyHTTPPlugin', () => {
    const plugin = definePlugin({ name: DB, setup: () => ({ query: () => 1 }) })
    expectTypeOf(plugin).toMatchTypeOf<AnyHTTPPlugin>()
  })
})
