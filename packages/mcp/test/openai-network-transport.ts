import https from 'node:https';
import { rootCertificates, checkServerIdentity } from 'node:tls';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { z } from 'zod';
import { AgentFailure } from './agent-evaluation.js';
import type { OpenAiHttpTransport } from './openai-provider.js';
import { providerRequestSchema, responsesEndpoint } from './provider-wire-contract.js';
import {
  approvedBudget,
  assertLiveGrant,
  consumeLiveRequest,
  type LiveGrant,
} from './provider-live-approval.js';

const transports = new WeakMap<object, { grant: LiveGrant; invocationId: string }>();
export function assertNetworkTransport(
  transport: object,
  grant: LiveGrant,
  invocationId: string,
): void {
  const state = transports.get(transport);
  if (
    !state ||
    state.grant !== grant ||
    state.invocationId !== invocationId ||
    Object.getPrototypeOf(transport) !== OpenAiNetworkTransport.prototype
  )
    throw new AgentFailure('approval_mismatch');
}
type HttpInput = Parameters<OpenAiHttpTransport['request']>[0];
const headersSchema = z.strictObject({
  'content-type': z.literal('application/json'),
  accept: z.literal('application/json'),
  authorization: z.string().regex(/^Bearer [^\r\n]{1,4096}$/),
});
/** No configurable endpoint, TLS trust, connector, proxy, retries or environment credentials. */
export class OpenAiNetworkTransport implements OpenAiHttpTransport {
  readonly mode = 'network' as const;
  private readonly agent: https.Agent;
  private readonly budget: ReturnType<typeof approvedBudget>;
  private readonly active = new Map<
    ClientRequest,
    { response?: IncomingMessage; fail: () => void }
  >();
  private failed = false;
  private cleanupFailed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly grant: LiveGrant,
    private readonly invocationId: string,
  ) {
    this.budget = approvedBudget(grant, invocationId);
    this.agent = new https.Agent({
      keepAlive: false,
      maxSockets: 1,
      maxTotalSockets: 1,
      proxyEnv: {},
      rejectUnauthorized: true,
      ca: [...rootCertificates],
      minVersion: 'TLSv1.3',
      checkServerIdentity,
    });
    transports.set(this, { grant, invocationId });
    Object.defineProperty(this, 'request', { writable: false, configurable: false });
    Object.defineProperty(this, 'close', { writable: false, configurable: false });
  }
  request = async (input: HttpInput): Promise<Response> => {
    assertLiveGrant(this.grant, this.invocationId);
    if (this.closing || this.failed || this.active.size !== 0)
      throw new AgentFailure('provider_failure');
    if (
      input.url !== responsesEndpoint ||
      input.method !== 'POST' ||
      input.redirect !== 'error' ||
      typeof input.body !== 'string' ||
      Buffer.byteLength(input.body) > 131072
    )
      throw new AgentFailure('provider_configuration');
    const headers = headersSchema.safeParse(input.headers);
    let body: unknown;
    try {
      body = JSON.parse(input.body);
    } catch {
      throw new AgentFailure('provider_configuration');
    }
    if (!headers.success || !providerRequestSchema.safeParse(body).success)
      throw new AgentFailure('provider_configuration');
    if (input.signal.aborted) throw new AgentFailure('model_timeout');
    consumeLiveRequest(this.grant, this.invocationId, input.permit, input.body);
    const serialized = input.body;
    return await new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined, response: IncomingMessage | undefined;
      let settled = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const finish = () => {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
        if (request) this.active.delete(request);
      };
      const dispose = () => {
        try {
          response?.destroy();
        } catch {
          this.cleanupFailed = true;
        }
        try {
          request?.destroy();
        } catch {
          this.cleanupFailed = true;
        }
        if (this.cleanupFailed && request)
          this.active.set(request, {
            fail: () => fail('provider_failure'),
            ...(response ? { response } : {}),
          });
      };
      const fail = (
        code:
          | 'model_timeout'
          | 'provider_failure'
          | 'provider_invalid_response'
          | 'provider_response_limit',
      ) => {
        if (settled) return;
        settled = true;
        finish();
        this.failed = true;
        this.budget.markUnknown();
        dispose();
        reject(new AgentFailure(code));
      };
      const abort = () => fail('model_timeout');
      const timer = setTimeout(abort, 5000);
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        request = https.request(
          {
            protocol: 'https:',
            hostname: 'api.openai.com',
            port: 443,
            path: '/v1/responses',
            method: 'POST',
            servername: 'api.openai.com',
            agent: this.agent,
            rejectUnauthorized: true,
            ca: [...rootCertificates],
            minVersion: 'TLSv1.3',
            checkServerIdentity,
            maxHeaderSize: 8192,
            headers: {
              ...headers.data,
              'accept-encoding': 'identity',
              'content-length': String(Buffer.byteLength(serialized)),
            },
          },
          (incoming) => {
            response = incoming;
            if (request) {
              const active = this.active.get(request);
              if (active) active.response = incoming;
            }
            incoming.once('error', () => fail('provider_failure'));
            if (settled) {
              dispose();
              return;
            }
            incoming.once('aborted', () => fail('provider_failure'));
            const status = incoming.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              fail('provider_invalid_response');
              return;
            }
            if (status < 200 || status > 599 || (status >= 200 && status < 300 && status !== 200)) {
              fail('provider_invalid_response');
              return;
            }
            if (status !== 200) {
              settled = true;
              finish();
              this.failed = true;
              this.budget.markUnknown();
              dispose();
              resolve(
                new Response(null, { status, headers: { 'content-type': 'application/json' } }),
              );
              return;
            }
            const contentType = incoming.headers['content-type'];
            const encoding = incoming.headers['content-encoding'];
            const length = incoming.headers['content-length'];
            if (
              typeof contentType !== 'string' ||
              !/^application\/json(?:;|$)/i.test(contentType) ||
              (encoding !== undefined && encoding !== 'identity')
            ) {
              fail('provider_invalid_response');
              return;
            }
            if (
              length !== undefined &&
              (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 65536)
            ) {
              fail('provider_response_limit');
              return;
            }
            incoming.on('data', (chunk: unknown) => {
              if (settled) return;
              if (!Buffer.isBuffer(chunk)) {
                fail('provider_invalid_response');
                return;
              }
              bytes += chunk.byteLength;
              if (bytes > 65536) {
                fail('provider_response_limit');
                return;
              }
              chunks.push(chunk);
            });

            incoming.once('close', () => {
              if (!settled && !incoming.complete) fail('provider_failure');
            });
            incoming.once('end', () => {
              if (settled) return;
              if (!incoming.complete || (length !== undefined && Number(length) !== bytes)) {
                fail('provider_invalid_response');
                return;
              }
              settled = true;
              finish();
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              );
            });
          },
        );
        this.active.set(request, { fail: () => fail('provider_failure') });
        request.once('error', () => fail('provider_failure'));
        request.once('upgrade', () => fail('provider_invalid_response'));
        request.once('close', () => {
          if (!response && !settled) fail('provider_failure');
        });
        if (input.signal.aborted) {
          abort();
          return;
        }
        request.end(serialized);
      } catch {
        fail('provider_failure');
      }
    });
  };
  close = (signal: AbortSignal): Promise<void> => {
    // Cleanup is attempted even when the caller's signal has already aborted.
    void signal;
    this.closing ??= Promise.resolve().then(() => {
      let failed = this.cleanupFailed;
      for (const [request, state] of [...this.active]) {
        try {
          state.fail();
        } catch {
          failed = true;
        }
        try {
          state.response?.destroy();
        } catch {
          failed = true;
        }
        try {
          request.destroy();
        } catch {
          failed = true;
        }
      }
      this.active.clear();
      try {
        this.agent.destroy();
      } catch {
        failed = true;
      }
      if (failed || this.cleanupFailed) throw new AgentFailure('cleanup_failed');
    });
    return this.closing;
  };
}
