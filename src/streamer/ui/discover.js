/**
 * One mDNS query for the `_nvstream._tcp.local` hosts Sunshine and GeForce Experience announce,
 * answers collected for a short window and turned into host candidates (CLAUDE.md).
 */
import dgram from 'node:dgram';
import {sameHost} from './hosts.js';

/** The service GameStream hosts announce. */
const SERVICE = '_nvstream._tcp.local';
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
/** The DNS record types this reads. */
const TYPE = {a: 1, ptr: 12, txt: 16, aaaa: 28, srv: 33};
const CLASS_IN = 1;
/** The QU bit of the question class: answer by unicast to the asking port. */
const UNICAST_RESPONSE = 0x8000;
/** Bounds on what one packet may hold before it is rejected unread. */
const MAX_PACKET = 9000;
const MAX_RECORDS = 64;
/** Compression pointers followed in one name before it counts as a loop. */
const MAX_JUMPS = 16;
const HEADER_BYTES = 12;

/** A dotted name as DNS labels: a length byte before each label, a zero byte at the end. */
function encodeName(name) {
  const labels = name.split('.').filter(Boolean);
  const encoded = labels.map(label =>
    Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'utf8')])
  );
  return Buffer.concat([...encoded, Buffer.from([0])]);
}

/** The PTR question for the service, asking for a unicast reply so any source port hears it. */
function query() {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16BE(1, 4);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE.ptr, 0);
  tail.writeUInt16BE(CLASS_IN | UNICAST_RESPONSE, 2);

  return Buffer.concat([header, encodeName(SERVICE), tail]);
}

/**
 * A DNS name at `offset`, following compression pointers, as {name, next} where next is the
 * offset after the name in the packet (not after the pointer target).
 */
function readName(packet, offset) {
  const labels = [];
  let next = null;
  let jumps = 0;

  for (;;) {
    if (offset >= packet.length) throw Error('mDNS name runs past the packet');
    const length = packet[offset];

    if (length === 0) {
      offset++;
      break;
    }

    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw Error('mDNS pointer runs past the packet');
      jumps++;
      if (jumps > MAX_JUMPS) throw Error('mDNS name pointer loop');

      next ??= offset + 2;
      offset = ((length & 0x3f) << 8) | packet[offset + 1];
      continue;
    }

    if ((length & 0xc0) !== 0) throw Error('mDNS label type unsupported');
    if (offset + 1 + length > packet.length) throw Error('mDNS label runs past the packet');
    labels.push(packet.toString('utf8', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }

  return {name: labels.join('.'), next: next ?? offset};
}

/**
 * @typedef {{name: string, type: number, ttl: number, data: any}} Record
 * data: PTR and SRV targets are names; SRV adds port; A/AAAA give the address text; TXT gives
 * the strings. Unknown types keep the raw bytes.
 */

/**
 * The resource records of one packet, answers and additionals alike, questions skipped.
 * @param {Buffer} packet
 * @returns {Record[]}
 */
function parsePacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < HEADER_BYTES)
    throw Error('mDNS packet too short');
  if (packet.length > MAX_PACKET) throw Error('mDNS packet too large');

  const questions = packet.readUInt16BE(4);
  const total = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (total > MAX_RECORDS) throw Error('mDNS packet has too many records');

  // Each question is a name, then its type and class words.
  let offset = HEADER_BYTES;
  for (let i = 0; i < questions; i++) offset = readName(packet, offset).next + 4;

  const records = [];
  for (let i = 0; i < total; i++) {
    const owner = readName(packet, offset);
    offset = owner.next;
    if (offset + 10 > packet.length) throw Error('mDNS record header runs past the packet');

    const type = packet.readUInt16BE(offset);
    const ttl = packet.readUInt32BE(offset + 4);
    const length = packet.readUInt16BE(offset + 8);
    const start = offset + 10;
    const end = start + length;
    if (end > packet.length) throw Error('mDNS record data runs past the packet');

    records.push({name: owner.name, type, ttl, data: readData(packet, type, start, end)});
    offset = end;
  }

  return records;
}

