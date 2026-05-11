import { AxiosError } from 'axios';
import axios, { AxiosInstance } from 'axios';
import { CallerSDKError } from '@/errors';
import { BASE_API_URL } from '@/generated/env';
import type {
  WorkflowClientOptions,
} from '@/types';
import type {
  TriggerRunResponse,
  WorkflowRunDetail,
  RunStreamEvent,
  UpdateComponentRequest,
  ComponentNamespace,
  WorkflowExecutionNamespace,
} from './workflow-types';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED']);
const PING_PREFIX = ':ping';

/**
 * Subscription handle returned by {@link WorkflowClient.stream}.
 * Call `close()` to unsubscribe and release the SSE connection.
 */
export interface RunStreamSubscription {
  close(): void;
}

/**
 * Event handlers for {@link WorkflowClient.stream}.
 */
export interface RunStreamHandlers {
  /** Called for every status event emitted by the stream. */
  onUpdate(event: RunStreamEvent): void;
  /** Called when the stream closes due to a connection error. */
  onError?(err: Error): void;
}

/**
 * SDK client for workflow run operations.
 *
 * Requires a **Workspace API key** (`ws_...`) and the UUID of the workflow to
 * trigger. The key must have the target workflow in its `allowedWorkflowIds`
 * list (or be unrestricted — empty list). Get a key from
 * **Dashboard → Workspace Settings → API Keys**.
 *
 * @example
 * ```ts
 * import { WorkflowClient } from '@zafeguard/caller-sdk';
 *
 * const workflow = new WorkflowClient({
 *   apiKey: process.env.ZAFEGUARD_API_KEY!,
 *   workflowId: process.env.ZAFEGUARD_WORKFLOW_ID!,
 * });
 *
 * // Trigger and wait until done
 * const { runId } = await workflow.trigger();
 * const run = await workflow.waitForRun(runId);
 * console.log(run.status, run.totalUsage);
 * ```
 */
export class WorkflowClient {
  protected readonly apiKey: string;
  protected readonly workflowId: string;
  protected readonly client: AxiosInstance;

  constructor(options: WorkflowClientOptions) {
    const { apiKey, workflowId, baseUrl } = options as WorkflowClientOptions & { baseUrl?: string };
    this.apiKey = apiKey;
    this.workflowId = workflowId;
    this.client = axios.create({
      baseURL: baseUrl ?? BASE_API_URL,
    });
  }

  /**
   * Trigger a new workflow run.
   *
   * @returns A {@link TriggerRunResponse} containing the `runId` and BullMQ `jobId`.
   */
  async trigger(): Promise<TriggerRunResponse> {
    try {
      const response = await this.client.post(
        `/v1/sdk/workflows/${this.workflowId}`,
        {},
        { headers: { 'X-Api-Key': this.apiKey } },
      );
      return response.data as TriggerRunResponse;
    } catch (error) {
      if (error instanceof AxiosError) throw CallerSDKError.fromAxiosError(error);
      throw error;
    }
  }

  /** @see {@link WorkflowExecutionNamespace} */
  readonly execution: WorkflowExecutionNamespace = {
    get: async (runId: string): Promise<WorkflowRunDetail> => {
      try {
        const response = await this.client.get(`/v1/sdk/workflows/executions/${runId}`, {
          headers: { 'X-Api-Key': this.apiKey },
        });
        return response.data as WorkflowRunDetail;
      } catch (error) {
        if (error instanceof AxiosError) throw CallerSDKError.fromAxiosError(error);
        throw error;
      }
    },
  };

  /**
   * Subscribe to live status events for a run via SSE.
   *
   * The stream closes automatically when the run reaches a terminal state
   * (`COMPLETED`, `FAILED`, or `CANCELED`). Call the returned `close()` to
   * unsubscribe early.
   *
   * @param runId    - The run UUID returned by {@link trigger}.
   * @param handlers - Callbacks for status events and errors.
   *
   * @example
   * ```ts
   * const sub = workflow.stream(runId, {
   *   onUpdate(event) {
   *     console.log(event.status, event.output.pendingStageCount);
   *     // sub.close() is called automatically on COMPLETED/FAILED/CANCELED
   *   },
   * });
   * ```
   */
  stream(runId: string, handlers: RunStreamHandlers): RunStreamSubscription {
    const baseUrl = (this.client.defaults.baseURL ?? '').replace(/\/$/, '');
    const url = `${baseUrl}/v1/sdk/workflows/executions/${runId}/stream`;
    const apiKey = this.apiKey;

    let controller: AbortController | null = new AbortController();
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      controller?.abort();
      controller = null;
    };

    // Use fetch + ReadableStream for Node.js 18+ and browser compatibility.
    // This avoids a dependency on the `eventsource` package while still supporting
    // custom headers (which the native EventSource API does not allow).
    (async () => {
      try {
        const response = await fetch(url, {
          headers: { 'X-Api-Key': apiKey },
          signal: controller?.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data.startsWith(PING_PREFIX)) continue;

            try {
              const event: RunStreamEvent = JSON.parse(data);
              handlers.onUpdate(event);

              if (TERMINAL_STATUSES.has(event.status)) {
                close();
                return;
              }
            } catch {
              // Ignore malformed JSON events
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
  }

  /**
   * Wait for a run to reach a terminal state (`COMPLETED`, `FAILED`, or `CANCELED`).
   *
   * Opens an SSE stream and resolves with the final {@link WorkflowRunDetail}
   * once the terminal event arrives. Rejects if `timeoutMs` elapses before
   * the run finalizes.
   *
   * @param runId      - The run UUID returned by {@link trigger}.
   * @param timeoutMs  - Maximum wait time in ms. Defaults to `300_000` (5 min).
   *
   * @example
   * ```ts
   * const run = await workflow.waitForRun(runId, 60_000);
   * console.log(run.status, run.totalUsage);
   * ```
   */
  waitForRun(runId: string, timeoutMs = 300_000): Promise<WorkflowRunDetail> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const sub = this.stream(runId, {
        onUpdate: (event) => {
          if (!TERMINAL_STATUSES.has(event.status)) return;
          // Defensive guard: the timer is always set synchronously after
          // `this.stream(...)` returns, so by the time any event fires it is
          // never null. The else branch is unreachable in practice.
          /* istanbul ignore else */
          if (timer) clearTimeout(timer);
          // Fetch the final run detail to get stage breakdown
          this.execution.get(runId).then(resolve).catch(reject);
        },
        onError: (err) => {
          // Same defensive guard as above — `timer` is always set before
          // any onError can fire.
          /* istanbul ignore else */
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });

      timer = setTimeout(() => {
        sub.close();
        reject(new Error(`waitForRun timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /** @see {@link ComponentNamespace} */
  readonly component: ComponentNamespace = {
    update: async (componentId: string, update: UpdateComponentRequest): Promise<void> => {
      try {
        await this.client.post(
          `/v1/sdk/workflows/${this.workflowId}/components/${componentId}`,
          update,
          {
            headers: {
              'X-Api-Key': this.apiKey,
              'Content-Type': 'application/json',
            },
          },
        );
      } catch (error) {
        if (error instanceof AxiosError) throw CallerSDKError.fromAxiosError(error);
        throw error;
      }
    },
  };
}
