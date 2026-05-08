# Caller SDK

TypeScript SDK for calling components via the Caller API.

## Installation

```bash
npm install @zafeguard/caller-sdk
```

## Setup

1. Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

2. Edit `.env` with your values:

```env
PUBLIC_BASE_API_URL=http://localhost:3000
```

> Variables prefixed with `PUBLIC_` are generated into typed constants (prefix is stripped).

3. Install dependencies and generate files:

```bash
npm install
```

This automatically runs code generation (`postinstall`) which:
- Generates `src/generated/env.ts` from `PUBLIC_` variables in `.env`
- Fetches component definitions from the API
- Generates typed enums and interfaces from the component definitions

## Usage

```typescript
import { CallerSDK, CallerSDKError, ComponentModule } from 'caller-sdk';

const sdk = new CallerSDK({
  apiKey: 'your-api-key',
  baseUrl: 'http://localhost:3000', // optional, defaults to PUBLIC_BASE_API_URL
});

// Call a component
const result = await sdk.call(
  ComponentModule.GET_EVM_DERIVATION_PATH,
  { addressIndex: 0 },
);
console.log(result.derivationPath); // [44, 60, 0, 0, 0]

// Call a component with config
const key = await sdk.call(
  ComponentModule.GENERATE_ROOT_KEY,
  { curve: 'SECP256k1', threshold: 2 },
  { servers: ['OFFICIAL_1', 'OFFICIAL_2', 'OFFICIAL_3'] },
);
console.log(key.keyId, key.rootPublicKey);

// Components with no input
const ageKeys = await sdk.call(
  ComponentModule.GENERATE_AGE_ENCRYPTION,
  {},
);
console.log(ageKeys.ageIdentity, ageKeys.ageRecipient);
```

All `call` overloads are fully typed - your editor will autocomplete the correct `input`, `config`, and return type for each `ComponentModule`.

## Error Handling

```typescript
import { CallerSDKError } from 'caller-sdk';

try {
  await sdk.call(ComponentModule.COMPUTE_EVM_ADDRESS, { publicKey: 'invalid' });
} catch (err) {
  if (err instanceof CallerSDKError) {
    console.log(err.message);       // "POST /v1/sdk/components failed with status 422"
    console.log(err.status);        // 422
    console.log(err.errors);        // [{ code: 'INVALID_INPUT', message: '...' }]
    console.log(err.requestBody);   // the payload sent
    console.log(err.responseBody);  // full API response
  }
}
```

## Development

```bash
# Generate typed constants and component interfaces
npm run generate

# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test
```

### Scripts

| Script | Description |
|---|---|
| `npm run generate` | Run all code generation steps |
| `npm run generate:env` | Generate `src/generated/env.ts` from `.env` |
| `npm run fetch:components` | Fetch component definitions from the API |
| `npm run generate:components` | Generate enums and interfaces from `components.json` |
| `npm run build` | Generate + compile TypeScript |
| `npm run dev` | Watch mode (TypeScript compiler) |
| `npm test` | Run tests |

### Environment Variables

| Variable | Generated | Description |
|---|---|---|
| `PUBLIC_BASE_API_URL` | Yes (as `BASE_API_URL`) | Base URL for the API |

> Only `PUBLIC_` prefixed variables are generated into `src/generated/env.ts`. The prefix is stripped from the exported constant name.
