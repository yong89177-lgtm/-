#!/usr/bin/env node
/*
 * 관리자 비밀번호 설정/변경 스크립트.
 * 사용법: node set-password.js <아이디> <새비밀번호>
 * 예:     node set-password.js admin  MyNewPassword!23
 * 새 아이디를 지정하면 관리자 계정이 새로 추가된다(role: admin).
 * server.js가 이미 실행 중이라면 이 스크립트 실행 후 서버를 재시작해야 반영된다.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const PBKDF2_ITER = 100000;

function hashPw(pw, salt) {
  return crypto.pbkdf2Sync(String(pw), salt, PBKDF2_ITER, 32, "sha256").toString("hex");
}
function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

const [, , id, pw] = process.argv;
if (!id || !pw) {
  console.log("사용법: node set-password.js <아이디> <새비밀번호>");
  console.log("예:     node set-password.js admin  MyNewPassword!23");
  process.exit(1);
}
if (pw.length < 6) {
  console.log("비밀번호는 6자 이상으로 설정하세요.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
let store;
try {
  store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
} catch (e) {
  store = { accounts: [], requests: [] };
}
if (!Array.isArray(store.accounts)) store.accounts = [];
if (!Array.isArray(store.requests)) store.requests = [];

const salt = newSalt();
const hash = hashPw(pw, salt);
const existing = store.accounts.find((a) => a.id === id);
if (existing) {
  existing.salt = salt;
  existing.hash = hash;
  console.log(`기존 계정 '${id}'의 비밀번호를 변경했습니다.`);
} else {
  store.accounts.push({ id, role: "admin", salt, hash });
  console.log(`관리자 계정 '${id}'을(를) 새로 추가했습니다.`);
}
fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
console.log("server.js가 이미 실행 중이면 반드시 서버를 재시작하세요 (변경 사항은 재시작 후 적용됩니다).");
