import { AxiosError } from 'axios';
import { ComponentModule } from '@/generated/enums';
import { Client } from './client';
import { CallerSDKError } from '@/errors';
import { CallableComponents } from '@/generated/components';
import { validationSchemas } from '@/generated/schemas';
import { CallBuilder } from './call-builder';
import type {
  ExecuteComponentResponse,
  ExecuteOptions,
  ExecutionStreamEvent,
  ExecutionStreamHandlers,
  ExecutionStreamSubscription,
} from '@/types';

// ---------------------------------------------------------------------------
// Management interface — operations on existing executions
// ---------------------------------------------------------------------------

/**
 * Execution namespace on {@link WorkspaceClient} — `workspace.execution.*`
 */
export interface ExecutionNamespace {
  /**
   * Fetch the current state of any execution by its UUID.
   *
   * Useful when you submitted a job with `.execute()` and want to check it
   * later without opening an SSE stream.
   *
   * @param executionId - UUID returned by `.execute()`.
   *
   * @example
   * const exec = await workspace.call(ComponentModule.RANDOM_UUID, {}).execute();
   * // ... later ...
   * const latest = await workspace.execution.get(exec.id);
   * if (latest.completed) console.log(latest.output);
   */
  get(executionId: string): Promise<ExecuteComponentResponse>;

  /**
   * Subscribe to live status events for an execution via SSE.
   *
   * The stream closes automatically when the execution reaches a terminal
   * state (`COMPLETED` or `FAILED`). Call the returned `close()` to
   * unsubscribe early.
   *
   * @param executionId - UUID returned by `.execute()`.
   * @param handlers    - Callbacks for status events and errors.
   * @returns A subscription handle with a `close()` method.
   *
   * @example
   * const sub = workspace.execution.stream(exec.id, {
   *   onUpdate(event) {
   *     console.log(event.status, event.output);
   *   },
   *   onError(err) {
   *     console.error('Stream error:', err.message);
   *   },
   * });
   * // sub.close() to unsubscribe early
   */
  stream(
    executionId: string,
    handlers: ExecutionStreamHandlers,
  ): ExecutionStreamSubscription;
}

/**
 * Webhook namespace on {@link WorkspaceClient} — `workspace.webhook.*`
 */
export interface WebhookNamespace {
  /**
   * Re-deliver the completion webhook for an execution whose original
   * callback delivery failed.
   *
   * Idempotent — safe to call multiple times. Requires that `callbackUrl`
   * was set when the execution was created.
   *
   * @param executionId - UUID of the execution whose callback should be retried.
   *
   * @example
   * await workspace.webhook.redeliver('3f7a1c...');
   */
  redeliver(executionId: string): Promise<void>;
}

/**
 * Namespaced management API available on {@link WorkspaceClient}.
 */
export interface WorkspaceClientManagement {
  /** Operations on existing executions. */
  execution: ExecutionNamespace;
  /** Webhook delivery operations. */
  webhook: WebhookNamespace;
}

/**
 * Core SDK implementation.
 *
 * Consumers interact with this through the {@link WorkspaceClient} type alias,
 * which presents the fully-typed {@link CallableComponents} interface instead
 * of the raw `WorkspaceClientImpl` class. This keeps the public API clean and
 * ensures TypeScript infers the correct per-component input/output types.
 *
 * @internal
 */
