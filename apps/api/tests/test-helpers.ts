import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { seedDatabase } from '../prisma/seed';

export async function resetAndSeed() {
  return seedDatabase();
}

export async function loginCookieFor(email: string): Promise<string> {
  const res = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.55' },
      body: JSON.stringify({ email, password: 'Demo1234!' }),
    })
  );
  if (!res.ok) {
    throw new Error(`Login failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(`No set-cookie returned for ${email}`);
  }
  return setCookie.split(';')[0];
}

export async function apiFetch(
  path: string,
  options: {
    method?: string;
    cookie?: string;
    body?: unknown;
    ip?: string;
  } = {}
) {
  const headers: Record<string, string> = {
    'x-forwarded-for': options.ip ?? '203.0.113.10',
  };
  if (options.cookie) headers['cookie'] = options.cookie;
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    })
  );
}

export { prisma };
