import { CallerSDKError } from '@/errors';
import type {
  ExecuteComponentResponse,
  ExecuteOptions,
  PromiseOptions,
} from '@/types';

// ---------------------------------------------------------------------------
// CallBuilder
// ---------------------------------------------------------------------------

/**
 * Lazy execution builder returned by {@link CallerSDK.call}.
 *
 * `call()` validates your input immediately and returns a `CallBuilder` — no
 * network request is made until you call one of the delivery methods:
 *
 * | Method | When to use |
 * |--------|-------------|
 * | {@link execute} | You have a webhook endpoint, or want to fire-and-forget |
 * | {@link promise} | You want `await`-able results with no polling (recommended) |
 *
 * @template Output The typed output shape of the component being called.
 *
 * @example
 * // Fire-and-forget with webhook callback
 * const exec = await sdk
 *   .call(ComponentModule.SIGN_EVM_TRANSACTION, input, config)
 *   .execute({ callbackUrl: 'https://yourserver.com/hook', callbackSecret: 'shhh' });
 *
 * @example
 * // SSE-backed promise — resolves when the execution completes
 * const result = await sdk
 *   .call(ComponentModule.GET_EVM_ACCOUNT_BALANCE, { address: '0x…', chainId: 1 }, {})
 *   .promise({ timeoutMs: 30_000 });
 *
 * console.log(result.balance);
 */
export class CallBuilder<Output> {
  /**
   * @internal
   * @param submitFn    - Sends the POST /v1/sdk/components request.
   * @param streamUrlFn - Builds the SSE endpoint URL from an executionId.
   * @param apiKey      - Workspace API key forwarded to the SSE request.
   */
  constructor(
    private readonly submitFn: (
      options: ExecuteOptions,
    ) => Promise<ExecuteComponentResponse>,
    private readonly streamUrlFn: (executionId: string) => string,
    private readonly apiKey: string,
  ) {}

  // -------------------------------------------------------------------------
  // .execute()
  // -------------------------------------------------------------------------

  /**
   * Submit the execution and return immediately with the raw execution record.
   *
   * The returned {@link ExecuteComponentResponse} reflects the state at
   * submission time:
   * - Without `waitForMs` → `status: 'CREATED'`, `completed: false`
   * - With `waitForMs` and fast execution → `status: 'COMPLETED'`, `completed: true`
   *
   * **Choose this method when:**
   * - You have an HTTPS webhook to receive the result (`callbackUrl`)
   * - You want to implement your own polling loop
   * - You need to submit many executions in parallel and process results later
   *
   * @param options - {@link ExecuteOptions}: attempts, waitForMs, callbackUrl,
   *   callbackSecret, callbackHeaders
   * @returns The raw execution record at submission time.
   *
   * @example
   * // Webhook delivery — returns immediately after submission
   * const exec = await sdk
   *   .call(ComponentModule.BROADCAST_EVM_TRANSACTION, input, config)
   *   .execute({
   *     callbackUrl: 'https://yourserver.com/webhook',
   *     callbackSecret: process.env.WEBHOOK_SECRET!,
   *     attempts: 2,
   *   });
   *
   * console.log('Submitted:', exec.id); // track with exec.id
   *
   * @example
   * // Inline wait up to 5 seconds (simple components only)
   * const exec = await sdk
   *   .call(ComponentModule.RANDOM_UUID, {})
   *   .execute({ waitForMs: 5_000 });
   *
   * if (exec.completed) {
   *   console.log(exec.output); // typed as `unknown` — use .promise() for typed output
   * }
   */
  async execute(options: ExecuteOptions = {}): Promise<ExecuteComponentResponse> {
    return this.submitFn(options);
  }

  // -------------------------------------------------------------------------
  // .promise()
  // -------------------------------------------------------------------------

