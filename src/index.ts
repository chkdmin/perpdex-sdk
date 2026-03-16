// Factory (primary entry point)
export { createClient } from './client'

// Types
export type {
  ExchangeId,
  PositionSide,
  Position,
  AccountBalance,
  SpotBalance,
  ExchangeResponse,
  ExchangeClient,
  AddressQuery,
  LighterConfig,
  AsterConfig,
  GrvtConfig,
  BackpackConfig,
  ExtendedConfig,
  StandXConfig,
  ExchangeConfigMap,
} from './types'

// Direct client imports (for advanced usage)
export { HyperliquidClient } from './exchanges/hyperliquid'
export { LighterClient } from './exchanges/lighter'
export { AsterClient } from './exchanges/aster'
export { BackpackClient } from './exchanges/backpack'
export { PacificaClient } from './exchanges/pacifica'
export { GrvtClient } from './exchanges/grvt'
export { ExtendedClient } from './exchanges/extended'
export { StandXClient } from './exchanges/standx'

// Utilities
export { isValidEvmAddress, isValidSolanaAddress } from './utils'

// Signers
export { createLighterAuthToken, refreshLighterAuthToken } from './signers/lighter-signer'
