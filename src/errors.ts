import { AxiosError } from 'axios';
import { ZodError } from 'zod';

export interface ErrorDetail {
  code: string;
  message: string;
}

export class CallerSDKError extends Error {
  readonly status?: number;
  readonly statusText?: string;
  readonly url?: string;
  readonly method?: string;
  readonly requestBody?: unknown;
  readonly responseBody?: unknown;
  readonly headers?: Record<string, string>;
  readonly errors: ErrorDetail[];

  constructor(message: string, options: {
    status?: number;
    statusText?: string;
    url?: string;
    method?: string;
    requestBody?: unknown;
    responseBody?: unknown;
    headers?: Record<string, string>;
    errors?: ErrorDetail[];
  } = {}) {
    super(message);
    this.name = 'CallerSDKError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.method = options.method;
    this.url = options.url;
    this.requestBody = options.requestBody;
    this.responseBody = options.responseBody;
    this.headers = options.headers;
    this.errors = options.errors ?? [];

    // captureStackTrace is V8-only; guard for non-V8 runtimes. (TS 6 lib
    // dropped this from ErrorConstructor's typing.)
    const captureStackTrace = (Error as {
      captureStackTrace?: (target: object, ctor: Function) => void;
    }).captureStackTrace;
    if (captureStackTrace) {
      captureStackTrace(this, CallerSDKError);
    }
  }

  static fromZodError(error: ZodError, context?: string): CallerSDKError {
    const errors: ErrorDetail[] = error.issues.map((issue) => ({
      code: issue.code,
      message: `${issue.path.join('.')}: ${issue.message}`,
    }));

    const summary = context
      ? `Validation failed for ${context}`
      : 'Validation failed';

    return new CallerSDKError(summary, { errors });
  }

  static fromAxiosError(error: AxiosError): CallerSDKError {
    const status = error.response?.status;
    const method = error.config?.method?.toUpperCase();
    const url = error.config?.url;
    const responseData = error.response?.data as Record<string, unknown> | undefined;

    const message = buildSummary(error);
    const errors = extractErrors(responseData);

    let requestBody: unknown;
    try {
      requestBody = error.config?.data ? JSON.parse(error.config.data) : undefined;
    } catch {
      requestBody = error.config?.data;
    }

    return new CallerSDKError(message, {
      status,
      statusText: error.response?.statusText,
      method,
      url,
      requestBody,
      responseBody: responseData,
      headers: error.response?.headers as Record<string, string> | undefined,
      errors,
    });
  }
}

function buildSummary(error: AxiosError): string {
  const method = error.config?.method?.toUpperCase();
  const url = error.config?.url;
  const status = error.response?.status;

  if (status) {
    return `${method} ${url} failed with status ${status}`;
  }
  if (error.code === 'ECONNREFUSED') {
    return `${method} ${url} connection refused`;
  }
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    return `${method} ${url} request timed out`;
  }
  return `${method} ${url} failed: ${error.message}`;
}

function extractErrors(data: Record<string, unknown> | undefined): ErrorDetail[] {
  if (!data) return [];

  // Handle { errors: [{ code, message }, ...] }
  if (Array.isArray(data.errors)) {
    return data.errors.map((e: unknown) => {
      if (typeof e === 'object' && e !== null) {
        const obj = e as Record<string, unknown>;
        return {
          code: String(obj.code ?? 'UNKNOWN'),
          message: String(obj.message ?? ''),
        };
      }
      return { code: 'UNKNOWN', message: String(e) };
    });
  }

  // Handle { error: string, message: string }
  if (data.message || data.error) {
    // The `?? ''` fallback inside `message` is unreachable: the outer guard
    // requires either `data.message` or `data.error` to be truthy, so at least
    // one will satisfy the nullish-coalescing chain.
    return [{
      code: String(data.code ?? data.error ?? 'UNKNOWN'),
      message: String(
        data.message ??
          data.error ??
          /* istanbul ignore next */ '',
      ),
    }];
  }

  return [];
}
