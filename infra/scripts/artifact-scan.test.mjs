// Tests for artifact-scan.sh: the directory mode against temporary directories and the image mode against
// small images built FROM scratch (nothing is pulled for them). The scans need Docker, because the script runs
// gitleaks as the container CI uses; without Docker those tests are skipped with a message, except in CI,
// where a missing Docker fails. Every planted value is made up and put together at run time, so this file
// holds nothing a secret scanner would report.
// Run: node --test "infra/scripts/*.test.mjs"
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const SCRIPT = fileURLToPath(new URL('./artifact-scan.sh', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const scriptText = readFileSync(SCRIPT, 'utf8');
const GITLEAKS_IMAGE = /^GITLEAKS_IMAGE='([^']+)'$/m.exec(scriptText)?.[1];

// Shaped like a GitHub personal access token (gitleaks rule github-pat), and nothing else.
const FAKE_BODY = ['POIIfake', 'TESTonly', '0123456789', 'abcdef', 'XYZW'].join('');
const FAKE = ['ghp', FAKE_BODY].join('_');
const SHA1_NAME = 'a1b2c3d4e5'.repeat(4);
// What the generic rule takes for a key: a line of xterm.js as Playwright's trace viewer bundles it, and a
// made-up value under the name Next.js gives its per-build keys.
const XTERM_LINE = ['t.Four', 'KeyMap=t.Two', 'KeyMap=void 0;'].join('');
const MADE_UP_KEY = Buffer.from('POII made-up value, not a secret').toString('base64');
const NEXT_MANIFEST = JSON.stringify({ node: {}, edge: {}, [['encryption', 'Key'].join('')]: MADE_UP_KEY }, null, 2);

/** A zip archive with deflated entries, enough for unzip and gitleaks. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const packed = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let workDir;
let counter = 0;
before(() => { workDir = mkdtempSync(join(tmpdir(), 'poii-artifact-scan-test-')); });
after(() => rmSync(workDir, { recursive: true, force: true }));

/** A fresh directory holding the given files (path -> text or Buffer). */
function tree(files) {
  const dir = join(workDir, `tree-${counter++}`);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function scan(...args) {
  return new Promise(resolve => {
    execFile('bash', [SCRIPT, ...args], { env: process.env, timeout: 240_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr, all: stdout + stderr });
    });
  });
}

const assertNoPlantedText = result => {
  assert.ok(!result.all.includes(FAKE), 'the planted value was printed');
  assert.ok(!result.all.includes(FAKE_BODY.slice(0, 12)), 'part of the planted value was printed');
  assert.ok(!result.all.includes(MADE_UP_KEY.slice(0, 12)), 'part of the made-up key was printed');
};

describe('artifact-scan.sh stays in step with the repository scan', () => {
  test('uses the gitleaks image and version of the history scan in ci.yml', () => {
    const inCi = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8').match(/ghcr\.io\/gitleaks\/gitleaks:[\w.-]+/g) ?? [];
    assert.ok(GITLEAKS_IMAGE, 'GITLEAKS_IMAGE not found in artifact-scan.sh');
    assert.ok(inCi.length > 0, 'ci.yml no longer names a gitleaks image');
    for (const image of inCi) assert.equal(image, GITLEAKS_IMAGE);
  });

  test('uses the name patterns of forbidden-material.sh, word for word', () => {
    const forbidden = readFileSync(join(REPO, 'infra/scripts/forbidden-material.sh'), 'utf8');
    const names = /^FORBIDDEN_NAMES='([^']+)'$/m.exec(scriptText)?.[1];
    const except = /^FORBIDDEN_NAMES_EXCEPT='([^']+)'$/m.exec(scriptText)?.[1];
    assert.ok(names && except);
    assert.ok(forbidden.includes(`grep -Ei '${names}'`), 'the forbidden name patterns differ');
    assert.ok(forbidden.includes(`grep -Ev '${except}'`), 'the exception differs');
  });

  test('refuses a call it does not understand, and a directory that does not exist', async () => {
    for (const args of [[], ['nonsense', 'x'], ['dir'], ['image']]) {
      const result = await scan(...args);
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.stderr, /usage: artifact-scan\.sh image <image-ref> \| dir <path>/);
    }
    const missing = await scan('dir', join(workDir, 'does-not-exist'));
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /not a directory/);
  });
});

const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 60_000 });
const dockerAvailable = docker.status === 0;
const skip = dockerAvailable ? false : `Docker is not available; artifact-scan.sh runs gitleaks as the container ${GITLEAKS_IMAGE}`;

test('Docker is available where CI runs these tests', { skip: !process.env.CI }, () => {
  assert.ok(dockerAvailable, 'CI must run the artifact scans, not skip them');
});

