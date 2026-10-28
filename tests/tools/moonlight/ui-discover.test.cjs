// The parser against a Sunshine answer recorded on the LAN (rig, avahi, compressed names,
// TXT, SRV, AAAA and A in one packet) and against packets built here for the edge cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {
  SERVICE,
  TYPE,
  query,
  parsePacket,
  candidates,
  merge,
  discover
} = require('../../../host/ui/discover.js');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mdns-sunshine.bin'));

function name(text) {
  return Buffer.concat([
    ...text
      .split('.')
      .filter(Boolean)
      .map(part => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
    Buffer.from([0])
  ]);
}
function record(owner, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([Buffer.isBuffer(owner) ? owner : name(owner), head, data]);
}
function packet(answers, additionals = []) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(answers.length, 6);
  head.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([head, ...answers, ...additionals]);
}
const srv = (port, target) => {
  const data = Buffer.alloc(6);
  data.writeUInt16BE(port, 4);
  return Buffer.concat([data, name(target)]);
};

test('the query asks for the service with a unicast reply', () => {
  const bytes = query();
  assert.equal(bytes.readUInt16BE(4), 1);
  assert.equal(bytes.readUInt16BE(bytes.length - 4), TYPE.ptr);
  assert.equal(bytes.readUInt16BE(bytes.length - 2), 0x8001);
  assert.deepEqual(bytes.subarray(12, bytes.length - 4), name(SERVICE));
});

test('the recorded Sunshine answer yields one host with its SRV port and A address', () => {
  const records = parsePacket(FIXTURE);
  assert.deepEqual(
    records.map(r => [r.type, r.name]),
    [
      [TYPE.ptr, '_nvstream._tcp.local'],
      [TYPE.txt, 'rig._nvstream._tcp.local'],
      [TYPE.srv, 'rig._nvstream._tcp.local'],
      [TYPE.aaaa, 'rig.local'],
      [TYPE.a, 'rig.local']
    ]
  );
  assert.deepEqual(records[0].data, {target: 'rig._nvstream._tcp.local'});
  assert.deepEqual(records[1].data, {strings: ['']}, 'the empty TXT avahi sends is fine');
  assert.deepEqual(records[2].data, {port: 47989, target: 'rig.local'});
  assert.match(records[3].data.address, /^fe80:|^fd|^2/);
  assert.deepEqual(candidates(records), [{name: 'rig', address: '192.168.8.245', port: 47989}]);
});

test('records may sit in the additional section in any order; other services are ignored', () => {
  const built = packet(
    [
      record(SERVICE, TYPE.ptr, name('Office PC.' + SERVICE)),
      record('_http._tcp.local', TYPE.ptr, name('nas._http._tcp.local'))
    ],
    [
      record('office.local', TYPE.a, Buffer.from([10, 0, 0, 7])),
      record('Office PC.' + SERVICE, TYPE.srv, srv(47990, 'office.local')),
      record('nas._http._tcp.local', TYPE.srv, srv(80, 'nas.local')),
      record('nas.local', TYPE.a, Buffer.from([10, 0, 0, 8]))
    ]
  );
  assert.deepEqual(candidates(parsePacket(built)), [
    {name: 'Office PC', address: '10.0.0.7', port: 47990}
  ]);
  const pointer = Buffer.from([0xc0, 12]);
  const box = Buffer.concat([name('Box').subarray(0, -1), pointer]);
  const compressed = packet(
    [record(SERVICE, TYPE.ptr, box)],
    [
      record(box, TYPE.srv, srv(47989, 'box.local')),
      record('box.local', TYPE.a, Buffer.from([10, 0, 0, 9]))
    ]
  );
  assert.deepEqual(candidates(parsePacket(compressed)), [
    {name: 'Box', address: '10.0.0.9', port: 47989}
  ]);
  const twice = packet([
    record(SERVICE, TYPE.ptr, name('A.' + SERVICE)),
    record(SERVICE, TYPE.ptr, name('B.' + SERVICE)),
    record('A.' + SERVICE, TYPE.srv, srv(47989, 'same.local')),
    record('B.' + SERVICE, TYPE.srv, srv(47989, 'same.local')),
    record('same.local', TYPE.a, Buffer.from([10, 0, 0, 1]))
  ]);
  assert.equal(candidates(parsePacket(twice)).length, 1, 'one host per address');
  assert.deepEqual(
    candidates(parsePacket(packet([record(SERVICE, TYPE.ptr, name('Lonely.' + SERVICE))]))),
    []
  );
});

test('truncated and malformed packets are rejected, not misread', () => {
  assert.throws(() => parsePacket(FIXTURE.subarray(0, 11)), /too short/);
  assert.throws(() => parsePacket(FIXTURE.subarray(0, 100)), /past the packet/);
  const loop = packet([record(SERVICE, TYPE.ptr, Buffer.from([0xc0, 12]))]);
  loop.writeUInt8(0xc0, 12);
  loop.writeUInt8(12, 13);
  assert.throws(() => parsePacket(loop), /pointer loop|past the packet/);
  const short = packet([record(SERVICE, TYPE.a, Buffer.from([1, 2]))]);
  assert.throws(() => parsePacket(short), /four bytes/);
  const many = Buffer.from(FIXTURE);
  many.writeUInt16BE(1000, 6);
  assert.throws(() => parsePacket(many), /too many/);
});

test('merge keeps the manual list first and intact, appends new hosts once', () => {
  const manual = [
    {name: 'Rig', address: '192.168.8.245'},
    {name: 'Laptop', address: '192.168.8.9'}
  ];
  const merged = merge(manual, [
    {name: 'rig', address: '192.168.8.245', port: 47989},
    {name: 'Laptop', address: '192.168.8.99', port: 47989},
    {name: 'Office PC', address: '10.0.0.7', port: 47989},
    {name: 'Office PC', address: '10.0.0.7', port: 47989}
  ]);
  assert.deepEqual(merged, [...manual, {name: 'Office PC', address: '10.0.0.7'}]);
  assert.deepEqual(merge(manual, []), manual, 'absence removes nothing');
  assert.notEqual(merge(manual, [])[0], manual[0], 'the manual entries are copied, not shared');
});

test('discover sends the query, collects answers for the window and closes the socket', async () => {
  const sent = [];
  const socket = Object.assign(new EventEmitter(), {
    bind: (port, ready) => {
      assert.equal(port, 5353);
      setImmediate(ready);
    },
    addMembership: group => sent.push('join ' + group),
    send: (bytes, port, address, done) => {
      sent.push(`${address}:${port} ${bytes.length}`);
      done();
      setImmediate(() => socket.emit('message', FIXTURE, {address: '192.168.8.245'}));
      setImmediate(() => socket.emit('message', Buffer.from('junk'), {address: '192.168.8.1'}));
    },
    close: () => sent.push('close')
  });
  const hosts = await discover({windowMs: 30, createSocket: () => socket});
  assert.deepEqual(hosts, [{name: 'rig', address: '192.168.8.245', port: 47989}]);
  assert.deepEqual(sent, ['join 224.0.0.251', `224.0.0.251:5353 ${query().length}`, 'close']);
});
