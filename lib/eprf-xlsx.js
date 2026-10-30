'use strict';
const zlib = require('zlib');
const fs = require('fs');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid EPRF template ZIP archive.');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014B50) throw new Error('Invalid EPRF template ZIP directory.');
    const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10);
    const time = buffer.readUInt16LE(p + 12), date = buffer.readUInt16LE(p + 14);
    const crc = buffer.readUInt32LE(p + 16), csize = buffer.readUInt32LE(p + 20), usize = buffer.readUInt32LE(p + 24);
    const nl = buffer.readUInt16LE(p + 28), el = buffer.readUInt16LE(p + 30), cl = buffer.readUInt16LE(p + 32);
    const external = buffer.readUInt32LE(p + 38), localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lp = localOffset;
    const lnl = buffer.readUInt16LE(lp + 26), lel = buffer.readUInt16LE(lp + 28);
    const dataStart = lp + 30 + lnl + lel;
    const compressed = buffer.subarray(dataStart, dataStart + csize);
    entries.push({ name, flags, method, time, date, crc, csize, usize, external, compressed });
    p += 46 + nl + el + cl;
  }
  return entries;
}
function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const method = data ? 8 : e.method;
    const compressed = data ? zlib.deflateRawSync(data) : e.compressed;
    const usize = data ? data.length : e.usize;
    const csize = compressed.length;
    const crc = data ? crc32(data) : e.crc;
    const flags = e.flags & ~0x0008;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(e.time, 10); local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(csize, 18); local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(e.time, 12); central.writeUInt16LE(e.date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(csize, 20); central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(e.external || 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + csize;
  }
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralData, end]);
}
function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function columnName(n) {
  let s = '';
  while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function rowCells(rowXml) {
  const result = {};
  for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = (m[1].match(/\br="([A-Z]+)\d+"/) || [])[1];
    if (ref) result[ref] = (m[1].match(/\bs="(\d+)"/) || [,''])[1];
  }
  return result;
}
function makeCell(col, row, style, value, numeric = false) {
  const s = style === '' ? '' : ` s="${style}"`;
  const ref = `${col}${row}`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${s}/>`;
  if (numeric) return `<c r="${ref}"${s}><v>${Number(value)}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}
function makeDataRow(row, styleRow, attendee, index) {
  const styles = rowCells(styleRow);
  let cells = '';
  for (let c = 1; c <= 23; c++) {
    const col = columnName(c), style = styles[col] ?? '';
    let value = '';
    if (c === 1) value = index + 1;
    if (c === 2) value = attendee.district;
    if (c === 3) value = attendee.full_name;
    if (c === 4) value = attendee.designation;
    if (c === 5) value = attendee.phone_number;
    cells += makeCell(col, row, style, value, c === 1);
  }
  return `<row r="${row}" spans="1:23" s="13" customFormat="1" ht="18.75" x14ac:dyDescent="0.25">${cells}</row>`;
}
function makeBlankRow(row, styleRow, hidden = true) {
  const styles = rowCells(styleRow);
  let cells = '';
  for (let c = 1; c <= 23; c++) {
    const col = columnName(c);
    cells += makeCell(col, row, styles[col] ?? '', '');
  }
  return `<row r="${row}" spans="1:23" s="13" customFormat="1" ht="18.75"${hidden ? ' hidden="1"' : ''} x14ac:dyDescent="0.25">${cells}</row>`;
}
function shiftReferences(xml, delta, fromRow) {
  if (!delta) return xml;
  xml = xml.replace(/<row r="(\d+)"/g, (m, n) => Number(n) >= fromRow ? `<row r="${Number(n) + delta}"` : m);
  return xml.replace(/\b([A-Z]{1,3})(\$?)(\d+)\b/g, (all, col, dollar, digits) => {
    const n = Number(digits);
    // Do not shift whole-column/full-sheet ranges (for example E1:E1048576).
    // Moving those past Excel's row limit corrupts conditional-formatting ranges.
    return n >= fromRow && n < 1048576 ? `${col}${dollar}${n + delta}` : all;
  });
}
function makeTotalRow(totalRowXml, count, targetRow) {
  const delta = targetRow - 59;
  let row = shiftReferences(totalRowXml, delta, 59);
  return row.replace(/<c r="B\d+"([^>]*)\/>/, (m, attrs) => `<c r="B${targetRow}"${attrs}><v>${count}</v></c>`)
    .replace(/<c r="B\d+"([^>]*)>([\s\S]*?)<\/c>/, (m, attrs) => `<c r="B${targetRow}"${attrs}><v>${count}</v></c>`);
}

function createEprfWorkbook(attendees, templatePath) {
  const template = fs.readFileSync(templatePath);
  const entries = readZip(template);
  const entry = entries.find(e => e.name === 'xl/worksheets/sheet1.xml');
  if (!entry) throw new Error('The EPRF template worksheet could not be found.');
  const xml = zlib.inflateRawSync(entry.compressed).toString('utf8');
  const dataMatch = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!dataMatch) throw new Error('The EPRF template does not contain a worksheet data section.');
  const rows = [...dataMatch[1].matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)].map(m => m[0]);
  const rowNumber = r => Number((r.match(/<row r="(\d+)"/) || [])[1]);
  const byNumber = new Map(rows.map(r => [rowNumber(r), r]));
  const styleRow = byNumber.get(8);
  const totalRow = byNumber.get(59);
  if (!styleRow || !totalRow) throw new Error('The EPRF template is missing its participant or Total row.');

  const count = attendees.length;
  const first = 8;
  const last = count ? first + count - 1 : first - 1;
  // The Total row always follows the final participant; the template's original
  // row 59 is only the source style/content, not a minimum participant capacity.
  const totalPosition = first + count;
  const delta = totalPosition - 59;

  const before = rows.filter(r => rowNumber(r) < 4);
  const tail = rows.filter(r => rowNumber(r) >= 60).map(r => shiftReferences(r, delta, 59));
  const hiddenRows = [4, 5, 6, 7].map(n => makeBlankRow(n, styleRow, true));
  const participantRows = attendees.map((a, i) => makeDataRow(first + i, styleRow, a, i));

  let total = makeTotalRow(totalRow, count, totalPosition);
  total = total.replace(/<f>SUM\(P\d+:P\d+\)<\/f>/, `<f>SUM(P${first}:P${last})</f>`);
  for (const col of ['Q', 'R', 'S']) {
    const re = new RegExp(`<f>SUBTOTAL\\(9,${col}\\d+:${col}\\d+\\)<\\/f>`);
    total = total.replace(re, `<f>SUBTOTAL(9,${col}${first}:${col}${last})</f>`);
  }

  const newRows = [...before, ...hiddenRows, ...participantRows, total, ...tail].join('');
  const dataStart = xml.indexOf('<sheetData>');
  const dataEnd = xml.indexOf('</sheetData>', dataStart) + '</sheetData>'.length;
  const prefix = xml.slice(0, dataStart);
  let suffix = xml.slice(dataEnd);
  suffix = shiftReferences(suffix, delta, 59);
  suffix = suffix.replace(/(<autoFilter ref="A3:W)\d+(")/, `$1${Math.max(3, last)}$2`);
  const updatedXml = `${prefix}<sheetData>${newRows}</sheetData>${suffix}`;
  entry.data = Buffer.from(updatedXml, 'utf8');
  return writeZip(entries);
}
module.exports = { createEprfWorkbook };
