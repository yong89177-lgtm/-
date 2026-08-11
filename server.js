#!/usr/bin/env node
/*
 * MAPS — 최소 백엔드 (의존성 없음, Node 내장 모듈만 사용)
 *
 * "AI Agent 등록" 요청 -> 관리자 승인(1차 IT / 2차 적절성) -> 카테고리별 카드 생성 -> 카드 클릭 시
 * 업로드한 HTML Agent가 열리는 흐름만 실제로 동작하도록 구현한다.
 * 그 외 화면(계정관리/게시판/자료공유 등)은 기존 HTML의 오프라인(standalone) 폴백을 그대로 사용한다.
 *
 * 실행: node server.js   (기본 포트 8080, PORT 환경변수로 변경 가능)
 * 접속: http://<서버 IP>:8080/  ← 반드시 루트 경로로 접속해야 한다 (상대경로 fetch 때문).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { URL } = require("url");

const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, "MAPS 기존버전 (김동우 선임) 2.html");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- 계정 / 비밀번호 ---------- */
const PBKDF2_ITER = 100000;
function hashPw(pw, salt) {
  return crypto.pbkdf2Sync(String(pw), salt, PBKDF2_ITER, 32, "sha256").toString("hex");
}
function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function defaultStore() {
  const salt1 = newSalt(), salt2 = newSalt();
  return {
    /* admin      : 1차 IT 검토 담당(초기 비번 admin1234)
       admin2     : 2차 적절성 검토 담당(초기 비번 admin1234)
       운영 전에 반드시 비밀번호를 변경할 것 — /api/change-password 없음, data/store.json 직접 교체 또는 계정 추가 */
    accounts: [
      { id: "admin", role: "admin", salt: salt1, hash: hashPw("admin1234", salt1) },
      { id: "admin2", role: "admin", salt: salt2, hash: hashPw("admin1234", salt2) }
    ],
    requests: []
  };
}

let STORE;
function loadStore() {
  try {
    STORE = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!Array.isArray(STORE.accounts) || !STORE.accounts.length) STORE.accounts = defaultStore().accounts;
    if (!Array.isArray(STORE.requests)) STORE.requests = [];
  } catch (e) {
    STORE = defaultStore();
    saveStore();
  }
}
function saveStore() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(STORE, null, 2));
}
loadStore();

/* ---------- 세션 (메모리, 쿠키 기반) ---------- */
const SESSIONS = new Map(); // sid -> {id, role}
function newSid() {
  return crypto.randomBytes(24).toString("hex");
}
function parseCookies(req) {
  const h = req.headers.cookie || "";
  const out = {};
  h.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i < 0) return;
    const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function getSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  return SESSIONS.get(sid) || null;
}
function requireAdmin(req, res) {
  const s = getSession(req);
  if (!s || s.role !== "admin") {
    sendJson(res, 401, { ok: false, error: "관리자 로그인이 필요합니다." });
    return null;
  }
  return s;
}

function tsNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 공통 유틸 ---------- */
function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  }, extraHeaders || {}));
  res.end(body);
}
function readJsonBody(req, maxBytes, cb) {
  let total = 0, aborted = false;
  const chunks = [];
  req.on("data", (c) => {
    if (aborted) return;
    total += c.length;
    if (total > maxBytes) {
      aborted = true;
      req.destroy();
      cb(new Error("PAYLOAD_TOO_LARGE"));
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    if (!chunks.length) return cb(null, {});
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      cb(null, body ? JSON.parse(body) : {});
    } catch (e) {
      cb(e);
    }
  });
  req.on("error", (e) => { if (!aborted) cb(e); });
}

/* ---------- 카테고리별 기본(FALLBACK) 대시보드 데이터 ----------
   기존 HTML의 FALLBACK 상수와 동일하다 — 새 백엔드가 붙어도 기존 화면이 그대로 보이고,
   승인된 AI Agent 요청만 해당 카테고리 컬럼 끝에 카드로 추가된다. */
