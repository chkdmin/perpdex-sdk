# @chkdmin/perpdex-sdk

Perpetual DEX 거래소들의 포지션과 잔고를 통합 인터페이스로 조회하는 TypeScript SDK.

## Supported Exchanges

| Exchange | Auth Type | Required Config |
|----------|-----------|-----------------|
| Hyperliquid | Wallet Address | - |
| Pacifica | Wallet Address (Solana) | - |
| Lighter | Wallet Address / API Key | Address or `apiKey`/`privateKey`, `accountIndex?` |
| Aster | API Key (HMAC) | `apiKey`, `apiSecret` |
| Backpack | API Key (ED25519) | `apiKey`, `apiSecret` |
| GRVT | API Key (Session) | `apiKey`, `apiSecret`, `tradingAccountId` |
| Extended | API Key | `apiKey`, `apiSecret` |
| StandX | JWT Token | `jwtToken` |

## Installation

```bash
npm install @chkdmin/perpdex-sdk
```

## Quick Start

```typescript
import { createClient } from '@chkdmin/perpdex-sdk'

// Hyperliquid - 지갑 주소로 조회
const hl = createClient('hyperliquid')
const positions = await hl.getPositions({ address: '0x...' })
const balance = await hl.getAccountBalance({ address: '0x...' })

if (positions.success) {
  console.log(positions.data) // Position[]
}
```

## Usage

### Address-based Exchanges

Hyperliquid, Pacifica, Lighter는 지갑 주소만으로 조회 가능합니다. 별도의 인증 설정이 필요 없습니다.

```typescript
import { createClient } from '@chkdmin/perpdex-sdk'

// Hyperliquid (EVM address)
const hl = createClient('hyperliquid')
const result = await hl.getPositions({ address: '0xYourEvmAddress' })

// Pacifica (Solana address)
const pacifica = createClient('pacifica')
const result = await pacifica.getPositions({ address: 'YourSolanaAddress' })

// Lighter (EVM address) - config 없이 address만으로 조회
const lighter = createClient('lighter')
const result = await lighter.getPositions({ address: '0xYourEvmAddress' })
```

> **Note:** Lighter의 address-only 모드에서는 포지션과 잔고가 조회되지만 SL/TP 주문은 조회되지 않습니다.
> SL/TP까지 필요하면 아래 Config 모드를 사용하세요.

### API Key-based Exchanges

API Key가 필요한 거래소는 `createClient` 두 번째 인자에 config를 전달합니다.

```typescript
import { createClient } from '@chkdmin/perpdex-sdk'

// Lighter (Config 모드 - SL/TP 주문 조회 포함)
const lighter = createClient('lighter', {
  privateKey: 'your-private-key',
  apiKeyIndex: 0,
  accountIndex: 12345,
})

// Aster (Binance-compatible)
const aster = createClient('aster', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
})

// Backpack (ED25519 signing)
const backpack = createClient('backpack', {
  apiKey: 'your-api-key',
  apiSecret: 'base64-encoded-private-key',
})

// GRVT (Session-based)
const grvt = createClient('grvt', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
  tradingAccountId: 'your-sub-account-id',
})

// Extended
const extended = createClient('extended', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
})

// StandX (JWT)
const standx = createClient('standx', {
  jwtToken: 'your-jwt-token',
})
```

### Fetching Positions

```typescript
const result = await client.getPositions()

if (result.success) {
  for (const position of result.data!) {
    console.log(`${position.market} ${position.side}`)
    console.log(`  Size: ${position.size} (${position.sizeUsd} USD)`)
    console.log(`  Entry: ${position.entryPrice} → Mark: ${position.markPrice}`)
    console.log(`  PnL: ${position.unrealizedPnl} (${position.unrealizedPnlPercent.toFixed(2)}%)`)
    console.log(`  Leverage: ${position.leverage}x`)
    console.log(`  Liquidation: ${position.liquidationPrice}`)
    console.log(`  SL: ${position.stopLoss} / TP: ${position.takeProfit}`)
  }
} else {
  console.error(`Error: ${result.error}`)
}
```

