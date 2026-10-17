// Table and column grants are inspected independently, including PUBLIC and inherited
// privileges. Reachable roles also cover NOINHERIT / SET ROLE escalation paths.
export const runtimePrivilegesQuery = `
WITH roles AS (
  SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_roles WHERE rolname IN (current_user, session_user)
    OR pg_has_role(session_user, oid, 'MEMBER')
), schemas AS (
  SELECT oid, nspname, nspowner FROM pg_namespace
  WHERE left(nspname,3) <> 'pg_' AND nspname <> 'information_schema'
), relations AS (
  SELECT c.oid, c.relname, c.relowner, c.relkind, n.nspname
  FROM pg_class c JOIN schemas n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f','S')
), allowed AS (
  SELECT * FROM (VALUES
    ('public','tenant_memberships',true,false),
    ('public','developer_profiles',true,false), ('public','clients',true,false),
    ('public','projects',true,false), ('public','project_evidence',true,false),
    ('public','project_blockers',true,false), ('public','project_notes',true,true),
    ('public','opportunities',true,false), ('public','audit_logs',false,true),
    ('public','tenants',false,false), ('public','users',false,false),
    ('drizzle','__drizzle_migrations',true,false)
  ) AS a(schema_name, table_name, can_read, can_insert)
), tables AS (
  SELECT c.*, coalesce(a.can_read,false) AS can_read,
    coalesce(a.can_insert,false) AS can_insert
  FROM relations c LEFT JOIN allowed a ON a.schema_name=c.nspname AND a.table_name=c.relname
  WHERE c.relkind<>'S'
), routines AS (
  SELECT p.oid,p.proowner,p.prosecdef FROM pg_proc p JOIN schemas n ON n.oid=p.pronamespace
), system_schemas AS (
  SELECT oid,nspname FROM pg_namespace WHERE left(nspname,3)='pg_' OR nspname='information_schema'
), system_grants AS (
  -- System metadata has necessary PUBLIC access. Permit only the capabilities
  -- PostgreSQL recorded for PUBLIC at initdb, not later grants of catalog writes,
  -- credential reads, or privileged builtin function execution.
  SELECT a.*, coalesce(i.initprivs,
    CASE WHEN n.nspname='information_schema' THEN ARRAY[makeaclitem(0,c.relowner,'SELECT',false)]
    ELSE acldefault(CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END::"char",c.relowner) END) AS initial_acl
  FROM pg_class c JOIN system_schemas n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  LEFT JOIN pg_init_privs i ON i.classoid='pg_class'::regclass AND i.objoid=c.oid AND i.objsubid=0
  WHERE c.relkind IN ('r','p','v','m','f','S')
  UNION ALL
  SELECT a.*, coalesce(i.initprivs,'{}'::aclitem[]) || coalesce(t.initprivs,
    CASE WHEN n.nspname='information_schema' THEN ARRAY[makeaclitem(0,c.relowner,'SELECT',false)]
    ELSE acldefault('r',c.relowner) END) AS initial_acl
  FROM pg_class c JOIN system_schemas n ON n.oid=c.relnamespace
  JOIN pg_attribute col ON col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped
  CROSS JOIN LATERAL aclexplode(col.attacl) a
  LEFT JOIN pg_init_privs i ON i.classoid='pg_class'::regclass AND i.objoid=c.oid AND i.objsubid=col.attnum
  LEFT JOIN pg_init_privs t ON t.classoid='pg_class'::regclass AND t.objoid=c.oid AND t.objsubid=0
  UNION ALL
  SELECT a.*, coalesce(i.initprivs,acldefault('f',p.proowner)) AS initial_acl
  FROM pg_proc p JOIN system_schemas n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  LEFT JOIN pg_init_privs i ON i.classoid='pg_proc'::regclass AND i.objoid=p.oid AND i.objsubid=0
)
SELECT (
  current_user <> session_user
  OR EXISTS (SELECT FROM roles WHERE rolsuper OR rolcreatedb OR rolcreaterole
    OR rolreplication OR rolbypassrls OR left(rolname,3)='pg_')
  OR EXISTS (SELECT FROM pg_auth_members m JOIN roles r ON r.oid=m.member WHERE m.admin_option)
  OR EXISTS (SELECT FROM roles r JOIN pg_database d ON d.datname=current_database()
    WHERE d.datdba=r.oid OR has_database_privilege(r.oid,d.oid,'CREATE')
      OR has_database_privilege(r.oid,d.oid,'TEMPORARY')
      OR has_database_privilege(r.oid,d.oid,'CONNECT WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r CROSS JOIN pg_namespace n
    WHERE n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE')
      OR has_schema_privilege(r.oid,n.oid,'USAGE WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r JOIN pg_class c ON c.relowner=r.oid)
  OR EXISTS (SELECT FROM roles r JOIN pg_type t ON t.typowner=r.oid)
  OR EXISTS (SELECT FROM roles r JOIN pg_proc p ON p.proowner=r.oid)
  OR EXISTS (SELECT FROM system_grants a
    WHERE (a.grantee=0 OR a.grantee IN (SELECT oid FROM roles))
    AND (a.is_grantable OR NOT EXISTS (SELECT FROM aclexplode(a.initial_acl) b
      WHERE b.grantee=0 AND b.privilege_type=a.privilege_type)))
  OR EXISTS (SELECT FROM roles r CROSS JOIN routines p
    WHERE p.proowner=r.oid OR (p.prosecdef AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
      OR has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r CROSS JOIN tables c CROSS JOIN
    (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(priv)
    WHERE (has_table_privilege(r.oid,c.oid,v.priv) AND NOT
      ((v.priv='SELECT' AND c.can_read) OR (v.priv='INSERT' AND c.can_insert)))
      OR has_table_privilege(r.oid,c.oid,v.priv || ' WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r CROSS JOIN tables c
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(priv)
    WHERE (has_column_privilege(r.oid,c.oid,a.attnum,v.priv) AND NOT (
      (v.priv='SELECT' AND (c.can_read OR
        (c.nspname='public' AND c.relname IN ('tenants','users') AND a.attname IN ('id','status'))))
      OR (v.priv='INSERT' AND c.can_insert)))
      OR has_column_privilege(r.oid,c.oid,a.attnum,v.priv || ' WITH GRANT OPTION'))
  OR EXISTS (SELECT FROM roles r CROSS JOIN relations c
    CROSS JOIN (VALUES ('USAGE'),('SELECT'),('UPDATE')) v(priv)
    WHERE c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,v.priv))
) AS unsafe,
(
  NOT has_database_privilege(current_database(),'CONNECT')
  OR NOT has_schema_privilege('public','USAGE')
  OR NOT has_schema_privilege('drizzle','USAGE')
  OR EXISTS (SELECT FROM allowed a
    WHERE (a.can_read AND NOT has_table_privilege(format('%I.%I',a.schema_name,a.table_name),'SELECT'))
      OR (a.can_insert AND NOT has_table_privilege(format('%I.%I',a.schema_name,a.table_name),'INSERT')))
  OR EXISTS (SELECT FROM (VALUES ('tenants'),('users')) t(name)
    CROSS JOIN (VALUES ('id'),('status')) c(name)
    WHERE NOT has_column_privilege(format('public.%I',t.name),c.name,'SELECT'))
) AS missing`;