const BASE_COLUMNS = [
 {team:"新 공정/공법 개발",tag:"New Process & Method Development",items:[
  {name:"공정 조건 최적화 Agent",desc:"실험 데이터 기반 최적 조건 탐색",owner:"",addr:"",order:1,org:"전극기술그룹",likes:34},
  {name:"신공법 사례 조사 Agent",desc:"특허·논문에서 유사 공법 자동 수집",owner:"",addr:"",order:2,org:"전극기술그룹",likes:21},
  {name:"설비 사양 검토 Agent",desc:"신규 설비 요구사양 초안 작성",owner:"",addr:"",order:3,org:"파우치/각형기술그룹",likes:18},
  {name:"공법 변경 영향 예측",desc:"변경 시 품질·수율 파급 범위 추정",owner:"",addr:"",order:4,org:"원통형기술그룹",likes:27},
  {name:"파일럿 결과 요약 Agent",desc:"시험 로트 결과 자동 정리·비교",owner:"",addr:"",order:5,org:"파우치/각형기술그룹",likes:15},
  {name:"공정 표준서 초안 생성",desc:"검증 완료 조건을 표준 문서로 변환",owner:"",addr:"",order:6,org:"전극기술그룹",likes:9}]},
 {team:"해외법인 양산 지원",tag:"Overseas Plant Production Support",items:[
  {name:"해외법인 수율 모니터링",desc:"법인별 수율 추이·이상 구간 알림",owner:"",addr:"",order:1,org:"Pack기술그룹",likes:41},
  {name:"현지 이슈 원인분석 Agent",desc:"불량 발생 구간 역추적 · 원인 후보 제시",owner:"",addr:"",order:2,org:"원통형기술그룹",likes:38},
  {name:"설비 알람 대응 가이드",desc:"알람 이력 기반 조치 절차 자동 안내",owner:"",addr:"",order:3,org:"파우치/각형기술그룹",likes:24},
  {name:"양산 조건 이관 점검",desc:"국내 조건과 현지 조건 차이 자동 대조",owner:"",addr:"",order:4,org:"전극기술그룹",likes:17},
  {name:"현지 교육자료 생성 Agent",desc:"공정 문서를 현지어 교육안으로 변환",owner:"",addr:"",order:5,org:"인프라그룹",likes:12},
  {name:"법인 간 실적 비교",desc:"동일 공정 지표를 법인별로 정렬 비교",owner:"",addr:"",order:6,org:"Pack기술그룹",likes:8}]},
 {team:"제품 개발 대응",tag:"Product Development Response",items:[
  {name:"개발 요구사양 정리 Agent",desc:"고객 요구를 검증 항목으로 분해",owner:"",addr:"",order:1,org:"Pack기술그룹",likes:33},
  {name:"설계 변경 영향 분석",desc:"변경 파급 범위와 재검증 항목 자동 추적",owner:"",addr:"",order:2,org:"원통형기술그룹",likes:29},
  {name:"개발 일정 리스크 경보",desc:"마일스톤 지연 위험 사전 탐지",owner:"",addr:"",order:3,org:"Pack기술그룹",likes:22},
  {name:"시험 결과 판정 지원",desc:"규격 대비 합부 자동 판정 · 근거 제시",owner:"",addr:"",order:4,org:"파우치/각형기술그룹",likes:19},
  {name:"과거 개발 이력 검색",desc:"유사 과제의 판단 근거를 찾아 제시",owner:"",addr:"",order:5,org:"인프라그룹",likes:14}]},
 {team:"공통 및 루틴 업무",tag:"Common & Routine Operations",items:[
  {name:"회의록 자동 정리 Agent",desc:"녹취·메모를 결정사항과 액션으로 분리",owner:"",addr:"",order:1,org:"인프라그룹",likes:45},
  {name:"보고서 초안 생성 Agent",desc:"데이터에서 주간·월간 보고 초안 작성",owner:"",addr:"",order:2,org:"인프라그룹",likes:36},
  {name:"사내 문서 통합 검색",desc:"흩어진 규정·표준·보고서를 한 번에 검색",owner:"",addr:"",order:3,org:"인프라그룹",likes:31},
  {name:"데이터 취합 자동화",desc:"반복 집계 작업을 정해진 양식으로 출력",owner:"",addr:"",order:4,org:"Pack기술그룹",likes:26},
  {name:"번역·요약 지원 Agent",desc:"기술 문서 번역과 핵심 요약",owner:"",addr:"",order:5,org:"인프라그룹",likes:20}]}
];
const COLUMN_TEAMS = BASE_COLUMNS.map((c) => c.team);
function norm(s) {
  return String(s || "").replace(/\s+/g, "");
}
function pickCategory(features) {
  const arr = Array.isArray(features) ? features : [];
  for (const f of arr) {
    const hit = COLUMN_TEAMS.find((t) => norm(t) === norm(f));
    if (hit) return hit;
  }
  return "공통 및 루틴 업무";
}
function buildDashboards(origin) {
  const cols = BASE_COLUMNS.map((c) => ({ team: c.team, tag: c.tag, items: c.items.map((it) => Object.assign({}, it)) }));
  const byTeam = {};
  cols.forEach((c) => { byTeam[c.team] = c; });
  const approved = STORE.requests
    .filter((q) => q.status === "approved")
    .sort((a, b) => (a.approvedAt || 0) - (b.approvedAt || 0));
  approved.forEach((q) => {
    const col = byTeam[q.category] || byTeam["공통 및 루틴 업무"];
    const maxOrder = col.items.reduce((m, it) => Math.max(m, it.order || 0), 0);
    col.items.push({
      name: q.name,
      desc: q.desc || "",
      owner: q.requesterName || "",
      addr: q.hasFile ? origin + "/api/agent-file?id=" + encodeURIComponent(q.id) : "",
      order: maxOrder + 1,
      org: q.org || "",
      likes: 0
    });
  });
  return { columns: cols };
}