const scannerContainers = () =>
  spawnSync('docker', ['ps', '-aq', '--filter', `ancestor=${GITLEAKS_IMAGE}`], { encoding: 'utf8' }).stdout.split(/\s+/).filter(Boolean).sort();

const reportHtml = body => `<!doctype html><div id="root"></div><template id="playwrightReportBase64">data:application/zip;base64,${body}</template>`;
// Every character that means something in a regular expression, backslash included.
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each scan starts a container, so the cases share three scans: one directory that must pass, one in which
// everything is planted, and one that cannot be read.
describe('artifact-scan.sh dir', { skip }, () => {
  const FORBIDDEN = ['.env', 'nested/.env.local', 'db/poii.sql.gz', 'private/note.txt', 'data/report.zip'];
  let containersBefore;
  let clean;
  let planted;
  let broken;
  before(async () => {
    containersBefore = scannerContainers();
    clean = await scan('dir', tree({
      'index.html': reportHtml(zip({ 'report.json': '{"steps":[]}' }).toString('base64')),
      'data/notes.md': '# Notes\nDATABASE_URL=postgres://poii:test-only-password@127.0.0.1:5432/poii\n',
      '.env.example': 'POSTGRES_PASSWORD=change-me-locally\n',
      [`data/${SHA1_NAME}.zip`]: zip({ 'trace.network': '{"status":200}' }),
      'trace/assets/xtermModule-B794rD2Z.js': `var t={};\n${XTERM_LINE}\n`,
    }));
    planted = await scan('dir', tree({
      'index.html': reportHtml(zip({ 'report.json': `{"steps":[{"title":"fill","value":"${FAKE}"}]}` }).toString('base64')),
      'data/steps.txt': `step one\nAuthorization: token ${FAKE}\n`,
      [`data/${SHA1_NAME}.zip`]: zip({ 'trace.network': `{"authorization":"Bearer ${FAKE}"}` }),
      'data/bundle.js': `var t={};\n${XTERM_LINE}\n`,
      '.env': 'A=1\n',
      'nested/.env.local': 'A=1\n',
      'db/poii.sql.gz': 'x',
      'private/note.txt': 'x',
      'data/report.zip': zip({ 'a.txt': 'x' }),
    }));
    broken = await scan('dir', tree({ 'index.html': reportHtml('AAAAnotAzipAAAA') }));
  });

  test('passes a directory with nothing in it to find, .env.example and a documented placeholder included', () => {
    assert.equal(clean.code, 0, clean.all);
    assert.match(clean.stdout, /artifact-scan dir .*: nothing found beyond the 1 known line\(s\) above\. 8 paths checked by name; gitleaks read every file, zip archives and 1 zip\(s\) embedded in HTML\./);
    assert.ok(!/FAIL/.test(clean.stdout), clean.stdout);
  });

  test('passes an allowlisted name: a Playwright trace stored as data/<sha1>.zip', () => {
    assert.ok(!clean.stdout.includes(SHA1_NAME), clean.stdout);
  });

  test('prints a known finding as KNOWN without failing, and only at its known path', () => {
    assert.match(clean.stdout, /KNOWN secret:generic-api-key\s+trace\/assets\/xtermModule-B794rD2Z\.js:2\n/);
    assert.match(planted.stdout, /FAIL {2}secret:generic-api-key\s+data\/bundle\.js:2\n/);
  });

  test('fails on a planted key, names the file, the line and the rule, and does not print the key', () => {
    assert.equal(planted.code, 1, planted.all);
    assert.match(planted.stdout, /FAIL {2}secret:github-pat\s+data\/steps\.txt:2\n/);
    assertNoPlantedText(planted);
  });

  test('fails on an environment file, a dump, a private directory and an archive, whatever they hold', () => {
    for (const path of FORBIDDEN) assert.match(planted.stdout, new RegExp(`FAIL {2}forbidden-name\\s+${escaped(path)}\\n`), path);
    assert.equal(planted.stdout.match(/forbidden-name/g).length, FORBIDDEN.length, planted.stdout);
  });

  test('reads into the allowlisted trace archive: a key inside it fails and names the archive', () => {
    assert.match(planted.stdout, new RegExp(`FAIL {2}secret:github-pat\\s+data/${SHA1_NAME}\\.zip`));
    assert.ok(!new RegExp(`forbidden-name\\s+data/${SHA1_NAME}`).test(planted.stdout), planted.stdout);
  });

  test('reads the zip a Playwright report embeds in index.html as base64, and stops when it cannot', () => {
    assert.match(planted.stdout, /FAIL {2}secret:github-pat\s+embedded\/index\.html\.1\.zip/);
    assert.match(planted.stdout, /9 finding\(s\)\. .* 1 zip\(s\) embedded in HTML\./);
    assert.equal(broken.code, 2, broken.all);
    assert.match(broken.stderr, /embedded in index\.html/);
  });

  test('leaves no scanner container behind', () => {
    assert.deepEqual(scannerContainers(), containersBefore);
  });
});

