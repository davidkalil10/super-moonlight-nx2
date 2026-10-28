// Helpers shared by the moonlight test files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = [];

test.after(() => {
  for (const directory of created) fs.rmSync(directory, {recursive: true, force: true});
});

/** A path to NAME in a fresh temp directory, removed after the file's tests. */
function tempFile(prefix, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return path.join(directory, name);
}

/**
 * The staggered counts without the pacer's read counters and the acquire and fetch waits, which
 * the fake device does not pin. EXCHANGE is the exchange bin that must carry a timing.
 */
const withoutPacer =
  exchange =>
  ({pacer, exchanges, acquireWaits, fetchWaits, ...counts}) => {
    assert.equal(typeof pacer.reads, 'number');
    assert.equal(typeof exchanges[exchange].ms, 'number');
    assert.deepEqual(Object.keys(acquireWaits), ['small', 'large']);
    assert.deepEqual(Object.keys(fetchWaits), ['small', 'large']);
    return counts;
  };

const uiPage = () => import('../ui/page.js');

/** An MSB-first bit writer for hand-built H.264 NAL units, with Exp-Golomb codes. */
function bitWriter() {
  const bits = [];
  const writer = {
    u(count, value) {
      for (let bit = count - 1; bit >= 0; bit--) bits.push(Math.floor(value / 2 ** bit) % 2);
      return writer;
    },
    ue(value) {
      const code = (value + 1).toString(2);
      return writer.u(code.length - 1, 0).u(code.length, value + 1);
    },
    se(value) {
      return writer.ue(value > 0 ? 2 * value - 1 : -2 * value);
    },
    /** The NAL unit: header, RBSP with stop bit and the emulation prevention bytes. */
    nal(header) {
      const rbsp = [...bits, 1];
      while (rbsp.length % 8) rbsp.push(0);

      const out = [header];
      let zeros = 0;
      for (let at = 0; at < rbsp.length; at += 8) {
        const byte = parseInt(rbsp.slice(at, at + 8).join(''), 2);
        if (zeros >= 2 && byte <= 3) {
          out.push(3);
          zeros = 0;
        }
        zeros = byte ? 0 : zeros + 1;
        out.push(byte);
      }

      return Buffer.from(out);
    }
  };
  return writer;
}

/** Eight scaling lists: the first present with a single delta of -8, the rest absent. */
function scalingLists(w) {
  for (let list = 0; list < 8; list++) {
    if (list === 0) w.u(1, 1).se(-8);
    else w.u(1, 0);
  }
}

/**
 * A 1920x1080 SPS NAL unit (7.3.2.1.1). `reorder` null leaves out bitstream_restriction,
 * `vui` false the whole VUI; `scaling` adds a scaling matrix, `hrd` NAL HRD parameters.
 */
function spsNal({
  profile = 100,
  constraints = 0,
  pocType = 0,
  vui = true,
  reorder = 0,
  scaling = false,
  hrd = false
} = {}) {
  const w = bitWriter().u(8, profile).u(8, constraints).u(8, 40).ue(0);
  if (profile === 100) {
    w.ue(1)
      .ue(0)
      .ue(0)
      .u(1, 0)
      .u(1, scaling ? 1 : 0);
    if (scaling) scalingLists(w);
  }

  w.ue(0).ue(pocType);
  if (pocType === 0) w.ue(2);
  if (pocType === 1) w.u(1, 0).se(0).se(0).ue(1).se(-2);
  w.ue(1).u(1, 0).ue(119).ue(67).u(1, 1).u(1, 1).u(1, 1).ue(0).ue(0).ue(0).ue(4);

  w.u(1, vui ? 1 : 0);
  if (!vui) return w.nal(0x67);

  w.u(1, 1).u(8, 255).u(16, 1).u(16, 1).u(1, 0);
  w.u(1, 1).u(3, 5).u(1, 0).u(1, 1).u(8, 1).u(8, 1).u(8, 1).u(1, 0);
  w.u(1, 1).u(32, 1).u(32, 120).u(1, 1);
  w.u(1, hrd ? 1 : 0);
  if (hrd) w.ue(0).u(4, 0).u(4, 0).ue(20000).ue(20000).u(1, 0).u(5, 23).u(5, 23).u(5, 23).u(5, 24);
  w.u(1, 0);
  if (hrd) w.u(1, 0);

  w.u(1, 0).u(1, reorder === null ? 0 : 1);
  if (reorder !== null)
    w.u(1, 1)
      .ue(2)
      .ue(1)
      .ue(16)
      .ue(16)
      .ue(reorder)
      .ue(reorder + 1);
  return w.nal(0x67);
}

/** A slice NAL unit header of `sliceType`: IDR for 2 or 7, else a reference slice. */
const sliceNal = sliceType =>
  bitWriter()
    .ue(0)
    .ue(sliceType)
    .ue(0)
    .nal(sliceType % 5 === 2 ? 0x65 : 0x41);

module.exports = {tempFile, withoutPacer, uiPage, bitWriter, spsNal, sliceNal};
