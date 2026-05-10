import { AxiosError, AxiosHeaders } from 'axios';
import { z, ZodError } from 'zod';
import { CallerSDKError } from '@/errors';

function createAxiosError(options: {
  status?: number;
  statusText?: string;
  method?: string;
  url?: string;
  code?: string;
  message?: string;
  responseData?: unknown;
  requestData?: string;
}): AxiosError {
  const {
    status,
    statusText,
    method = 'post',
    url = '/v1/sdk/components',
    code,
    message = 'Request failed',
    responseData,
    requestData,
  } = options;

  const error = new AxiosError(
    message,
    code,
    {
      method,
      url,
      data: requestData,
      headers: new AxiosHeaders(),
    },
    {},
    status
      ? {
          status,
          statusText: statusText ?? '',
          data: responseData,
          headers: { 'content-type': 'application/json' },
          config: { headers: new AxiosHeaders() },
        }
      : undefined,
  );

  return error;
}

describe('CallerSDKError', () => {
  describe('constructor', () => {
    it('should create error with message only', () => {
      const error = new CallerSDKError('something went wrong');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CallerSDKError);
      expect(error.name).toBe('CallerSDKError');
      expect(error.message).toBe('something went wrong');
      expect(error.errors).toEqual([]);
      expect(error.status).toBeUndefined();
    });

    it('should create error with all options', () => {
      const error = new CallerSDKError('failed', {
        status: 400,
        statusText: 'Bad Request',
        method: 'POST',
        url: '/v1/sdk/components',
        requestBody: { module: 'RANDOM_HEX' },
        responseBody: { message: 'invalid input' },
        headers: { 'content-type': 'application/json' },
        errors: [{ code: 'VALIDATION', message: 'invalid input' }],
      });

      expect(error.status).toBe(400);
      expect(error.statusText).toBe('Bad Request');
      expect(error.method).toBe('POST');
      expect(error.url).toBe('/v1/sdk/components');
      expect(error.requestBody).toEqual({ module: 'RANDOM_HEX' });
      expect(error.responseBody).toEqual({ message: 'invalid input' });
      expect(error.headers).toEqual({ 'content-type': 'application/json' });
      expect(error.errors).toEqual([{ code: 'VALIDATION', message: 'invalid input' }]);
    });

    it('should have a proper stack trace', () => {
      const error = new CallerSDKError('test');
      expect(error.stack).toBeDefined();
      expect(error.stack).not.toContain('CallerSDKError.fromAxiosError');
    });

    it('should default all optional fields to undefined', () => {
      const error = new CallerSDKError('fail');

      expect(error.status).toBeUndefined();
      expect(error.statusText).toBeUndefined();
      expect(error.url).toBeUndefined();
      expect(error.method).toBeUndefined();
      expect(error.requestBody).toBeUndefined();
      expect(error.responseBody).toBeUndefined();
      expect(error.headers).toBeUndefined();
      expect(error.errors).toEqual([]);
    });

    it('should default errors to empty array when passed undefined', () => {
      const error = new CallerSDKError('fail', { errors: undefined });
      expect(error.errors).toEqual([]);
    });

    it('should be catchable as a standard Error', () => {
      let caught: Error | undefined;
      try {
        throw new CallerSDKError('test error');
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBeInstanceOf(CallerSDKError);
      expect(caught?.message).toBe('test error');
    });

    it('should still construct when Error.captureStackTrace is unavailable', () => {
      const original = Error.captureStackTrace;
      try {
        // Simulate a non-V8 environment (e.g. Firefox/Safari) where
        // Error.captureStackTrace does not exist. Exercises the false branch
        // of the runtime guard in the constructor.
        delete (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace;

        const error = new CallerSDKError('no captureStackTrace');
        expect(error).toBeInstanceOf(CallerSDKError);
        expect(error.message).toBe('no captureStackTrace');
        expect(error.stack).toBeDefined();
      } finally {
        (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace = original;
      }
    });
  });

  describe('fromAxiosError', () => {
    describe('HTTP errors', () => {
      it('should handle 400 Bad Request', () => {
        const axiosError = createAxiosError({
          status: 400,
          statusText: 'Bad Request',
          responseData: { message: 'Invalid parameters' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.message).toBe('POST /v1/sdk/components failed with status 400');
        expect(error.status).toBe(400);
        expect(error.statusText).toBe('Bad Request');
        expect(error.errors).toEqual([{ code: 'UNKNOWN', message: 'Invalid parameters' }]);
      });

      it('should handle 401 Unauthorized', () => {
        const axiosError = createAxiosError({
          status: 401,
          statusText: 'Unauthorized',
          responseData: { error: 'UNAUTHORIZED', message: 'Invalid API key' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(401);
        expect(error.errors).toEqual([{ code: 'UNAUTHORIZED', message: 'Invalid API key' }]);
      });

      it('should handle 403 Forbidden', () => {
        const axiosError = createAxiosError({
          status: 403,
          statusText: 'Forbidden',
          responseData: { error: 'FORBIDDEN', message: 'Insufficient permissions' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(403);
        expect(error.errors).toEqual([{ code: 'FORBIDDEN', message: 'Insufficient permissions' }]);
      });

      it('should handle 404 Not Found', () => {
        const axiosError = createAxiosError({
          status: 404,
          statusText: 'Not Found',
          responseData: { error: 'NOT_FOUND', message: 'Resource not found' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(404);
        expect(error.errors).toEqual([{ code: 'NOT_FOUND', message: 'Resource not found' }]);
      });

      it('should handle 422 Unprocessable Entity with multiple errors', () => {
        const axiosError = createAxiosError({
          status: 422,
          statusText: 'Unprocessable Entity',
          responseData: {
            errors: [
              { code: 'INVALID_INPUT', message: 'field "keyId" is required' },
              { code: 'INVALID_INPUT', message: 'field "curve" must be SECP256k1 or ED25519' },
            ],
          },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(422);
        expect(error.errors).toHaveLength(2);
        expect(error.errors[0]).toEqual({ code: 'INVALID_INPUT', message: 'field "keyId" is required' });
        expect(error.errors[1]).toEqual({ code: 'INVALID_INPUT', message: 'field "curve" must be SECP256k1 or ED25519' });
      });

      it('should handle 429 Too Many Requests', () => {
        const axiosError = createAxiosError({
          status: 429,
          statusText: 'Too Many Requests',
          responseData: { error: 'RATE_LIMITED', message: 'Rate limit exceeded' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(429);
        expect(error.errors).toEqual([{ code: 'RATE_LIMITED', message: 'Rate limit exceeded' }]);
      });

      it('should handle 500 Internal Server Error', () => {
        const axiosError = createAxiosError({
          status: 500,
          statusText: 'Internal Server Error',
          responseData: { error: 'INTERNAL_ERROR', message: 'Unexpected error' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(500);
        expect(error.errors).toEqual([{ code: 'INTERNAL_ERROR', message: 'Unexpected error' }]);
      });

      it('should handle 502 Bad Gateway', () => {
        const axiosError = createAxiosError({
          status: 502,
          statusText: 'Bad Gateway',
          responseData: undefined,
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(502);
        expect(error.errors).toEqual([]);
      });

      it('should handle 503 Service Unavailable', () => {
        const axiosError = createAxiosError({
          status: 503,
          statusText: 'Service Unavailable',
          responseData: { message: 'Service is under maintenance' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.status).toBe(503);
        expect(error.errors).toEqual([{ code: 'UNKNOWN', message: 'Service is under maintenance' }]);
      });
    });

    describe('network errors', () => {
      it('should handle connection refused', () => {
        const axiosError = createAxiosError({
          code: 'ECONNREFUSED',
          message: 'connect ECONNREFUSED 127.0.0.1:3000',
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.message).toBe('POST /v1/sdk/components connection refused');
        expect(error.status).toBeUndefined();
        expect(error.errors).toEqual([]);
      });

      it('should handle timeout (ETIMEDOUT)', () => {
        const axiosError = createAxiosError({
          code: 'ETIMEDOUT',
          message: 'connect ETIMEDOUT',
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.message).toBe('POST /v1/sdk/components request timed out');
        expect(error.status).toBeUndefined();
      });

      it('should handle timeout (ECONNABORTED)', () => {
        const axiosError = createAxiosError({
          code: 'ECONNABORTED',
          message: 'timeout of 5000ms exceeded',
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.message).toBe('POST /v1/sdk/components request timed out');
        expect(error.status).toBeUndefined();
      });

      it('should handle unknown network error', () => {
        const axiosError = createAxiosError({
          code: 'ERR_NETWORK',
          message: 'Network Error',
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.message).toBe('POST /v1/sdk/components failed: Network Error');
        expect(error.status).toBeUndefined();
      });

      it('should handle AxiosError with no config', () => {
        const axiosError = new AxiosError('Network Error', 'ERR_NETWORK');

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.message).toBe('undefined undefined failed: Network Error');
        expect(error.method).toBeUndefined();
        expect(error.url).toBeUndefined();
        expect(error.requestBody).toBeUndefined();
        expect(error.status).toBeUndefined();
      });

      it('should handle AxiosError with no response and no code', () => {
        const axiosError = createAxiosError({
          message: 'Something broke',
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.message).toBe('POST /v1/sdk/components failed: Something broke');
        expect(error.status).toBeUndefined();
        expect(error.responseBody).toBeUndefined();
        expect(error.headers).toBeUndefined();
      });
    });

    describe('HTTP methods', () => {
      it.each(['get', 'put', 'delete', 'patch'] as const)(
        'should handle %s method',
        (method) => {
          const axiosError = createAxiosError({
            status: 400,
            method,
            responseData: {},
          });

          const error = CallerSDKError.fromAxiosError(axiosError);

          expect(error.method).toBe(method.toUpperCase());
          expect(error.message).toBe(`${method.toUpperCase()} /v1/sdk/components failed with status 400`);
        },
      );
    });

    describe('response body parsing', () => {
      it('should extract errors from errors array with string entries', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: {
            errors: ['field is required', 'value out of range'],
          },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([
          { code: 'UNKNOWN', message: 'field is required' },
          { code: 'UNKNOWN', message: 'value out of range' },
        ]);
      });

      it('should extract error from { code, message } response', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: { code: 'BAD_REQUEST', message: 'Missing module' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([{ code: 'BAD_REQUEST', message: 'Missing module' }]);
      });

      it('should handle empty response body', () => {
        const axiosError = createAxiosError({
          status: 500,
          responseData: undefined,
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([]);
        expect(error.responseBody).toBeUndefined();
      });

      it('should handle response with no recognizable error format', () => {
        const axiosError = createAxiosError({
          status: 500,
          responseData: { foo: 'bar' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([]);
        expect(error.responseBody).toEqual({ foo: 'bar' });
      });

      it('should handle empty errors array', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: { errors: [] },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([]);
      });

      it('should handle errors array with missing code', () => {
        const axiosError = createAxiosError({
          status: 422,
          responseData: {
            errors: [{ message: 'field is required' }],
          },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([{ code: 'UNKNOWN', message: 'field is required' }]);
      });

      it('should handle errors array with missing message', () => {
        const axiosError = createAxiosError({
          status: 422,
          responseData: {
            errors: [{ code: 'VALIDATION_ERROR' }],
          },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([{ code: 'VALIDATION_ERROR', message: '' }]);
      });

      it('should handle errors array with null entries', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: {
            errors: [null, { code: 'ERR', message: 'valid' }],
          },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([
          { code: 'UNKNOWN', message: 'null' },
          { code: 'ERR', message: 'valid' },
        ]);
      });

      it('should handle errors array with mixed object and string entries', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: {
            errors: [
              { code: 'FIELD_ERROR', message: 'name is required' },
              'unexpected value',
              { code: 'TYPE_ERROR', message: 'must be number' },
            ],
          },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toHaveLength(3);
        expect(error.errors[0]).toEqual({ code: 'FIELD_ERROR', message: 'name is required' });
        expect(error.errors[1]).toEqual({ code: 'UNKNOWN', message: 'unexpected value' });
        expect(error.errors[2]).toEqual({ code: 'TYPE_ERROR', message: 'must be number' });
      });

      it('should handle response with only error field (no message)', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: { error: 'BAD_REQUEST' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([{ code: 'BAD_REQUEST', message: 'BAD_REQUEST' }]);
      });

      it('should handle response with only message field (no error or code)', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: { message: 'Something went wrong' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([{ code: 'UNKNOWN', message: 'Something went wrong' }]);
      });

      it('should handle response with code and message (no error field)', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: { code: 'INVALID', message: 'bad value' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.errors).toEqual([{ code: 'INVALID', message: 'bad value' }]);
      });

      it('should preserve full response body regardless of error extraction', () => {
        const responseData = {
          error: 'CONFLICT',
          message: 'Already exists',
          requestId: 'abc-123',
          timestamp: '2026-01-01T00:00:00Z',
        };
        const axiosError = createAxiosError({
          status: 409,
          responseData,
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.responseBody).toEqual(responseData);
        expect(error.errors).toEqual([{ code: 'CONFLICT', message: 'Already exists' }]);
      });
    });

    describe('request body parsing', () => {
      it('should parse JSON request body', () => {
        const axiosError = createAxiosError({
          status: 400,
          requestData: JSON.stringify({ module: 'RANDOM_HEX', input: {} }),
          responseData: { message: 'bad request' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.requestBody).toEqual({ module: 'RANDOM_HEX', input: {} });
      });

      it('should fallback to raw string if request body is not valid JSON', () => {
        const axiosError = createAxiosError({
          status: 400,
          requestData: 'not-json',
          responseData: { message: 'bad request' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.requestBody).toBe('not-json');
      });

      it('should handle missing request body', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: { message: 'bad request' },
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.requestBody).toBeUndefined();
      });
    });

    describe('request metadata', () => {
      it('should capture method and url', () => {
        const axiosError = createAxiosError({
          status: 400,
          method: 'post',
          url: '/v1/sdk/components',
          responseData: {},
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.method).toBe('POST');
        expect(error.url).toBe('/v1/sdk/components');
      });

      it('should capture response headers', () => {
        const axiosError = createAxiosError({
          status: 400,
          responseData: {},
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.headers).toEqual({ 'content-type': 'application/json' });
      });

      it('should return a CallerSDKError instance', () => {
        const axiosError = createAxiosError({
          status: 500,
          responseData: {},
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error).toBeInstanceOf(CallerSDKError);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('CallerSDKError');
      });

      it('should handle different url paths', () => {
        const axiosError = createAxiosError({
          status: 404,
          url: '/v2/other/endpoint',
          responseData: {},
        });

        const error = CallerSDKError.fromAxiosError(axiosError);

        expect(error.url).toBe('/v2/other/endpoint');
        expect(error.message).toBe('POST /v2/other/endpoint failed with status 404');
      });
    });
  });

  describe('fromZodError', () => {
    function getZodError(schema: z.ZodType, data: unknown): ZodError {
      const result = schema.safeParse(data);
      if (result.success) throw new Error('Expected validation to fail');
      return result.error;
    }

    it('should create CallerSDKError from ZodError with context', () => {
      const schema = z.object({ addressIndex: z.number() });
      const zodError = getZodError(schema, { addressIndex: 'not-a-number' });

      const error = CallerSDKError.fromZodError(zodError, 'GET_EVM_DERIVATION_PATH input');

      expect(error).toBeInstanceOf(CallerSDKError);
      expect(error.message).toBe('Validation failed for GET_EVM_DERIVATION_PATH input');
      expect(error.errors).toHaveLength(1);
      expect(error.errors[0].message).toContain('addressIndex');
    });

    it('should handle multiple validation issues', () => {
      const schema = z.object({
        apiUrl: z.string(),
        method: z.enum(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']),
      });
      const zodError = getZodError(schema, { apiUrl: 123, method: 'INVALID' });

      const error = CallerSDKError.fromZodError(zodError, 'API_CALL config');

      expect(error.errors).toHaveLength(2);
      expect(error.errors.some((e) => e.message.includes('apiUrl'))).toBe(true);
      expect(error.errors.some((e) => e.message.includes('method'))).toBe(true);
    });

    it('should handle nested path in error', () => {
      const schema = z.object({
        items: z.array(z.object({ name: z.string() })),
      });
      const zodError = getZodError(schema, { items: [{ name: 123 }] });

      const error = CallerSDKError.fromZodError(zodError, 'TEST input');

      expect(error.errors).toHaveLength(1);
      expect(error.errors[0].message).toContain('items.0.name');
    });

    it('should handle missing required fields', () => {
      const schema = z.object({ keyId: z.string() });
      const zodError = getZodError(schema, {});

      const error = CallerSDKError.fromZodError(zodError);

      expect(error.message).toBe('Validation failed');
      expect(error.errors).toHaveLength(1);
      expect(error.errors[0].message).toContain('keyId');
    });

    it('should have no HTTP-related fields', () => {
      const schema = z.object({ keyId: z.string() });
      const zodError = getZodError(schema, {});

      const error = CallerSDKError.fromZodError(zodError);

      expect(error.status).toBeUndefined();
      expect(error.statusText).toBeUndefined();
      expect(error.url).toBeUndefined();
      expect(error.method).toBeUndefined();
      expect(error.requestBody).toBeUndefined();
      expect(error.responseBody).toBeUndefined();
      expect(error.headers).toBeUndefined();
    });
  });
});