class WorkspaceClientImpl extends Client {
  /**
   * Prepare a component execution.
   *
   * Input and config are validated **synchronously** against the component's
   * Zod schema before any network activity takes place. If validation fails a
   * {@link CallerSDKError} is thrown immediately — no `await` needed to catch it.
   *
   * The method returns a {@link CallBuilder} that lets you choose how to
   * deliver and receive the result:
   *
   * - **{@link CallBuilder.execute}** — fire-and-forget / webhook mode.
   *   Returns the raw `ExecuteComponentResponse` immediately after the server
   *   accepts the job. Wire up a `callbackUrl` to receive the terminal result
   *   asynchronously, or poll using the execution `id`.
   *
   * - **{@link CallBuilder.promise}** — SSE-backed promise mode (**recommended**).
   *   Submits the job, opens a Server-Sent Events stream, and resolves with
   *   the **typed** component output the instant the server pushes a terminal
   *   event. No polling, no repeated DB queries.
   *
   * @param module - The component to invoke (e.g. `ComponentModule.API_CALL`).
   * @param input  - Component input; must satisfy the component's input schema.
   * @param config - Component config; must satisfy the component's config schema.
   * @returns A {@link CallBuilder} instance.
   * @throws {CallerSDKError} synchronously when input or config fails validation.
   *
   * @example
   * // SSE-backed promise (recommended for request/response style)
   * const { balance } = await workspace
   *   .call(ComponentModule.GET_EVM_ACCOUNT_BALANCE, {
   *     jsonRpcUrl: 'https://rpc.ankr.com/eth',
   *     tokenAddress: '0x0000000000000000000000000000000000000000',
   *     account: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
   *   }, {})
   *   .promise({ timeoutMs: 30_000 });
   *
   * @example
   * // Webhook / fire-and-forget
   * const exec = await workspace
   *   .call(ComponentModule.BROADCAST_EVM_TRANSACTION, input, config)
   *   .execute({
   *     callbackUrl: 'https://yourserver.com/hook',
   *     callbackSecret: process.env.WEBHOOK_SECRET!,
   *   });
   *
   * console.log('Tracking ID:', exec.id);
   */
  call(
    module: ComponentModule,
    input: unknown = {},
    config: unknown = {},
  ): CallBuilder<unknown> {
    // Validate synchronously — fail fast before touching the network.
    const schemas = validationSchemas[module];

    const inputResult = schemas.input.safeParse(input);
    if (!inputResult.success) {
      throw CallerSDKError.fromZodError(inputResult.error, `${module} input`);
    }

    const configResult = schemas.config.safeParse(config);
    if (!configResult.success) {
      throw CallerSDKError.fromZodError(configResult.error, `${module} config`);
    }

    const baseUrl = (this.client.defaults.baseURL ?? '').replace(/\/$/, '');

    return new CallBuilder<unknown>(
      (options: ExecuteOptions) => this._submit(module, input, config, options),
      (executionId: string) =>
        `${baseUrl}/v1/sdk/components/executions/${executionId}/stream`,
      this.apiKey,
    );
  }

