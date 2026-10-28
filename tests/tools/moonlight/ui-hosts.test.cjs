const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hosts = require('../../../host/ui/hosts.js');

// --- host list load/save/seed -----------------------------------------

const created = [];

test.after(() => {
  for (const directory of created) fs.rmSync(directory, {recursive: true, force: true});
});

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hbhosts-'));
  created.push(directory);
  return path.join(directory, 'hosts.json');
}

test('loadHosts returns [] for a missing or corrupt file', () => {
  assert.deepEqual(hosts.loadHosts('/no/such/file.json'), []);
  const file = tempFile();
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(hosts.loadHosts(file), []);
  fs.writeFileSync(file, '{"not":"an array"}');
  assert.deepEqual(hosts.loadHosts(file), []);
});

test('saveHosts then loadHosts round-trips and names default from address', () => {
  const file = tempFile();
  hosts.saveHosts(file, [{name: 'Rig', address: '192.168.8.245'}, {address: '10.0.0.5'}]);
  assert.deepEqual(hosts.loadHosts(file), [
    {name: 'Rig', address: '192.168.8.245'},
    {name: '10.0.0.5', address: '10.0.0.5'}
  ]);
});

test('seedHosts dedupes, keeps order and always includes the default host', () => {
  const seeded = hosts.seedHosts(
    [{name: 'Rig', address: '192.168.8.245'}],
    ['10.0.0.5', '10.0.0.5']
  );
  assert.deepEqual(seeded, [
    {name: 'Rig', address: '192.168.8.245'},
    {name: '10.0.0.5', address: '10.0.0.5'}
  ]);
  const fresh = hosts.seedHosts([]);
  assert.deepEqual(fresh, [hosts.DEFAULT_HOST]);
  assert.equal(fresh.find(h => h.address === hosts.DEFAULT_HOST.address).name, 'Sunshine');
});

// --- list JSON parsing -------------------------------------------------

test('parseList reads currentGame and apps from the helper line', () => {
  const stdout =
    '{"event":"connected"}\n{"currentGame":12,"apps":[{"id":1,"name":"Desktop"},{"id":881448767,"name":"Steam Big Picture"}]}\n';
  assert.deepEqual(hosts.parseList(stdout), {
    currentGame: 12,
    apps: [
      {id: 1, name: 'Desktop'},
      {id: 881448767, name: 'Steam Big Picture'}
    ]
  });
});

test('parseList defaults currentGame to 0 and throws without an app list', () => {
  assert.deepEqual(hosts.parseList('{"currentGame":0,"apps":[]}'), {currentGame: 0, apps: []});
  assert.throws(() => hosts.parseList('{"event":"error"}'));
});
