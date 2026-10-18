// SVPX 容器：deflate-raw + 单层 XOR，防简单扫描（混淆非加密）
// 布局：magic "SVPX"(4B) + ver(1B) + key(16B, 每版随机轮换) + XOR(deflate-raw(json))
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('SVPX');
const VERSION = 1;
const KEY_LEN = 16;

/** items: { [category]: string[] } → Buffer */
export function pack(items) {
  const data = deflateRawSync(JSON.stringify({ v: VERSION, items }), { level: 9 });
  const key = randomBytes(KEY_LEN);
  for (let i = 0; i < data.length; i++) data[i] ^= key[i % KEY_LEN];
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), key, data]);
}

/** Buffer → { v, items } */
export function unpack(buf) {
  if (buf.length < 21 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('bad magic');
  const ver = buf[4];
  if (ver !== VERSION) throw new Error(`unsupported version ${ver}`);
  const key = buf.subarray(5, 5 + KEY_LEN);
  const data = Buffer.from(buf.subarray(5 + KEY_LEN)); // copy 后原地 XOR
  for (let i = 0; i < data.length; i++) data[i] ^= key[i % KEY_LEN];
  return JSON.parse(inflateRawSync(data).toString('utf8'));
}
