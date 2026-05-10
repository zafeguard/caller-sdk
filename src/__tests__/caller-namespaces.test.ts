import axios, { AxiosError, AxiosHeaders } from 'axios';
import { WorkspaceClient } from '@/bootstrap/caller';
import { CallerSDKError } from '@/errors';
import type { ExecuteComponentResponse, ExecutionStreamEvent } from '@/types';

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

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let emitted = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emitted) {
        emitted = true;
        controller.enqueue(encoder.encode(text));
      } else {
        controller.close();
      }
    },
  });
}

function streamThatErrorsOnAbort(): typeof fetch {
  return (async (_url: string, opts: RequestInit) => {
    const signal = opts?.signal as AbortSignal | undefined;
    return {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      }),
    };
  }) as unknown as typeof fetch;
}

function mockExecResponse(
  overrides: Partial<ExecuteComponentResponse> = {},
): ExecuteComponentResponse {
  return {
    id: 'exec-1',
    module: 'GENERATE_AGE_ENCRYPTION',
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
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('WorkspaceClient namespaces', () => {
  let mockGet: jest.Mock;
  let mockPost: jest.Mock;
  let mockFetch: jest.SpyInstance;
  let sdk: InstanceType<typeof WorkspaceClient>;

  beforeEach(() => {
    mockGet = jest.fn();
    mockPost = jest.fn();
    mockedCreate.mockReturnValue({
      get: mockGet,
      post: mockPost,
      defaults: { baseURL: 'http://localhost:3000/' },
    } as any);

    sdk = new WorkspaceClient({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:3000/',
    });

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
    mockedCreate.mockReset();
  });

  // -------------------------------------------------------------------------
  // execution.get
  // -------------------------------------------------------------------------

  describe('execution.get()', () => {
    it('returns the response data on success', async () => {
      const expected = mockExecResponse({ id: 'exec-x' });
      mockGet.mockResolvedValue({ data: expected });

      await expect(sdk.execution.get('exec-x')).resolves.toEqual(expected);
      expect(mockGet).toHaveBeenCalledWith(
        '/v1/sdk/components/executions/exec-x',
        { headers: { 'X-Api-Key': 'test-key' } },
      );
    });

    it('wraps AxiosError as CallerSDKError', async () => {
      const axiosError = new AxiosError(
        'fail',
        undefined,
        { method: 'get', url: '/v1/sdk/components/executions/x', headers: new AxiosHeaders() },
        {},
        {
          status: 404,
          statusText: 'Not Found',
          data: { error: 'NOT_FOUND' },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockGet.mockRejectedValue(axiosError);

      await expect(sdk.execution.get('x')).rejects.toThrow(CallerSDKError);
    });

    it('rethrows non-Axios errors as-is', async () => {
      const err = new Error('weird');
      mockGet.mockRejectedValue(err);
      await expect(sdk.execution.get('x')).rejects.toBe(err);
    });
  });

  // -------------------------------------------------------------------------
  // execution.stream
  // -------------------------------------------------------------------------

  describe('execution.stream()', () => {
    it('opens an SSE stream at the correct URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'e', status: 'COMPLETED', output: {}, error: null, timestamp: 't' })}\n\n`,
        ),
      } as any);

      const events: ExecutionStreamEvent[] = [];
      await new Promise<void>((resolve) => {
        sdk.execution.stream('exec-1', {
          onUpdate: (e) => {
            events.push(e);
            if (e.status === 'COMPLETED') resolve();
          },
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/v1/sdk/components/executions/exec-1/stream',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Api-Key': 'test-key',
            Accept: 'text/event-stream',
          }),
        }),
      );
      expect(events).toHaveLength(1);
    });

    it('terminates on FAILED status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'e', status: 'FAILED', output: null, error: 'boom', timestamp: 't' })}\n\n`,
        ),
      } as any);

      await new Promise<void>((resolve) => {
        sdk.execution.stream('e', {
          onUpdate: (e) => {
            if (e.status === 'FAILED') resolve();
          },
        });
      });
    });

    it('aggregates multi-line data fields, ignoring empty boundaries and bad JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `\n\n` + // empty boundary, no data
            `data: not-json\n\n` +
            `data: {"id":"e","status":"EXECUTING","output":null,"error":null,"timestamp":"t"}\n\n` +
            `data: {"id":"e","status":"COMPLETED","output":{},"error":null,"timestamp":"t"}\n\n`,
        ),
      } as any);

      const seen: string[] = [];
      await new Promise<void>((resolve) => {
        sdk.execution.stream('e', {
          onUpdate: (e) => {
            seen.push(e.status);
            if (e.status === 'COMPLETED') resolve();
          },
        });
      });
      expect(seen).toEqual(['EXECUTING', 'COMPLETED']);
    });

    it('calls onError when SSE response is not OK', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        body: null,
      } as any);

      const err: Error = await new Promise((resolve) => {
        sdk.execution.stream('e', {
          onUpdate: () => {},
          onError: (e) => resolve(e),
        });
      });
      expect(err.message).toMatch(/SSE connection failed: 401/);
    });

    it('close() prevents onError from firing after abort', async () => {
      mockFetch.mockImplementation(streamThatErrorsOnAbort());
      const onError = jest.fn();
      const sub = sdk.execution.stream('e', {
        onUpdate: () => {},
        onError,
      });
      await new Promise((r) => setTimeout(r, 5));
      sub.close();
      sub.close(); // idempotent
      await new Promise((r) => setTimeout(r, 20));
      expect(onError).not.toHaveBeenCalled();
    });

    it('exits the read loop when the stream ends without a terminal event', async () => {
      // Drives the `if (done) break` branch — the server closes the
      // connection without ever emitting COMPLETED or FAILED.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'e', status: 'EXECUTING', output: null, error: null, timestamp: 't' })}\n\n`,
        ),
      } as any);

      const events: ExecutionStreamEvent[] = [];
      const onError = jest.fn();
      sdk.execution.stream('e', {
        onUpdate: (e) => {
          events.push(e);
        },
        onError,
      });

      // Wait long enough for the read loop to finish naturally.
      await new Promise((r) => setTimeout(r, 30));
      expect(events.map((e) => e.status)).toEqual(['EXECUTING']);
      expect(onError).not.toHaveBeenCalled();
    });

    it('aggregates multi-line `data:` fields with embedded newlines', async () => {
      // Two consecutive `data:` lines are concatenated with a literal \n,
      // exercising the truthy branch of `dataLine ? '\n' : ''`.
      const json = JSON.stringify({
        id: 'e',
        status: 'COMPLETED',
        output: { ok: true },
        error: null,
        timestamp: 't',
      });
      const half = Math.floor(json.length / 2);
      // Multi-line `data:` events are concatenated with `\n`, which would
      // normally break JSON parsing — so use a known multi-line-but-valid
      // JSON shape: split on a non-meaningful boundary then recombine.
      // Easiest: encode the full event on one line, but precede it with an
      // earlier event whose `data:` payload spans two lines (gibberish that
      // fails JSON.parse and is harmlessly discarded).
      const text =
        `data: line-one\n` +
        `data: line-two\n` +
        `\n` +
        `data: ${json.slice(0, half)}` +
        `${json.slice(half)}\n\n`;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(text),
      } as any);

      await new Promise<void>((resolve) => {
        sdk.execution.stream('e', {
          onUpdate: (e) => {
            if (e.status === 'COMPLETED') resolve();
          },
        });
      });
    });

    it('silently ignores SSE comment lines and event/id metadata lines', async () => {
      // Lines that don't start with `data: ` and aren't blank fall through
      // both branches of the dispatcher — exercises the implicit else.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `: heartbeat\n` +
            `event: status\n` +
            `id: 42\n` +
            `retry: 1000\n` +
            `data: ${JSON.stringify({ id: 'e', status: 'COMPLETED', output: {}, error: null, timestamp: 't' })}\n\n`,
        ),
      } as any);

      const events: ExecutionStreamEvent[] = [];
      await new Promise<void>((resolve) => {
        sdk.execution.stream('e', {
          onUpdate: (e) => {
            events.push(e);
            if (e.status === 'COMPLETED') resolve();
          },
        });
      });
      expect(events.map((e) => e.status)).toEqual(['COMPLETED']);
    });

    it('handles missing baseURL by treating as empty string', async () => {
      mockedCreate.mockReturnValueOnce({
        get: mockGet,
        post: mockPost,
        defaults: {},
      } as any);
      const sdk2 = new WorkspaceClient({
        apiKey: 'k',
        baseUrl: 'http://x',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'e', status: 'COMPLETED', output: {}, error: null, timestamp: 't' })}\n\n`,
        ),
      } as any);

      await new Promise<void>((resolve) => {
        sdk2.execution.stream('eid', {
          onUpdate: (e) => {
            if (e.status === 'COMPLETED') resolve();
          },
        });
      });

      const calls = mockFetch.mock.calls;
      expect(calls[calls.length - 1][0]).toBe('/v1/sdk/components/executions/eid/stream');
    });
  });

  // -------------------------------------------------------------------------
  // webhook.redeliver
  // -------------------------------------------------------------------------

  describe('webhook.redeliver()', () => {
    it('POSTs to the replay-callback endpoint', async () => {
      mockPost.mockResolvedValue({ data: undefined });

      await sdk.webhook.redeliver('exec-z');

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/sdk/components/executions/exec-z/replay-callback',
        {},
        { headers: { 'X-Api-Key': 'test-key' } },
      );
    });

    it('wraps AxiosError as CallerSDKError', async () => {
      const axiosError = new AxiosError(
        'fail',
        undefined,
        { method: 'post', url: '/x', headers: new AxiosHeaders() },
        {},
        {
          status: 409,
          statusText: 'Conflict',
          data: { error: 'NO_CALLBACK', message: 'no callback url' },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockPost.mockRejectedValue(axiosError);

      await expect(sdk.webhook.redeliver('e')).rejects.toThrow(CallerSDKError);
    });

    it('rethrows non-Axios errors as-is', async () => {
      const err = new Error('weird');
      mockPost.mockRejectedValue(err);
      await expect(sdk.webhook.redeliver('e')).rejects.toBe(err);
    });
  });

  // -------------------------------------------------------------------------
  // .call() — baseURL stripping
  // -------------------------------------------------------------------------

  describe('.call() URL handling', () => {
    it('handles undefined baseURL when constructing the stream URL', async () => {
      mockedCreate.mockReturnValueOnce({
        get: mockGet,
        post: mockPost,
        defaults: {},
      } as any);
      const sdk2 = new WorkspaceClient({ apiKey: 'k', baseUrl: 'http://x' });

      mockPost.mockResolvedValueOnce({ data: mockExecResponse({ id: 'e' }) });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ status: 'COMPLETED', output: { ageIdentity: 'i', ageRecipient: 'r' } })}\n\n`,
        ),
      } as any);

      // Using GENERATE_AGE_ENCRYPTION — no required input.
      const result = await sdk2
        .call(
          // ComponentModule.GENERATE_AGE_ENCRYPTION
          'GENERATE_AGE_ENCRYPTION' as any,
          {},
          {},
        )
        .promise();
      expect(result).toEqual({ ageIdentity: 'i', ageRecipient: 'r' });
      const fetchCalls = mockFetch.mock.calls;
      expect(fetchCalls[fetchCalls.length - 1][0]).toBe('/v1/sdk/components/executions/e/stream');
    });
  });
});
