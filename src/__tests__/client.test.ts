import axios from 'axios';
import { Client } from '@/bootstrap/client';
import { BASE_API_URL } from '@/generated/env';
import type { ClientOptions } from '@/types';

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

// Concrete subclass used to access protected fields for assertion.
class TestClient extends Client {
  getApiKey(): string {
    return this.apiKey;
  }
  getRawClient(): unknown {
    return this.client;
  }
}

describe('Client', () => {
  beforeEach(() => {
    mockedCreate.mockReset();
    mockedCreate.mockReturnValue({ defaults: { baseURL: '' } });
  });

  it('uses baseUrl from options when provided', () => {
    new TestClient({ apiKey: 'k', baseUrl: 'https://api.example.com' } as unknown as ClientOptions);
    expect(mockedCreate).toHaveBeenCalledWith({ baseURL: 'https://api.example.com' });
  });

  it('falls back to BASE_API_URL when baseUrl is omitted', () => {
    new TestClient({ apiKey: 'k' } as unknown as ClientOptions);
    expect(mockedCreate).toHaveBeenCalledWith({ baseURL: BASE_API_URL });
  });

  it('stores the apiKey passed in options', () => {
    const c = new TestClient({ apiKey: 'my-secret' } as unknown as ClientOptions);
    expect(c.getApiKey()).toBe('my-secret');
  });

  it('exposes the axios instance returned by axios.create', () => {
    const fakeAxios = { defaults: { baseURL: 'x' } };
    mockedCreate.mockReturnValueOnce(fakeAxios);
    const c = new TestClient({ apiKey: 'k' } as unknown as ClientOptions);
    expect(c.getRawClient()).toBe(fakeAxios);
  });
});
