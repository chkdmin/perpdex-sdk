import type { ExchangeClient, ExchangeConfigMap, ExchangeId } from './types'
import { HyperliquidClient } from './exchanges/hyperliquid'
import { LighterClient } from './exchanges/lighter'
import { AsterClient } from './exchanges/aster'
import { BackpackClient } from './exchanges/backpack'
import { PacificaClient } from './exchanges/pacifica'
import { GrvtClient } from './exchanges/grvt'
import { ExtendedClient } from './exchanges/extended'
import { StandXClient } from './exchanges/standx'

export function createClient<T extends ExchangeId>(
  exchangeId: T,
  ...args: ExchangeConfigMap[T] extends undefined
    ? []
    : undefined extends ExchangeConfigMap[T]
      ? [config?: NonNullable<ExchangeConfigMap[T]>]
      : [config: ExchangeConfigMap[T]]
): ExchangeClient {
  const config = args[0]

  switch (exchangeId) {
    case 'hyperliquid':
      return new HyperliquidClient()
    case 'lighter':
      return new LighterClient(config as any ?? undefined)
    case 'aster':
      return new AsterClient(config as any)
    case 'backpack':
      return new BackpackClient(config as any)
    case 'pacifica':
      return new PacificaClient()
    case 'grvt':
      return new GrvtClient(config as any)
    case 'extended':
      return new ExtendedClient(config as any)
    case 'standx':
      return new StandXClient(config as any)
    default:
      throw new Error(`Unknown exchange: ${exchangeId}`)
  }
}
