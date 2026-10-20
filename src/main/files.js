// 코드 화면용 파일 작업: 폴더 목록, 읽기/쓰기, 새로 만들기, 이름 변경, 휴지통으로 삭제
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const HIDDEN = new Set(['.git']);

function list(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => {
      const p = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {}
      }
      return { name: e.name, path: p, dir: isDir };
    })
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function read(p) {
  const st = fs.statSync(p);
  if (st.size > MAX_EDIT_BYTES) return { tooLarge: true, size: st.size, mtime: st.mtimeMs };
  const buf = fs.readFileSync(p);
  if (isBinary(buf)) return { binary: true, size: st.size, mtime: st.mtimeMs };
  let text = buf.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = /\r\n/.test(text.slice(0, 20000)) ? 'CRLF' : 'LF';
  return { text, bom, eol, mtime: st.mtimeMs, size: st.size };
}

function write(p, text, { bom } = {}) {
  fs.writeFileSync(p, (bom ? '﻿' : '') + text, 'utf8');
  return fs.statSync(p).mtimeMs;
}

function stat(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, mtime: st.mtimeMs, dir: st.isDirectory() };
  } catch {
    return { exists: false };
  }
}

function createFile(p) {
  if (fs.existsSync(p)) throw new Error('같은 이름의 파일이 이미 있습니다.');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
}

function createFolder(p) {
  if (fs.existsSync(p)) throw new Error('같은 이름의 폴더가 이미 있습니다.');
  fs.mkdirSync(p, { recursive: true });
}

function rename(from, to) {
  if (fs.existsSync(to)) throw new Error('같은 이름이 이미 있습니다.');
  fs.renameSync(from, to);
}

async function trash(p) {
  await shell.trashItem(p);
}

module.exports = { list, read, write, stat, createFile, createFolder, rename, trash };
