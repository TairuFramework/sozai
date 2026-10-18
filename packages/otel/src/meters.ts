import { type Meter, type MeterOptions, metrics } from '@opentelemetry/api'

/**
 * Build a meter factory for a consuming package. Same scope rules as `createTracerFactory`:
 * `version` is the consumer's version, and `options.schemaUrl` keeps the OTel API spelling.
 */
export function createMeterFactory(
  prefix: string,
  version?: string,
  options?: MeterOptions,
): (name: string) => Meter {
  return (name: string): Meter => {
    return metrics.getMeterProvider().getMeter(`${prefix}.${name}`, version, options)
  }
}
