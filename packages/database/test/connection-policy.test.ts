import { describe, expect, it } from 'vitest';
import { databaseConnectionConfig, DatabasePolicyError } from '../src/connection-policy.js';

describe('database transport policy', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'permits explicit loopback plaintext: %s',
    (host) => {
      expect(databaseConnectionConfig(`postgresql://runtime:secret@${host}/app`).ssl).toBe(false);
    },
  );

  it('requires certificate and hostname verification for remote connections', () => {
    const config = databaseConnectionConfig(
      'postgresql://runtime:secret@db.example/app?sslmode=verify-full',
      'test-ca',
    );
    expect(config).toMatchObject({
      host: 'db.example',
      ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: 'test-ca' },
    });
    expect(config).not.toHaveProperty('connectionString');
    expect(config.options).toBe('-c search_path=public');
  });

  it.each([
    'postgresql://runtime:private-secret@db.example/app',
    'postgresql://runtime:private-secret@10.0.0.1/app?sslmode=disable',
    ...['require', 'prefer', 'allow', 'verify-ca', 'no-verify'].map(
      (mode) => `postgresql://runtime:private-secret@localhost/app?sslmode=${mode}`,
    ),
    ...[
      'host=remote',
      'options=-crole=admin',
      'user=admin',
      'sslrootcert=path',
      'uselibpqcompat=true',
      'sslmode=verify-full&sslmode=disable',
    ].map((query) => `postgresql://runtime:private-secret@localhost/app?${query}`),
    'postgresql://runtime@localhost/app',
    'postgresql://runtime:private-secret@localhost/app#fragment',
  ])('rejects unsafe configuration without echoing it: %#', (url) => {
    expect(() => databaseConnectionConfig(url)).toThrow(DatabasePolicyError);
    expect(() => databaseConnectionConfig(url)).toThrow(
      'The database connection policy is invalid.',
    );
  });

  it('does not silently ignore a CA configured for a plaintext connection', () => {
    expect(() =>
      databaseConnectionConfig('postgresql://runtime:secret@localhost/app', 'ca'),
    ).toThrow(DatabasePolicyError);
  });

  it('does not accept ambient PG endpoint, TLS, or role options', () => {
    // All fields through which pg can inherit PG* connection settings are explicit.
    expect(databaseConnectionConfig('postgresql://runtime:secret@localhost/app')).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      user: 'runtime',
      password: 'secret',
      database: 'app',
      ssl: false,
      options: '-c search_path=public',
      application_name: 'beloveddev',
    });
  });
});