  /** @see {@link ExecutionNamespace} */
  readonly execution: ExecutionNamespace = {
    get: async (executionId: string): Promise<ExecuteComponentResponse> => {
      try {
        const response = await this.client.get(
          `/v1/sdk/components/executions/${executionId}`,
          { headers: { 'X-Api-Key': this.apiKey } },
        );
        return response.data as ExecuteComponentResponse;
      } catch (error) {
        if (error instanceof AxiosError) throw CallerSDKError.fromAxiosError(error);
        throw error;
      }
    },

    stream: (
      executionId: string,
      handlers: ExecutionStreamHandlers,
    ): ExecutionStreamSubscription => {
      const baseUrl = (this.client.defaults.baseURL ?? '').replace(/\/$/, '');
      const url = `${baseUrl}/v1/sdk/components/executions/${executionId}/stream`;
      const apiKey = this.apiKey;

      let controller: AbortController | null = new AbortController();
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        controller?.abort();
        controller = null;
      };

      (async () => {
        try {
          const response = await fetch(url, {
            headers: {
              'X-Api-Key': apiKey,
              Accept: 'text/event-stream',
              'Cache-Control': 'no-cache',
            },
            signal: controller?.signal,
          });

          if (!response.ok || !response.body) {
            throw new Error(`SSE connection failed: ${response.status}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            // `String.prototype.split` always returns a non-empty array, so
            // `lines.pop()` is guaranteed to be a string. The `?? ''` is a
            // defensive fallback that cannot be reached in practice.
            /* istanbul ignore next */
            buffer = lines.pop() ?? '';

            let dataLine = '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                dataLine += (dataLine ? '\n' : '') + line.slice(6);
              } else if (line === '') {
                if (!dataLine) continue;

                try {
                  const event = JSON.parse(dataLine) as ExecutionStreamEvent;
                  dataLine = '';
                  handlers.onUpdate(event);
                  if (event.status === 'COMPLETED' || event.status === 'FAILED') {
                    close();
                    return;
                  }
                } catch {
                  dataLine = '';
                }
              }
            }
          }
        } catch (err) {
          if (!closed && err instanceof Error && err.name !== 'AbortError') {
            handlers.onError?.(err);
          }
        }
      })();

      return { close };
    },
  };

  /** @see {@link WebhookNamespace} */
  readonly webhook: WebhookNamespace = {
    redeliver: async (executionId: string): Promise<void> => {
      try {
        await this.client.post(
          `/v1/sdk/components/executions/${executionId}/replay-callback`,
          {},
          { headers: { 'X-Api-Key': this.apiKey } },
        );
      } catch (error) {
        if (error instanceof AxiosError) throw CallerSDKError.fromAxiosError(error);
        throw error;
      }
    },
  };

  /**
   * Send `POST /v1/sdk/components` with the given payload.
   *
   * Only defined `options` fields are included in the request body so that
   * the server never receives `undefined`-valued keys.
   *
   * @internal
   */
  private async _submit(
    module: ComponentModule,
    input: unknown,
    config: unknown,
    options: ExecuteOptions,
  ): Promise<ExecuteComponentResponse> {
    const body: Record<string, unknown> = { module, input, config };

    if (options.attempts !== undefined) body['attempts'] = options.attempts;
    if (options.waitForMs !== undefined) body['waitForMs'] = options.waitForMs;
    if (options.callbackUrl !== undefined) body['callbackUrl'] = options.callbackUrl;
    if (options.callbackSecret !== undefined) body['callbackSecret'] = options.callbackSecret;
    if (options.callbackHeaders !== undefined) body['callbackHeaders'] = options.callbackHeaders;

    try {
      const response = await this.client.post('/v1/sdk/components', body, {
        headers: { 'X-Api-Key': this.apiKey },
      });
      return response.data as ExecuteComponentResponse;
    } catch (error) {
      if (error instanceof AxiosError) {
        throw CallerSDKError.fromAxiosError(error);
      }
      throw error;
    }
  }
}

/**
 * White Rabbit WorkspaceClient.
 *
 * Provides a fully-typed client for invoking White Rabbit components and
 * choosing between two result-delivery models:
 *
 * | Model | Method | Best for |
 * |-------|--------|----------|
 * | SSE promise | `.call(…).promise()` | Request/response flows, `await` semantics |
 * | Fire & forget | `.call(…).execute()` | Webhook callbacks, batch submission |
 *
 * ### Installation
 * ```bash
 * npm install caller-sdk
 * ```
 *
 * ### Quick start
 * ```ts
 * import { WorkspaceClient, ComponentModule } from 'caller-sdk';
 *
 * const workspace = new WorkspaceClient({ apiKey: 'wrk_…' });
 *
 * // SSE-backed promise — no polling, no webhooks needed
 * const result = await workspace
 *   .call(ComponentModule.GET_EVM_DERIVATION_PATH, { addressIndex: 0 })
 *   .promise();
 *
 * console.log(result.derivationPath); // [44, 60, 0, 0, 0]
 * ```
 *
 * ### Authentication
 * Pass your **Workspace API key** (prefixed `wrk_`) as `apiKey`. You can
 * create one in the [White Rabbit Dashboard](https://app.whiterabbit.app)
 * under **Settings → API Keys**.
 */
export type WorkspaceClient = CallableComponents & WorkspaceClientManagement;

export const WorkspaceClient = WorkspaceClientImpl as unknown as {
  new (options: import('@/types').ClientOptions): CallableComponents & WorkspaceClientManagement;
};
