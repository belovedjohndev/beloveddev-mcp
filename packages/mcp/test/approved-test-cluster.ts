import { z } from 'zod';
import { openDatabase } from '@beloveddev/database/client';
import { AgentFailure } from './agent-evaluation.js';

const clusterBrand: unique symbol = Symbol('approved-synthetic-cluster');
export interface ApprovedTestCluster {
  readonly [clusterBrand]: true;
}
const clusterSchema = z.strictObject({
  administratorUrl: z.string().url(),
  systemIdentifier: z.string().regex(/^[0-9]{1,20}$/),
  marker: z.uuid(),
});
type ClusterIdentity = z.infer<typeof clusterSchema>;
const clusters = new WeakMap<object, ClusterIdentity>();
function parseIdentity(input: unknown): ClusterIdentity {
  const parsed = clusterSchema.safeParse(input);
  if (!parsed.success) throw new AgentFailure('setup_failed');
  const url = new URL(parsed.data.administratorUrl);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.pathname !== '/postgres' ||
    url.search ||
    url.hash ||
    !url.username
  )
    throw new AgentFailure('setup_failed');
  return Object.freeze(parsed.data);
}
async function verifyCluster(identity: ClusterIdentity): Promise<void> {
  let database: ReturnType<typeof openDatabase> | undefined;
  let poolFailed = false;
  let failure: AgentFailure | undefined;
  try {
    database = openDatabase(identity.administratorUrl, {
      maxConnections: 1,
      onIdleError: () => {
        poolFailed = true;
      },
    });
    const result = await database.pool.query<{
      database: string;
      version: number;
      identifier: string;
      marker: string | null;
    }>(
      "SELECT current_database() AS database, current_setting('server_version_num')::integer AS version, system_identifier::text AS identifier, shobj_description(oid,'pg_database') AS marker FROM pg_control_system() CROSS JOIN pg_database WHERE datname=current_database()",
    );
    const row = result.rows[0];
    if (
      poolFailed ||
      result.rowCount !== 1 ||
      !row ||
      row.database !== 'postgres' ||
      row.version < 180000 ||
      row.version >= 190000 ||
      row.identifier !== identity.systemIdentifier ||
      row.marker !== 'beloveddev.synthetic-evaluation-cluster:' + identity.marker
    )
      throw new AgentFailure('setup_failed');
  } catch {
    failure = new AgentFailure('setup_failed');
  } finally {
    try {
      await database?.close();
    } catch {
      failure = new AgentFailure('cleanup_failed');
    }
  }
  if (failure) throw failure;
}
/** Trusted test bootstrap supplies out-of-band identity; this gate never installs its own proof. */
export async function approveTestCluster(input: unknown): Promise<ApprovedTestCluster> {
  const identity = parseIdentity(input);
  await verifyCluster(identity);
  const capability: ApprovedTestCluster = Object.freeze({ [clusterBrand]: true as const });
  clusters.set(capability, identity);
  return capability;
}
/** Recheck the pinned server before any fixture database/role creation. */
export async function approvedClusterUrl(cluster: ApprovedTestCluster): Promise<string> {
  const identity = clusters.get(cluster);
  if (!identity) throw new AgentFailure('setup_failed');
  await verifyCluster(identity);
  return identity.administratorUrl;
}
