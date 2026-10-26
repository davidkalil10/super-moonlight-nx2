const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../../../hbl-moonlight/tools/moonlight/ui-settings.js');

const created = [];
test.after(() => {
  for (const directory of created) fs.rmSync(directory, {recursive: true, force: true});
});
function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hbsettings-'));
  created.push(directory);
  return path.join(directory, 'settings.json');
}

test('defaults are the tested 1080p60 control shape', () => {
  const values = settings.defaults();
  assert.deepEqual(values, {
    size: '1920x1080',
    fps: 60,
    bitrate: 20,
    codec: 'h264',
    audio: 'stereo',
    quitOnReturn: false,
    optimise: false,
    presentHz: 60
  });
  assert.deepEqual(settings.streamArgs(values), [
    '--codec',
    'h264',
    '--size',
    '1920x1080',
    '--fps',
    '60',
    '--bitrate',
    '20000',
    '--staggered',
    '--socket-audio'
  ]);
});

test('load falls back per value for a missing, corrupt or out-of-range file', () => {
  assert.deepEqual(settings.load('/no/such/settings.json'), settings.defaults());
  const file = tempFile();
  fs.writeFileSync(file, 'nope');
  assert.deepEqual(settings.load(file), settings.defaults());
  fs.writeFileSync(file, JSON.stringify({fps: 30, bitrate: 7, size: '640x480', extra: 1}));
  assert.deepEqual(settings.load(file), {...settings.defaults(), fps: 30});
});

test('save then load round-trips and lives beside hosts.json', () => {
  const file = tempFile();
  const values = {...settings.defaults(), size: '1280x720', bitrate: 7.5, presentHz: 120};
  settings.save(file, values);
  assert.deepEqual(settings.load(file), values);
  assert.equal(path.basename(settings.settingsFile()), 'settings.json');
  assert.equal(path.basename(path.dirname(settings.settingsFile())), 'moonlight');
});

test('adjust steps without wrapping and leaves locked and unbacked rows alone', () => {
  let values = settings.defaults();
  values = settings.adjust(values, 'bitrate', 1);
  assert.equal(values.bitrate, 22.5);
  values = settings.adjust(values, 'fps', -1);
  assert.equal(values.fps, 30);
  assert.equal(settings.adjust(values, 'fps', -1), values, 'no wrap below the first value');
  values = settings.adjust(values, 'presentHz', 1);
  values = settings.adjust(values, 'presentHz', 1);
  assert.equal(values.presentHz, 120, 'no wrap above the last value');
  assert.equal(settings.adjust(values, 'codec', 1).codec, 'h264');
  assert.equal(settings.adjust(values, 'quitOnReturn', 1).quitOnReturn, false);
  assert.equal(settings.adjust(values, 'nothing', 1), values);
});

test('rows carry the value text and grey the unbacked toggles', () => {
  const rows = settings.rows({...settings.defaults(), presentHz: 120, bitrate: 7.5});
  assert.deepEqual(
    rows.map(row => [row.id, row.value, row.adjustable, row.greyed]),
    [
      ['size', '1920 × 1080', true, false],
      ['fps', '60 fps', true, false],
      ['bitrate', '7.5 Mbps', true, false],
      ['codec', 'H.264', false, false],
      ['audio', 'Stereo', false, false],
      ['quitOnReturn', 'Off', false, true],
      ['optimise', 'Off', false, true],
      ['presentHz', '120 Hz (experimental)', true, false]
    ]
  );
});

test('streamArgs adds the present rate only at 120 and keeps the bitrate in kbps', () => {
  const args = settings.streamArgs({...settings.defaults(), presentHz: 120, bitrate: 7.5});
  assert.deepEqual(args.slice(-2), ['--present-hz', '120']);
  assert.equal(args[args.indexOf('--bitrate') + 1], '7500');
  assert.ok(args.includes('--staggered'), 'present-hz needs the staggered form');
});
