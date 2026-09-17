import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const within = (root, file) => file === root || file.startsWith(root + path.sep);

// Directory links are never followed. Every opened file is checked again so a
// configured folder cannot be used to reach a different private folder.
export async function listJSONL(root, { maxFiles = 10000, maxDepth = 16, expectedRoot } = {}) {
  const canonical = await fs.realpath(root);
  if (expectedRoot && canonical !== path.resolve(expectedRoot)) throw new Error('来源目录已被重定向，请重新检查连接配置');
  const files = [], warnings = [];
  async function visit(dir, depth) {
    if (depth > maxDepth) { warnings.push('目录层级超过读取上限'); return; }
    if (!within(canonical, await fs.realpath(dir))) { warnings.push('已跳过范围外目录'); return; }
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) { warnings.push('文件数量超过读取上限，请缩小范围'); return; }
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { warnings.push('已跳过符号链接'); continue; }
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  }
  const info = await fs.stat(canonical);
  if (!info.isDirectory()) throw new Error('数据位置必须是目录');
  await visit(canonical, 0);
  return { root: canonical, files, warnings: [...new Set(warnings)] };
}

// Cursor offsets count bytes, not JS characters. An incomplete line (including
// an incomplete UTF-8 codepoint) remains raw bytes until the next complete LF.
export async function readJSONL(file, root, previous, makeState, reduce, { maxBytes = 64 * 1024 * 1024, maxLineBytes = 8 * 1024 * 1024, expectedRoot } = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('单行大小限制必须是正整数');
  const real = await fs.realpath(file);
  const canonicalRoot = await fs.realpath(root);
  if (expectedRoot && canonicalRoot !== path.resolve(expectedRoot)) throw new Error('来源目录已被重定向，请重新检查连接配置');
  if (!within(canonicalRoot, real)) throw new Error('文件超出已配置的数据范围');
  const handle = await fs.open(real, 'r');
  try {
    if (!within(canonicalRoot, await fs.realpath(real))) throw new Error('文件超出已配置的数据范围');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('仅支持普通 JSONL 文件');
    const fingerprint = async (position, size) => {
      const bytes = Buffer.alloc(size); const result = await handle.read(bytes, 0, size, position);
      return createHash('sha256').update(bytes.subarray(0, result.bytesRead)).digest('hex');
    };
    let replaced = !previous || previous.dev !== stat.dev || previous.ino !== stat.ino || stat.size < previous.offset ||
      (stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs);
    // Copying a longer replacement over a file may preserve its inode. Check
    // small anchors rather than treating every increase in size as an append.
    if (!replaced && previous.anchors) for (const anchor of previous.anchors) {
      if (await fingerprint(anchor.position, anchor.size) !== anchor.hash) { replaced = true; break; }
    }
    const cursor = replaced ? { offset: 0, tail: '', line: 0, badLines: 0, oversizedLines: 0, droppingOversizedLine: false, state: makeState() } : structuredClone(previous);
    let carry = Buffer.from(cursor.tail || '', 'base64'), read = 0;
    cursor.oversizedLines ||= 0;
    cursor.droppingOversizedLine = cursor.droppingOversizedLine === true;
    if (cursor.droppingOversizedLine) carry = Buffer.alloc(0);
    else if (carry.length > maxLineBytes) {
      cursor.oversizedLines++; cursor.droppingOversizedLine = true; carry = Buffer.alloc(0);
    }
    const warnings = [];
    while (cursor.offset < stat.size && read < maxBytes) {
      const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - cursor.offset, maxBytes - read));
      const result = await handle.read(buffer, 0, buffer.length, cursor.offset);
      if (!result.bytesRead) break;
      cursor.offset += result.bytesRead; read += result.bytesRead;
      const chunk = Buffer.concat([carry, buffer.subarray(0, result.bytesRead)]);
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const line = chunk.subarray(start, end); start = end + 1; cursor.line++;
        if (cursor.droppingOversizedLine) { cursor.droppingOversizedLine = false; continue; }
        if (line.length > maxLineBytes) { cursor.oversizedLines++; continue; }
        if (!line.length) continue;
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
          const value = JSON.parse(text);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid line');
          reduce(cursor.state, value);
        } catch { cursor.badLines++; }
      }
      const tail = chunk.subarray(start);
      if (cursor.droppingOversizedLine) carry = Buffer.alloc(0);
      else if (tail.length > maxLineBytes) {
        // Image/tool payloads may span several reads or sync budgets. Discard
        // all their bytes until LF, persisting only this flag and byte offset.
        cursor.oversizedLines++; cursor.droppingOversizedLine = true; carry = Buffer.alloc(0);
      } else carry = tail;
    }
    if (cursor.badLines) warnings.push(`${cursor.badLines} 行无法解析，已继续读取其他行`);
    if (cursor.oversizedLines) {
      const limit = maxLineBytes % (1024 * 1024) === 0 ? `${maxLineBytes / (1024 * 1024)} MB` : `${maxLineBytes} 字节`;
      warnings.push(`${cursor.oversizedLines} 行超过 ${limit}，已跳过超长内容并继续读取其他消息`);
    }
    if (cursor.offset < stat.size) warnings.push('大文件尚未读完，下次同步继续');
    const anchorSize = Math.min(512, cursor.offset);
    const positions = [...new Set([0, Math.max(0, cursor.offset - anchorSize)])];
    const anchors = await Promise.all(positions.map(async position => ({ position, size: anchorSize, hash: await fingerprint(position, anchorSize) })));
    Object.assign(cursor, { tail: carry.toString('base64'), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, anchors });
    return { cursor, warnings };
  } finally { await handle.close(); }
}
