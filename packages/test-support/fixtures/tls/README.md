These certificates and the server private key are public, test-only fixtures.
Never use them for deployment. The CA private key was discarded after signing.
The server certificate covers only `localhost`, so integration tests can verify
that using `127.0.0.1` fails hostname validation. Certificates expire in 2036.
The disposable PostgreSQL container copies the key to a private file with mode
0600; Windows bind-mount permissions are not used as PostgreSQL key permissions.
