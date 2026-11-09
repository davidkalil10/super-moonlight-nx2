const fs = require('node:fs');
const Module = require('node:module');

const output = process.env.NS2_HELLO_TRACE_FILE;
const load = Module._load;
const traced = new WeakSet();
const installed = new WeakSet();

if (output) Module._load = function (name, ...args) {
  const result = load.call(this, name, ...args);
  if (!name.endsWith('/connection.cjs') || !result.Connection || installed.has(result.Connection)) return result;
  installed.add(result.Connection);
  const read = result.Connection.prototype.read;
  result.Connection.prototype.read = function (size) {
    const response = read.call(this, size);
    if (size !== result.HELLO_BYTES || traced.has(this)) return response;
    traced.add(this);
    return response.then(bytes => {
      const record = {time: new Date().toISOString(), bytes: bytes.toString('hex')};
      try { record.addresses = result.parseHello(bytes); }
      catch (error) { record.error = error.message; }
      fs.appendFileSync(output, JSON.stringify(record) + '\n', {mode: 0o600});
      return bytes;
    }, error => {
      const record = {time: new Date().toISOString(), error: error.message,
        partialBytes: this.buffer.subarray(0, result.HELLO_BYTES).toString('hex')};
      fs.appendFileSync(output, JSON.stringify(record) + '\n', {mode: 0o600});
      throw error;
    });
  };
  return result;
};
