import { CallBuilder } from '@/bootstrap/call-builder';
import { CallerSDKError } from '@/errors';
import type { ExecuteComponentResponse, ExecuteOptions } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecResponse(
  overrides: Partial<ExecuteComponentResponse> = {},
): ExecuteComponentResponse {
  return {
    id: 'exec-test',
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

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
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

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function makeBuilder(
  submitImpl: (opts: ExecuteOptions) => Promise<ExecuteComponentResponse>,
): CallBuilder<{ value: number }> {
  return new CallBuilder<{ value: number }>(
    submitImpl,
    (id) => `https://api.example.com/v1/sdk/components/executions/${id}/stream`,
    'test-api-key',
  );
}

// ---------------------------------------------------------------------------
// .execute()
// ---------------------------------------------------------------------------

describe('CallBuilder.execute', () => {
  it('forwards options to the submit function', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    const opts: ExecuteOptions = {
      attempts: 3,
      waitForMs: 100,
      callbackUrl: 'https://hook',
      callbackSecret: 's',
      callbackHeaders: { a: 'b' },
    };
    await builder.execute(opts);

    expect(submit).toHaveBeenCalledWith(opts);
  });

  it('defaults to an empty options object when none provided', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    await builder.execute();

    expect(submit).toHaveBeenCalledWith({});
  });

  it('returns the raw submit response unchanged', async () => {
    const resp = mockExecResponse({ id: 'abc-123' });
    const submit = jest.fn().mockResolvedValue(resp);
    const builder = makeBuilder(submit);

    await expect(builder.execute()).resolves.toBe(resp);
  });

  it('propagates submit errors', async () => {
    const err = new Error('boom');
    const submit = jest.fn().mockRejectedValue(err);
    const builder = makeBuilder(submit);

    await expect(builder.execute()).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// .promise()
// ---------------------------------------------------------------------------

describe('CallBuilder.promise', () => {
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes only attempts (not timeoutMs) to submit', async () => {
    const submit = jest.fn().mockResolvedValue(
      mockExecResponse({ status: 'COMPLETED', completed: true, output: { value: 1 } }),
    );
    const builder = makeBuilder(submit);

    await builder.promise({ attempts: 2, timeoutMs: 1000 });

    expect(submit).toHaveBeenCalledWith({ attempts: 2 });
  });

  it('resolves synchronously when submit returns a completed COMPLETED execution', async () => {
    const submit = jest.fn().mockResolvedValue(
      mockExecResponse({ status: 'COMPLETED', completed: true, output: { value: 7 } }),
    );
    const builder = makeBuilder(submit);

    const result = await builder.promise();
    expect(result).toEqual({ value: 7 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects synchronously when submit returns a completed FAILED execution with string error', async () => {
    const submit = jest.fn().mockResolvedValue(
      mockExecResponse({
        status: 'FAILED',
        completed: true,
        error: 'oops',
      }),
    );
    const builder = makeBuilder(submit);

    await expect(builder.promise()).rejects.toMatchObject({
      errors: [{ code: 'EXECUTION_FAILED', message: 'oops' }],
    });
  });

  it('rejects synchronously when submit returns a completed FAILED execution with object error', async () => {
    const submit = jest.fn().mockResolvedValue(
      mockExecResponse({
        status: 'FAILED',
        completed: true,
        error: { reason: 'rate-limited' },
      }),
    );
    const builder = makeBuilder(submit);

    await expect(builder.promise()).rejects.toMatchObject({
      errors: [{ code: 'EXECUTION_FAILED', message: '{"reason":"rate-limited"}' }],
    });
  });

  it('handles multi-chunk SSE delivery and parses split events', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    // Split a single SSE event across two chunks to exercise the buffer.
    mockFetch.mockResolvedValue({
      ok: true,
      body: streamFromChunks([
        'data: {"status":"EXEC',
        'UTING"}\n\ndata: {"status":"COMPLETED","output":{"value":42}}\n\n',
      ]),
    } as any);

    const result = await builder.promise();
    expect(result).toEqual({ value: 42 });
  });

  it('ignores SSE comment lines (heartbeats) and malformed JSON', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockResolvedValue({
      ok: true,
      body: streamFromText(
        ': ping\n\n' +
          'data: not-json\n\n' +
          'data: {"status":"COMPLETED","output":{"value":99}}\n\n',
      ),
    } as any);

    const result = await builder.promise();
    expect(result).toEqual({ value: 99 });
  });

  it('skips empty boundaries with no data accumulated', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockResolvedValue({
      ok: true,
      body: streamFromText(
        '\n\n\n\ndata: {"status":"COMPLETED","output":{"value":5}}\n\n',
      ),
    } as any);

    const result = await builder.promise();
    expect(result).toEqual({ value: 5 });
  });

  it('supports multi-line data fields (concatenated with \\n)', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    // Multi-line data — the spec joins with \n which would break JSON; emit a
    // single-line event instead but ensure the multi-line accumulation path
    // does not crash the loop.
    mockFetch.mockResolvedValue({
      ok: true,
      body: streamFromText(
        'data: {"status":"EXECUTING"}\n' +
          'data: extra\n\n' +
          'data: {"status":"COMPLETED","output":{"value":1}}\n\n',
      ),
    } as any);

    const result = await builder.promise();
    expect(result).toEqual({ value: 1 });
  });

  it('rejects with STREAM_ERROR when SSE response is not OK', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      body: null,
      text: async () => 'oops',
    } as any);

    await expect(builder.promise()).rejects.toMatchObject({
      status: 500,
      statusText: 'Server Error',
      responseBody: 'oops',
      errors: [{ code: 'STREAM_ERROR' }],
    });
  });

  it('falls back to empty body when text() throws', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      body: null,
      text: async () => {
        throw new Error('text-failed');
      },
    } as any);

    await expect(builder.promise()).rejects.toMatchObject({
      status: 502,
      responseBody: '',
      errors: [{ code: 'STREAM_ERROR' }],
    });
  });

  it('rejects with STREAM_CLOSED when the stream ends without a terminal event', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockResolvedValue({
      ok: true,
      body: streamFromText('data: {"status":"EXECUTING"}\n\n'),
    } as any);

    await expect(builder.promise()).rejects.toMatchObject({
      errors: [{ code: 'STREAM_CLOSED' }],
    });
  });

  it('rejects with TIMEOUT when the AbortController fires (Error AbortError)', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockImplementation(async (_url: string, opts: RequestInit) => {
      const signal = opts?.signal as AbortSignal | undefined;
      return {
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              controller.error(err);
            });
          },
        }),
      };
    });

    await expect(builder.promise({ timeoutMs: 30 })).rejects.toMatchObject({
      errors: [{ code: 'TIMEOUT' }],
    });
  });

  it('rejects with TIMEOUT when the AbortController fires (DOMException AbortError)', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockImplementation(async (_url: string, opts: RequestInit) => {
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
    });

    await expect(builder.promise({ timeoutMs: 30 })).rejects.toMatchObject({
      errors: [{ code: 'TIMEOUT' }],
    });
  });

  it('rejects with FAILED when the SSE event carries an object error', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockResolvedValue({
      ok: true,
      body: streamFromText(
        `data: ${JSON.stringify({ status: 'FAILED', error: { code: 'XX' } })}\n\n`,
      ),
    } as any);

    await expect(builder.promise()).rejects.toMatchObject({
      errors: [{ code: 'EXECUTION_FAILED', message: '{"code":"XX"}' }],
    });
  });

  it('rejects with FAILED when the SSE event carries a string error', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    mockFetch.mockResolvedValue({
      ok: true,
      body: streamFromText(
        `data: ${JSON.stringify({ status: 'FAILED', error: 'rpc-down' })}\n\n`,
      ),
    } as any);

    await expect(builder.promise()).rejects.toMatchObject({
      errors: [{ code: 'EXECUTION_FAILED', message: 'rpc-down' }],
    });
  });

  it('rethrows non-abort errors thrown by fetch', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    const networkErr = new Error('ECONNRESET');
    mockFetch.mockRejectedValue(networkErr);

    await expect(builder.promise()).rejects.toBe(networkErr);
  });

  it('rethrows CallerSDKError thrown inside the SSE block unchanged', async () => {
    const submit = jest.fn().mockResolvedValue(mockExecResponse());
    const builder = makeBuilder(submit);

    // Triggers the !response.ok branch which throws CallerSDKError. The catch
    // path must rethrow it as-is (not wrap it).
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      body: null,
      text: async () => '',
    } as any);

    const err = await builder.promise().catch((e) => e);
    expect(err).toBeInstanceOf(CallerSDKError);
    expect((err as CallerSDKError).errors[0].code).toBe('STREAM_ERROR');
  });
});
