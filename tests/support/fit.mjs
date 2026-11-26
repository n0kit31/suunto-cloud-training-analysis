function crc(contents) {
  let checksum = 0;
  for (const byte of contents) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xa001 : 0);
  }
  const result = Buffer.alloc(2);
  result.writeUInt16LE(checksum);
  return result;
}

function fields(entries) {
  return Buffer.concat(entries.map(([type, value]) => {
    const size = type === 'byte' ? 1 : type === 'short' ? 2 : 4;
    const result = Buffer.alloc(size);
    if (type === 'byte') result.writeUInt8(value);
    else if (type === 'short') result.writeUInt16LE(value);
    else if (type === 'signed') result.writeInt32LE(value);
    else result.writeUInt32LE(value);
    return result;
  }));
}

const byte = value => ['byte', value];
const short = value => ['short', value];
const unsigned = value => ['unsigned', value];
const signed = value => ['signed', value];

function definition(local, message, ...descriptions) {
  return Buffer.concat([fields([byte(0x40 | local), byte(0), byte(0), short(message), byte(descriptions.length)]),
    Buffer.from(descriptions.flat())]);
}

export function fitActivity({ start = 1_000_000_000, deviceModel, product, gps = false } = {}) {
  const timestamp = [253, 4, 0x86];
  const model = deviceModel ? Buffer.from(deviceModel + '\0') : null;
  const data = [];
  if (model || product !== undefined) {
    const name = model ? [[8, model.length, 7]] : [];
    data.push(definition(0, 0, [0, 1, 0], [1, 2, 0x84], [2, 2, 0x84], [4, 4, 0x86], ...name),
      fields([byte(0), byte(4), short(23), short(product ?? 1), unsigned(start)]));
    if (model) data.push(model);
  } else {
    data.push(definition(0, 0, [0, 1, 0], [4, 4, 0x86]), fields([byte(0), byte(4), unsigned(start)]));
  }
  data.push(definition(1, 21, timestamp, [0, 1, 0], [1, 1, 0]), fields([byte(1), unsigned(start), byte(0), byte(0)]));
  const coordinates = gps ? [[0, 4, 0x85], [1, 4, 0x85]] : [];
  data.push(definition(2, 20, timestamp, [3, 1, 2], [5, 4, 0x86], [6, 2, 0x84], ...coordinates));
  for (let second = 0; second <= 60; second++) {
    data.push(fields([byte(2), unsigned(start + second), byte(130 + second % 10), unsigned(second * 300), short(3000)]));
    if (gps) data.push(fields([signed(second * 10), signed(second * 100)]));
  }
  data.push(fields([byte(1), unsigned(start + 60), byte(0), byte(4)]));
  data.push(definition(3, 18, timestamp, [2, 4, 0x86], [5, 1, 0], [7, 4, 0x86],
    [8, 4, 0x86], [9, 4, 0x86], [16, 1, 2], [17, 1, 2]));
  data.push(fields([byte(3), unsigned(start + 60), unsigned(start), byte(1), unsigned(60000),
    unsigned(60000), unsigned(18000), byte(134), byte(139)]));
  const body = Buffer.concat(data);
  const header = Buffer.concat([fields([byte(14), byte(0x10), short(100), unsigned(body.length)]), Buffer.from('.FIT')]);
  return Buffer.concat([header, crc(header), body, crc(body)]);
}

export function corruptFit(fit) {
  const invalid = Buffer.from(fit);
  invalid[invalid.length - 1] ^= 0xff;
  return invalid;
}