/* ---------- 관리자 화면에 보낼 요청 필드 정리 ---------- */
function sanitizeReq(q) {
  return {
    id: q.id, name: q.name, desc: q.desc, features: q.features,
    org: q.org, team: q.team, file: q.hasFile,
    requester: q.requester, requesterName: q.requesterName, requesterOrg: q.requesterOrg,
    ts: q.ts, status: q.status, stage1: q.stage1, stage2: q.stage2
  };
}

/* ---------- 라우팅 ---------- */
const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  } catch (e) {
    res.writeHead(400); res.end("Bad Request"); return;
  }
  const p = u.pathname;
  const method = req.method;
  const origin = "http://" + (req.headers.host || "localhost");

  try {
    if (method === "GET" && (p === "/" || p === "/index.html")) {
      fs.readFile(HTML_FILE, (err, buf) => {
        if (err) { res.writeHead(500); res.end("페이지를 불러올 수 없습니다."); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buf);
      });
      return;
    }

    if (method === "GET" && p === "/data/dashboards.json") {
      sendJson(res, 200, buildDashboards(origin));
      return;
    }

    if (p === "/api/me" && method === "GET") {
      const s = getSession(req);
      sendJson(res, 200, s ? { auth: true, id: s.id, role: s.role } : { auth: false });
      return;
    }

    if (p === "/api/login" && method === "POST") {
      readJsonBody(req, 10 * 1024, (err, body) => {
        if (err) return sendJson(res, 400, { ok: false, error: "잘못된 요청입니다." });
        const id = String(body.id || "").trim(), pw = body.pw || "";
        const acc = STORE.accounts.find((a) => a.id === id);
        if (!acc || hashPw(pw, acc.salt) !== acc.hash) {
          return sendJson(res, 401, { ok: false, error: "아이디 또는 비밀번호가 올바르지 않습니다." });
        }
        const sid = newSid();
        SESSIONS.set(sid, { id: acc.id, role: acc.role });
        sendJson(res, 200, { ok: true, id: acc.id, role: acc.role }, { "Set-Cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      });
      return;
    }

    if (p === "/api/logout" && method === "POST") {
      const sid = parseCookies(req).sid;
      if (sid) SESSIONS.delete(sid);
      sendJson(res, 200, { ok: true }, { "Set-Cookie": "sid=; Path=/; HttpOnly; Max-Age=0" });
      return;
    }

    if (p === "/api/dash-request" && method === "POST") {
      readJsonBody(req, 60 * 1024 * 1024, (err, body) => {
        if (err) {
          if (err.message === "PAYLOAD_TOO_LARGE") return sendJson(res, 413, { ok: false, error: "업로드한 파일이 너무 큽니다." });
          return sendJson(res, 400, { ok: false, error: "잘못된 요청입니다." });
        }
        const name = String(body.name || "").trim();
        if (!name) return sendJson(res, 400, { ok: false, error: "대시보드명을 입력하세요." });
        const id = "req_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const features = Array.isArray(body.features) ? body.features.filter(Boolean) : [];
        const author = String(body.author || "").trim();
        const org = String(body.org || "").trim();
        let hasFile = false, fname = "";
        if (body.html && body.fname) {
          try {
            fs.writeFileSync(path.join(UPLOAD_DIR, id + ".html"), String(body.html), "utf8");
            hasFile = true;
            fname = String(body.fname);
          } catch (e) { hasFile = false; }
        }
        const q = {
          id, name, author,
          requester: author, requesterName: author, requesterOrg: org,
          org, team: String(body.team || "").trim(), desc: String(body.desc || "").trim(),
          features, etc: body.etc || "", category: pickCategory(features),
          fname, hasFile, ts: tsNow(), createdAt: Date.now(), status: "pending"
        };
        STORE.requests.push(q);
        saveStore();
        sendJson(res, 200, { ok: true, id });
      });
      return;
    }

    if (p === "/api/dash-requests" && method === "GET") {
      const s = requireAdmin(req, res); if (!s) return;
      const items = STORE.requests.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(sanitizeReq);
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (p === "/api/request-status" && method === "GET") {
      const s = requireAdmin(req, res); if (!s) return;
      const items = STORE.requests.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(sanitizeReq);
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (p === "/api/approve-dash-request" && method === "POST") {
      const s = requireAdmin(req, res); if (!s) return;
      readJsonBody(req, 10 * 1024, (err, body) => {
        if (err) return sendJson(res, 400, { ok: false, error: "잘못된 요청입니다." });
        const id = body.id, approve = !!body.approve, reason = String(body.reason || "").trim();
        const q = STORE.requests.find((r) => r.id === id);
        if (!q) return sendJson(res, 404, { ok: false, error: "요청을 찾을 수 없습니다." });
        if (q.status === "pending") {
          q.stage1 = { by: s.id, ts: tsNow(), decision: approve ? "approved" : "rejected", reason };
          q.status = approve ? "it_approved" : "rejected";
        } else if (q.status === "it_approved") {
          q.stage2 = { by: s.id, ts: tsNow(), decision: approve ? "approved" : "rejected", reason };
          q.status = approve ? "approved" : "rejected";
          if (approve) q.approvedAt = Date.now();
        } else {
          return sendJson(res, 400, { ok: false, error: "이미 처리된 요청입니다." });
        }
        saveStore();
        sendJson(res, 200, { ok: true });
      });
      return;
    }

    if (p === "/api/dash-request-cancel" && method === "POST") {
      const s = requireAdmin(req, res); if (!s) return;
      readJsonBody(req, 1024, (err, body) => {
        if (err) return sendJson(res, 400, { ok: false, error: "잘못된 요청입니다." });
        const idx = STORE.requests.findIndex((r) => r.id === body.id);
        if (idx < 0) return sendJson(res, 404, { ok: false, error: "요청을 찾을 수 없습니다." });
        const [removed] = STORE.requests.splice(idx, 1);
        try { fs.unlinkSync(path.join(UPLOAD_DIR, removed.id + ".html")); } catch (e) {}
        saveStore();
        sendJson(res, 200, { ok: true });
      });
      return;
    }

    if (p === "/api/req-file" && method === "GET") {
      const s = requireAdmin(req, res); if (!s) return;
      const id = u.searchParams.get("id") || "";
      const q = STORE.requests.find((r) => r.id === id);
      if (!q || !q.hasFile) { res.writeHead(404); res.end("Not found"); return; }
      fs.readFile(path.join(UPLOAD_DIR, id + ".html"), (err, buf) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        const safeName = encodeURIComponent(q.fname || ("agent_" + id + ".html"));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${safeName}`
        });
        res.end(buf);
      });
      return;
    }

    if (p === "/api/agent-file" && method === "GET") {
      const id = u.searchParams.get("id") || "";
      const q = STORE.requests.find((r) => r.id === id && r.status === "approved");
      if (!q || !q.hasFile) { res.writeHead(404); res.end("Not found"); return; }
      fs.readFile(path.join(UPLOAD_DIR, id + ".html"), (err, buf) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buf);
      });
      return;
    }

    if (p === "/api/admin-notifications" && method === "GET") {
      const s = requireAdmin(req, res); if (!s) return;
      const requestsPending = STORE.requests.filter((r) => r.status === "pending" || r.status === "it_approved").length;
      sendJson(res, 200, { ok: true, accounts: 0, requests: requestsPending });
      return;
    }

    if (p === "/api/pending-accounts" && method === "GET") {
      const s = requireAdmin(req, res); if (!s) return;
      sendJson(res, 200, { ok: true, items: [] });
      return;
    }

    if (p.indexOf("/api/") === 0) {
      sendJson(res, 404, { ok: false, error: "Not Found" });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "서버 오류가 발생했습니다." });
  }
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`MAPS 백엔드 실행 중 — 이 PC에서는 http://localhost:${PORT}/ 로 접속하세요.`);
  const ips = lanAddresses();
  if (ips.length) {
    console.log(`같은 사내망의 다른 사람은 아래 주소로 접속할 수 있습니다 (방화벽에서 포트 ${PORT}를 허용해야 합니다):`);
    ips.forEach((ip) => console.log(`  http://${ip}:${PORT}/`));
  } else {
    console.log(`이 PC의 네트워크 IP를 찾지 못했습니다 — cmd에서 ipconfig 로 IPv4 주소를 확인해 http://<IP>:${PORT}/ 로 안내하세요.`);
  }
  console.log(`관리자 계정: admin / admin1234 (1차 IT 검토), admin2 / admin1234 (2차 적절성 검토) — 운영 전 비밀번호를 변경하세요.`);
});