  /**
   * Submit the execution and wait for the typed output via SSE.
   *
   * Internally this method:
   * 1. Sends `POST /v1/sdk/components` (async, no `waitForMs`)
   * 2. Opens `GET /v1/sdk/components/executions/:id/stream` — a
   *    Server-Sent Events connection backed by Redis Pub/Sub
   * 3. Waits for a `COMPLETED` or `FAILED` event, then closes the connection
   *
   * There is **no polling** — the server pushes exactly one terminal event and
   * the connection closes. Under high concurrency this keeps database query
   * counts constant regardless of how many executions are in-flight.
   *
   * **Choose this method when:**
   * - You want classic `await`-able request/response semantics
   * - You don't want to manage webhook endpoints
   * - Performance matters (no repeated HTTP round-trips)
   *
   * Uses the native `fetch` API (Node 18+ / all modern browsers). No extra
   * dependencies are required.
   *
   * @param options - {@link PromiseOptions}: attempts, timeoutMs (default 60 s)
   * @returns The strongly-typed component output.
   * @throws {CallerSDKError} with `code: 'EXECUTION_FAILED'` if the component fails.
   * @throws {CallerSDKError} with `code: 'TIMEOUT'` if `timeoutMs` elapses.
   * @throws {CallerSDKError} with `code: 'STREAM_ERROR'` if the SSE connection fails.
   *
   * @example
   * const balance = await sdk
   *   .call(ComponentModule.GET_EVM_ACCOUNT_BALANCE, {
   *     jsonRpcUrl: 'https://rpc.ankr.com/eth',
   *     tokenAddress: '0x0000000000000000000000000000000000000000',
   *     account: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
   *   }, {})
   *   .promise({ timeoutMs: 30_000 });
   *
   * console.log(balance.value); // bigint wei value
   *
   * @example
   * // Chain multiple components
   * const { derivationPath } = await sdk
   *   .call(ComponentModule.GET_EVM_DERIVATION_PATH, { addressIndex: 0 })
   *   .promise();
   *
   * const { publicKey } = await sdk
   *   .call(ComponentModule.COMPUTE_PUBLIC_KEY, { derivationPath, keyShareIds: [...] }, {})
   *   .promise();
   */
  async promise(options: PromiseOptions = {}): Promise<Output> {
    const { timeoutMs = 60_000, attempts } = options;

    const execution = await this.submitFn({ attempts });

    // The execution completed synchronously (edge case with fast components).
    if (execution.completed) {
      return resolveTerminal<Output>(execution);
    }

    return waitViaSSE<Output>(
      this.streamUrlFn(execution.id),
      this.apiKey,
      timeoutMs,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves or throws based on a terminal {@link ExecuteComponentResponse}.
 * Used when the execution is already `completed` before we even open an SSE
 * connection (rare, but possible for near-instant components).
 */
function resolveTerminal<Output>(execution: ExecuteComponentResponse): Output {
  if (execution.status === 'FAILED') {
    const errMsg =
      typeof execution.error === 'string'
        ? execution.error
        : (JSON.stringify(execution.error) ?? 'Component execution failed');
    throw new CallerSDKError('Execution failed', {
      responseBody: execution.error,
      errors: [{ code: 'EXECUTION_FAILED', message: errMsg }],
    });
  }
  return execution.output as Output;
}

/**
 * Open an SSE stream at `url` and resolve/reject when a terminal status event
 * (`COMPLETED` or `FAILED`) arrives, then close the connection.
 *
 * ### SSE event format
 * Each event is a line `data: <JSON>\n\n` where the JSON has the shape:
 * ```json
 * { "id": "exec-…", "status": "COMPLETED", "output": {…}, "timestamp": "…" }
 * ```
 * Heartbeat comments (`: ping`) are silently ignored.
 * Non-terminal statuses (`CREATED`, `EXECUTING`) are skipped — reading continues.
 *
 * ### Timeout behaviour
 * If `timeoutMs` elapses before a terminal event, the `AbortController` fires,
 * the connection is torn down, and a `TIMEOUT` `CallerSDKError` is thrown.
 *
 * @param url        - Full SSE endpoint URL.
 * @param apiKey     - Workspace API key forwarded as `X-Api-Key`.
 * @param timeoutMs  - Maximum wait time in milliseconds.
 */
async function waitViaSSE<Output>(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<Output> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new CallerSDKError(
        `Failed to connect to execution stream: HTTP ${response.status}`,
        {
          status: response.status,
          statusText: response.statusText,
          responseBody: body,
          errors: [
            {
              code: 'STREAM_ERROR',
              message: `HTTP ${response.status} ${response.statusText}`,
            },
          ],
        },
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode the chunk and append to our line buffer.
      buffer += decoder.decode(value, { stream: true });

      // SSE events are delimited by blank lines (\n\n).
      // Split on newlines, keeping the last (potentially incomplete) line.
      const lines = buffer.split('\n');
      // `String.prototype.split` always returns a non-empty array, so
      // `lines.pop()` is guaranteed to be a string. The `?? ''` is a defensive
      // fallback that cannot be reached in practice.
      /* istanbul ignore next */
      buffer = lines.pop() ?? '';

      let dataLine = '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          // Accumulate data lines (the spec allows multi-line data fields).
          dataLine += (dataLine ? '\n' : '') + line.slice(6);
        } else if (line === '') {
          // Blank line = event boundary.
          if (!dataLine) {
            // No data accumulated — heartbeat or empty boundary, skip.
            continue;
          }

          const event = tryParseEvent(dataLine);
          dataLine = '';

          if (!event) continue; // Malformed JSON, skip silently.

          if (event.status === 'COMPLETED') {
            clearTimeout(timer);
            reader.cancel().catch(/* istanbul ignore next */ () => {});
            return event.output as Output;
          }

          if (event.status === 'FAILED') {
            clearTimeout(timer);
            reader.cancel().catch(/* istanbul ignore next */ () => {});
            const errMsg =
              typeof event.error === 'string'
                ? event.error
                : (JSON.stringify(event.error) ?? 'Component execution failed');
            throw new CallerSDKError('Execution failed', {
              responseBody: event.error,
              errors: [{ code: 'EXECUTION_FAILED', message: errMsg }],
            });
          }

          // Non-terminal status (CREATED, EXECUTING) — keep reading.
        }
        // Lines starting with ':' are SSE comments (e.g. ': ping') — ignored.
        // Lines starting with 'event:', 'id:', 'retry:' are not needed here.
      }
    }

    throw new CallerSDKError(
      'Execution stream closed without a terminal status event.',
      {
        errors: [
          {
            code: 'STREAM_CLOSED',
            message:
              'The SSE stream ended before a COMPLETED or FAILED event was received.',
          },
        ],
      },
    );
  } catch (err) {
    if (err instanceof CallerSDKError) throw err;
    // Guard against AbortError from both Error subclasses (native fetch) and
    // DOMException (ReadableStream controller), which may not extend Error in
    // all runtime environments.
    if (isAbortError(err)) {
      throw new CallerSDKError(`Execution timed out after ${timeoutMs}ms`, {
        errors: [
          {
            code: 'TIMEOUT',
            message: `Execution did not complete within ${timeoutMs}ms. Increase timeoutMs in PromiseOptions if needed.`,
          },
        ],
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface SseEvent {
  status: string;
  output?: unknown;
  error?: unknown;
}

/**
 * Returns `true` when `err` represents an `AbortError`.
 *
 * Handles two shapes:
 * - Native `fetch` AbortError: `err instanceof Error && err.name === 'AbortError'`
 * - `DOMException` from `ReadableStreamDefaultController.error()`, which may
 *   not extend `Error` in all Node.js/jsdom versions but always has `.name`.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

/** Safely parse an SSE data line as JSON. Returns `null` on malformed input. */
function tryParseEvent(data: string): SseEvent | null {
  try {
    return JSON.parse(data) as SseEvent;
  } catch {
    return null;
  }
}