/** The data of one record, laid out as the Record typedef describes. */
function readData(packet, type, start, end) {
  switch (type) {
    case TYPE.ptr:
      return {target: readName(packet, start).name};

    case TYPE.srv:
      if (end - start < 7) throw Error('mDNS SRV record too short');
      return {port: packet.readUInt16BE(start + 4), target: readName(packet, start + 6).name};

    case TYPE.a:
      if (end - start !== 4) throw Error('mDNS A record is not four bytes');
      return {address: [...packet.subarray(start, end)].join('.')};

    case TYPE.aaaa: {
      if (end - start !== 16) throw Error('mDNS AAAA record is not sixteen bytes');
      const groups = [];
      for (let i = start; i < end; i += 2) groups.push(packet.readUInt16BE(i).toString(16));
      return {address: groups.join(':')};
    }

    case TYPE.txt: {
      const strings = [];
      for (let i = start; i < end; ) {
        const length = packet[i];
        if (i + 1 + length > end) throw Error('mDNS TXT string runs past the record');
        strings.push(packet.toString('utf8', i + 1, i + 1 + length));
        i += 1 + length;
      }
      return {strings};
    }

    default:
      return {bytes: Buffer.from(packet.subarray(start, end))};
  }
}

/** DNS names compare without regard to case. */
function same(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Hosts named by the records: one per `_nvstream._tcp.local` instance that has an SRV target
 * with an IPv4 address, collapsed by address.
 * @param {Record[]} records
 * @returns {{name: string, address: string, port: number}[]}
 */
function candidates(records) {
  const hosts = [];
  const seen = new Set();

  for (const pointer of records) {
    if (pointer.type !== TYPE.ptr || !same(pointer.name, SERVICE)) continue;

    const instance = pointer.data.target;
    const service = records.find(record => record.type === TYPE.srv && same(record.name, instance));
    if (!service) continue;

    const address = records.find(
      record => record.type === TYPE.a && same(record.name, service.data.target)
    );
    if (!address || seen.has(address.data.address)) continue;
    seen.add(address.data.address);

    const name = instance.slice(0, instance.length - SERVICE.length).replace(/\.$/, '');
    hosts.push({
      name: name || service.data.target,
      address: address.data.address,
      port: service.data.port
    });
  }

  return hosts;
}

/**
 * The saved list with the discovered hosts appended. A found host is known when it is the same
 * PC as a saved or removed one: the same uniqueid when both carry one, else the same address,
 * never the name alone (ui/CLAUDE.md, Discovery). Saved entries are copied unchanged.
 * @param {{name: string, address: string, uniqueid?: string}[]} existing
 * @param {{name: string, address: string, uniqueid?: string}[]} discovered
 * @param {{address: string, uniqueid?: string}[]} [removed] Hosts the user removed.
 */
function merge(existing, discovered, removed = []) {
  const hosts = existing.map(host => ({...host}));

  for (const found of discovered) {
    const host = {...found, address: found.address.trim()};
    const known = [...hosts, ...removed].some(entry => sameHost(entry, host));
    if (known) continue;

    /** @type {{name: string, address: string, uniqueid?: string}} */
    const added = {name: host.name, address: host.address};
    if (host.uniqueid) added.uniqueid = host.uniqueid;
    hosts.push(added);
  }

  return hosts;
}

/**
 * One query, answers collected for `windowMs`, the socket closed after.
 * @param {{windowMs?: number, createSocket?: typeof dgram.createSocket}} [options]
 * @returns {Promise<{name: string, address: string, port: number}[]>}
 */
function discover({windowMs = 1500, createSocket = dgram.createSocket} = {}) {
  return new Promise(resolve => {
    const records = [];
    const socket = createSocket({type: 'udp4', reuseAddr: true});
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(candidates(records));
    };
    const timer = setTimeout(finish, windowMs);

    socket.on('error', finish);
    socket.on('message', message => {
      try {
        records.push(...parsePacket(message));
      } catch {}
    });

    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
      } catch {}
      socket.send(query(), MDNS_PORT, MDNS_ADDRESS, error => {
        if (error) finish();
      });
    });
  });
}

export {SERVICE, TYPE, query, parsePacket, candidates, merge, discover};
