import axios, { AxiosError, AxiosHeaders } from 'axios';
import { WorkflowClient } from '@/workflow/workflow-client';
import { CallerSDKError } from '@/errors';
import type {
  RunStreamEvent,
  TriggerRunResponse,
  WorkflowRunDetail,
} from '@/workflow/workflow-types';

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

function mockRunDetail(
  overrides: Partial<WorkflowRunDetail> = {},
): WorkflowRunDetail {
  return {
    id: 'run-1',
    status: 'COMPLETED',
    pendingStageCount: 0,
    failedStageCount: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    totalUsage: 12,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:01.000Z',
    runStages: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('WorkflowClient', () => {
  let mockGet: jest.Mock;
  let mockPost: jest.Mock;
  let mockFetch: jest.SpyInstance;
  let workflow: WorkflowClient;

  beforeEach(() => {
    mockGet = jest.fn();
    mockPost = jest.fn();
    mockedCreate.mockReturnValue({
      get: mockGet,
      post: mockPost,
      defaults: { baseURL: 'https://api.example.com/' },
    } as any);

    workflow = new WorkflowClient({
      apiKey: 'wf-key',
      workflowId: 'wf-uuid',
      baseUrl: 'https://api.example.com/',
    } as any);

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
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates an axios instance with the provided baseUrl', () => {
      expect(mockedCreate).toHaveBeenCalledWith({ baseURL: 'https://api.example.com/' });
    });

    it('falls back to BASE_API_URL when baseUrl is omitted', () => {
      mockedCreate.mockClear();
      new WorkflowClient({ apiKey: 'k', workflowId: 'w' } as any);
      const arg = mockedCreate.mock.calls[0][0];
      expect(arg).toEqual(expect.objectContaining({ baseURL: expect.any(String) }));
      expect(arg.baseURL).not.toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // .trigger()
  // -------------------------------------------------------------------------

  describe('trigger()', () => {
    it('POSTs to /v1/sdk/workflows/:id with the API key header', async () => {
      const trigger: TriggerRunResponse = { runId: 'run-1', jobId: 'job-1' };
      mockPost.mockResolvedValue({ data: trigger });

      const out = await workflow.trigger();

      expect(out).toEqual(trigger);
      expect(mockPost).toHaveBeenCalledWith(
        '/v1/sdk/workflows/wf-uuid',
        {},
        { headers: { 'X-Api-Key': 'wf-key' } },
      );
    });

    it('wraps AxiosError as CallerSDKError', async () => {
      const axiosError = new AxiosError(
        'fail',
        'ERR_BAD_REQUEST',
        { method: 'post', url: '/v1/sdk/workflows/wf-uuid', headers: new AxiosHeaders() },
        {},
        {
          status: 403,
          statusText: 'Forbidden',
          data: { error: 'FORBIDDEN', message: 'no access' },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockPost.mockRejectedValue(axiosError);

      await expect(workflow.trigger()).rejects.toThrow(CallerSDKError);
      await expect(workflow.trigger()).rejects.toMatchObject({ status: 403 });
    });

    it('rethrows non-Axios errors as-is', async () => {
      const err = new TypeError('bad');
      mockPost.mockRejectedValue(err);
      await expect(workflow.trigger()).rejects.toBe(err);
    });
  });

  // -------------------------------------------------------------------------
  // execution.get()
  // -------------------------------------------------------------------------

  describe('execution.get()', () => {
    it('GETs /v1/sdk/workflows/executions/:runId', async () => {
      const detail = mockRunDetail();
      mockGet.mockResolvedValue({ data: detail });

      const out = await workflow.execution.get('run-1');
      expect(out).toEqual(detail);
      expect(mockGet).toHaveBeenCalledWith(
        '/v1/sdk/workflows/executions/run-1',
        { headers: { 'X-Api-Key': 'wf-key' } },
      );
    });

    it('wraps AxiosError as CallerSDKError', async () => {
      const axiosError = new AxiosError(
        'fail',
        undefined,
        { method: 'get', url: '/v1/sdk/workflows/executions/run-1', headers: new AxiosHeaders() },
        {},
        {
          status: 404,
          statusText: 'Not Found',
          data: { error: 'NOT_FOUND', message: 'no run' },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockGet.mockRejectedValue(axiosError);

      await expect(workflow.execution.get('run-1')).rejects.toThrow(CallerSDKError);
    });

    it('rethrows non-Axios errors as-is', async () => {
      const err = new RangeError('oops');
      mockGet.mockRejectedValue(err);
      await expect(workflow.execution.get('run-1')).rejects.toBe(err);
    });
  });

  // -------------------------------------------------------------------------
  // component.update()
  // -------------------------------------------------------------------------

  describe('component.update()', () => {
    it('POSTs the update payload with required headers', async () => {
      mockPost.mockResolvedValue({ data: undefined });

      await workflow.component.update('component-1', {
        name: 'New name',
        config: { url: 'https://x' },
      });

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/sdk/workflows/wf-uuid/components/component-1',
        { name: 'New name', config: { url: 'https://x' } },
        {
          headers: {
            'X-Api-Key': 'wf-key',
            'Content-Type': 'application/json',
          },
        },
      );
    });

    it('wraps AxiosError as CallerSDKError', async () => {
      const axiosError = new AxiosError(
        'fail',
        undefined,
        { method: 'post', url: '/x', headers: new AxiosHeaders() },
        {},
        {
          status: 422,
          statusText: 'Unprocessable',
          data: { errors: [{ code: 'BAD', message: 'bad' }] },
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockPost.mockRejectedValue(axiosError);

      await expect(
        workflow.component.update('cmp', { name: 'x' }),
      ).rejects.toThrow(CallerSDKError);
    });

    it('rethrows non-Axios errors as-is', async () => {
      const err = new SyntaxError('boom');
      mockPost.mockRejectedValue(err);
      await expect(
        workflow.component.update('cmp', {}),
      ).rejects.toBe(err);
    });
  });

  // -------------------------------------------------------------------------
  // .stream()
  // -------------------------------------------------------------------------

  describe('stream()', () => {
    it('opens an SSE connection at the run stream URL with the API key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'run-1', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await new Promise<void>((resolve) => {
        const sub = workflow.stream('run-1', {
          onUpdate: (e: RunStreamEvent) => {
            if (e.status === 'COMPLETED') {
              sub.close();
              resolve();
            }
          },
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/sdk/workflows/executions/run-1/stream',
        expect.objectContaining({
          headers: { 'X-Api-Key': 'wf-key' },
        }),
      );
    });

    it('skips :ping heartbeats and malformed JSON, then forwards valid events', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: :ping\n` +
            `data: not-json\n` +
            `data: ${JSON.stringify({ id: 'run-1', status: 'EXECUTING', output: {}, timestamp: 't' })}\n` +
            `data: ${JSON.stringify({ id: 'run-1', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      const events: RunStreamEvent[] = [];
      await new Promise<void>((resolve) => {
        workflow.stream('run-1', {
          onUpdate: (e: RunStreamEvent) => {
            events.push(e);
            if (e.status === 'COMPLETED') resolve();
          },
        });
      });

      expect(events.map((e) => e.status)).toEqual(['EXECUTING', 'COMPLETED']);
    });

    it('terminates on FAILED status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'run-1', status: 'FAILED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      const seen: string[] = [];
      await new Promise<void>((resolve) => {
        workflow.stream('run-1', {
          onUpdate: (e: RunStreamEvent) => {
            seen.push(e.status);
            resolve();
          },
        });
      });
      expect(seen).toEqual(['FAILED']);
    });

    it('terminates on CANCELED status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'run-1', status: 'CANCELED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await new Promise<void>((resolve) => {
        workflow.stream('run-1', {
          onUpdate: (e: RunStreamEvent) => {
            if (e.status === 'CANCELED') resolve();
          },
        });
      });
    });

    it('calls onError when the SSE response is not OK', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        body: null,
      } as any);

      const err: Error = await new Promise((resolve) => {
        workflow.stream('run-1', {
          onUpdate: () => {},
          onError: (e) => resolve(e),
        });
      });

      expect(err.message).toMatch(/SSE connection failed: 401/);
    });

    it('does not raise onError when the subscription is closed before failure', async () => {
      mockFetch.mockImplementation(streamThatErrorsOnAbort());
      const onError = jest.fn();
      const sub = workflow.stream('run-1', {
        onUpdate: () => {},
        onError,
      });
      sub.close();
      // Idempotent close — second call is a no-op.
      sub.close();
      // Allow microtasks to drain.
      await new Promise((r) => setTimeout(r, 20));
      expect(onError).not.toHaveBeenCalled();
    });

    it('swallows AbortError silently when closed', async () => {
      mockFetch.mockImplementation(streamThatErrorsOnAbort());
      const onError = jest.fn();
      const sub = workflow.stream('run-1', {
        onUpdate: () => {},
        onError,
      });
      // Wait so fetch resolves and the read loop is awaiting.
      await new Promise((r) => setTimeout(r, 5));
      sub.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(onError).not.toHaveBeenCalled();
    });

    it('strips trailing slash from baseURL when computing the stream URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'r', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await new Promise<void>((resolve) => {
        workflow.stream('run-9', {
          onUpdate: () => resolve(),
        });
      });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('https://api.example.com/v1/sdk/workflows/executions/run-9/stream');
    });

    it('handles missing baseURL by treating it as empty', async () => {
      mockedCreate.mockReturnValueOnce({
        get: mockGet,
        post: mockPost,
        defaults: {},
      } as any);
      const w = new WorkflowClient({ apiKey: 'k', workflowId: 'w' } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'r', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await new Promise<void>((resolve) => {
        w.stream('rid', { onUpdate: () => resolve() });
      });

      const calls = mockFetch.mock.calls;
      expect(calls[calls.length - 1][0]).toBe('/v1/sdk/workflows/executions/rid/stream');
    });
  });

  // -------------------------------------------------------------------------
  // .waitForRun()
  // -------------------------------------------------------------------------

  describe('waitForRun()', () => {
    it('resolves with the run detail when the stream emits COMPLETED', async () => {
      const detail = mockRunDetail({ id: 'run-7', status: 'COMPLETED' });
      mockGet.mockResolvedValueOnce({ data: detail });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'run-7', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await expect(workflow.waitForRun('run-7', 5_000)).resolves.toEqual(detail);
    });

    it('skips non-terminal events and only fetches detail on terminal status', async () => {
      const detail = mockRunDetail();
      mockGet.mockResolvedValueOnce({ data: detail });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'r', status: 'EXECUTING', output: {}, timestamp: 't' })}\n` +
            `data: ${JSON.stringify({ id: 'r', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await expect(workflow.waitForRun('r', 5_000)).resolves.toEqual(detail);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('rejects when execution.get fails after a terminal event', async () => {
      const axiosError = new AxiosError(
        'fail',
        undefined,
        { method: 'get', url: '/x', headers: new AxiosHeaders() },
        {},
        {
          status: 500,
          statusText: 'Server Error',
          data: undefined,
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
      );
      mockGet.mockRejectedValueOnce(axiosError);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'r', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await expect(workflow.waitForRun('r', 5_000)).rejects.toThrow(CallerSDKError);
    });

    it('rejects when the stream emits a connection error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        body: null,
      } as any);

      await expect(workflow.waitForRun('r', 5_000)).rejects.toThrow(/SSE connection failed/);
    });

    it('rejects with timeout when no terminal event arrives', async () => {
      mockFetch.mockImplementation(streamThatErrorsOnAbort());
      await expect(workflow.waitForRun('r', 30)).rejects.toThrow(/timed out after 30ms/);
    });

    it('uses default timeout when none is provided', async () => {
      const detail = mockRunDetail();
      mockGet.mockResolvedValueOnce({ data: detail });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          `data: ${JSON.stringify({ id: 'r', status: 'COMPLETED', output: {}, timestamp: 't' })}\n`,
        ),
      } as any);

      await expect(workflow.waitForRun('r')).resolves.toEqual(detail);
    });
  });
});