describe('artifact-scan.sh image', { skip }, () => {
  const tags = [];
  after(() => { for (const tag of tags) spawnSync('docker', ['rmi', '-f', tag]); });

  /** Builds an image FROM scratch out of a directory tree and a Dockerfile body. */
  function build(files, dockerfile) {
    const context = tree({ ...files, Dockerfile: `FROM scratch\n${dockerfile}\n` });
    const tag = `poii-artifact-scan-test:${process.pid}-${counter++}`;
    const built = spawnSync('docker', ['build', '-q', '-t', tag, context], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(built.status, 0, built.stderr);
    tags.push(tag);
    return tag;
  }

  test('passes an image that holds only the application, and shows the key Next.js generates as KNOWN', async () => {
    const tag = build({
      'app/dist/main.js': 'console.log("ready");\n',
      'app/package.json': '{"name":"x"}\n',
      'app/apps/web/.next/server/server-reference-manifest.json': NEXT_MANIFEST,
    }, 'COPY app/ /app/\nWORKDIR /app');
    const result = await scan('image', tag);
    assert.equal(result.code, 0, result.all);
    assert.match(result.stdout, /KNOWN secret:generic-api-key\s+app\/apps\/web\/\.next\/server\/server-reference-manifest\.json:4 \(layer 1\)\n/);
    assert.match(result.stdout, /nothing found beyond the 1 known line\(s\) above\. \d+ paths in \d+ layers checked by name; gitleaks read \/app in \d+ layer\(s\) and the image configuration/);
    assertNoPlantedText(result);
  });

  test('finds forbidden names, things not meant for a runtime image, and keys in a replaced file and in the configuration', async () => {
    const tag = build({
      'one/notes.txt': `token=${FAKE}\n`,
      'one/.env': 'A=1\n',
      'one/.git/HEAD': 'ref: refs/heads/main\n',
      'one/fixtures/decision-chain.md': '# fixture\n',
      'one/apps/api/test/recorded/provider.ok.json': '{}\n',
      'one/scripts/agent-token.mjs': '// script\n',
      'one/node_modules/pkg/test/recorded/x.json': '{}\n',
      'one/apps/api/dist/manifest.json': NEXT_MANIFEST,
      'two/notes.txt': 'nothing here\n',
    }, `COPY one/ /app/\nCOPY two/ /app/\nENV UPSTREAM_TOKEN=${FAKE}`);
    const result = await scan('image', tag);
    assert.equal(result.code, 1, result.all);
    // The file is clean in the final filesystem: only the first layer still holds the key.
    assert.match(result.stdout, /FAIL {2}secret:github-pat\s+app\/notes\.txt:1 \(layer 1\)\n/);
    assert.ok(!/app\/notes\.txt:1 \(layer 2\)/.test(result.stdout), result.stdout);
    assert.match(result.stdout, /FAIL {2}secret:github-pat\s+image-config\.json:\d+\n/);
    // The same content as the known Next.js key, at a path that is not known.
    assert.match(result.stdout, /FAIL {2}secret:generic-api-key\s+app\/apps\/api\/dist\/manifest\.json:4 \(layer 1\)\n/);
    assert.match(result.stdout, /FAIL {2}forbidden-name\s+app\/\.env \(layer 1\)\n/);
    assert.match(result.stdout, /FAIL {2}not-for-runtime:git-directory\s+app\/\.git\/HEAD \(layer 1\)\n/);
    assert.match(result.stdout, /FAIL {2}not-for-runtime:repository-fixtures\s+app\/fixtures\/decision-chain\.md \(layer 1\)\n/);
    assert.match(result.stdout, /FAIL {2}not-for-runtime:recorded-provider-response\s+app\/apps\/api\/test\/recorded\/provider\.ok\.json \(layer 1\)\n/);
    assert.match(result.stdout, /FAIL {2}not-for-runtime:agent-token-script\s+app\/scripts\/agent-token\.mjs \(layer 1\)\n/);
    assert.ok(!/node_modules\/pkg\/test\/recorded/.test(result.stdout), 'a dependency\'s own test data is not ours');
    assertNoPlantedText(result);
  });

  test('stops when the image has no /app, instead of passing without reading anything', async () => {
    const tag = build({ 'srv/main.js': 'x\n' }, 'COPY srv/ /srv/');
    const result = await scan('image', tag);
    assert.equal(result.code, 2, result.all);
    assert.match(result.stderr, /no layer holds \/app/);
  });

  test('stops on an image that does not exist locally', async () => {
    const result = await scan('image', 'poii-artifact-scan-test:does-not-exist');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no local image/);
  });
});
