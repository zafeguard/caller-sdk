import axios, { AxiosError, AxiosHeaders } from 'axios';
import { z } from 'zod';
import { WorkspaceClient } from '@/bootstrap/caller';
import { CallBuilder } from '@/bootstrap/call-builder';
import { ComponentModule } from '@/generated/enums';
import { CallerSDKError } from '@/errors';
import { validationSchemas } from '@/generated/schemas';
import type { ExecuteComponentResponse } from '@/types';

// Alias kept for minimal churn — the SDK class was renamed from CallerSDK to WorkspaceClient.
const CallerSDK = WorkspaceClient;
type CallerSDK = InstanceType<typeof WorkspaceClient>;

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      create: jest.fn(),
    },
    create: jest.fn(),
  };
});

const mockedCreate = axios.create as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ExecuteComponentResponse for test mocks. */
function mockExecResponse(
  overrides: Partial<ExecuteComponentResponse> = {},
): ExecuteComponentResponse {
  return {
    id: 'exec-test-123',
    module: 'GET_EVM_DERIVATION_PATH',
    status: 'CREATED',
    completed: false,
    output: null,
    error: null,
    totalUsage: 0,
    callback: {
      url: null,
      signed: false,
      signatureAlgorithm: null,
      headerNames: [],
      deliveredAt: null,
      lastAttemptAt: null,
      attemptCount: 0,
      lastError: null,
    },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Create a minimal mock `ReadableStream<Uint8Array>` that emits a sequence of
 * SSE events and then closes. Each event object is serialised as:
 *   `data: <JSON>\n\n`
 */
function mockSseStream(
  events: Array<{ status: string; output?: unknown; error?: unknown }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = encoder.encode(text);
  let emitted = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emitted) {
        emitted = true;
        controller.enqueue(bytes);
      } else {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('CallerSDK', () => {
  let sdk: CallerSDK;
  let mockPost: jest.Mock;
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    mockPost = jest.fn();
    mockedCreate.mockReturnValue({
      post: mockPost,
      defaults: { baseURL: 'http://localhost:3000' },
    } as any);

    sdk = new CallerSDK({ apiKey: 'test-api-key', baseUrl: 'http://localhost:3000' });

    // Silence fetch calls that leak between tests — each test overrides this.
    mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: null,
      text: async () => '',
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // .call() — builder creation and synchronous validation
  // -------------------------------------------------------------------------

  describe('.call()', () => {
    it('should return a CallBuilder instance without making a network request', () => {
      const builder = sdk.call(
        ComponentModule.GET_EVM_DERIVATION_PATH,
        { accountIndex: 0, changeIndex: 0, addressIndex: 0 },
      );

      expect(builder).toBeInstanceOf(CallBuilder);
      expect(builder.execute).toBeDefined();
      expect(builder.promise).toBeDefined();
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('should default input and config to empty objects when omitted', async () => {
      // Components like GENERATE_AGE_ENCRYPTION accept an empty input — call
      // with only the module argument to exercise the default-value branches
      // for both `input` and `config`.
      mockPost.mockResolvedValue({ data: mockExecResponse() });

      // Cast through `any` because the public typed surface requires the
      // input argument; this ensures the runtime defaults are reachable.
      await (sdk as any).call(ComponentModule.GENERATE_AGE_ENCRYPTION).execute();

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/sdk/components',
        {
          module: 'GENERATE_AGE_ENCRYPTION',
          input: {},
          config: {},
        },
        { headers: { 'X-Api-Key': 'test-api-key' } },
      );
    });

    it('should throw CallerSDKError synchronously when required input is missing', () => {
      expect(() =>
        sdk.call(ComponentModule.GET_EVM_DERIVATION_PATH, {} as any),
      ).toThrow(CallerSDKError);

      expect(mockPost).not.toHaveBeenCalled();
    });

    it('should throw CallerSDKError synchronously when input field has the wrong type', () => {
      expect(() =>
        sdk.call(ComponentModule.GET_EVM_DERIVATION_PATH, {
          addressIndex: 'not-a-number',
        } as any),
      ).toThrow(CallerSDKError);

      expect(mockPost).not.toHaveBeenCalled();
    });

    it('should NOT throw when an empty config is passed for a component with no SDK config fields', () => {
      // All components use z.object({}) for the SDK config schema — the actual
      // URL/method/etc. live in the canvas config, not the SDK execution call.
      expect(() =>
        sdk.call(ComponentModule.API_CALL, { headers: {} }, {}),
      ).not.toThrow();

      expect(mockPost).not.toHaveBeenCalled(); // builder not yet executed
    });

    it('should throw CallerSDKError synchronously when multiple input fields are wrong', () => {
      // READ_EVM_CONTRACT requires jsonRpcUrl (string), contractAddress (string), calldata (string)
      expect(() =>
        sdk.call(
          ComponentModule.READ_EVM_CONTRACT,
          { jsonRpcUrl: 123, contractAddress: 456, calldata: null } as any,
        ),
      ).toThrow(CallerSDKError);

      expect(mockPost).not.toHaveBeenCalled();
    });

    it('validation error message should reference the correct context', () => {
      try {
        sdk.call(ComponentModule.GET_EVM_DERIVATION_PATH, {} as any);
        fail('Expected error');
      } catch (e) {
        const err = e as CallerSDKError;
        expect(err.message).toBe(
          'Validation failed for GET_EVM_DERIVATION_PATH input',
        );
        expect(err.errors.length).toBeGreaterThan(0);
      }
    });

    it('validation error should include all failing fields', () => {
      try {
        sdk.call(
          ComponentModule.READ_EVM_CONTRACT,
          { jsonRpcUrl: 123, contractAddress: 456, calldata: null } as any,
        );
        fail('Expected error');
      } catch (e) {
        const err = e as CallerSDKError;
        expect(err.errors.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('should throw CallerSDKError synchronously when config validation fails', () => {
      // The auto-generated config schemas are all `z.object({})` today, so
      // the config-validation branch only fires if a future component adds a
      // strict config schema. Stub one in to exercise the branch.
      const original = validationSchemas[ComponentModule.GET_EVM_DERIVATION_PATH];
      const strictConfig = z.object({ region: z.enum(['us', 'eu']) });
      (validationSchemas as Record<ComponentModule, { input: z.ZodType; config: z.ZodType }>)[ComponentModule.GET_EVM_DERIVATION_PATH] = {
        input: original.input,
        config: strictConfig as unknown as z.ZodType,
      };

      try {
        expect(() =>
          sdk.call(
            ComponentModule.GET_EVM_DERIVATION_PATH,
            { accountIndex: 0, changeIndex: 0, addressIndex: 0 },
            { region: 'mars' } as any,
          ),
        ).toThrow(CallerSDKError);

        try {
          sdk.call(
            ComponentModule.GET_EVM_DERIVATION_PATH,
            { accountIndex: 0, changeIndex: 0, addressIndex: 0 },
            {} as any,
          );
          fail('Expected error');
        } catch (e) {
          const err = e as CallerSDKError;
          expect(err.message).toBe(
            'Validation failed for GET_EVM_DERIVATION_PATH config',
          );
          expect(err.errors.length).toBeGreaterThan(0);
        }

        expect(mockPost).not.toHaveBeenCalled();
      } finally {
        (validationSchemas as Record<ComponentModule, { input: z.ZodType; config: z.ZodType }>)[ComponentModule.GET_EVM_DERIVATION_PATH] = original;
      }
    });
  });

  // -------------------------------------------------------------------------
  // .execute() — HTTP submission
  // -------------------------------------------------------------------------

  describe('.execute()', () => {
    it('should POST to /v1/sdk/components with the correct payload', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });

      await sdk
        .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
        .execute();

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/sdk/components',
        {
          module: 'GET_EVM_DERIVATION_PATH',
          input: { accountIndex: 0, changeIndex: 0, addressIndex: 0 },
          config: {},
        },
        { headers: { 'X-Api-Key': 'test-api-key' } },
      );
    });

    it('should include config when provided', async () => {
      mockPost.mockResolvedValue({
        data: mockExecResponse({ module: 'GET_NODE_RECIPIENT_KEY' }),
      });

      await sdk
        .call(ComponentModule.GET_NODE_RECIPIENT_KEY, {}, {})
        .execute();

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/sdk/components',
        {
          module: 'GET_NODE_RECIPIENT_KEY',
          input: {},
          config: {},
        },
        { headers: { 'X-Api-Key': 'test-api-key' } },
      );
    });

    it('should merge execute options into the request body', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });

      await sdk
        .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
        .execute({
          attempts: 2,
          waitForMs: 5_000,
          callbackUrl: 'https://example.com/hook',
          callbackSecret: 'shhh',
          callbackHeaders: { 'X-My-Header': 'value' },
        });

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/sdk/components',
        expect.objectContaining({
          attempts: 2,
          waitForMs: 5_000,
          callbackUrl: 'https://example.com/hook',
          callbackSecret: 'shhh',
          callbackHeaders: { 'X-My-Header': 'value' },
        }),
        expect.anything(),
      );
    });

    it('should omit undefined options from the request body', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });

      await sdk
        .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
        .execute();

      const [, body] = mockPost.mock.calls[0];
      expect(body).not.toHaveProperty('attempts');
      expect(body).not.toHaveProperty('waitForMs');
      expect(body).not.toHaveProperty('callbackUrl');
    });

    it('should return the raw ExecuteComponentResponse', async () => {
      const expected = mockExecResponse({ status: 'CREATED', id: 'my-id' });
      mockPost.mockResolvedValue({ data: expected });

      const result = await sdk
        .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
        .execute();

      expect(result).toEqual(expected);
      expect(result.id).toBe('my-id');
    });

    it('should throw CallerSDKError on an HTTP 4xx error', async () => {
      const axiosError = new AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        { method: 'post', url: '/v1/sdk/components', headers: new AxiosHeaders() },
        {},
        {
          status: 400,
          statusText: 'Bad Request',
          data: { error: 'INVALID_INPUT', message: 'module is required' },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockPost.mockRejectedValue(axiosError);

      await expect(
        sdk
          .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
          .execute(),
      ).rejects.toThrow(CallerSDKError);

      try {
        await sdk
          .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
          .execute();
      } catch (e) {
        const err = e as CallerSDKError;
        expect(err.status).toBe(400);
        expect(err.errors).toEqual([
          { code: 'INVALID_INPUT', message: 'module is required' },
        ]);
      }
    });

    it('should throw CallerSDKError on 401 Unauthorized', async () => {
      const axiosError = new AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        { method: 'post', url: '/v1/sdk/components', headers: new AxiosHeaders() },
        {},
        {
          status: 401,
          statusText: 'Unauthorized',
          data: { error: 'UNAUTHORIZED', message: 'Invalid API key' },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockPost.mockRejectedValue(axiosError);

      await expect(
        sdk.call(ComponentModule.GENERATE_AGE_ENCRYPTION, {}).execute(),
      ).rejects.toThrow(CallerSDKError);
    });

    it('should throw CallerSDKError on 422 with multiple validation errors', async () => {
      const axiosError = new AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        { method: 'post', url: '/v1/sdk/components', headers: new AxiosHeaders() },
        {},
        {
          status: 422,
          statusText: 'Unprocessable Entity',
          data: {
            errors: [
              { code: 'INVALID_INPUT', message: 'publicKey must be hex' },
              { code: 'INVALID_INPUT', message: 'publicKey is too short' },
            ],
          },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockPost.mockRejectedValue(axiosError);

      try {
        await sdk
          .call(ComponentModule.COMPUTE_EVM_ADDRESS, { publicKey: 'invalid' })
          .execute();
      } catch (e) {
        const err = e as CallerSDKError;
        expect(err.status).toBe(422);
        expect(err.errors).toHaveLength(2);
        expect(err.errors[0].code).toBe('INVALID_INPUT');
        expect(err.errors[1].message).toBe('publicKey is too short');
      }
    });

    it('should throw CallerSDKError on a network connection error', async () => {
      const axiosError = new AxiosError(
        'connect ECONNREFUSED 127.0.0.1:3000',
        'ECONNREFUSED',
        { method: 'post', url: '/v1/sdk/components', headers: new AxiosHeaders() },
      );
      mockPost.mockRejectedValue(axiosError);

      try {
        await sdk.call(ComponentModule.GENERATE_AGE_ENCRYPTION, {}).execute();
      } catch (e) {
        const err = e as CallerSDKError;
        expect(err).toBeInstanceOf(CallerSDKError);
        expect(err.message).toContain('connection refused');
        expect(err.status).toBeUndefined();
      }
    });

    it('should re-throw non-Axios errors as-is', async () => {
      const genericError = new TypeError('Cannot read properties of undefined');
      mockPost.mockRejectedValue(genericError);

      await expect(
        sdk.call(ComponentModule.GENERATE_AGE_ENCRYPTION, {}).execute(),
      ).rejects.toThrow(TypeError);

      await expect(
        sdk.call(ComponentModule.GENERATE_AGE_ENCRYPTION, {}).execute(),
      ).rejects.not.toThrow(CallerSDKError);
    });
  });

  // -------------------------------------------------------------------------
  // .promise() — SSE-backed result delivery
  // -------------------------------------------------------------------------

  describe('.promise()', () => {
    it('should resolve with typed output when the stream emits COMPLETED', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockSseStream([
          {
            status: 'COMPLETED',
            output: { derivationPath: [44, 60, 0, 0, 0] },
          },
        ]),
      });

      const result = await sdk
        .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
        .promise();

      expect(result.derivationPath).toEqual([44, 60, 0, 0, 0]);
    });

    it('should skip non-terminal events and wait for the terminal one', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockSseStream([
          { status: 'EXECUTING' },
          { status: 'EXECUTING' },
          { status: 'COMPLETED', output: { ageIdentity: 'AGE-SECRET-KEY-1…', ageRecipient: 'age1…' } },
        ]),
      });

      const result = await sdk
        .call(ComponentModule.GENERATE_AGE_ENCRYPTION, {})
        .promise();

      expect(result).toHaveProperty('ageIdentity');
      expect(result).toHaveProperty('ageRecipient');
    });

    it('should reject with EXECUTION_FAILED when the stream emits FAILED', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockSseStream([
          { status: 'FAILED', error: 'RPC node returned 429' },
        ]),
      });

      await expect(
        sdk.call(ComponentModule.GET_EVM_ACCOUNT_BALANCE, {
          jsonRpcUrl: 'https://rpc.ankr.com/eth',
          tokenAddress: '0x0000000000000000000000000000000000000000',
          account: '0x1234567890abcdef1234567890abcdef12345678',
        }, {}).promise(),
      ).rejects.toMatchObject({
        errors: [{ code: 'EXECUTION_FAILED' }],
      });
    });

    it('should connect the SSE stream to the correct URL', async () => {
      mockPost.mockResolvedValue({
        data: mockExecResponse({ id: 'exec-abc-789' }),
      });
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockSseStream([{ status: 'COMPLETED', output: { derivationPath: [] } }]),
      });

      await sdk
        .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
        .promise();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/v1/sdk/components/executions/exec-abc-789/stream',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Api-Key': 'test-api-key',
            Accept: 'text/event-stream',
          }),
        }),
      );
    });

    it('should resolve immediately when the execution is already terminal (completed synchronously)', async () => {
      mockPost.mockResolvedValue({
        data: mockExecResponse({
          status: 'COMPLETED',
          completed: true,
          output: { derivationPath: [44, 60, 0, 0, 0] },
        }),
      });

      const result = await sdk
        .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
        .promise();

      // No SSE connection should have been opened.
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.derivationPath).toEqual([44, 60, 0, 0, 0]);
    });

    it('should reject immediately when the execution is already terminal (failed synchronously)', async () => {
      mockPost.mockResolvedValue({
        data: mockExecResponse({
          status: 'FAILED',
          completed: true,
          error: 'RPC timeout',
        }),
      });

      await expect(
        sdk.call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 }).promise(),
      ).rejects.toMatchObject({ errors: [{ code: 'EXECUTION_FAILED' }] });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject with TIMEOUT when the SSE connection is aborted after timeoutMs', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });

      // Mock fetch to return a ReadableStream that hangs but correctly raises
      // an AbortError when the AbortController fires, so our SSE loop sees it.
      mockFetch.mockImplementation(async (_url: string, options: RequestInit) => {
        const signal = options?.signal as AbortSignal | undefined;
        return {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              if (signal) {
                signal.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The user aborted a request.', 'AbortError'),
                  );
                });
              }
              // Never enqueues data — simulates a connection that never delivers events.
            },
          }),
        };
      });

      await expect(
        sdk
          .call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 })
          .promise({ timeoutMs: 50 }),
      ).rejects.toMatchObject({ errors: [{ code: 'TIMEOUT' }] });
    }, 10_000);

    it('should reject with STREAM_ERROR when the SSE endpoint returns non-2xx', async () => {
      mockPost.mockResolvedValue({ data: mockExecResponse() });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        body: null,
        text: async () => 'Invalid API key',
      });

      await expect(
        sdk.call(ComponentModule.GET_EVM_DERIVATION_PATH, { accountIndex: 0, changeIndex: 0, addressIndex: 0 }).promise(),
      ).rejects.toMatchObject({
        errors: [{ code: 'STREAM_ERROR' }],
      });
    });

    it('should throw CallerSDKError when the POST submission fails', async () => {
      const axiosError = new AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        { method: 'post', url: '/v1/sdk/components', headers: new AxiosHeaders() },
        {},
        {
          status: 402,
          statusText: 'Payment Required',
          data: { error: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockPost.mockRejectedValue(axiosError);

      await expect(
        sdk.call(ComponentModule.GENERATE_AGE_ENCRYPTION, {}).promise(),
      ).rejects.toMatchObject({ status: 402 });

      // No SSE connection should have been opened.
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Component-specific smoke tests (validates schema + correct POST payload)
  // -------------------------------------------------------------------------

  describe('component schemas', () => {
    describe('GENERATE_AGE_ENCRYPTION (no input, no config)', () => {
      it('should accept empty input', async () => {
        mockPost.mockResolvedValue({ data: mockExecResponse() });
        await sdk.call(ComponentModule.GENERATE_AGE_ENCRYPTION, {}).execute();
        expect(mockPost).toHaveBeenCalled();
      });
    });

    describe('GET_EVM_DERIVATION_PATH (required input, no config)', () => {
      it('should POST with derivation path indices', async () => {
        mockPost.mockResolvedValue({ data: mockExecResponse() });
        await sdk
          .call(ComponentModule.GET_EVM_DERIVATION_PATH, {
            accountIndex: 0,
            changeIndex: 0,
            addressIndex: 5,
          })
          .execute();
        const [, body] = mockPost.mock.calls[0];
        expect(body.input.addressIndex).toBe(5);
        expect(body.input.accountIndex).toBe(0);
      });
    });

    describe('COMPUTE_EVM_ADDRESS (required input, no config)', () => {
      it('should accept a valid publicKey', async () => {
        mockPost.mockResolvedValue({ data: mockExecResponse() });
        const publicKey =
          '04bfcab88580f1de4c8a2b5c5f67e6e1e2a5e0f3c4d7a8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1';
        await sdk
          .call(ComponentModule.COMPUTE_EVM_ADDRESS, { publicKey })
          .execute();
        expect(mockPost).toHaveBeenCalled();
      });
    });

    describe('ERC20_ABI_CONSTANT (no input, no config)', () => {
      it('should accept empty input', async () => {
        mockPost.mockResolvedValue({ data: mockExecResponse() });
        await sdk.call(ComponentModule.ERC20_ABI_CONSTANT, {}).execute();
        expect(mockPost).toHaveBeenCalled();
      });
    });

    describe('GET_EVM_ACCOUNT_BALANCE (required input, no config)', () => {
      it('should accept valid input', async () => {
        mockPost.mockResolvedValue({ data: mockExecResponse() });
        await sdk
          .call(ComponentModule.GET_EVM_ACCOUNT_BALANCE, {
            jsonRpcUrl: 'https://rpc.sepolia.org',
            tokenAddress: '0x0000000000000000000000000000000000000000',
            account: '0x1234567890abcdef1234567890abcdef12345678',
          }, {})
          .execute();
        expect(mockPost).toHaveBeenCalled();
      });
    });

    describe('GET_NODE_RECIPIENT_KEY (no input, no SDK config)', () => {
      it('should POST with empty config', async () => {
        mockPost.mockResolvedValue({ data: mockExecResponse() });
        await sdk
          .call(ComponentModule.GET_NODE_RECIPIENT_KEY, {}, {})
          .execute();
        const [, body] = mockPost.mock.calls[0];
        expect(body.config).toEqual({});
      });
    });

    describe('API_CALL (required input, no SDK config)', () => {
      it('should accept valid input with empty config', async () => {
        mockPost.mockResolvedValue({ data: mockExecResponse() });
        // Note: apiUrl and method live in the canvas config, not the SDK execution config.
        // The SDK config schema for API_CALL is empty (z.object({})).
        await sdk
          .call(ComponentModule.API_CALL, { headers: {} }, {})
          .execute();
        expect(mockPost).toHaveBeenCalled();
      });
    });
  });
});
