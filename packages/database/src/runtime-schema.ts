/** PostgreSQL 18 catalog signature. Change only after reviewing an intentional schema change. */
export const RUNTIME_SCHEMA_SHA256 =
  '03cb152f4b1fc119e6a3b1427fa5b57ce43539ae03bbe33e969cd63d80d41e8e';

// Excludes ownership and ACLs, which are checked separately and vary by deployment.
// JSONB text and every aggregate are ordered; no extension or privileged function is needed.
export const runtimeSchemaQuery = `
SELECT jsonb_build_object(
  'relations', (SELECT jsonb_agg(jsonb_build_object(
    'name', c.relname, 'kind', c.relkind, 'persistence', c.relpersistence, 'rls', c.relrowsecurity,
    'forceRls', c.relforcerowsecurity,
    'columns', (SELECT jsonb_agg(jsonb_build_array(a.attname,
      format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
      pg_get_expr(d.adbin, d.adrelid), a.attcollation::regcollation::text) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints', (SELECT jsonb_agg(jsonb_build_array(k.conname, k.contype,
      pg_get_constraintdef(k.oid), k.convalidated, k.condeferrable, k.condeferred)
      ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
    'indexes', (SELECT jsonb_agg(jsonb_build_array(i.relname, pg_get_indexdef(x.indexrelid),
      x.indisvalid, x.indisready) ORDER BY i.relname)
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'triggers', (SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid), t.tgenabled) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
    'rules', (SELECT jsonb_agg(jsonb_build_array(pg_get_ruledef(r.oid),r.ev_enabled) ORDER BY r.rulename)
      FROM pg_rewrite r WHERE r.ev_class=c.oid)
  ) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')),
  'enums', (SELECT jsonb_agg(jsonb_build_array(t.typname,
    (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid))
    ORDER BY t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typtype='e')
)::text AS manifest`;
