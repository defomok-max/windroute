/**
 * Protobuf wire format codec — zero-dependency, schema-less.
 *
 * Wire types:
 *   0 = Varint    (int32, uint64, bool, enum)
 *   1 = Fixed64   (double, fixed64)
 *   2 = LenDelim  (string, bytes, embedded messages)
 *   5 = Fixed32   (float, fixed32)
 */

// ─── Varint ────────────────────────────────────────────────

/**
 * Encode a varint. Accepts Number, BigInt, or a string numeric literal.
 * Numbers above 2^53-1 MUST be passed as BigInt (request_id, token counts
 * from ModelUsageStats, etc.) — otherwise precision is lost silently.
 */
export function encodeVarint(value) {
  const bytes = [];
  // Normalise to BigInt internally so we can cover the full uint64 range.
  let big;
  if (typeof value === 'bigint') {
    big = value;
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`encodeVarint: non-finite value ${value}`);
    big = BigInt(Math.trunc(n));
  }
  // Two's-complement for negatives (protobuf spec: 10-byte varint).
  if (big < 0n) {
    big = big & 0xFFFFFFFFFFFFFFFFn;
  }
  do {
    let byte = Number(big & 0x7Fn);
    big >>= 7n;
    if (big > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (big > 0n);
  return Buffer.from(bytes);
}

/**
 * Decode a varint. Returns { value, length } where `value` is a Number for
 * inputs that fit in Number.MAX_SAFE_INTEGER, and a BigInt otherwise. Callers
 * that expect small counters (enum / bool / short ids) can `Number(v.value)`
 * without loss; callers reading uint64 token counts must handle BigInt.
 */
export function decodeVarint(buf, offset = 0) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7F) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
    if (shift >= 64n) throw new Error('Varint overflow');
  }
  const length = pos - offset;
  // Downcast to Number when it's safe; BigInt otherwise so we don't silently
  // truncate token counts or large request_ids.
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  if (result <= MAX_SAFE) {
    return { value: Number(result), length };
  }
  return { value: result, length };
}

// ─── Field-level writers (standalone functions) ────────────

function makeTag(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

/** Write a varint field (wire type 0). */
export function writeVarintField(field, value) {
  return Buffer.concat([makeTag(field, 0), encodeVarint(value)]);
}

/** Write a length-delimited string field (wire type 2). */
export function writeStringField(field, str) {
  if (!str && str !== '') return Buffer.alloc(0);
  const data = Buffer.from(str, 'utf-8');
  return Buffer.concat([makeTag(field, 2), encodeVarint(data.length), data]);
}

/** Write a length-delimited bytes field (wire type 2). */
export function writeBytesField(field, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([makeTag(field, 2), encodeVarint(buf.length), buf]);
}

/** Write an embedded message field (wire type 2). */
export function writeMessageField(field, msgBuf) {
  if (!msgBuf || msgBuf.length === 0) return Buffer.alloc(0);
  return Buffer.concat([makeTag(field, 2), encodeVarint(msgBuf.length), msgBuf]);
}

/** Write a fixed64 field (wire type 1). */
export function writeFixed64Field(field, buf8) {
  return Buffer.concat([makeTag(field, 1), buf8]);
}

/** Write a bool field (wire type 0), only if true. */
export function writeBoolField(field, value) {
  if (!value) return Buffer.alloc(0);
  return writeVarintField(field, 1);
}

// ─── Parser ────────────────────────────────────────────────

/**
 * Parse a protobuf buffer into an array of { field, wireType, value }.
 * For varint (0): value is a Number.
 * For lendelim (2): value is a Buffer (caller decides string vs message).
 * For fixed64 (1): value is an 8-byte Buffer.
 * For fixed32 (5): value is a 4-byte Buffer.
 */
export function parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos += tag.length;
    // Tags and lengths always fit in uint32 in practice — coerce BigInt (rare,
    // only on maliciously crafted input) to Number so bitwise ops work.
    const tagNum = typeof tag.value === 'bigint' ? Number(tag.value) : tag.value;
    const fieldNum = tagNum >>> 3;
    const wireType = tagNum & 0x07;

    let value;
    switch (wireType) {
      case 0: { // varint
        const v = decodeVarint(buf, pos);
        pos += v.length;
        value = v.value;
        break;
      }
      case 1: { // fixed64
        value = buf.subarray(pos, pos + 8);
        pos += 8;
        break;
      }
      case 2: { // length-delimited
        const len = decodeVarint(buf, pos);
        pos += len.length;
        const lenNum = typeof len.value === 'bigint' ? Number(len.value) : len.value;
        value = buf.subarray(pos, pos + lenNum);
        pos += lenNum;
        break;
      }
      case 5: { // fixed32
        value = buf.subarray(pos, pos + 4);
        pos += 4;
        break;
      }
      default:
        throw new Error(`Unknown wire type ${wireType} at offset ${pos}`);
    }
    fields.push({ field: fieldNum, wireType, value });
  }
  return fields;
}

/** Get first field matching number and optional wire type. */
export function getField(fields, num, wireType) {
  return fields.find(f => f.field === num && (wireType === undefined || f.wireType === wireType)) || null;
}

/** Get all fields matching number. */
export function getAllFields(fields, num) {
  return fields.filter(f => f.field === num);
}