### Fetching Account Balance

```typescript
const result = await client.getAccountBalance()

if (result.success) {
  const balance = result.data!
  console.log(`Equity: ${balance.totalEquity}`)
  console.log(`Available: ${balance.availableBalance}`)
  console.log(`Used Margin: ${balance.usedMargin}`)
  console.log(`Unrealized PnL: ${balance.unrealizedPnl}`)
}
```

### Direct Class Import

팩토리 함수 대신 클라이언트 클래스를 직접 import할 수도 있습니다.

```typescript
import { HyperliquidClient, LighterClient } from '@chkdmin/perpdex-sdk'

const hl = new HyperliquidClient()
// Address-only 모드
const lighter = new LighterClient()

// Config 모드 (SL/TP 포함)
const lighterWithAuth = new LighterClient({
  privateKey: 'key',
  accountIndex: 12345,
})
```

## Type Definitions

### Position

```typescript
interface Position {
  id: string                        // "exchange_market_side"
  exchange: ExchangeId
  market: string                    // e.g. "BTC-PERP"
  baseAsset: string                 // e.g. "BTC"
  side: 'long' | 'short'
  size: number                      // Base asset quantity
  sizeUsd: number                   // Notional value in USD
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number      // ROE %
  leverage: number
  liquidationPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  margin: number
  marginRatio: number | null
  createdAt: Date | null
  updatedAt: Date
}
```

### AccountBalance

```typescript
interface AccountBalance {
  exchange: ExchangeId
  totalEquity: number
  availableBalance: number
  usedMargin: number
  unrealizedPnl: number
}
```

### ExchangeResponse

모든 API 호출은 `ExchangeResponse<T>`를 반환합니다.

```typescript
interface ExchangeResponse<T> {
  success: boolean
  data: T | null
  error: string | null
  exchange: ExchangeId
}
```

## Bundler / Runtime 주의사항

이 SDK는 Lighter의 `privateKey` 모드에서 **koffi** (네이티브 FFI) 를 사용하여 Go 기반 서명 바이너리를 로드합니다. 번들러 환경에서 사용 시 아래 설정이 필요합니다.

### Next.js (Turbopack / Webpack)

koffi는 네이티브 `.node` 바이너리를 사용하므로 Next.js 번들러가 처리할 수 없습니다. `next.config.ts`에서 반드시 외부 패키지로 지정해야 합니다.

```typescript
// next.config.ts
const nextConfig: NextConfig = {
  serverExternalPackages: ["koffi", "@chkdmin/perpdex-sdk"],
};
```

이 설정이 없으면 런타임에 `Error: koffi is required for native Lighter token generation` 에러가 발생합니다.

### pnpm v10

pnpm v10은 기본적으로 네이티브 빌드 스크립트를 차단합니다. koffi 설치를 허용하려면 `package.json`에 추가:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["koffi"]
  }
}
```

### 지원 플랫폼

Lighter 네이티브 서명은 아래 플랫폼에서만 동작합니다:

| Platform | Architecture | Binary |
|----------|-------------|--------|
| macOS | ARM64 (Apple Silicon) | `lighter-signer-darwin-arm64.dylib` |
| Linux | x64 | `lighter-signer-linux-amd64.so` |
| Linux | ARM64 | `lighter-signer-linux-arm64.so` |
| Windows | x64 | `lighter-signer-windows-amd64.dll` |

### 서버 전용

이 SDK는 **Node.js 서버 환경 전용**입니다. 브라우저나 Edge Runtime에서는 사용할 수 없습니다. Next.js에서는 API Route, Server Component 등 서버 코드에서만 import하세요.

## Error Handling

SDK는 예외를 throw하지 않습니다. 모든 에러는 `ExchangeResponse`를 통해 반환됩니다.

```typescript
const result = await client.getPositions()

if (!result.success) {
  console.error(`[${result.exchange}] ${result.error}`)
  // 에러 처리
}
```

## License

MIT
