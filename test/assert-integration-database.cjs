const databaseName = 'codekids_integration';
const containerName = process.env.CODEKIDS_IT_CONTAINER;
const urlValue = process.env.DATABASE_URL;
let url;

try {
  url = new URL(urlValue ?? '');
} catch {
  process.stderr.write(
    'Refusing to use an invalid integration database URL.\n',
  );
  process.exit(1);
}

const safe =
  /^codekids-it-\d+-\d+-\d+$/.test(containerName ?? '') &&
  process.env.CODEKIDS_IT_DB_GUARD === `${containerName}/${databaseName}` &&
  ['postgres:', 'postgresql:'].includes(url.protocol) &&
  url.hostname === '127.0.0.1' &&
  url.pathname === `/${databaseName}` &&
  decodeURIComponent(url.username) === 'codekids_test' &&
  url.searchParams.get('schema') === 'public' &&
  Number.isInteger(Number(url.port)) &&
  Number(url.port) > 0 &&
  Number(url.port) <= 65535;

if (!safe) {
  process.stderr.write(
    'Refusing to use a non-isolated integration database.\n',
  );
  process.exit(1);
}
