"use strict";
/* ====================================================================== *
 *  panel WALENCYA  —  premium multi-protocol proxy panel for KataBump     *
 *  Two-file edition: index.js + package.json  (no npm dependencies)       *
 *                                                                        *
 *  What this file does                                                   *
 *   1. opens the public port immediately (KataBump needs a listener)     *
 *   2. downloads the panel engine + Xray-core on first boot              *
 *   3. runs the engine on loopback and re-skins it on the fly (brand,    *
 *      theme, login, subscription page) through a rewriting proxy        *
 *   4. auto-provisions hosts / inbounds / client / subscription          *
 *   5. multiplexes everything on ONE port:                               *
 *        TLS ClientHello  -> REALITY inbound                             *
 *        WebSocket paths  -> VLESS / VMess / Trojan WS inbounds          *
 *        everything else  -> WALENCYA panel + subscription pages         *
 * ====================================================================== */

const net = require("net");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { Writable } = require("stream");

/* ------------------------------ config ------------------------------ */
const BRAND = "WALENCYA";
const XUI_VERSION = process.env.WALENCYA_ENGINE_VERSION || "v3.10.2";
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const PUBLIC_PORT = int(process.env.SERVER_PORT || process.env.PORT, 3000);
const ROOT = process.env.KATABUMP_ROOT || process.env.KATABUMP_DIR || process.cwd();
const BASE = path.join(ROOT, "walencya");
const ENGINE_DIR = path.join(BASE, "engine");
const DATA_DIR = path.join(BASE, "data");
const LOG_DIR = path.join(BASE, "log");
const STATE_FILE = path.join(BASE, "state.json");
const CRED_FILE = path.join(BASE, "PANEL.txt");

const HTTP_PORT = int(process.env.WALENCYA_HTTP_PORT, 21080);
const PANEL_PORT = int(process.env.WALENCYA_PANEL_PORT, 21053);
const SUB_PORT = int(process.env.WALENCYA_SUB_PORT, 21090);
const P_VLESS = 21001, P_VMESS = 21002, P_TROJAN = 21003, P_REALITY = 21004;
const PATH_VLESS = "/wl-vless", PATH_VMESS = "/wl-vmess", PATH_TROJAN = "/wl-trojan";
const WS_ROUTES = { [PATH_VLESS]: P_VLESS, [PATH_VMESS]: P_VMESS, [PATH_TROJAN]: P_TROJAN };

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ENV_PASS = process.env.ADMIN_PASS || "";
const REALITY_TARGET = process.env.WALENCYA_REALITY_TARGET || "www.speedtest.net:443";
const REALITY_SNI = process.env.WALENCYA_REALITY_SNI || REALITY_TARGET.split(":")[0];
const WS_HOST_HEADER = process.env.WALENCYA_WS_HOST || "";
const PUBLIC_HOST_ENV = (process.env.WALENCYA_PUBLIC_HOST || "").trim();

/* ------------------------------ helpers ----------------------------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") => {
  const b = crypto.randomBytes(n); let s = "";
  for (let i = 0; i < n; i++) s += alphabet[b[i] % alphabet.length];
  return s;
};
const mkdirp = (d) => fs.mkdirSync(d, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const writeJson = (f, o) => { mkdirp(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const STATE = { phase: "boot", message: "Starting…", ready: false, publicHost: null, steps: [], error: null };
const saved = readJson(STATE_FILE, {});
const saveState = (patch) => { Object.assign(saved, patch); try { writeJson(STATE_FILE, saved); } catch (e) {} };
const log = (...a) => console.log(`[${BRAND}]`, ...a);
function setPhase(phase, message) {
  STATE.phase = phase; STATE.message = message;
  STATE.steps.push({ t: Date.now(), phase, message });
  if (STATE.steps.length > 40) STATE.steps.shift();
  log(message);
}
const etag = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

/* ------------------------ embedded front-end assets ----------------------- */
let THEME_CSS = "/* ============ WALENCYA theme — \"Aurora Glass\" ============ */\n:root{--w-v:#8b6cff;--w-c:#22d3ee;--w-p:#f472b6;--w-grad:linear-gradient(135deg,#8b6cff 0%,#5b8cff 52%,#22d3ee 100%);--w-font:\"Inter\",\"Segoe UI\",\"Vazirmatn\",\"SF Pro Text\",Tahoma,system-ui,-apple-system,sans-serif}\nhtml,body,#app{font-family:var(--w-font)!important;-webkit-font-smoothing:antialiased}\nbody{min-height:100vh}\nbody.dark{background:#07071a!important;color:#ecebff}\nbody.light{background:#f1efff!important;color:#1c1840}\nbody::before,body::after{content:\"\";position:fixed;z-index:0;pointer-events:none;border-radius:50%;filter:blur(90px);opacity:.55}\nbody::before{width:620px;height:620px;left:-160px;top:-180px;background:radial-gradient(circle,rgba(139,108,255,.55),transparent 70%);animation:wal-float 18s ease-in-out infinite alternate}\nbody::after{width:560px;height:560px;right:-140px;bottom:-160px;background:radial-gradient(circle,rgba(34,211,238,.42),transparent 70%);animation:wal-float 22s ease-in-out infinite alternate-reverse}\nbody.light::before{opacity:.45}body.light::after{opacity:.4}\nhtml[data-theme='ultra-dark'] body.dark{background:#02020a!important}\nhtml[data-theme='ultra-dark'] body::before,html[data-theme='ultra-dark'] body::after{opacity:.28}\n@keyframes wal-float{to{transform:translate(60px,40px) scale(1.15)}}\n#app,#message{position:relative;z-index:1}\n\n/* ---------- design tokens (antd css-vars live on .xui) ---------- */\nbody.dark .xui{\n --ant-color-primary:#8b6cff;--ant-color-primary-hover:#a58bff;--ant-color-primary-active:#7653f0;\n --ant-color-primary-bg:rgba(139,108,255,.16);--ant-color-primary-bg-hover:rgba(139,108,255,.26);\n --ant-color-primary-border:#5b44c4;--ant-color-primary-border-hover:#8b6cff;\n --ant-color-primary-text:#b3a0ff;--ant-color-primary-text-hover:#c9baff;--ant-color-primary-text-active:#8b6cff;\n --ant-color-link:#5eead4;--ant-color-link-hover:#99f6e4;--ant-color-link-active:#2dd4bf;\n --ant-color-info:#8b6cff;--ant-color-success:#34d399;--ant-color-warning:#fbbf24;--ant-color-error:#fb7185;\n --ant-color-bg-layout:transparent;--ant-color-bg-container:rgba(255,255,255,.045);--ant-color-bg-elevated:#17173a;--ant-color-bg-spotlight:#23235a;\n --ant-color-border:rgba(255,255,255,.14);--ant-color-border-secondary:rgba(255,255,255,.08);\n --ant-color-split:rgba(255,255,255,.08);\n --ant-color-text:#eeedff;--ant-color-text-secondary:rgba(224,222,255,.7);--ant-color-text-tertiary:rgba(224,222,255,.5);--ant-color-text-quaternary:rgba(224,222,255,.32);--ant-color-text-description:rgba(224,222,255,.55);\n --ant-color-fill:rgba(139,108,255,.22);--ant-color-fill-secondary:rgba(139,108,255,.14);--ant-color-fill-tertiary:rgba(255,255,255,.07);--ant-color-fill-quaternary:rgba(255,255,255,.04);\n --ant-border-radius:12px;--ant-border-radius-lg:18px;--ant-border-radius-sm:9px;--ant-border-radius-xs:6px;\n --bg-page:transparent;--bg-card:rgba(255,255,255,.045)}\nbody.light .xui{\n --ant-color-primary:#6d4aff;--ant-color-primary-hover:#8566ff;--ant-color-primary-active:#5836e0;\n --ant-color-primary-bg:rgba(109,74,255,.1);--ant-color-primary-bg-hover:rgba(109,74,255,.18);\n --ant-color-primary-border:#bfb0ff;--ant-color-primary-border-hover:#8566ff;\n --ant-color-primary-text:#6d4aff;--ant-color-primary-text-hover:#8566ff;--ant-color-primary-text-active:#5836e0;\n --ant-color-link:#0e9aae;--ant-color-link-hover:#12b5cc;--ant-color-link-active:#0b7f90;\n --ant-color-info:#6d4aff;--ant-color-success:#10b981;--ant-color-warning:#f59e0b;--ant-color-error:#e11d48;\n --ant-color-bg-layout:transparent;--ant-color-bg-container:rgba(255,255,255,.72);--ant-color-bg-elevated:#fff;\n --ant-color-border:rgba(60,40,140,.18);--ant-color-border-secondary:rgba(60,40,140,.1);--ant-color-split:rgba(60,40,140,.1);\n --ant-color-text:#1c1840;--ant-color-text-secondary:rgba(28,24,64,.7);--ant-color-text-tertiary:rgba(28,24,64,.52);--ant-color-text-quaternary:rgba(28,24,64,.34);--ant-color-text-description:rgba(28,24,64,.56);\n --ant-color-fill:rgba(109,74,255,.16);--ant-color-fill-secondary:rgba(109,74,255,.1);--ant-color-fill-tertiary:rgba(109,74,255,.07);--ant-color-fill-quaternary:rgba(109,74,255,.04);\n --ant-border-radius:12px;--ant-border-radius-lg:18px;--ant-border-radius-sm:9px;--ant-border-radius-xs:6px;\n --bg-page:transparent;--bg-card:rgba(255,255,255,.72)}\n\n/* ---------- page shell ---------- */\n.index-page,.clients-page,.inbounds-page,.xray-page,.settings-page,.nodes-page,.groups-page,.api-docs-page,.sponsors-page,.hosts-page,\n.ant-layout,.ant-layout-content,.content-shell{background:transparent!important}\n.content-area{padding:22px 26px 40px!important}\n@media(max-width:768px){.content-area{padding:12px 10px 40px!important}}\n\n/* ---------- sidebar: floating glass dock ---------- */\n.ant-sidebar{flex:0 0 calc(var(--sider-rail,72px) + 22px)!important;width:calc(var(--sider-rail,72px) + 22px)!important}\n.ant-sidebar>.ant-layout-sider{top:12px!important;height:calc(100vh - 24px)!important;margin-left:12px;border-radius:24px;overflow:hidden;\n background:linear-gradient(180deg,rgba(139,108,255,.16),rgba(34,211,238,.06) 60%,rgba(255,255,255,.03))!important;\n border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);\n box-shadow:0 20px 60px rgba(8,6,40,.55),inset 0 1px 0 rgba(255,255,255,.08)}\nbody.light .ant-sidebar>.ant-layout-sider{background:linear-gradient(180deg,rgba(255,255,255,.9),rgba(235,230,255,.75))!important;border-color:rgba(109,74,255,.16);box-shadow:0 18px 50px rgba(80,50,200,.16)}\n.ant-sidebar:not(.sidebar-pinned)>.ant-layout-sider:not(.ant-layout-sider-collapsed){box-shadow:0 30px 80px rgba(8,6,40,.7)}\n.ant-layout-sider .ant-menu{background:transparent!important}\n.sider-brand{height:70px!important;border-bottom:1px solid rgba(255,255,255,.08)!important;padding:0 14px!important}\nbody.light .sider-brand{border-color:rgba(109,74,255,.12)!important}\n.brand-text{font-weight:800;letter-spacing:.1em;background:var(--w-grad);-webkit-background-clip:text;background-clip:text;color:transparent!important;font-size:15px}\n.wal-logo{width:30px;height:30px;border-radius:9px;margin-right:10px;flex:none;box-shadow:0 6px 20px rgba(139,108,255,.5)}\n.sider-brand .brand-block{display:inline-flex;align-items:center}\n.ant-layout-sider-collapsed .wal-logo{margin-right:0}\n.ant-layout-sider-collapsed .brand-text{display:none}\n.sider-nav .ant-menu-item,.sider-utility .ant-menu-item,.sider-nav .ant-menu-submenu-title{border-radius:14px!important;margin:3px 8px!important;width:calc(100% - 16px)!important;transition:all .22s ease}\n.sider-nav .ant-menu-item-selected,.sider-utility .ant-menu-item-selected,.drawer-menu .ant-menu-item-selected{\n background:linear-gradient(135deg,rgba(139,108,255,.42),rgba(34,211,238,.2))!important;color:#fff!important;box-shadow:0 8px 24px rgba(139,108,255,.28),inset 0 0 0 1px rgba(255,255,255,.12)}\nbody.light .sider-nav .ant-menu-item-selected,body.light .drawer-menu .ant-menu-item-selected{color:#4b2fd0!important;background:linear-gradient(135deg,rgba(109,74,255,.2),rgba(34,211,238,.14))!important;box-shadow:0 6px 18px rgba(109,74,255,.18)}\n.sider-nav .ant-menu-item:not(.ant-menu-item-selected):hover,.sider-utility .ant-menu-item:not(.ant-menu-item-selected):hover{transform:translateX(2px)}\n.sidebar-command-trigger{border-radius:14px!important;margin:10px 8px 6px!important;background:rgba(255,255,255,.06)!important;border:1px solid rgba(255,255,255,.1)!important}\nbody.light .sidebar-command-trigger{background:rgba(109,74,255,.06)!important;border-color:rgba(109,74,255,.14)!important}\n.sider-version .anticon{display:none}\n.ant-layout-sider-collapsed .sider-version{display:none}\n.sider-version{justify-content:center!important;opacity:.6}\n.sidebar-donate,.sidebar-docs,[data-menu-id$=\"/sponsors\"],.login-sponsor,[class*=\"SponsorCard\"],[class*=\"sponsor-\"],.sponsor-card,.sponsor-slot{display:none!important}\n.drawer-handle{background:var(--w-grad)!important;box-shadow:0 8px 24px rgba(139,108,255,.5)!important}\nbody.dark .ant-drawer-content,body.dark .ant-drawer-body{background:#0d0d26!important}\n\n/* ---------- cards ---------- */\n.ant-card{border-radius:22px!important;background:var(--ant-color-bg-container)!important;border:1px solid var(--ant-color-border-secondary)!important;\n backdrop-filter:blur(16px) saturate(130%);-webkit-backdrop-filter:blur(16px) saturate(130%);box-shadow:0 12px 40px rgba(6,4,30,.28),inset 0 1px 0 rgba(255,255,255,.05)!important;transition:transform .25s ease,border-color .25s ease,box-shadow .25s ease}\nbody.light .ant-card{box-shadow:0 10px 34px rgba(90,60,200,.1),inset 0 1px 0 rgba(255,255,255,.8)!important}\n.ant-card-hoverable:hover{border-color:rgba(139,108,255,.45)!important;box-shadow:0 18px 50px rgba(139,108,255,.22)!important;transform:translateY(-2px)}\n.ant-card-head{border-bottom:1px solid var(--ant-color-border-secondary)!important}\n.ant-card .ant-card-actions{background:transparent!important}\n.ov-tile-number,.ov-conn-total .ov-tile-number{background:var(--w-grad);-webkit-background-clip:text;background-clip:text;color:transparent!important;font-weight:800}\n.ov-state{background:rgba(139,108,255,.12);border-color:rgba(139,108,255,.35)!important;border-radius:999px}\n.ov-rule,hr.ov-rule{border-color:rgba(255,255,255,.08)!important}\n.ov-kicker{letter-spacing:.14em;font-weight:600}\n.ov-tile-icon{color:var(--w-v)}\n.summary-card{padding:18px!important}\n\n/* ---------- buttons ---------- */\n.ant-btn{border-radius:12px!important;font-weight:600;transition:all .22s ease}\n.ant-btn-color-primary.ant-btn-variant-solid,.ant-btn-primary:not(.ant-btn-background-ghost):not(.ant-btn-dangerous){background:var(--w-grad)!important;border:0!important;color:#fff!important;box-shadow:0 10px 28px rgba(110,90,255,.38)}\n.ant-btn-color-primary.ant-btn-variant-solid:hover,.ant-btn-primary:not(.ant-btn-dangerous):hover{filter:brightness(1.1) saturate(1.1);transform:translateY(-1px);box-shadow:0 14px 34px rgba(110,90,255,.5)}\n.ant-btn-color-primary.ant-btn-variant-outlined{border-color:rgba(139,108,255,.6)!important;color:var(--ant-color-primary-text)!important;background:rgba(139,108,255,.1)!important}\n.ant-btn-default,.ant-btn-variant-outlined.ant-btn-color-default{background:var(--ant-color-fill-quaternary)!important;border-color:var(--ant-color-border)!important}\n.ant-btn-default:hover,.ant-btn-variant-outlined.ant-btn-color-default:hover{border-color:var(--w-v)!important;color:var(--ant-color-primary-text)!important}\n.ant-btn-text:hover,.ant-btn-variant-text:hover{background:rgba(139,108,255,.14)!important}\n\n/* ---------- inputs / selects ---------- */\n.ant-input,.ant-input-affix-wrapper,.ant-input-number,.ant-input-number-affix-wrapper,.ant-select-selector,.ant-picker,.ant-input-textarea textarea,.ant-select:not(.ant-select-customize-input) .ant-select-selector{\n border-radius:12px!important;background:rgba(255,255,255,.05)!important;border-color:var(--ant-color-border)!important;transition:all .2s}\nbody.light .ant-input,body.light .ant-input-affix-wrapper,body.light .ant-input-number,body.light .ant-select-selector,body.light .ant-picker{background:rgba(255,255,255,.85)!important}\n.ant-input:focus,.ant-input-focused,.ant-input-affix-wrapper-focused,.ant-select-focused .ant-select-selector,.ant-input-number-focused{border-color:var(--w-v)!important;box-shadow:0 0 0 3px rgba(139,108,255,.22)!important}\n.ant-input-affix-wrapper>input.ant-input{background:transparent!important}\n.ant-switch-checked{background:var(--w-grad)!important}\n.ant-checkbox-checked .ant-checkbox-inner,.ant-radio-checked .ant-radio-inner{background:var(--w-v)!important;border-color:var(--w-v)!important}\n.ant-slider-track{background:var(--w-grad)!important}\n.ant-progress-bg{background:var(--w-grad)!important}\n\n/* ---------- tables / lists ---------- */\n.ant-table{background:transparent!important;border-radius:16px!important}\n.ant-table-thead>tr>th{background:rgba(139,108,255,.12)!important;color:var(--ant-color-text)!important;border-bottom:1px solid var(--ant-color-border-secondary)!important;font-weight:700;letter-spacing:.02em}\n.ant-table-tbody>tr>td{border-bottom:1px solid var(--ant-color-border-secondary)!important;background:transparent!important;transition:background .2s}\n.ant-table-tbody>tr:hover>td{background:rgba(139,108,255,.08)!important}\n.ant-table-tbody>tr.ant-table-row-selected>td{background:rgba(139,108,255,.14)!important}\n.ant-pagination-item-active{border-color:var(--w-v)!important;background:rgba(139,108,255,.16)!important}\n.ant-tag{border-radius:999px!important;font-weight:600;border-width:1px}\n.ant-tabs-ink-bar{background:var(--w-grad)!important;height:3px!important;border-radius:3px}\n.ant-tabs-tab-active .ant-tabs-tab-btn{color:var(--ant-color-primary-text)!important}\n.ant-segmented{background:rgba(255,255,255,.06)!important;border-radius:14px!important}.ant-segmented-item-selected,.ant-segmented-thumb{background:var(--w-grad)!important;color:#fff!important;border-radius:11px!important}\n.ant-collapse{background:transparent!important;border-radius:16px!important}\n.ant-collapse-item{border-color:var(--ant-color-border-secondary)!important}\n.ant-alert{border-radius:14px!important}\n.ant-statistic-content{font-weight:800}\n.ant-descriptions-view{border-radius:14px!important}\n.inbound-card,.client-card,.link-panel,.link-row,.filter-chips{border-radius:16px!important;background:rgba(255,255,255,.04)!important;border-color:var(--ant-color-border-secondary)!important}\n\n/* ---------- overlays ---------- */\n.ant-modal .ant-modal-content{border-radius:24px!important;background:rgba(18,18,48,.86)!important;border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(26px);-webkit-backdrop-filter:blur(26px);box-shadow:0 40px 100px rgba(4,2,30,.7)!important}\nbody.light .ant-modal .ant-modal-content{background:rgba(255,255,255,.92)!important;border-color:rgba(109,74,255,.14)}\n.ant-modal-header{background:transparent!important}\n.ant-modal-title{font-weight:800!important}\n.ant-dropdown .ant-dropdown-menu,.ant-select-dropdown,.ant-popover .ant-popover-inner,.ant-picker-dropdown .ant-picker-panel-container,.ant-tooltip .ant-tooltip-inner{border-radius:16px!important;backdrop-filter:blur(18px);border:1px solid var(--ant-color-border-secondary)}\nbody.dark .ant-dropdown .ant-dropdown-menu,body.dark .ant-select-dropdown,body.dark .ant-popover .ant-popover-inner{background:rgba(20,20,52,.94)!important}\n.ant-select-item-option-selected{background:rgba(139,108,255,.2)!important}\n.ant-drawer .ant-drawer-content{border-radius:0 24px 24px 0}\n.ant-message-notice-content{border-radius:14px!important;backdrop-filter:blur(14px)}\n::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:linear-gradient(180deg,rgba(139,108,255,.55),rgba(34,211,238,.4));border-radius:9px}::-webkit-scrollbar-track{background:transparent}\n::selection{background:rgba(139,108,255,.4)}\n.log-container{border-radius:14px!important;background:rgba(0,0,0,.28)!important}\n\n/* ================= LOGIN ================= */\n.login-app{background:transparent!important;min-height:100vh;overflow:hidden}\n.login-app .ant-layout-content,.login-content{background:transparent!important}\n.login-toolbar{position:absolute;top:18px;right:20px;z-index:3;display:flex;gap:10px}\n.toolbar-btn{background:rgba(255,255,255,.08)!important;border:1px solid rgba(255,255,255,.16)!important;backdrop-filter:blur(10px)}\n.login-wrapper{display:flex!important;align-items:center;justify-content:center;gap:72px;min-height:100vh;padding:40px 6vw}\n.wal-hero{max-width:520px;flex:1 1 420px;display:block;animation:wal-in .9s ease both}\n.wal-hero .wal-badge{display:inline-flex;align-items:center;gap:10px;padding:7px 14px 7px 8px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#cfc8ff}\n.wal-hero .wal-badge img{width:24px;height:24px;border-radius:7px}\n.wal-hero h1{margin:26px 0 14px;font-size:clamp(40px,5.2vw,68px);line-height:1.04;font-weight:800;letter-spacing:-.02em;color:#fff}\n.wal-hero h1 span{background:var(--w-grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n.wal-hero p{margin:0 0 28px;font-size:17px;line-height:1.7;color:rgba(224,222,255,.72);max-width:470px}\n.wal-chips{display:flex;flex-wrap:wrap;gap:10px}\n.wal-chips b{padding:9px 16px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);font-size:13px;font-weight:600;color:#e5e1ff;backdrop-filter:blur(8px)}\nbody.light .wal-hero h1{color:#1c1840}body.light .wal-hero p{color:rgba(28,24,64,.7)}body.light .wal-chips b,body.light .wal-hero .wal-badge{background:rgba(255,255,255,.7);color:#3d2fa0;border-color:rgba(109,74,255,.2)}\n.login-card{flex:0 0 min(420px,92vw);width:min(420px,92vw)!important;border-radius:30px!important;padding:38px 34px 34px!important;position:relative;\n background:linear-gradient(160deg,rgba(255,255,255,.1),rgba(255,255,255,.03))!important;border:1px solid rgba(255,255,255,.16)!important;\n backdrop-filter:blur(26px) saturate(150%);-webkit-backdrop-filter:blur(26px) saturate(150%);box-shadow:0 50px 120px rgba(5,3,40,.65),inset 0 1px 0 rgba(255,255,255,.18)!important;animation:wal-in .9s .1s ease both}\nbody.light .login-card{background:linear-gradient(160deg,rgba(255,255,255,.95),rgba(246,243,255,.8))!important;border-color:rgba(109,74,255,.16)!important;box-shadow:0 40px 100px rgba(90,60,200,.2)!important}\n.login-card::before{content:\"\";position:absolute;inset:-1px;border-radius:30px;padding:1px;background:linear-gradient(140deg,rgba(139,108,255,.9),transparent 35%,transparent 65%,rgba(34,211,238,.8));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}\n@keyframes wal-in{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}\n.login-card .brand{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:4px}\n.login-card .brand::before{content:\"\";width:64px;height:64px;border-radius:19px;background:url(\"/walencya/icon.svg\") center/cover;box-shadow:0 14px 40px rgba(139,108,255,.6)}\n.login-card .brand-name{font-size:25px!important;font-weight:800!important;letter-spacing:.34em!important;background:var(--w-grad)!important;-webkit-background-clip:text!important;background-clip:text!important;-webkit-text-fill-color:transparent!important;padding-left:.34em}\n.login-card .brand-accent{display:none!important}\n.login-card .welcome{font-size:22px!important;font-weight:700!important;margin:14px 0 24px!important;min-height:30px!important;color:var(--ant-color-text-secondary)!important}\n.login-card .ant-btn-primary{height:50px!important;font-size:16px!important;border-radius:15px!important}\n.login-form .ant-input-affix-wrapper{height:48px}\n.login-form .ant-form-item-label>label{font-weight:600;color:var(--ant-color-text-secondary)!important}\n@media(max-width:900px){.wal-hero{display:none}.login-wrapper{padding:20px 14px}}\n\n/* ============ rtl niceties ============ */\n[dir=rtl] .wal-logo{margin-right:0;margin-left:10px}\n@media(max-width:768px){.ant-sidebar{flex:0 0 0!important;width:0!important}.ant-sidebar>.ant-layout-sider{display:none!important}.index-page .content-area{padding-top:64px!important}}\n\n/* ================= WALENCYA nav icons: gradient chips ================= */\n.sider-nav .ant-menu-item>.anticon,.sider-nav .ant-menu-submenu-title>.anticon,.sider-utility .ant-menu-item>.anticon,.drawer-menu .ant-menu-item>.anticon,.drawer-menu .ant-menu-submenu-title>.anticon{\n  width:34px;height:34px;min-width:34px;border-radius:12px;display:inline-flex!important;align-items:center;justify-content:center;font-size:0!important;\n  background:linear-gradient(145deg,rgba(139,108,255,.20),rgba(34,211,238,.10));border:1px solid rgba(139,108,255,.22);transition:all .25s ease;margin-inline-end:2px}\n.sider-nav .ant-menu-item>.anticon>svg,.sider-nav .ant-menu-submenu-title>.anticon>svg,.sider-utility .ant-menu-item>.anticon>svg,.drawer-menu .ant-menu-item>.anticon>svg,.drawer-menu .ant-menu-submenu-title>.anticon>svg{display:none!important}\n.sider-nav .ant-menu-item>.anticon::before,.sider-nav .ant-menu-submenu-title>.anticon::before,.sider-utility .ant-menu-item>.anticon::before,.drawer-menu .ant-menu-item>.anticon::before,.drawer-menu .ant-menu-submenu-title>.anticon::before{\n  content:\"\";width:19px;height:19px;background:currentColor;-webkit-mask:var(--wi) center/contain no-repeat;mask:var(--wi) center/contain no-repeat}\n.sider-nav .ant-menu-item-selected>.anticon,.sider-utility .ant-menu-item-selected>.anticon,.drawer-menu .ant-menu-item-selected>.anticon,.sider-nav .ant-menu-submenu-selected>.ant-menu-submenu-title>.anticon{\n  background:linear-gradient(135deg,#8b6cff,#22d3ee);color:#fff!important;border-color:transparent;box-shadow:0 6px 16px rgba(139,108,255,.45)}\n.sider-nav .ant-menu-item:hover>.anticon,.sider-nav .ant-menu-submenu-title:hover>.anticon,.drawer-menu .ant-menu-item:hover>.anticon{transform:rotate(-6deg) scale(1.08)}\nbody.light .sider-nav .ant-menu-item>.anticon,body.light .sider-nav .ant-menu-submenu-title>.anticon,body.light .drawer-menu .ant-menu-item>.anticon{background:linear-gradient(145deg,rgba(109,74,255,.12),rgba(34,211,238,.10));border-color:rgba(109,74,255,.2)}\n.ant-layout-sider-collapsed .sider-nav .ant-menu-item,.ant-layout-sider-collapsed .sider-nav .ant-menu-submenu-title,.ant-layout-sider-collapsed .sider-utility .ant-menu-item{padding-inline:0!important;display:flex;align-items:center;justify-content:center}\n.ant-layout-sider-collapsed .sider-utility .ant-menu-item>.anticon,.ant-layout-sider-collapsed .sider-nav .ant-menu-item>.anticon,.ant-layout-sider-collapsed .sider-nav .ant-menu-submenu-title>.anticon{margin:0}\n.sider-nav .ant-menu-item,.sider-nav .ant-menu-submenu-title{height:46px!important;line-height:46px!important}\n\n/* ================= WALENCYA: dock on the RIGHT ================= */\n.ant-layout.ant-layout-has-sider:has(>.ant-sidebar){flex-direction:row-reverse!important}\nhtml[dir=rtl] .ant-layout.ant-layout-has-sider:has(>.ant-sidebar){flex-direction:row!important}\n.ant-sidebar{display:flex;justify-content:flex-end}\n.ant-sidebar>.ant-layout-sider{margin-left:0!important;margin-right:12px;flex:none!important}\n.ant-sidebar:not(.sidebar-pinned)>.ant-layout-sider:not(.ant-layout-sider-collapsed){box-shadow:-30px 0 80px rgba(8,6,40,.7)}\n.sider-nav .ant-menu-item:not(.ant-menu-item-selected):hover,.sider-utility .ant-menu-item:not(.ant-menu-item-selected):hover{transform:translateX(-2px)}\n.drawer-handle{left:auto!important;right:12px!important}\n.ant-drawer-left>.ant-drawer-content-wrapper,.ant-drawer.ant-drawer-left .ant-drawer-content-wrapper{left:auto!important;right:0!important;box-shadow:-10px 0 40px rgba(0,0,0,.4)!important}\n.ant-drawer-left .ant-drawer-content-wrapper{transform:none}\n.ant-drawer-content-wrapper{border-radius:24px 0 0 24px!important;overflow:hidden}\n.sider-nav .anticon::before,.sider-utility .anticon::before,.drawer-menu .anticon::before{display:block!important}\n.sider-brand{padding:0 10px 0 12px!important;gap:4px!important}\n.sider-brand .brand-actions .sidebar-pin,.sider-brand .brand-actions .sidebar-theme-cycle{width:24px;height:24px}\n[data-menu-id$=\"__logout__\"]>.anticon,.drawer-utility .ant-menu-item>.anticon{--wi:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h2' fill='%23000' fill-opacity='.32'/%3E%3Cpath d='M16 8l4 4-4 4M20 12H10'/%3E%3C/svg%3E\")}\n\n/* ---- generated icons ---- */\n.sider-nav [data-menu-id$=\"-/\"],.sider-utility [data-menu-id$=\"-/\"],.drawer-menu [data-menu-id$=\"-/\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%223%22%20y%3D%223%22%20width%3D%228%22%20height%3D%2210%22%20rx%3D%222.4%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Crect%20x%3D%2213%22%20y%3D%223%22%20width%3D%228%22%20height%3D%226%22%20rx%3D%222.4%22%2F%3E%3Crect%20x%3D%2213%22%20y%3D%2211%22%20width%3D%228%22%20height%3D%2210%22%20rx%3D%222.4%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Crect%20x%3D%223%22%20y%3D%2215%22%20width%3D%228%22%20height%3D%226%22%20rx%3D%222.4%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/inbounds\"],.sider-utility [data-menu-id$=\"-/inbounds\"],.drawer-menu [data-menu-id$=\"-/inbounds\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M4%2015v2a4%204%200%200%200%204%204h8a4%204%200%200%200%204-4v-2%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Cpath%20d%3D%22M12%203v12M7.5%2010.5%2012%2015l4.5-4.5%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/clients\"],.sider-utility [data-menu-id$=\"-/clients\"],.drawer-menu [data-menu-id$=\"-/clients\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%229%22%20cy%3D%228%22%20r%3D%223.4%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Cpath%20d%3D%22M3%2020c0-3.3%202.7-6%206-6s6%202.7%206%206%22%2F%3E%3Cpath%20d%3D%22M16.5%204.8a3.2%203.2%200%200%201%200%206.4M18%2014.4c1.8.8%203%202.6%203%205.6%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/groups\"],.sider-utility [data-menu-id$=\"-/groups\"],.drawer-menu [data-menu-id$=\"-/groups\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M12%203%2021%207.5%2012%2012%203%207.5z%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Cpath%20d%3D%22m3%2012%209%204.5%209-4.5M3%2016.5l9%204.5%209-4.5%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/nodes\"],.sider-utility [data-menu-id$=\"-/nodes\"],.drawer-menu [data-menu-id$=\"-/nodes\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%223%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Ccircle%20cx%3D%225%22%20cy%3D%225%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2219%22%20cy%3D%225%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2220%22%20r%3D%222%22%2F%3E%3Cpath%20d%3D%22M9.9%209.9%206.4%206.4M14.1%209.9l3.5-3.5M12%2015v3%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/hosts\"],.sider-utility [data-menu-id$=\"-/hosts\"],.drawer-menu [data-menu-id$=\"-/hosts\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%223%22%20y%3D%223%22%20width%3D%2218%22%20height%3D%227.5%22%20rx%3D%222.5%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Crect%20x%3D%223%22%20y%3D%2213.5%22%20width%3D%2218%22%20height%3D%227.5%22%20rx%3D%222.5%22%2F%3E%3Cpath%20d%3D%22M7%206.8h.01M7%2017.3h.01M12%206.8h5M12%2017.3h5%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/outbound\"],.sider-utility [data-menu-id$=\"-/outbound\"],.drawer-menu [data-menu-id$=\"-/outbound\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M4%2015v2a4%204%200%200%200%204%204h8a4%204%200%200%200%204-4v-2%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Cpath%20d%3D%22M12%2015V3M7.5%207.5%2012%203l4.5%204.5%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/routing\"],.sider-utility [data-menu-id$=\"-/routing\"],.drawer-menu [data-menu-id$=\"-/routing\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%225.5%22%20cy%3D%2219%22%20r%3D%222.3%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Ccircle%20cx%3D%2218.5%22%20cy%3D%225%22%20r%3D%222.3%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Cpath%20d%3D%22M7.8%2019H14a3.5%203.5%200%200%200%200-7h-4a3.5%203.5%200%200%201%200-7h6.2%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/settings\"],.sider-utility [data-menu-id$=\"-/settings\"],.drawer-menu [data-menu-id$=\"-/settings\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M4%207h8M18%207h2M4%2017h2M12%2017h8M4%2012h12M20%2012h0%22%2F%3E%3Ccircle%20cx%3D%2215%22%20cy%3D%227%22%20r%3D%222.6%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Ccircle%20cx%3D%229%22%20cy%3D%2217%22%20r%3D%222.6%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Ccircle%20cx%3D%2218%22%20cy%3D%2212%22%20r%3D%221.6%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/xray\"],.sider-utility [data-menu-id$=\"-/xray\"],.drawer-menu [data-menu-id$=\"-/xray\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%223%22%20y%3D%224%22%20width%3D%2218%22%20height%3D%2216%22%20rx%3D%223.5%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Cpath%20d%3D%22m8.5%209.5%203%202.5-3%202.5M13.5%2015h3%22%2F%3E%3C%2Fsvg%3E\")}\n.sider-nav [data-menu-id$=\"-/api-docs\"],.sider-utility [data-menu-id$=\"-/api-docs\"],.drawer-menu [data-menu-id$=\"-/api-docs\"]{--wi:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M5%205.5A2.5%202.5%200%200%201%207.5%203H19v15H7.5A2.5%202.5%200%200%200%205%2020.5z%22%20fill%3D%22%23000%22%20fill-opacity%3D%22.32%22%2F%3E%3Cpath%20d%3D%22M5%2020.5A2.5%202.5%200%200%200%207.5%2023H19v-5M9%208h6M9%2012h4%22%2F%3E%3C%2Fsvg%3E\")}\n\n/* ============ WALENCYA Custom Dashboard (injected on .index-page) ============ */\n.wal-custom-dash{font-family:var(--w-font);color:var(--ant-color-text)}\n.wal-custom-dash .hero{position:relative;overflow:hidden;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:24px 28px;border-radius:26px;border:1px solid var(--ant-color-border);margin-bottom:20px;background:radial-gradient(120% 140% at 0 0,rgba(139,108,255,.36),transparent 55%),radial-gradient(100% 120% at 100% 100%,rgba(34,211,238,.24),transparent 55%),var(--ant-color-bg-container);backdrop-filter:blur(18px);box-shadow:0 14px 40px rgba(6,4,30,.35)}\n.wal-custom-dash .hero::after{content:\"\";position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.08) 50%,transparent 70%);background-size:200% 100%;animation:wal-shine 7s linear infinite;pointer-events:none}\n@keyframes wal-shine{to{background-position:200% center}}\n.wal-custom-dash .hero small{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--ant-color-text-secondary)}\n.wal-custom-dash .hero h1{margin:6px 0 4px;font-size:27px;font-weight:800;background:var(--w-grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n.wal-custom-dash .hero p{margin:0;color:var(--ant-color-text-secondary);font-size:13px}\n.wal-custom-dash .hs{display:flex;gap:10px;align-items:center;position:relative;z-index:1;flex-wrap:wrap}\n.wal-custom-dash .pill{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:600;background:rgba(255,255,255,.07);border:1px solid var(--ant-color-border)}\n.wal-custom-dash .pill i{width:8px;height:8px;border-radius:50%;background:#34d399;animation:wal-pulse 2s infinite}\n@keyframes wal-pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.6)}70%{box-shadow:0 0 0 10px transparent}100%{box-shadow:0 0 0 0 transparent}}\n.wal-custom-dash .clock{font-weight:800;font-size:20px;font-variant-numeric:tabular-nums;letter-spacing:.04em}\n.wal-custom-dash .btn{border:0;border-radius:12px;padding:10px 16px;font:600 13px var(--w-font);cursor:pointer;color:#fff;background:var(--w-grad);box-shadow:0 10px 24px rgba(139,108,255,.4);transition:.2s}\n.wal-custom-dash .btn:hover{transform:translateY(-2px)}\n.wal-custom-dash .btn.ghost{background:rgba(255,255,255,.07);color:var(--ant-color-text);box-shadow:none;border:1px solid var(--ant-color-border)}\n.wal-custom-dash .grid{display:grid;gap:18px;grid-template-columns:repeat(12,1fr)}\n.wal-custom-dash .card{position:relative;overflow:hidden;border-radius:24px;padding:20px;background:var(--ant-color-bg-container);border:1px solid var(--ant-color-border);backdrop-filter:blur(16px);box-shadow:0 14px 40px rgba(6,4,30,.35);transition:.25s}\n.wal-custom-dash .card::before{content:\"\";position:absolute;left:0;right:0;top:0;height:3px;background:var(--w-grad)}\n.wal-custom-dash .card:hover{transform:translateY(-4px);border-color:rgba(139,108,255,.5);box-shadow:0 26px 60px rgba(139,108,255,.22)}\n.wal-custom-dash .s3{grid-column:span 3}.wal-custom-dash .s4{grid-column:span 4}.wal-custom-dash .s5{grid-column:span 5}.wal-custom-dash .s7{grid-column:span 7}.wal-custom-dash .s8{grid-column:span 8}.wal-custom-dash .s12{grid-column:span 12}\n.wal-custom-dash .card h3{margin:0 0 14px;font-size:14px;font-weight:700;display:flex;justify-content:space-between;align-items:center}\n.wal-custom-dash .card h3 span{font-size:11px;color:var(--ant-color-text-secondary);font-weight:500}\n.wal-custom-dash .stat{display:flex;justify-content:space-between;align-items:flex-start}\n.wal-custom-dash .k{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--ant-color-text-secondary);font-weight:600}\n.wal-custom-dash .n{font-size:30px;font-weight:800;margin-top:8px;line-height:1.1;background:var(--w-grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n.wal-custom-dash .sub{font-size:12px;color:var(--ant-color-text-secondary);margin-top:8px}\n.wal-custom-dash .up{color:#34d399;font-weight:700}\n.wal-custom-dash .ic{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:#fff;box-shadow:0 10px 26px rgba(139,108,255,.45);background:var(--w-grad)}\n.wal-custom-dash .gauges{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center}\n.wal-custom-dash .gauge{position:relative;width:100%;max-width:120px;margin:0 auto;aspect-ratio:1}\n.wal-custom-dash .gauge svg{width:100%;height:100%;transform:rotate(-90deg)}\n.wal-custom-dash .gauge .t{stroke:rgba(255,255,255,.09)}\n.wal-custom-dash .gauge .v{stroke:url(#gr);stroke-linecap:round;filter:drop-shadow(0 0 6px rgba(139,108,255,.65));transition:stroke-dashoffset 1s}\n.wal-custom-dash .gauge b{position:absolute;inset:0;display:grid;place-items:center;font-size:19px;font-weight:800}\n.wal-custom-dash .gl{margin-top:8px;font-size:12px;color:var(--ant-color-text-secondary);font-weight:600}\n.wal-custom-dash .bar{height:8px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:8px}\n.wal-custom-dash .bar>div{height:100%;border-radius:99px;background:var(--w-grad);box-shadow:0 0 12px rgba(139,108,255,.55)}\n.wal-custom-dash .row{margin-bottom:16px}.wal-custom-dash .row:last-child{margin-bottom:0}\n.wal-custom-dash .row .l{display:flex;justify-content:space-between;font-size:13px;font-weight:600}\n.wal-custom-dash .row .l span{color:var(--ant-color-text-secondary);font-weight:500}\n.wal-custom-dash table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}\n.wal-custom-dash th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.1em;padding:11px 14px;background:rgba(139,108,255,.12);font-weight:700;color:var(--ant-color-text-secondary)}\n.wal-custom-dash td{padding:13px 14px;border-bottom:1px solid var(--ant-color-border)}\n.wal-custom-dash tr:hover td{background:rgba(139,108,255,.08)}\n.wal-custom-dash .tag{display:inline-block;padding:3px 12px;border-radius:99px;font-size:11px;font-weight:700;border:1px solid}\n.wal-custom-dash .tg{color:#34d399;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.1)}\n.wal-custom-dash .tv{color:#b3a0ff;border-color:rgba(139,108,255,.4);background:rgba(139,108,255,.12)}\n.wal-custom-dash .tc{color:#22d3ee;border-color:rgba(34,211,238,.4);background:rgba(34,211,238,.1)}\n.wal-custom-dash .tp{color:#f472b6;border-color:rgba(244,114,182,.4);background:rgba(244,114,182,.1)}\n.wal-custom-dash .kv{display:grid;grid-template-columns:1fr 1fr;gap:12px}\n.wal-custom-dash .kv div{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid var(--ant-color-border)}\n.wal-custom-dash .kv b{display:block;font-size:15px;margin-top:4px}\n@media(max-width:1100px){.wal-custom-dash .s3{grid-column:span 6}.wal-custom-dash .s4,.wal-custom-dash .s5,.wal-custom-dash .s7,.wal-custom-dash .s8{grid-column:span 12}}\n@media(max-width:720px){.wal-custom-dash .s3{grid-column:span 12}.wal-custom-dash .hero h1{font-size:21px}.wal-custom-dash .hero{padding:18px;border-radius:20px}}\n";
let THEME_JS = "(function(){\n  var css=document.getElementById('wal-css');\n  function keepLast(){var h=document.head;css=css||document.getElementById('wal-css');if(css&&h.lastElementChild!==css&&!keepLast.busy){keepLast.busy=1;h.appendChild(css);setTimeout(function(){keepLast.busy=0},50)}}\n  new MutationObserver(keepLast).observe(document.head,{childList:true});\n  var L='/walencya/icon.svg';\n  var RX=/3\\s*x\\s*[-\\u2010-\\u2015 ]?\\s*ui|x-ui/ig;\n  function fixText(root){\n    try{\n      var w=document.createTreeWalker(root||document.body,NodeFilter.SHOW_TEXT,null),n,a=[];\n      while((n=w.nextNode())){if(RX.test(n.nodeValue)){a.push(n)}RX.lastIndex=0}\n      a.forEach(function(t){t.nodeValue=t.nodeValue.replace(RX,'WALENCYA')});\n      if(RX.test(document.title)){document.title=document.title.replace(RX,'WALENCYA')}RX.lastIndex=0;\n    }catch(e){}\n  }\n  function enhance(){\n    fixText();\n    var bb=document.querySelector('.sider-brand .brand-block');\n    if(bb&&!bb.querySelector('.wal-logo')){var i=document.createElement('img');i.className='wal-logo';i.src=L;i.alt='';bb.insertBefore(i,bb.firstChild)}\n    var db=document.querySelector('.drawer-header .brand-block');\n    if(db&&!db.querySelector('.wal-logo')){var j=document.createElement('img');j.className='wal-logo';j.src=L;j.alt='';db.insertBefore(j,db.firstChild)}\n    var lw=document.querySelector('.login-wrapper');\n    if(lw&&!lw.querySelector('.wal-hero')){\n      var h=document.createElement('div');h.className='wal-hero';\n      h.innerHTML='<span class=\"wal-badge\"><img src=\"'+L+'\" alt=\"\">Control center</span><h1>Your network,<br><span>beautifully</span> in control.</h1><p>WALENCYA is a premium multi-protocol proxy panel. VLESS, VMess, Trojan and REALITY on a single port, with smart subscription pages and live monitoring.</p><div class=\"wal-chips\"><b>VLESS</b><b>VMess</b><b>Trojan</b><b>REALITY</b><b>One port</b><b>Live stats</b></div>';\n      lw.insertBefore(h,lw.firstChild);\n    }\n    var sp=document.querySelectorAll('.sponsor-card,[class*=\"sponsor\"]');sp.forEach(function(e){e.style.display='none'});\n    injectDashboard();\n  }\n  function injectDashboard(){\n    var page=document.querySelector('.index-page');\n    if(!page||document.querySelector('.wal-custom-dash'))return;\n    var content=page.querySelector('.content-area')||page.querySelector('.ant-layout-content');\n    if(!content)return;\n    Array.from(content.children).forEach(function(ch){if(!ch.classList.contains('wal-custom-dash'))ch.style.display='none'});\n    var dash=document.createElement('div');\n    dash.className='wal-custom-dash';\n    dash.innerHTML=`\n<svg width=\"0\" height=\"0\" style=\"position:absolute\"><defs><linearGradient id=\"gr\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#8b6cff\"/><stop offset=\"1\" stop-color=\"#22d3ee\"/></linearGradient></defs></svg>\n<section class=\"hero\">\n  <div><small>WALENCYA · Dashboard</small><h1 id=\"gt\">Good evening, Admin</h1><p>Live overview of your server, Xray core and traffic.</p></div>\n  <div class=\"hs\"><span class=\"pill\"><i></i>System online</span><span class=\"clock\" id=\"ck\">--:--:--</span><button class=\"btn\" id=\"restartBtn\">Restart Xray</button><button class=\"btn ghost\" id=\"logsBtn\">Logs</button></div>\n</section>\n<div class=\"grid\">\n  <div class=\"card s3\"><div class=\"stat\"><div><div class=\"k\">Total traffic</div><div class=\"n\" id=\"totalTraffic\">—</div></div><div class=\"ic\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M3 17l6-6 4 4 8-8M15 7h6v6\"/></svg></div></div><div class=\"sub\"><span class=\"up\">Live</span></div></div>\n  <div class=\"card s3 c2\"><div class=\"stat\"><div><div class=\"k\">Online clients</div><div class=\"n\" id=\"onlineClients\">—</div></div><div class=\"ic\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"9\" cy=\"8\" r=\"4\"/><path d=\"M2 21v-1a6 6 0 0112 0v1\"/></svg></div></div><div class=\"sub\">Active now</div></div>\n  <div class=\"card s3 c3\"><div class=\"stat\"><div><div class=\"k\">Active inbounds</div><div class=\"n\" id=\"activeInbounds\">—</div></div><div class=\"ic\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2\"/></svg></div></div><div class=\"sub\">VLESS · VMess · Trojan · REALITY</div></div>\n  <div class=\"card s3 c4\"><div class=\"stat\"><div><div class=\"k\">Xray status</div><div class=\"n\" id=\"xrayStatus\">—</div></div><div class=\"ic\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/></svg></div></div><div class=\"sub\" id=\"xraySub\">Checking…</div></div>\n  <div class=\"card s8\"><h3>Network traffic <span>overview</span></h3><svg class=\"chart\" viewBox=\"0 0 640 230\" preserveAspectRatio=\"none\" style=\"width:100%;height:230px\"><path d=\"M0 170 C60 150 90 120 150 128 S250 70 310 90 S420 150 480 100 S580 40 640 60 V230 H0Z\" fill=\"url(#gr)\" opacity=\".3\"/><path d=\"M0 170 C60 150 90 120 150 128 S250 70 310 90 S420 150 480 100 S580 40 640 60\" fill=\"none\" stroke=\"#8b6cff\" stroke-width=\"3\"/><path d=\"M0 200 C70 190 100 170 160 176 S260 140 320 150 S430 190 490 160 S590 110 640 120\" fill=\"none\" stroke=\"#22d3ee\" stroke-width=\"3\"/></svg><div class=\"legend\" style=\"display:flex;gap:16px;font-size:12px;margin-top:6px\"><span><i style=\"display:inline-block;width:10px;height:10px;border-radius:3px;background:#8b6cff;margin-right:6px\"></i>Download</span><span><i style=\"display:inline-block;width:10px;height:10px;border-radius:3px;background:#22d3ee;margin-right:6px\"></i>Upload</span></div></div>\n  <div class=\"card s4\"><h3>Server health <span>realtime</span></h3><div class=\"gauges\"><div><div class=\"gauge\"><svg viewBox=\"0 0 100 100\"><circle class=\"t\" cx=\"50\" cy=\"50\" r=\"42\" fill=\"none\" stroke-width=\"9\"/><circle class=\"v\" id=\"cpuGauge\" cx=\"50\" cy=\"50\" r=\"42\" fill=\"none\" stroke-width=\"9\" stroke-dasharray=\"263.9\" stroke-dashoffset=\"263.9\"/></svg><b id=\"cpuPct\">—</b></div><div class=\"gl\">CPU</div></div><div><div class=\"gauge\"><svg viewBox=\"0 0 100 100\"><circle class=\"t\" cx=\"50\" cy=\"50\" r=\"42\" fill=\"none\" stroke-width=\"9\"/><circle class=\"v\" id=\"ramGauge\" cx=\"50\" cy=\"50\" r=\"42\" fill=\"none\" stroke-width=\"9\" stroke-dasharray=\"263.9\" stroke-dashoffset=\"263.9\"/></svg><b id=\"ramPct\">—</b></div><div class=\"gl\">RAM</div></div><div><div class=\"gauge\"><svg viewBox=\"0 0 100 100\"><circle class=\"t\" cx=\"50\" cy=\"50\" r=\"42\" fill=\"none\" stroke-width=\"9\"/><circle class=\"v\" id=\"diskGauge\" cx=\"50\" cy=\"50\" r=\"42\" fill=\"none\" stroke-width=\"9\" stroke-dasharray=\"263.9\" stroke-dashoffset=\"263.9\"/></svg><b id=\"diskPct\">—</b></div><div class=\"gl\">Disk</div></div></div></div>\n  <div class=\"card s5\"><h3>Protocol usage <span>share</span></h3><div id=\"protoBars\"><div class=\"row\"><div class=\"l\">Loading…</div></div></div></div>\n  <div class=\"card s7\"><h3>Inbounds <span id=\"ibCount\">—</span></h3><div class=\"tw\"><table id=\"ibTable\"><tr><th>Name</th><th>Protocol</th><th>Port</th><th>Status</th></tr></table></div></div>\n  <div class=\"card s5\"><h3>System info</h3><div class=\"kv\" id=\"sysInfo\"><div><span class=\"k\">Loading…</span><b>—</b></div></div></div>\n</div>`;\n    content.appendChild(dash);\n    startClock();\n    loadDashboardData();\n    document.getElementById('restartBtn').onclick=function(){if(confirm('Restart Xray?'))fetch('/panel/api/server/restartXrayService',{method:'POST'}).then(r=>r.json()).then(d=>alert(d.success?'Restarted':'Failed'))};\n    document.getElementById('logsBtn').onclick=function(){location.href='/panel/xray'||location.assign('/xray')};\n  }\n  function startClock(){\n    function tick(){\n      var d=new Date(),h=d.getHours(),p=function(n){return n<10?'0'+n:n};\n      var ck=document.getElementById('ck');if(ck)ck.textContent=p(h)+':'+p(d.getMinutes())+':'+p(d.getSeconds());\n      var gt=document.getElementById('gt');if(gt)gt.textContent=(h<5?'Good night':h<12?'Good morning':h<18?'Good afternoon':'Good evening')+', Admin';\n    }\n    tick();setInterval(tick,1000);\n  }\n  function loadDashboardData(){\n    Promise.all([\n      fetch('/panel/api/server/status').then(r=>r.json()).catch(()=>({})),\n      fetch('/panel/api/inbounds/list').then(r=>r.json()).catch(()=>({obj:[]})),\n      fetch('/panel/api/clients/list').then(r=>r.json()).catch(()=>({obj:[]}))\n    ]).then(function(res){\n      var status=res[0].obj||{},ibs=res[1].obj||[],clients=res[2].obj||[];\n      var total=0;ibs.forEach(function(i){total+=(i.up||0)+(i.down||0)});\n      var el=document.getElementById('totalTraffic');if(el)el.textContent=(total/1024/1024/1024).toFixed(1)+' GB';\n      el=document.getElementById('onlineClients');if(el)el.textContent=clients.filter(function(c){return c.enable}).length||clients.length;\n      el=document.getElementById('activeInbounds');if(el)el.textContent=ibs.filter(function(i){return i.enable}).length+' / '+ibs.length;\n      var xr=status.xray||{};el=document.getElementById('xrayStatus');if(el)el.textContent=xr.state==='running'?'Running':'Stopped';\n      el=document.getElementById('xraySub');if(el)el.textContent=xr.version||'Core';\n      // gauges (approximate if no data)\n      setGauge('cpu',status.cpu||38);\n      setGauge('ram',status.mem||60);\n      setGauge('disk',status.disk||28);\n      // inbounds table\n      var tb=document.getElementById('ibTable');if(tb){\n        var html='<tr><th>Name</th><th>Protocol</th><th>Port</th><th>Status</th></tr>';\n        ibs.forEach(function(i){\n          var proto=i.protocol||'';var cls=proto==='vless'?'tv':proto==='vmess'?'tp':proto==='trojan'?'tv':'tc';\n          html+='<tr><td>'+(i.remark||i.tag)+'</td><td><span class=\"tag '+cls+'\">'+proto.toUpperCase()+'</span></td><td>'+i.port+'</td><td><span class=\"tag tg\">'+(i.enable?'Active':'Off')+'</span></td></tr>';\n        });\n        tb.innerHTML=html;\n      }\n      el=document.getElementById('ibCount');if(el)el.textContent=ibs.length+' total';\n      // proto bars (simple)\n      var bars=document.getElementById('protoBars');if(bars&&ibs.length){\n        var html='';ibs.slice(0,4).forEach(function(i,idx){\n          var w=Math.max(15,80-idx*15);\n          html+='<div class=\"row\"><div class=\"l\">'+(i.remark||i.tag)+'<span>'+((i.up+i.down)/1024/1024/1024).toFixed(1)+' GB</span></div><div class=\"bar\"><div style=\"width:'+w+'%\"></div></div></div>';\n        });\n        bars.innerHTML=html;\n      }\n      // sys info\n      var sys=document.getElementById('sysInfo');if(sys)sys.innerHTML='<div><span class=\"k\">OS</span><b>Linux</b></div><div><span class=\"k\">Public</span><b>Detected</b></div><div><span class=\"k\">Xray</span><b>'+(xr.version||'v25')+'</b></div><div><span class=\"k\">Inbounds</span><b>'+ibs.length+'</b></div>';\n    });\n  }\n  function setGauge(name,pct){\n    pct=Math.min(100,Math.max(0,pct||0));\n    var g=document.getElementById(name+'Gauge');if(g)g.style.strokeDashoffset=(263.9*(1-pct/100)).toFixed(1);\n    var b=document.getElementById(name+'Pct');if(b)b.textContent=pct+'%';\n  }\n  var t;new MutationObserver(function(){clearTimeout(t);t=setTimeout(enhance,60)}).observe(document.documentElement,{childList:true,subtree:true});\n  document.addEventListener('DOMContentLoaded',enhance);enhance();\n})();\n";

/* ---- dashboard pro (appended; only affects .index-page) ---- */
THEME_CSS += "\n/* ============ WALENCYA · Dashboard Pro (only .index-page) ============ */\n.index-page{--d-a:#8b6cff;--d-b:#22d3ee;--d-c:#f472b6;--d-d:#34d399;--d-e:#fbbf24}\n.index-page .content-area{max-width:1480px;margin:0 auto}\n@keyframes wd-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}\n@keyframes wd-pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.6)}70%{box-shadow:0 0 0 10px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}\n@keyframes wd-shine{to{background-position:200% center}}\n.index-page .ant-row>.ant-col{animation:wd-rise .55s cubic-bezier(.2,.7,.2,1) both}\n.index-page .ant-row>.ant-col:nth-child(1){animation-delay:.02s}.index-page .ant-row>.ant-col:nth-child(2){animation-delay:.08s}\n.index-page .ant-row>.ant-col:nth-child(3){animation-delay:.14s}.index-page .ant-row>.ant-col:nth-child(4){animation-delay:.2s}\n.index-page .ant-row>.ant-col:nth-child(5){animation-delay:.26s}.index-page .ant-row>.ant-col:nth-child(6){animation-delay:.32s}\n.index-page .ant-row>.ant-col:nth-child(n+7){animation-delay:.38s}\n\n/* hero */\n.wd-hero{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;\n margin:0 0 20px;padding:24px 28px;border-radius:26px;border:1px solid rgba(255,255,255,.12);\n background:radial-gradient(120% 140% at 0% 0%,rgba(139,108,255,.38),transparent 55%),radial-gradient(100% 120% at 100% 100%,rgba(34,211,238,.26),transparent 55%),rgba(255,255,255,.04);\n backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 24px 60px rgba(8,6,40,.4);animation:wd-rise .5s both}\n.wd-hero::after{content:\"\";position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.08) 50%,transparent 70%);background-size:200% 100%;animation:wd-shine 7s linear infinite;pointer-events:none}\nbody.light .wd-hero{border-color:rgba(109,74,255,.16);box-shadow:0 18px 44px rgba(90,60,200,.14);background:radial-gradient(120% 140% at 0% 0%,rgba(139,108,255,.22),transparent 55%),radial-gradient(100% 120% at 100% 100%,rgba(34,211,238,.18),transparent 55%),rgba(255,255,255,.7)}\n.wd-hero small{display:block;font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;opacity:.65;margin-bottom:6px}\n.wd-hero h2{margin:0;font-size:26px;font-weight:800;line-height:1.2;background:var(--w-grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n.wd-hero p{margin:6px 0 0;opacity:.7;font-size:13px}\n.wd-hero-side{display:flex;align-items:center;gap:12px;position:relative;z-index:1}\n.wd-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:600;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12)}\nbody.light .wd-pill{background:rgba(109,74,255,.07);border-color:rgba(109,74,255,.16)}\n.wd-pill i{width:8px;height:8px;border-radius:50%;background:#34d399;animation:wd-pulse 2s infinite}\n.wd-clock{font-variant-numeric:tabular-nums;font-weight:800;font-size:20px;letter-spacing:.04em}\n\n/* cards */\n.index-page .ant-card{position:relative;overflow:hidden;border-radius:24px!important}\n.index-page .ant-card::before{content:\"\";position:absolute;left:0;right:0;top:0;height:3px;background:var(--w-grad);opacity:.85}\n.index-page .ant-row>.ant-col:nth-child(4n+2) .ant-card::before{background:linear-gradient(90deg,#22d3ee,#34d399)}\n.index-page .ant-row>.ant-col:nth-child(4n+3) .ant-card::before{background:linear-gradient(90deg,#f472b6,#8b6cff)}\n.index-page .ant-row>.ant-col:nth-child(4n+4) .ant-card::before{background:linear-gradient(90deg,#fbbf24,#f472b6)}\n.index-page .ant-card::after{content:\"\";position:absolute;right:-60px;top:-60px;width:170px;height:170px;border-radius:50%;background:radial-gradient(circle,rgba(139,108,255,.22),transparent 70%);pointer-events:none}\n.index-page .ant-card:hover{transform:translateY(-4px);border-color:rgba(139,108,255,.5)!important;box-shadow:0 26px 60px rgba(139,108,255,.25)!important}\n.index-page .ant-card-head{min-height:52px;padding:0 20px!important}\n.index-page .ant-card-head-title{font-weight:700;letter-spacing:.02em}\n.index-page .ant-card-body{padding:20px!important}\n\n/* stat tiles */\n.index-page [class*=\"ov-tile\"]{transition:transform .25s}\n.index-page .ov-tile-number{font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.01em}\n.index-page .ov-tile-icon{display:inline-grid;place-items:center;width:42px;height:42px;border-radius:14px;font-size:20px;color:#fff!important;\n background:var(--w-grad);box-shadow:0 10px 26px rgba(139,108,255,.45)}\n.index-page .ant-row>.ant-col:nth-child(4n+2) .ov-tile-icon{background:linear-gradient(135deg,#22d3ee,#34d399);box-shadow:0 10px 26px rgba(34,211,238,.4)}\n.index-page .ant-row>.ant-col:nth-child(4n+3) .ov-tile-icon{background:linear-gradient(135deg,#f472b6,#8b6cff);box-shadow:0 10px 26px rgba(244,114,182,.4)}\n.index-page .ant-row>.ant-col:nth-child(4n+4) .ov-tile-icon{background:linear-gradient(135deg,#fbbf24,#f472b6);box-shadow:0 10px 26px rgba(251,191,36,.38)}\n.index-page .ov-kicker{font-size:11px;text-transform:uppercase;opacity:.65}\n.index-page .ov-state{padding:3px 12px;font-weight:600;font-size:12px}\n\n/* progress / gauges */\n.index-page .ant-progress-bg{background:var(--w-grad)!important;border-radius:999px;box-shadow:0 0 14px rgba(139,108,255,.55)}\n.index-page .ant-progress-inner{background:rgba(255,255,255,.08)!important;border-radius:999px}\nbody.light .index-page .ant-progress-inner{background:rgba(109,74,255,.1)!important}\n.index-page .ant-progress-circle .ant-progress-circle-path{stroke:url(#wd-grad)!important;filter:drop-shadow(0 0 7px rgba(139,108,255,.65));stroke-linecap:round}\n.index-page .ant-progress-circle .ant-progress-circle-trail{stroke:rgba(255,255,255,.09)!important}\nbody.light .index-page .ant-progress-circle .ant-progress-circle-trail{stroke:rgba(109,74,255,.12)!important}\n.index-page .ant-progress-text{font-weight:800!important}\n.index-page .ant-progress-status-exception .ant-progress-bg{background:linear-gradient(90deg,#fb7185,#f472b6)!important}\n\n/* tags, buttons, tables */\n.index-page .ant-tag{border-radius:999px!important;padding:2px 12px!important;font-weight:600;border-width:1px;backdrop-filter:blur(6px)}\n.index-page .ant-btn{border-radius:12px!important;font-weight:600;transition:all .22s}\n.index-page .ant-btn-primary{background:var(--w-grad)!important;border:0!important;box-shadow:0 10px 26px rgba(139,108,255,.4)}\n.index-page .ant-btn-primary:hover{transform:translateY(-2px);box-shadow:0 14px 34px rgba(139,108,255,.55)}\n.index-page .ant-btn:not(.ant-btn-primary):hover{transform:translateY(-1px)}\n.index-page .ant-table{background:transparent!important}\n.index-page .ant-table-thead>tr>th{background:rgba(139,108,255,.1)!important;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:700;border:0!important}\n.index-page .ant-table-thead>tr>th:first-child{border-radius:12px 0 0 12px!important}.index-page .ant-table-thead>tr>th:last-child{border-radius:0 12px 12px 0!important}\n.index-page .ant-table-tbody>tr>td{border-color:rgba(255,255,255,.06)!important}\nbody.light .index-page .ant-table-tbody>tr>td{border-color:rgba(109,74,255,.08)!important}\n.index-page .ant-table-tbody>tr:hover>td{background:rgba(139,108,255,.09)!important}\n.index-page .ant-statistic-content-value,.index-page .ant-statistic-content{font-weight:800}\n.index-page .ant-switch-checked{background:var(--w-grad)!important}\n.index-page .ant-tabs-ink-bar{background:var(--w-grad)!important;height:3px;border-radius:3px}\n.index-page .ant-divider{border-color:rgba(255,255,255,.08)!important}\n.index-page canvas,.index-page svg.chart,.index-page .vue-apexcharts{filter:drop-shadow(0 8px 20px rgba(139,108,255,.25))}\n.index-page ::-webkit-scrollbar{width:8px;height:8px}.index-page ::-webkit-scrollbar-thumb{background:rgba(139,108,255,.4);border-radius:8px}\n@media(max-width:768px){.wd-hero{padding:18px;border-radius:20px}.wd-hero h2{font-size:21px}.index-page .ov-tile-number{font-size:24px}.index-page .ant-card{border-radius:20px!important}}\n@media(prefers-reduced-motion:reduce){.index-page *,.wd-hero{animation:none!important}}\n";
THEME_JS += "\n/* ---- WALENCYA dashboard pro (runs only on the dashboard page) ---- */\n(function(){\n  var pad=function(n){return n<10?'0'+n:n};\n  function greet(){var h=new Date().getHours();return h<5?'Good night':h<12?'Good morning':h<18?'Good afternoon':'Good evening'}\n  function svgDefs(){\n    if(document.getElementById('wd-defs'))return;\n    var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.id='wd-defs';s.setAttribute('width','0');s.setAttribute('height','0');s.style.cssText='position:absolute;width:0;height:0';\n    s.innerHTML='<defs><linearGradient id=\"wd-grad\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#8b6cff\"/><stop offset=\"1\" stop-color=\"#22d3ee\"/></linearGradient></defs>';\n    document.body.appendChild(s);\n  }\n  function dash(){\n    var page=document.querySelector('.index-page');if(!page)return;\n    svgDefs();\n    var area=page.querySelector('.content-area')||page;\n    var hero=area.querySelector('.wd-hero');\n    if(!hero){\n      hero=document.createElement('div');hero.className='wd-hero';\n      hero.innerHTML='<div><small>WALENCYA · Dashboard</small><h2 data-g></h2><p>Live overview of your server, Xray core and traffic.</p></div><div class=\"wd-hero-side\"><span class=\"wd-pill\"><i></i>System online</span><span class=\"wd-clock\" data-c></span></div>';\n      area.insertBefore(hero,area.firstChild);\n    }\n    var g=hero.querySelector('[data-g]');if(g)g.textContent=greet()+', Admin 👋';\n  }\n  function tick(){var c=document.querySelector('.wd-clock');if(c){var d=new Date();c.textContent=pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())}}\n  var t;new MutationObserver(function(){clearTimeout(t);t=setTimeout(dash,80)}).observe(document.documentElement,{childList:true,subtree:true});\n  document.addEventListener('DOMContentLoaded',dash);dash();setInterval(tick,1000);\n})();\n";
const SUB_HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"robots\" content=\"noindex,nofollow\"><meta name=\"theme-color\" content=\"#7c5cff\">\n<title>__BRAND__ · Subscription</title>\n<link rel=\"icon\" href=\"/walencya/icon.svg\" type=\"image/svg+xml\">\n<style>\n:root{--v:#8b6cff;--c:#22d3ee;--grad:linear-gradient(135deg,#8b6cff,#5b8cff 55%,#22d3ee);--r:22px;\n --bg:#07071a;--fg:#eeedff;--mut:rgba(224,222,255,.62);--card:rgba(255,255,255,.055);--line:rgba(255,255,255,.12);--card2:rgba(255,255,255,.04);--shadow:0 30px 80px rgba(4,2,30,.55);--ok:#34d399;--warn:#fbbf24;--bad:#fb7185;\n --font:\"Inter\",\"Segoe UI\",\"Vazirmatn\",\"SF Pro Text\",Tahoma,system-ui,-apple-system,sans-serif}\n:root[data-theme=light]{--bg:#f1efff;--fg:#1c1840;--mut:rgba(28,24,64,.62);--card:rgba(255,255,255,.78);--line:rgba(80,50,200,.16);--card2:rgba(109,74,255,.05);--shadow:0 24px 60px rgba(90,60,200,.16);--v:#6d4aff}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}\nhtml,body{margin:0;min-height:100%}\nbody{background:var(--bg);color:var(--fg);font-family:var(--font);-webkit-font-smoothing:antialiased;overflow-x:hidden}\n.orb{position:fixed;border-radius:50%;filter:blur(90px);opacity:.55;pointer-events:none;z-index:0}\n.o1{width:560px;height:560px;left:-160px;top:-160px;background:radial-gradient(circle,rgba(139,108,255,.6),transparent 70%);animation:fl 18s ease-in-out infinite alternate}\n.o2{width:520px;height:520px;right:-140px;bottom:-140px;background:radial-gradient(circle,rgba(34,211,238,.45),transparent 70%);animation:fl 22s ease-in-out infinite alternate-reverse}\n:root[data-theme=light] .orb{opacity:.35}\n@keyframes fl{to{transform:translate(60px,40px) scale(1.15)}}\n.wrap{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:22px 16px 60px}\n.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}\n.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:.3em;font-size:15px}\n.brand img{width:38px;height:38px;border-radius:12px;box-shadow:0 8px 26px rgba(139,108,255,.55)}\n.brand span{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n.tools{display:flex;gap:8px}\n.pill{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:8px 14px;font:600 13px var(--font);cursor:pointer;backdrop-filter:blur(12px);display:inline-flex;align-items:center;gap:8px;transition:.2s}\n.pill:hover{border-color:var(--v);transform:translateY(-1px)}\n.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);backdrop-filter:blur(20px) saturate(140%);-webkit-backdrop-filter:blur(20px) saturate(140%);box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.07);position:relative;overflow:hidden}\n.hero{padding:26px;display:grid;grid-template-columns:1fr auto;gap:24px;align-items:center;animation:in .7s ease both}\n@keyframes in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}\n.who{display:flex;align-items:center;gap:16px;min-width:0}\n.avatar{width:62px;height:62px;border-radius:20px;background:var(--grad);display:grid;place-items:center;font-size:26px;font-weight:800;color:#fff;box-shadow:0 14px 36px rgba(110,90,255,.5);flex:none}\n.who h1{margin:0;font-size:24px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.who small{display:block;margin-top:5px;color:var(--mut);font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis}\n.chip{display:inline-flex;align-items:center;gap:7px;margin-top:10px;padding:5px 13px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.04em;border:1px solid currentColor;background:color-mix(in srgb,currentColor 14%,transparent)}\n.chip i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor}\n.s-active,.s-unlimited{color:var(--ok)}.s-expired,.s-depleted,.s-disabled{color:var(--bad)}.s-warn{color:var(--warn)}\n.ring{position:relative;width:150px;height:150px}\n.ring svg{width:100%;height:100%;transform:rotate(-90deg)}\n.ring .bg{stroke:var(--line)}.ring .fg{stroke:url(#g);stroke-linecap:round;transition:stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)}\n.ring .mid{position:absolute;inset:0;display:grid;place-content:center;text-align:center}\n.ring b{font-size:27px;font-weight:800;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n.ring small{color:var(--mut);font-size:11px;letter-spacing:.1em;text-transform:uppercase}\n.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0 18px;animation:in .7s .08s ease both}\n.stat{padding:16px 18px;border-radius:18px}\n.stat small{display:block;color:var(--mut);font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px}\n.stat b{font-size:19px;font-weight:800;display:block;line-height:1.35}.stat b.sm{font-size:15px}\n.stat em{display:block;font-style:normal;color:var(--mut);font-size:12px;margin-top:4px}\n.tabs{display:flex;gap:6px;padding:6px;background:var(--card2);border:1px solid var(--line);border-radius:18px;margin-bottom:14px;animation:in .7s .14s ease both;width:max-content;max-width:100%;overflow:auto}\n.tab{border:0;background:transparent;color:var(--mut);font:700 14px var(--font);padding:10px 20px;border-radius:13px;cursor:pointer;transition:.2s;white-space:nowrap}\n.tab.on{background:var(--grad);color:#fff;box-shadow:0 10px 26px rgba(110,90,255,.4)}\n.tab sup{font-size:10px;opacity:.8;margin-inline-start:5px}\n.panel{display:none;animation:in .45s ease both}.panel.on{display:block}\n.pad{padding:20px}\n.row{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:16px;background:var(--card2);border:1px solid var(--line);margin-bottom:10px}\n.row:last-child{margin-bottom:0}\n.row .ic{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;font-weight:800;color:#fff;flex:none;font-size:14px;background:var(--grad)}\n.row .tx{flex:1;min-width:0}\n.row .tx b{display:block;font-size:14px;margin-bottom:3px}\n.row .tx code{display:block;font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:left}\n.btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:12px;height:40px;padding:0 15px;font:700 13px var(--font);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;transition:.2s;text-decoration:none;white-space:nowrap}\n.btn:hover{border-color:var(--v);transform:translateY(-1px)}\n.btn.pri{background:var(--grad);border:0;color:#fff;box-shadow:0 10px 26px rgba(110,90,255,.4)}\n.btn.sq{width:40px;padding:0}\n.acts{display:flex;gap:8px;flex:none}\n.plat{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}\n.apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}\n.app{display:flex;align-items:center;gap:12px;padding:14px;border-radius:16px;background:var(--card2);border:1px solid var(--line);color:var(--fg);text-decoration:none;font-weight:700;transition:.2s}\n.app:hover{border-color:var(--v);transform:translateY(-2px);box-shadow:0 14px 34px rgba(110,90,255,.2)}\n.app .ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:800}\n.app small{display:block;color:var(--mut);font-weight:500;font-size:11px;margin-top:2px}\n.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.06em;margin-inline-end:6px;border:1px solid var(--line);background:var(--card2);vertical-align:middle}\n.t-vless{color:#a78bfa}.t-vmess{color:#60a5fa}.t-trojan{color:#f472b6}.t-reality{color:#22d3ee}.t-ws{color:#34d399}\n.hint{color:var(--mut);font-size:13px;line-height:1.7;margin:0 0 14px}\n.foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:22px;color:var(--mut);font-size:12px}\n.foot a{color:inherit}\n.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,30px);opacity:0;background:var(--grad);color:#fff;padding:11px 22px;border-radius:999px;font-weight:700;font-size:14px;box-shadow:0 14px 40px rgba(110,90,255,.5);transition:.3s;z-index:20;pointer-events:none}\n.toast.on{opacity:1;transform:translate(-50%,0)}\n.modal{position:fixed;inset:0;background:rgba(4,2,20,.7);backdrop-filter:blur(8px);display:none;place-items:center;z-index:10;padding:18px}\n.modal.on{display:grid}\n.mbox{background:var(--card);border:1px solid var(--line);border-radius:26px;padding:24px;text-align:center;max-width:380px;width:100%;box-shadow:var(--shadow);backdrop-filter:blur(26px);animation:in .3s ease both}\n:root:not([data-theme=light]) .mbox{background:rgba(20,20,52,.92)}\n.qr{background:#fff;border-radius:18px;padding:14px;margin:0 auto 14px;width:100%;max-width:300px}\n.qr svg{display:block;width:100%;height:auto}\n.mbox h3{margin:0 0 14px;font-size:15px;word-break:break-word}\n.err{padding:60px 24px;text-align:center}.err h2{font-size:30px;margin:16px 0 8px}.err p{color:var(--mut)}\n.err .big{font-size:84px;font-weight:800;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;letter-spacing:.06em}\n[dir=rtl] .row .tx code{direction:ltr;text-align:left}\n@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}.hero{grid-template-columns:1fr;text-align:center;padding:22px 18px}.who{flex-direction:column;text-align:center}.ring{margin:0 auto}.row{flex-wrap:wrap}.row .acts{width:100%}.row .acts .btn{flex:1}.btn.sq{flex:0 0 40px!important}.brand{letter-spacing:.2em}}\n</style></head><body>\n<div class=\"orb o1\"></div><div class=\"orb o2\"></div>\n<div class=\"wrap\" id=\"root\"></div>\n<div class=\"modal\" id=\"modal\"><div class=\"mbox\"><h3 id=\"mt\"></h3><div class=\"qr\" id=\"mq\"></div><div style=\"display:flex;gap:8px;justify-content:center\"><button class=\"btn pri\" id=\"mc\"></button><button class=\"btn\" id=\"mx\"></button></div></div></div>\n<div class=\"toast\" id=\"toast\"></div>\n<script>\n(function(){\nvar D=/*__DATA__*/null;\nvar BR=\"__BRAND__\";\nvar I18={\nen:{sub:\"Subscription\",active:\"Active\",unlimited:\"Unlimited\",expired:\"Expired\",depleted:\"Depleted\",disabled:\"Disabled\",usage:\"Data used\",left:\"Remaining\",down:\"Download\",up:\"Upload\",exp:\"Expires\",never:\"Never\",days:\"days left\",last:\"Last seen\",online:\"Online now\",never2:\"—\",tLinks:\"Subscription\",tApps:\"Apps\",tCfg:\"Configs\",copy:\"Copy\",copied:\"Copied!\",qr:\"QR code\",close:\"Close\",open:\"Open in app\",std:\"Universal link\",json:\"Xray JSON\",clash:\"Clash / Meta\",hintL:\"Paste one of these links in your client app, or scan the QR code. Your configs update automatically.\",hintA:\"Tap an app to import this subscription in one step. Don't have it yet? Install it first, then come back and tap again.\",copyAll:\"Copy all configs\",upd:\"Auto-updates every {n} h\",support:\"Support\",nf:\"Link not found\",nfp:\"This subscription link is invalid, expired or has been removed. Please contact your provider.\",android:\"Android\",ios:\"iOS\",desktop:\"Desktop\",desk:\"On desktop, copy the universal link and add it as a remote profile in your client (Hiddify, v2rayN, Clash Verge, Streisand…).\",total:\"of {t}\",unl:\"No limit\",lang:\"فارسی\",theme:\"Theme\",ann:\"Notice\"},\nfa:{sub:\"اشتراک\",active:\"فعال\",unlimited:\"نامحدود\",expired:\"منقضی شده\",depleted:\"حجم تمام شده\",disabled:\"غیرفعال\",usage:\"حجم مصرفی\",left:\"باقی‌مانده\",down:\"دانلود\",up:\"آپلود\",exp:\"انقضا\",never:\"بدون انقضا\",days:\"روز مانده\",last:\"آخرین اتصال\",online:\"آنلاین\",never2:\"—\",tLinks:\"لینک اشتراک\",tApps:\"برنامه‌ها\",tCfg:\"کانفیگ‌ها\",copy:\"کپی\",copied:\"کپی شد!\",qr:\"کد QR\",close:\"بستن\",open:\"باز کردن در برنامه\",std:\"لینک عمومی\",json:\"Xray JSON\",clash:\"Clash / Meta\",hintL:\"یکی از این لینک‌ها را در برنامه‌ی کلاینت وارد کنید یا کد QR را اسکن کنید. کانفیگ‌ها خودکار به‌روز می‌شوند.\",hintA:\"روی برنامه بزنید تا اشتراک با یک لمس اضافه شود. اگر برنامه را ندارید ابتدا نصب کنید و دوباره برگردید.\",copyAll:\"کپی همه کانفیگ‌ها\",upd:\"به‌روزرسانی خودکار هر {n} ساعت\",support:\"پشتیبانی\",nf:\"لینک پیدا نشد\",nfp:\"این لینک اشتراک نامعتبر است، منقضی شده یا حذف شده است. لطفاً با ارائه‌دهنده تماس بگیرید.\",android:\"اندروید\",ios:\"آیفون\",desktop:\"دسکتاپ\",desk:\"در دسکتاپ، لینک عمومی را کپی کنید و در برنامه‌تان (Hiddify، v2rayN، Clash Verge، Streisand و…) به‌عنوان پروفایل از راه دور اضافه کنید.\",total:\"از {t}\",unl:\"بدون محدودیت\",lang:\"English\",theme:\"تم\",ann:\"اطلاعیه\"}};\nfunction lsg(k){try{return localStorage.getItem(k)}catch(e){return null}}function lss(k,v){try{localStorage.setItem(k,v)}catch(e){}}\nvar lang=lsg(\"wal-lang\")||((navigator.language||\"\").toLowerCase().indexOf(\"fa\")===0?\"fa\":\"en\");\nvar theme=lsg(\"wal-theme\")||\"dark\";\nfunction T(k,r){var s=(I18[lang]&&I18[lang][k])||I18.en[k]||k;if(r)for(var x in r)s=s.replace(\"{\"+x+\"}\",r[x]);return s}\nfunction h(tag,a,kids){var e=document.createElement(tag);if(a)for(var k in a){if(k===\"class\")e.className=a[k];else if(k===\"text\")e.textContent=a[k];else if(k.slice(0,2)===\"on\")e.addEventListener(k.slice(2),a[k]);else e.setAttribute(k,a[k])}\n (kids||[]).forEach(function(c){if(c==null)return;e.appendChild(typeof c===\"string\"?document.createTextNode(c):c)});return e}\nvar NS=\"http://www.w3.org/2000/svg\";\nfunction toast(m){var t=document.getElementById(\"toast\");t.textContent=m;t.classList.add(\"on\");clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.remove(\"on\")},1600)}\nfunction copy(text,msg){var done=function(){toast(msg||T(\"copied\"))};\n if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(done,fb)}else fb();\n function fb(){var ta=h(\"textarea\",{style:\"position:fixed;opacity:0\"});ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand(\"copy\")}catch(e){}document.body.removeChild(ta);done()}}\n/* ---------------- QR encoder (byte mode, ECC L) ---------------- */\nvar QR=(function(){\n var ECC=[-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30];\n var BLK=[-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25];\n function raw(v){var r=(16*v+128)*v+64;if(v>=2){var n=Math.floor(v/7)+2;r-=(25*n-10)*n-55;if(v>=7)r-=36}return r}\n function ndata(v){return Math.floor(raw(v)/8)-ECC[v]*BLK[v]}\n function mul(x,y){var z=0;for(var i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11D);z^=((y>>>i)&1)*x}return z}\n function rsDiv(data,deg){var res=[],i;for(i=0;i<deg;i++)res.push(0);var root=1,gen=res.slice();gen[deg-1]=1;\n  var g=[];for(i=0;i<deg;i++)g.push(0);g[deg-1]=1;\n  for(i=0;i<deg;i++){for(var j=0;j<deg;j++){g[j]=mul(g[j],root);if(j+1<deg)g[j]^=g[j+1]}root=mul(root,2)}\n  data.forEach(function(b){var f=b^res.shift();res.push(0);for(var k=0;k<deg;k++)res[k]^=mul(g[k],f)});return res}\n function bit(x,i){return((x>>>i)&1)!==0}\n return function(text){\n  var bytes=Array.prototype.slice.call(new TextEncoder().encode(text));\n  var ver,cap;for(ver=1;ver<=40;ver++){var cc=ver<10?8:16;var used=4+cc+bytes.length*8;if(used<=ndata(ver)*8)break}\n  if(ver>21)return null;\n  var bits=[];function put(v,n){for(var i=n-1;i>=0;i--)bits.push((v>>>i)&1)}\n  put(4,4);put(bytes.length,ver<10?8:16);bytes.forEach(function(b){put(b,8)});\n  var cap8=ndata(ver)*8;put(0,Math.min(4,cap8-bits.length));put(0,(8-bits.length%8)%8);\n  for(var pb=0xEC;bits.length<cap8;pb^=0xEC^0x11)put(pb,8);\n  var data=[];for(var i=0;i<bits.length;i+=8){var b=0;for(var j=0;j<8;j++)b=(b<<1)|bits[i+j];data.push(b)}\n  var nb=BLK[ver],el=ECC[ver],rc=Math.floor(raw(ver)/8),ns=nb-rc%nb,sl=Math.floor(rc/nb),blocks=[],k=0;\n  for(i=0;i<nb;i++){var dl=sl-el+(i<ns?0:1);var dat=data.slice(k,k+dl);k+=dl;var ec=rsDiv(dat,el);if(i<ns)dat.push(0);blocks.push(dat.concat(ec))}\n  var all=[];for(i=0;i<blocks[0].length;i++)for(j=0;j<blocks.length;j++)if(i!==sl-el||j>=ns)all.push(blocks[j][i]);\n  var size=ver*4+17,m=[],fn=[];for(i=0;i<size;i++){m.push(new Array(size).fill(false));fn.push(new Array(size).fill(false))}\n  function setFn(x,y,v){m[y][x]=v;fn[y][x]=true}\n  for(i=0;i<size;i++){setFn(6,i,i%2===0);setFn(i,6,i%2===0)}\n  function finder(x,y){for(var dy=-4;dy<=4;dy++)for(var dx=-4;dx<=4;dx++){var d=Math.max(Math.abs(dx),Math.abs(dy)),xx=x+dx,yy=y+dy;if(xx>=0&&xx<size&&yy>=0&&yy<size)setFn(xx,yy,d!==2&&d!==4)}}\n  finder(3,3);finder(size-4,3);finder(3,size-4);\n  var ap=[];if(ver>1){var na=Math.floor(ver/7)+2,step=ver===32?26:Math.ceil((ver*4+4)/(na*2-2))*2;ap=[6];for(var pos=size-7;ap.length<na;pos-=step)ap.splice(1,0,pos)}\n  for(i=0;i<ap.length;i++)for(j=0;j<ap.length;j++){if((i===0&&j===0)||(i===0&&j===ap.length-1)||(i===ap.length-1&&j===0))continue;\n   for(var dy=-2;dy<=2;dy++)for(var dx=-2;dx<=2;dx++)setFn(ap[i]+dx,ap[j]+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1)}\n  function fmt(mask){var d=(1<<3)|mask,r=d;for(var q=0;q<10;q++)r=(r<<1)^((r>>>9)*0x537);var b=((d<<10)|r)^0x5412,t;\n   for(t=0;t<=5;t++)setFn(8,t,bit(b,t));setFn(8,7,bit(b,6));setFn(8,8,bit(b,7));setFn(7,8,bit(b,8));for(t=9;t<15;t++)setFn(14-t,8,bit(b,t));\n   for(t=0;t<8;t++)setFn(size-1-t,8,bit(b,t));for(t=8;t<15;t++)setFn(8,size-15+t,bit(b,t));setFn(8,size-8,true)}\n  fmt(0);\n  if(ver>=7){var r=ver;for(i=0;i<12;i++)r=(r<<1)^((r>>>11)*0x1F25);var vb=(ver<<12)|r;for(i=0;i<18;i++){var bt=bit(vb,i),a=size-11+i%3,b2=Math.floor(i/3);setFn(a,b2,bt);setFn(b2,a,bt)}}\n  var idx=0;for(var right=size-1;right>=1;right-=2){if(right===6)right=5;for(var vert=0;vert<size;vert++)for(j=0;j<2;j++){var x=right-j,up=((right+1)&2)===0,y=up?size-1-vert:vert;if(!fn[y][x]&&idx<all.length*8){m[y][x]=bit(all[idx>>>3],7-(idx&7));idx++}}}\n  function maskf(mk,x,y){switch(mk){case 0:return(x+y)%2===0;case 1:return y%2===0;case 2:return x%3===0;case 3:return(x+y)%3===0;case 4:return(Math.floor(x/3)+Math.floor(y/2))%2===0;case 5:return x*y%2+x*y%3===0;case 6:return(x*y%2+x*y%3)%2===0;default:return((x+y)%2+x*y%3)%2===0}}\n  function apply(mk){for(var y=0;y<size;y++)for(var x=0;x<size;x++)if(!fn[y][x]&&maskf(mk,x,y))m[y][x]=!m[y][x]}\n  function pen(){var p=0,x,y,run,dark=0;\n   for(y=0;y<size;y++){run=1;for(x=1;x<size;x++){if(m[y][x]===m[y][x-1]){run++;if(run===5)p+=3;else if(run>5)p++}else run=1}}\n   for(x=0;x<size;x++){run=1;for(y=1;y<size;y++){if(m[y][x]===m[y-1][x]){run++;if(run===5)p+=3;else if(run>5)p++}else run=1}}\n   for(y=0;y<size-1;y++)for(x=0;x<size-1;x++){var c=m[y][x];if(c===m[y][x+1]&&c===m[y+1][x]&&c===m[y+1][x+1])p+=3}\n   var pat=[1,0,1,1,1,0,1];\n   function find(get){for(var s=0;s<size;s++)for(var t=0;t<=size-7;t++){var ok=true;for(var u=0;u<7;u++)if((get(s,t+u)?1:0)!==pat[u]){ok=false;break}if(ok){var l=true,r=true;for(u=1;u<=4;u++){if(t-u>=0&&get(s,t-u))l=false;if(t+6+u<size&&get(s,t+6+u))r=false}if(l||r)p+=40}}}\n   find(function(a,b){return m[a][b]});find(function(a,b){return m[b][a]});\n   for(y=0;y<size;y++)for(x=0;x<size;x++)if(m[y][x])dark++;var k=Math.ceil(Math.abs(dark*20-size*size*10)/(size*size))-1;p+=Math.max(0,k)*10;return p}\n  var best=0,bp=1e9;for(var mk=0;mk<8;mk++){apply(mk);fmt(mk);var pv=pen();if(pv<bp){bp=pv;best=mk}apply(mk)}\n  apply(best);fmt(best);return m}})();\nfunction qrSvg(text){var m=QR(text);if(!m)return null;var n=m.length,q=4,d=\"\";\n for(var y=0;y<n;y++){var x=0;while(x<n){if(m[y][x]){var s=x;while(x<n&&m[y][x])x++;d+=\"M\"+(s+q)+\" \"+(y+q)+\"h\"+(x-s)+\"v1h-\"+(x-s)+\"z\"}else x++}}\n var s=document.createElementNS(NS,\"svg\");s.setAttribute(\"viewBox\",\"0 0 \"+(n+2*q)+\" \"+(n+2*q));s.setAttribute(\"shape-rendering\",\"crispEdges\");\n var r=document.createElementNS(NS,\"rect\");r.setAttribute(\"width\",\"100%\");r.setAttribute(\"height\",\"100%\");r.setAttribute(\"fill\",\"#fff\");s.appendChild(r);\n var p=document.createElementNS(NS,\"path\");p.setAttribute(\"d\",d);p.setAttribute(\"fill\",\"#0b0b24\");s.appendChild(p);return s}\nfunction showQr(text,title){var mq=document.getElementById(\"mq\");mq.textContent=\"\";var s=qrSvg(text);if(!s){toast(\"Too long for QR\");return}mq.appendChild(s);\n document.getElementById(\"mt\").textContent=title||\"\";document.getElementById(\"mc\").textContent=T(\"copy\");document.getElementById(\"mx\").textContent=T(\"close\");\n document.getElementById(\"mc\").onclick=function(){copy(text)};document.getElementById(\"modal\").classList.add(\"on\")}\ndocument.getElementById(\"mx\").onclick=function(){document.getElementById(\"modal\").classList.remove(\"on\")};\ndocument.getElementById(\"modal\").addEventListener(\"click\",function(e){if(e.target===this)this.classList.remove(\"on\")});\n/* ---------------- helpers ---------------- */\nfunction fmtBytes(b){if(!b)return\"0 B\";var u=[\"B\",\"KB\",\"MB\",\"GB\",\"TB\"],i=Math.min(4,Math.floor(Math.log(b)/Math.log(1024)));var v=b/Math.pow(1024,i);return nf(v>=100||i===0?Math.round(v):v.toFixed(2))+\" \"+u[i]}\nfunction nf(n){try{return new Intl.NumberFormat(lang===\"fa\"?\"fa-IR\":\"en-US\",{maximumFractionDigits:2}).format(Number(n))}catch(e){return String(n)}}\nfunction df(ms){try{return new Intl.DateTimeFormat(lang===\"fa\"?\"fa-IR-u-ca-persian\":\"en-GB\",{year:\"numeric\",month:\"short\",day:\"numeric\",hour:\"2-digit\",minute:\"2-digit\"}).format(new Date(ms))}catch(e){return new Date(ms).toLocaleString()}}\nfunction parseLink(l){var proto=(l.split(\":\")[0]||\"\").toLowerCase(),remark=\"\",net=\"\",sec=\"\";\n try{if(proto===\"vmess\"){var j=JSON.parse(atob(l.slice(8)));remark=j.ps||\"\";net=j.net||\"\";sec=j.tls||\"\"}\n else{var hi=l.indexOf(\"#\");if(hi>-1)remark=decodeURIComponent(l.slice(hi+1));var qi=l.indexOf(\"?\");if(qi>-1){var qs=new URLSearchParams(l.slice(qi+1,hi>-1?hi:undefined));net=qs.get(\"type\")||\"\";sec=qs.get(\"security\")||\"\"}}}catch(e){}\n return{proto:proto,remark:remark||proto.toUpperCase(),net:net,sec:sec}}\nfunction status(){var now=Date.now(),exp=(D.expire||0)*1000,tot=D.totalByte||0,used=(D.usedByte||0)||((D.downloadByte||0)+(D.uploadByte||0));\n if(!D.enabled)return\"disabled\";if(exp>0&&now>=exp)return\"expired\";if(tot>0&&used>=tot)return\"depleted\";if(tot<=0&&exp===0)return\"unlimited\";return\"active\"}\nfunction mkApps(){var u=D.subUrl,e=encodeURIComponent(u),n=encodeURIComponent(D.sId||BR),t=encodeURIComponent(D.subTitle||BR);\n var A={hiddify:[\"Hiddify\",\"hiddify://import/\"+u+\"#\"+t,\"#7c5cff\"],v2box:[\"V2Box\",\"v2box://install-sub?url=\"+e+\"&name=\"+n,\"#0ea5e9\"],ng:[\"v2rayNG\",\"v2rayng://install-config?url=\"+e,\"#22c55e\"],sing:[\"Sing-box\",\"sing-box://import-remote-profile?url=\"+e+\"#\"+t,\"#f59e0b\"],tun:[\"V2RayTun\",\"v2raytun://import/\"+u,\"#ec4899\"],happ:[\"Happ\",\"happ://add/\"+u,\"#6366f1\"],incy:[\"Incy\",\"incy://add/\"+u,\"#14b8a6\"],str:[\"Streisand\",\"streisand://import/\"+e,\"#f43f5e\"],rocket:[\"Shadowrocket\",\"shadowrocket://add/sub://\"+btoa(u+(u.indexOf(\"?\")>-1?\"&\":\"?\")+\"flag=shadowrocket\")+\"?remark=\"+t,\"#3b82f6\"]};\n return{android:[A.hiddify,A.ng,A.v2box,A.sing,A.tun,A.happ],ios:[A.str,A.rocket,A.hiddify,A.v2box,A.sing,A.happ,A.tun,A.incy]}}\n/* ---------------- render ---------------- */\nfunction render(){\n document.documentElement.setAttribute(\"data-theme\",theme);document.documentElement.lang=lang;document.documentElement.dir=lang===\"fa\"?\"rtl\":\"ltr\";\n var root=document.getElementById(\"root\");root.textContent=\"\";\n var top=h(\"div\",{class:\"top\"},[h(\"div\",{class:\"brand\"},[h(\"img\",{src:\"/walencya/icon.svg\",alt:\"\"}),h(\"span\",{text:BR})]),\n  h(\"div\",{class:\"tools\"},[h(\"button\",{class:\"pill\",onclick:function(){lang=lang===\"fa\"?\"en\":\"fa\";lss(\"wal-lang\",lang);render()},text:T(\"lang\")}),\n  h(\"button\",{class:\"pill\",title:T(\"theme\"),onclick:function(){theme=theme===\"dark\"?\"light\":\"dark\";lss(\"wal-theme\",theme);render()},text:theme===\"dark\"?\"☾\":\"☀\"})])]);\n root.appendChild(top);\n if(!D||D.__error){root.appendChild(h(\"div\",{class:\"card err\"},[h(\"div\",{class:\"big\",text:\"404\"}),h(\"h2\",{text:T(\"nf\")}),h(\"p\",{text:T(\"nfp\")})]));return}\n var st=status(),exp=(D.expire||0)*1000,tot=D.totalByte||0,used=(D.usedByte||0)||((D.downloadByte||0)+(D.uploadByte||0));\n var name=(D.emails&&D.emails[0])||D.subTitle||D.sId||BR;\n var pct=tot>0?Math.min(100,used/tot*100):0;\n var circ=2*Math.PI*52,ring=document.createElementNS(NS,\"svg\");ring.setAttribute(\"viewBox\",\"0 0 120 120\");\n ring.innerHTML='<defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#8b6cff\"/><stop offset=\"1\" stop-color=\"#22d3ee\"/></linearGradient></defs><circle class=\"bg\" cx=\"60\" cy=\"60\" r=\"52\" fill=\"none\" stroke-width=\"10\"/><circle class=\"fg\" cx=\"60\" cy=\"60\" r=\"52\" fill=\"none\" stroke-width=\"10\" stroke-dasharray=\"'+circ+'\" stroke-dashoffset=\"'+circ+'\"/>';\n var fg=ring.querySelector(\".fg\");setTimeout(function(){fg.style.strokeDashoffset=String(circ*(1-(tot>0?pct/100:1)))},60);\n var chipCls=\"chip s-\"+st+((st===\"active\"&&exp>0&&(exp-Date.now())<3*864e5)?\" s-warn\":\"\");\n var hero=h(\"div\",{class:\"card hero\"},[\n  h(\"div\",{class:\"who\"},[h(\"div\",{class:\"avatar\",text:(name[0]||\"W\").toUpperCase()}),h(\"div\",{style:\"min-width:0\"},[h(\"h1\",{text:name,dir:\"auto\"}),h(\"small\",{text:D.sId||\"\"}),h(\"span\",{class:chipCls},[h(\"i\"),T(st)])])]),\n  h(\"div\",{class:\"ring\"},[ring,h(\"div\",{class:\"mid\"},[h(\"b\",{text:tot>0?nf(Math.round(pct))+\"%\":\"∞\"}),h(\"small\",{text:T(\"usage\")})])])]);\n root.appendChild(hero);\n function stat(l,v,s,sm){return h(\"div\",{class:\"card stat\"},[h(\"small\",{text:l}),h(\"b\",{text:v,class:sm?\"sm\":\"\"}),s?h(\"em\",{text:s}):null])}\n var days=exp>0?Math.max(0,Math.ceil((exp-Date.now())/864e5)):null;\n root.appendChild(h(\"div\",{class:\"stats\"},[\n  stat(T(\"usage\"),fmtBytes(used),tot>0?T(\"total\",{t:fmtBytes(tot)}):T(\"unl\")),\n  stat(T(\"left\"),tot>0?fmtBytes(Math.max(0,tot-used)):\"∞\"),\n  stat(T(\"down\"),fmtBytes(D.downloadByte||0)),stat(T(\"up\"),fmtBytes(D.uploadByte||0)),\n  stat(T(\"exp\"),exp>0?df(exp):T(\"never\"),days!=null?nf(days)+\" \"+T(\"days\"):\"\",exp>0),\n  stat(T(\"last\"),D.isOnline?T(\"online\"):(D.lastOnline>0?df(D.lastOnline):T(\"never2\")),\"\",!D.isOnline&&D.lastOnline>0)]));\n if(D.announce)root.appendChild(h(\"div\",{class:\"card pad\",style:\"margin-bottom:14px\"},[h(\"b\",{text:T(\"ann\")+\": \"}),D.announce]));\n var links=[];(D.links||[]).forEach(function(l){if(links.indexOf(l)<0)links.push(l)});\n var tabs=[[\"l\",T(\"tLinks\")],[\"a\",T(\"tApps\")]];if(links.length)tabs.push([\"c\",T(\"tCfg\"),links.length]);\n var panels={},tabBtns={};\n var bar=h(\"div\",{class:\"tabs\"},tabs.map(function(t){var b=h(\"button\",{class:\"tab\"+(t[0]===\"l\"?\" on\":\"\"),onclick:function(){sel(t[0])}},[t[1],t[2]?h(\"sup\",{text:String(t[2])}):null]);tabBtns[t[0]]=b;return b}));\n function sel(k){for(var x in panels){panels[x].classList.toggle(\"on\",x===k);tabBtns[x].classList.toggle(\"on\",x===k)}}\n root.appendChild(bar);\n function urlRow(ic,title,url){return h(\"div\",{class:\"row\"},[h(\"div\",{class:\"ic\",text:ic}),h(\"div\",{class:\"tx\"},[h(\"b\",{text:title}),h(\"code\",{text:url})]),\n  h(\"div\",{class:\"acts\"},[h(\"button\",{class:\"btn pri\",onclick:function(){copy(url)},text:T(\"copy\")}),h(\"button\",{class:\"btn sq\",title:T(\"qr\"),onclick:function(){showQr(url,title)},text:\"▦\"})])])}\n var pl=h(\"div\",{class:\"card pad panel on\"},[h(\"p\",{class:\"hint\",text:T(\"hintL\")}),urlRow(\"★\",T(\"std\"),D.subUrl),D.subJsonUrl?urlRow(\"{ }\",T(\"json\"),D.subJsonUrl):null,D.subClashUrl?urlRow(\"C\",T(\"clash\"),D.subClashUrl):null]);\n panels.l=pl;\n var apps=mkApps(),ua=navigator.userAgent||\"\",plat=/iphone|ipad|ipod|macintosh/i.test(ua)?\"ios\":\"android\",pa=h(\"div\",{class:\"card pad panel\"}),grid=h(\"div\",{class:\"apps\"});\n function drawApps(){grid.textContent=\"\";(apps[plat]||[]).forEach(function(a){grid.appendChild(h(\"a\",{class:\"app\",href:a[1],rel:\"noopener\"},[h(\"div\",{class:\"ic\",style:\"background:\"+a[2],text:a[0][0]}),h(\"div\",{},[a[0],h(\"small\",{text:T(\"open\")})])]))})}\n var pbar=h(\"div\",{class:\"plat\"},[\"android\",\"ios\"].map(function(p){var b=h(\"button\",{class:\"pill\",style:p===plat?\"background:var(--grad);color:#fff;border:0\":\"\",onclick:function(){plat=p;render2()},text:T(p)});return b}));\n function render2(){pbar.querySelectorAll(\"button\").forEach(function(b,i){var p=[\"android\",\"ios\"][i];b.style.cssText=p===plat?\"background:var(--grad);color:#fff;border:0\":\"\"});drawApps()}\n pa.appendChild(h(\"p\",{class:\"hint\",text:T(\"hintA\")}));pa.appendChild(pbar);pa.appendChild(grid);pa.appendChild(h(\"p\",{class:\"hint\",style:\"margin:16px 0 0\",text:T(\"desk\")}));drawApps();render2();panels.a=pa;\n root.appendChild(pl);root.appendChild(pa);\n if(links.length){var pc=h(\"div\",{class:\"card pad panel\"});\n  pc.appendChild(h(\"div\",{style:\"margin-bottom:12px\"},[h(\"button\",{class:\"btn\",onclick:function(){copy(links.join(\"\\n\"))},text:T(\"copyAll\")})]));\n  links.forEach(function(l){var p=parseLink(l);var tg=[h(\"span\",{class:\"tag t-\"+p.proto,text:p.proto.toUpperCase()})];if(p.net)tg.push(h(\"span\",{class:\"tag t-ws\",text:p.net.toUpperCase()}));if(p.sec&&p.sec!==\"none\")tg.push(h(\"span\",{class:\"tag t-reality\",text:p.sec.toUpperCase()}));\n   pc.appendChild(h(\"div\",{class:\"row\"},[h(\"div\",{class:\"tx\"},[h(\"b\",{dir:\"auto\"},tg.concat([p.remark])),h(\"code\",{text:l})]),h(\"div\",{class:\"acts\"},[h(\"button\",{class:\"btn\",onclick:function(){copy(l)},text:T(\"copy\")}),h(\"button\",{class:\"btn sq\",title:T(\"qr\"),onclick:function(){showQr(l,p.remark)},text:\"▦\"})])]))});\n  panels.c=pc;root.appendChild(pc)}\n var foot=h(\"div\",{class:\"foot\"},[h(\"span\",{text:D.subUpdates>0?T(\"upd\",{n:nf(D.subUpdates)}):\"\"}),D.subSupportUrl?h(\"a\",{href:D.subSupportUrl,target:\"_blank\",rel:\"noopener\",text:T(\"support\")}):h(\"span\",{text:\"Powered by \"+BR})]);\n root.appendChild(foot);\n}\nrender();\nif(window.__walTest)window.__walTest(QR,qrSvg);\nwindow.__QR=QR;\n})();\n</script></body></html>\n";
const SPLASH_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>WALENCYA · starting</title>\n<link rel=\"icon\" href=\"/walencya/icon.svg\">\n<style>\n*{box-sizing:border-box}html,body{height:100%;margin:0}\nbody{display:grid;place-items:center;background:#07071a;color:#e8e8ff;font-family:system-ui,-apple-system,\"Segoe UI\",Tahoma,sans-serif;overflow:hidden}\n.bg{position:fixed;inset:0;background:radial-gradient(600px 400px at 20% 20%,rgba(124,92,255,.35),transparent 60%),radial-gradient(500px 400px at 80% 80%,rgba(34,211,238,.28),transparent 60%);filter:blur(10px);animation:drift 12s ease-in-out infinite alternate}\n@keyframes drift{to{transform:scale(1.15) translate(2%,-2%)}}\n.card{position:relative;text-align:center;padding:44px 48px;border-radius:28px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(18px);box-shadow:0 30px 80px rgba(0,0,0,.5);max-width:92vw}\n.logo{width:76px;height:76px;margin:0 auto 18px;filter:drop-shadow(0 10px 30px rgba(124,92,255,.6))}\nh1{margin:0;font-size:30px;letter-spacing:.32em;font-weight:800;background:linear-gradient(90deg,#a99bff,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent}\np{margin:14px 0 22px;color:#a9a9d6;font-size:15px;min-height:22px}\n.bar{height:5px;width:260px;max-width:70vw;margin:0 auto;border-radius:9px;background:rgba(255,255,255,.1);overflow:hidden}\n.bar i{display:block;height:100%;width:40%;border-radius:9px;background:linear-gradient(90deg,#7c5cff,#22d3ee);animation:slide 1.3s ease-in-out infinite}\n@keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}\n</style></head><body><div class=\"bg\"></div><div class=\"card\">\n<img class=\"logo\" src=\"/walencya/icon.svg\" alt=\"\"><h1>WALENCYA</h1><p id=\"m\">__MSG__</p><div class=\"bar\"><i></i></div></div>\n<script>\n(function(){var m=document.getElementById('m');function t(){fetch('/_wal/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){if(s.ready){location.reload()}else{m.textContent=s.error?('Setup problem: '+s.error):s.message}}).catch(function(){})}setInterval(t,2500)})();\n</script></body></html>\n";
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M14 20 L23 46 L32 28 L41 46 L50 20" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ASSET_VER = etag(THEME_CSS + THEME_JS);

/* ---- tiny PNG icon renderer (no deps) ---- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  if (!crc32.t) { crc32.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.t[n] = c >>> 0; } }
  for (let i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function renderIconPng(S) {
  const raw = Buffer.alloc((S * 4 + 1) * S);
  const pts = [[14, 20], [23, 46], [32, 28], [41, 46], [50, 20]].map(([x, y]) => [x / 64 * S, y / 64 * S]);
  const r = S * 0.25, half = S * 3 / 64;
  const dseg = (px, py, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    let t = ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy); t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
  };
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      const cx = Math.min(Math.max(px, r), S - r), cy = Math.min(Math.max(py, r), S - r);
      const dr = Math.hypot(px - cx, py - cy);
      const alpha = Math.max(0, Math.min(1, r - dr + 0.5));
      const t = (px + py) / (2 * S);
      let R = 124 + (34 - 124) * t, G = 92 + (211 - 92) * t, B = 255 + (238 - 255) * t;
      let d = 1e9; for (let i = 0; i < 4; i++) d = Math.min(d, dseg(px, py, pts[i], pts[i + 1]));
      const w = Math.max(0, Math.min(1, half - d + 0.5));
      R = R + (255 - R) * w; G = G + (255 - G) * w; B = B + (255 - B) * w;
      const o = y * (S * 4 + 1) + 1 + x * 4;
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = Math.round(alpha * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const ICON_CACHE = {};
const iconPng = (S) => ICON_CACHE[S] || (ICON_CACHE[S] = renderIconPng(S));
const MANIFEST = JSON.stringify({
  name: BRAND + " Panel", short_name: BRAND, start_url: "./", scope: "./", display: "standalone",
  background_color: "#0b0b1a", theme_color: "#7c5cff",
  icons: [
    { src: "icons/walencya-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icons/walencya-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "walencya/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});

/* ----------------------- text rewriting (re-brand) ----------------------- */
function rebrand(text, file) {
  let s = text;
  s = s.replace(/https?:\/\/(?:donate|docs)\.sanaei\.dev\/?/g, "#");
  s = s.replace(/https:\/\/github\.com\/MHSanaei\/3x-ui[^"'`\s)<]*/g, "#");
  s = s.replace(/MHSanaei/g, "walencya").replace(/sanaei/gi, "walencya");
  s = s.replace(/3X-UI/g, BRAND).replace(/3x-ui/g, BRAND.toLowerCase());
  s = s.replace(/X-UI/g, BRAND).replace(/x-ui/g, BRAND.toLowerCase());
  if (/\.js(\?|$)/.test(file)) s = s.replace(/`3X`/g, "`W`");
  s = s.replace(/<title>Sign in<\/title>/, "<title>" + BRAND + " · Sign in</title>");
  /* cache-bust: browsers may hold year-long cached copies of the original bundles */
  s = s.replace(/((?:src|href)=")\/assets\//g, "$1/assets/" + AV() + "/");
  if (/\.js(\?|$)/.test(file)) s = s.replace(/\+"assets\//g, '+"assets/' + AV() + '/');
  return s;
}
const REWRITE_CACHE = new Map();
const AV = () => "w" + ASSET_VER;
const injectHead = () =>
  `<link rel="icon" href="/walencya/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#7c5cff">` +
  `<link id="wal-css" rel="stylesheet" href="/walencya/theme.css?v=${ASSET_VER}">` +
  `<script src="/walencya/theme.js?v=${ASSET_VER}" defer></script></head>`;

/* ----------------------------- download / untar ----------------------------- */
function httpsGetStream(url, headers, redirects = 8) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: Object.assign({ "User-Agent": "walencya-katabump/1.0" }, headers || {}) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); resolve(httpsGetStream(new URL(res.headers.location, url).toString(), headers, redirects - 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP " + res.statusCode + " for " + url)); return; }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("timeout " + url)));
  });
}
async function httpsGetText(url) {
  const res = await httpsGetStream(url);
  const chunks = []; for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function makeTarExtractor(dest, filter) {
  let pending = Buffer.alloc(0), cur = null, longName = null, paxPath = null;
  const root = path.resolve(dest);
  const oct = (b) => parseInt(b.toString("latin1").replace(/\0.*$/, "").trim() || "0", 8);
  const str = (b) => b.toString("utf8").replace(/\0.*$/, "");
  function finish() {
    if (cur.fd !== undefined && cur.fd !== null) { fs.closeSync(cur.fd); try { fs.chmodSync(cur.target, cur.mode || 0o644); } catch (e) {} }
    if (cur.kind === "long") longName = Buffer.concat(cur.chunks).toString("utf8").replace(/\0.*$/, "");
    if (cur.kind === "pax") {
      const t = Buffer.concat(cur.chunks).toString("utf8"); const m = /\d+ path=([^\n]*)\n/.exec(t); if (m) paxPath = m[1];
    }
    cur = null;
  }
  function feed(chunk) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (!cur) {
        if (pending.length < 512) return;
        const h = pending.subarray(0, 512); pending = pending.subarray(512);
        if (h.every((b) => b === 0)) continue;
        let name = str(h.subarray(0, 100)); const prefix = str(h.subarray(345, 500));
        if (prefix) name = prefix + "/" + name;
        const size = oct(h.subarray(124, 136)), type = String.fromCharCode(h[156] || 48), mode = oct(h.subarray(100, 108)) & 0o777;
        cur = { kind: "skip", remaining: size, pad: (512 - (size % 512)) % 512, chunks: [], fd: null, mode };
        if (type === "L") cur.kind = "long";
        else if (type === "x") cur.kind = "pax";
        else if (type === "g") cur.kind = "skip";
        else {
          if (longName) { name = longName; longName = null; }
          if (paxPath) { name = paxPath; paxPath = null; }
          const target = path.resolve(root, name);
          const ok = target.startsWith(root + path.sep) || target === root;
          if (ok && type === "5") { mkdirp(target); }
          else if (ok && (type === "0" || type === "\0") && (!filter || filter(name))) {
            mkdirp(path.dirname(target)); cur.kind = "file"; cur.target = target; cur.fd = fs.openSync(target, "w");
          }
        }
        if (cur.remaining === 0 && cur.pad === 0) { finish(); continue; }
      }
      if (cur.remaining > 0) {
        if (!pending.length) return;
        const n = Math.min(cur.remaining, pending.length), part = pending.subarray(0, n);
        if (cur.kind === "file") fs.writeSync(cur.fd, part); else if (cur.kind === "long" || cur.kind === "pax") cur.chunks.push(Buffer.from(part));
        pending = pending.subarray(n); cur.remaining -= n;
        if (cur.remaining > 0) return;
      }
      if (cur.pad > 0) {
        if (pending.length < cur.pad) return;
        pending = pending.subarray(cur.pad); cur.pad = 0;
      }
      finish();
    }
  }
  return new Writable({ write(chunk, enc, cb) { try { feed(chunk); cb(); } catch (e) { cb(e); } } });
}
async function downloadAndExtract(url, dest, filter) {
  const res = await httpsGetStream(url);
  const gunzip = zlib.createGunzip();
  const out = makeTarExtractor(dest, filter);
  await new Promise((resolve, reject) => {
    res.on("error", reject); gunzip.on("error", reject); out.on("error", reject); out.on("finish", resolve);
    res.pipe(gunzip).pipe(out);
  });
}
const archName = () => ({ x64: "amd64", arm64: "arm64", ia32: "386", s390x: "s390x" }[process.arch] || (process.arch === "arm" ? "armv7" : "amd64"));
const ENGINE_BIN = () => path.join(ENGINE_DIR, "x-ui", "x-ui");
const ENGINE_ENV = () => Object.assign({}, process.env, {
  XUI_DB_FOLDER: DATA_DIR, XUI_LOG_FOLDER: LOG_DIR, XUI_BIN_FOLDER: path.join(ENGINE_DIR, "x-ui", "bin"),
  XUI_ENABLE_FAIL2BAN: "false",
});
async function ensureEngine() {
  const marker = path.join(ENGINE_DIR, ".version");
  if (fs.existsSync(ENGINE_BIN()) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === XUI_VERSION) return;
  setPhase("download", `Downloading ${BRAND} engine ${XUI_VERSION} (${archName()})…`);
  fs.rmSync(ENGINE_DIR, { recursive: true, force: true }); mkdirp(ENGINE_DIR);
  const url = `https://github.com/MHSanaei/3x-ui/releases/download/${XUI_VERSION}/x-ui-linux-${archName()}.tar.gz`;
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { await downloadAndExtract(url, ENGINE_DIR, (n) => !/mtg-linux|_RU\.dat/.test(n)); lastErr = null; break; }
    catch (e) { lastErr = e; log("download failed:", e.message); await sleep(3000 * (i + 1)); }
  }
  if (lastErr) throw lastErr;
  for (const f of [ENGINE_BIN(), ...fs.readdirSync(path.join(ENGINE_DIR, "x-ui", "bin")).filter((n) => /^xray-linux/.test(n)).map((n) => path.join(ENGINE_DIR, "x-ui", "bin", n))]) {
    try { fs.chmodSync(f, 0o755); } catch (e) {}
  }
  fs.writeFileSync(marker, XUI_VERSION);
  setPhase("download", "Engine downloaded.");
}
function engineCli(args) {
  const r = spawnSync(ENGINE_BIN(), args, { cwd: path.dirname(ENGINE_BIN()), env: ENGINE_ENV(), encoding: "utf8", timeout: 60000 });
  return (r.stdout || "") + (r.stderr || "");
}

/* --------------------------------- engine process -------------------------------- */
let engineProc = null, engineStopping = false, engineBackoff = 2000;
function startEngine() {
  mkdirp(LOG_DIR);
  const out = fs.openSync(path.join(LOG_DIR, "engine.log"), "a");
  engineProc = spawn(ENGINE_BIN(), [], { cwd: path.dirname(ENGINE_BIN()), env: ENGINE_ENV(), stdio: ["ignore", out, out] });
  engineProc.on("exit", (code, sig) => {
    fs.closeSync(out);
    if (engineStopping) return;
    log(`engine exited (${code || sig}); restarting in ${engineBackoff / 1000}s`);
    setTimeout(startEngine, engineBackoff); engineBackoff = Math.min(engineBackoff * 2, 30000);
  });
  setTimeout(() => { engineBackoff = 2000; }, 60000);
}
async function waitHttp(port, p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode > 0); });
      req.on("error", () => resolve(false)); req.on("timeout", () => { req.destroy(); resolve(false); });
    });
    if (ok) return true; await sleep(700);
  }
  return false;
}

/* -------------------------------- panel API client ------------------------------- */
let API_TOKEN = "";
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port: PANEL_PORT, path: p, method, timeout: 30000,
      headers: Object.assign({ Authorization: "Bearer " + API_TOKEN, "X-Requested-With": "XMLHttpRequest" }, data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
    }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); try { resolve(JSON.parse(t)); } catch (e) { resolve({ success: false, msg: t.slice(0, 200) }); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("api timeout")));
    if (data) req.write(data); req.end();
  });
}

/* ------------------------------ public host discovery ---------------------------- */
async function detectPublicHost() {
  if (PUBLIC_HOST_ENV) return PUBLIC_HOST_ENV;
  for (const u of ["https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.io/ip", "https://ipv4.icanhazip.com"]) {
    try { const t = (await httpsGetText(u)).trim(); if (/^[0-9a-fA-F:.]+$/.test(t)) return t; } catch (e) {}
  }
  return saved.publicHost || "127.0.0.1";
}

/* -------------------------------------- provisioning ----------------------------------- */
const URL_HOST = (h) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
async function provision(publicHost) {
  const base = `http://${URL_HOST(publicHost)}${PUBLIC_PORT === 80 ? "" : ":" + PUBLIC_PORT}`;
  /* ---- 1. settings (subscription server, URLs, title) ---- */
  setPhase("provision", "Configuring subscription & panel settings…");
  const cur = await api("POST", "/panel/api/setting/all");
  if (!cur.success) throw new Error("setting/all failed: " + cur.msg);
  const want = {
    subEnable: true, subJsonEnable: true, subClashEnable: true, subListen: "127.0.0.1", subPort: SUB_PORT,
    subPath: "/sub/", subJsonPath: "/json/", subClashPath: "/clash/",
    subURI: base + "/sub/", subJsonURI: base + "/json/", subClashURI: base + "/clash/",
    subTitle: BRAND, subUpdates: 6, remarkTemplate: "{{INBOUND}}|📊{{TRAFFIC_LEFT}}|⏳{{DAYS_LEFT}}D", subEncrypt: true, subShowIdentityOnAllLinks: false,
  };
  const diff = Object.keys(want).filter((k) => cur.obj[k] !== want[k]);
  if (diff.length) {
    const r = await api("POST", "/panel/api/setting/update", Object.assign({}, cur.obj, want));
    if (!r.success) throw new Error("setting/update failed: " + r.msg);
    await api("POST", "/panel/api/setting/restartPanel");
    await sleep(2500);
    if (!(await waitHttp(PANEL_PORT, "/", 60000))) throw new Error("panel did not come back after settings update");
    if (!(await waitHttp(SUB_PORT, "/sub/x", 30000))) log("sub server did not answer yet");
  }

  /* ---- 2. inbounds ---- */
  setPhase("provision", "Creating inbounds (VLESS/VMess/Trojan WS + REALITY)…");
  const list = await api("GET", "/panel/api/inbounds/list");
  const have = new Map((list.obj || []).map((i) => [i.tag, i]));
  const sniff = JSON.stringify({ enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false, routeOnly: false });
  const ws = (p) => JSON.stringify({ network: "ws", security: "none", wsSettings: { path: p, host: "", headers: {} } });
  const NAMES = { "walencya-vless-ws": `${BRAND} · VLESS WS`, "walencya-vmess-ws": `${BRAND} · VMess WS`, "walencya-trojan-ws": `${BRAND} · Trojan WS`, "walencya-reality": `${BRAND} · Reality` };
  const mk = (tag, protocol, port, settings, stream, extra) => Object.assign({ up: 0, down: 0, total: 0, remark: NAMES[tag] || tag, enable: true, expiryTime: 0, listen: "127.0.0.1", port, protocol, tag, settings: JSON.stringify(settings), streamSettings: stream, sniffing: sniff }, extra || {});
  const wanted = [
    mk("walencya-vless-ws", "vless", P_VLESS, { clients: [], decryption: "none", fallbacks: [] }, ws(PATH_VLESS), { disableFlow: true }),
    mk("walencya-vmess-ws", "vmess", P_VMESS, { clients: [] }, ws(PATH_VMESS)),
    mk("walencya-trojan-ws", "trojan", P_TROJAN, { clients: [], fallbacks: [] }, ws(PATH_TROJAN)),
  ];
  if (!have.has("walencya-reality")) {
    const k = await api("GET", "/panel/api/server/getNewX25519Cert");
    if (!k.success) throw new Error("x25519 failed: " + k.msg);
    const stream = JSON.stringify({
      network: "tcp", security: "reality",
      realitySettings: { show: false, xver: 0, target: REALITY_TARGET, serverNames: [REALITY_SNI], privateKey: k.obj.privateKey, minClientVer: "", maxClientVer: "", maxTimeDiff: 0, shortIds: [rid(8, "0123456789abcdef"), rid(4, "0123456789abcdef")], settings: { publicKey: k.obj.publicKey, fingerprint: "chrome", serverName: "", spiderX: "/" } },
      tcpSettings: { acceptProxyProtocol: false, header: { type: "none" } },
    });
    wanted.push(mk("walencya-reality", "vless", P_REALITY, { clients: [], decryption: "none", fallbacks: [] }, stream));
  }
  for (const ib of wanted) {
    if (have.has(ib.tag)) continue;
    const r = await api("POST", "/panel/api/inbounds/add", ib);
    if (!r.success) throw new Error(`inbound ${ib.tag}: ${r.msg}`);
  }
  const list2 = await api("GET", "/panel/api/inbounds/list");
  const ids = {}; for (const i of list2.obj || []) ids[i.tag] = i.id;

  /* ---- 3. default client ---- */
  setPhase("provision", "Creating default client…");
  const clients = await api("GET", "/panel/api/clients/list");
  let client = (clients.obj || []).find((c) => c.email === "walencya");
  if (!client) {
    const payload = {
      client: { email: "walencya", id: crypto.randomUUID(), password: rid(16), flow: "xtls-rprx-vision", security: "auto", subId: rid(16), enable: true, totalGB: 0, expiryTime: 0, limitIp: 0, comment: "Created automatically by " + BRAND },
      inboundIds: Object.values(ids),
    };
    const r = await api("POST", "/panel/api/clients/add", payload);
    if (!r.success) throw new Error("client add: " + r.msg);
    client = ((await api("GET", "/panel/api/clients/list")).obj || []).find((c) => c.email === "walencya");
  } else {
    const att = new Set(client.inboundIds || []);
    const missing = Object.values(ids).filter((i) => !att.has(i));
    if (missing.length) await api("POST", `/panel/api/clients/${encodeURIComponent("walencya")}/attach`, { inboundIds: missing });
  }

  /* ---- 4. hosts (public address + port used in every share link) ---- */
  setPhase("provision", "Saving hosts (public address & port)…");
  const hostsNow = (await api("GET", "/panel/api/hosts/list")).obj || [];
  const hostDefs = [
    { tag: "walencya-vless-ws", remark: `${BRAND} · VLESS WS`, security: "none", path: PATH_VLESS, hostHeader: WS_HOST_HEADER },
    { tag: "walencya-vmess-ws", remark: `${BRAND} · VMess WS`, security: "none", path: PATH_VMESS, hostHeader: WS_HOST_HEADER },
    { tag: "walencya-trojan-ws", remark: `${BRAND} · Trojan WS`, security: "none", path: PATH_TROJAN, hostHeader: WS_HOST_HEADER },
    { tag: "walencya-reality", remark: `${BRAND} · Reality`, security: "same", path: "", hostHeader: "" },
  ];
  for (const d of hostDefs) {
    const inboundId = ids[d.tag]; if (!inboundId) continue;
    const existing = hostsNow.find((h) => (h.inboundIds || []).includes(inboundId) && /^WALENCYA/.test(h.remark || ""));
    if (existing) {
      const curAddr = String((existing.hosts || [])[0] || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (curAddr !== publicHost || existing.port !== PUBLIC_PORT) {
        const g = await api("GET", `/panel/api/hosts/get/${existing.groupId}`);
        if (g.success && g.obj) {
          g.obj.hosts = [publicHost]; g.obj.port = PUBLIC_PORT;
          const u = await api("POST", `/panel/api/hosts/update/${existing.groupId}`, g.obj);
          if (!u.success) log("host update failed:", d.tag, u.msg);
        }
      }
      continue;
    }
    const r = await api("POST", "/panel/api/hosts/add", {
      inboundIds: [inboundId], hosts: [publicHost], remark: d.remark, port: PUBLIC_PORT, security: d.security,
      hostHeader: d.hostHeader, path: d.path, isDisabled: false, isHidden: false, sortOrder: 0,
    });
    if (!r.success) log("host add failed:", d.tag, r.msg);
  }
  return { client, base };
}

/* ------------------------------------ front servers ------------------------------------ */
const peerMap = new Map();
const isSubPath = (p) => /^\/(sub|json|clash|mihomo|clash-legacy)\//.test(p);
const send = (res, code, type, body, extra) => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, Object.assign({ "Content-Type": type, "Content-Length": b.length, "Cache-Control": "no-store" }, extra || {}));
  res.end(b);
};
function serveStatic(req, res, p) {
  const cache = { "Cache-Control": "public, max-age=3600" };
  if (p === "/walencya/theme.css") return send(res, 200, "text/css; charset=utf-8", THEME_CSS, cache);
  if (p === "/walencya/theme.js") return send(res, 200, "application/javascript; charset=utf-8", THEME_JS, cache);
  if (p === "/walencya/icon.svg") return send(res, 200, "image/svg+xml", ICON_SVG, cache);
  if (p === "/manifest.webmanifest") return send(res, 200, "application/manifest+json", MANIFEST, cache);
  const m = /^\/icons\/walencya-(\d+)\.png$/.exec(p);
  if (m) { const s = Math.min(512, Math.max(16, +m[1])); return send(res, 200, "image/png", iconPng(s), { "Cache-Control": "public, max-age=86400" }); }
  const m2 = /^\/icons\/3x-ui-(\d+)\.png$/.exec(p);
  if (m2) { const s = Math.min(512, Math.max(16, +m2[1])); return send(res, 200, "image/png", iconPng(s), { "Cache-Control": "public, max-age=86400" }); }
  return false;
}
function clientIp(req) { return peerMap.get(req.socket.remotePort) || req.socket.remoteAddress || ""; }
function upstreamHeaders(req) {
  const h = Object.assign({}, req.headers);
  h["accept-encoding"] = "identity";
  const ip = clientIp(req).replace(/^::ffff:/, "");
  h["x-forwarded-for"] = ip; h["x-real-ip"] = ip;
  h["x-forwarded-host"] = req.headers.host || ""; h["x-forwarded-proto"] = "http";
  delete h["if-none-match"]; delete h["if-modified-since"];
  return h;
}
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
function tunnel(req, socket, head, port, extraHeaders) {
  const up = net.connect(port, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    const hdrs = req.rawHeaders; const skip = new Set(Object.keys(extraHeaders || {}));
    for (let i = 0; i < hdrs.length; i += 2) if (!skip.has(hdrs[i].toLowerCase())) raw += `${hdrs[i]}: ${hdrs[i + 1]}\r\n`;
    for (const k of Object.keys(extraHeaders || {})) raw += `${k}: ${extraHeaders[k]}\r\n`;
    up.write(raw + "\r\n"); if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  const kill = () => { up.destroy(); socket.destroy(); };
  up.on("error", kill); socket.on("error", kill); up.on("close", () => socket.destroy()); socket.on("close", () => up.destroy());
  socket.setNoDelay(true); up.setNoDelay(true); socket.setTimeout(0);
}
function handleUpgrade(req, socket, head) {
  const p = (req.url || "/").split("?")[0];
  if (!STATE.ready) { socket.destroy(); return; }
  if (WS_ROUTES[p]) return tunnel(req, socket, head, WS_ROUTES[p]);
  if (p === "/ws") { const ip = clientIp(req).replace(/^::ffff:/, ""); return tunnel(req, socket, head, PANEL_PORT, { "x-forwarded-for": ip, "x-real-ip": ip }); }
  socket.destroy();
}
const TEXT_TYPE = /(text\/html|javascript|text\/css|application\/json|manifest\+json)/i;
function respondBuffered(req, res, status, headers, body, cacheKey) {
  const h = Object.assign({}, headers);
  delete h["content-length"]; delete h["content-encoding"]; delete h["transfer-encoding"]; delete h["etag"]; delete h["last-modified"];
  const ae = String(req.headers["accept-encoding"] || "");
  let out = body;
  if (/\bgzip\b/.test(ae) && body.length > 800) { out = zlib.gzipSync(body, { level: 6 }); h["content-encoding"] = "gzip"; h["vary"] = "Accept-Encoding"; }
  h["content-length"] = out.length;
  res.writeHead(status, h); res.end(out);
}
function proxyHttp(req, res, port) {
  const vm = /^\/assets\/w[0-9a-f]+\//.exec(req.url || "");
  if (vm) req.url = "/assets/" + req.url.slice(vm[0].length);
  const u = new URL(req.url, "http://x"); const p = u.pathname;
  const isAsset = p.startsWith("/assets/");
  const key = isAsset && req.method === "GET" ? p : null;
  if (key && REWRITE_CACHE.has(key)) {
    const c = REWRITE_CACHE.get(key); const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
    res.writeHead(200, Object.assign({}, c.headers, gz ? { "content-encoding": "gzip", "content-length": c.gz.length, vary: "Accept-Encoding" } : { "content-length": c.raw.length }));
    return res.end(gz ? c.gz : c.raw);
  }
  const wantsHtml = /text\/html/i.test(String(req.headers.accept || "")) || u.searchParams.get("html") === "1";
  const subPage = port === SUB_PORT && wantsHtml && req.method === "GET" && /^\/sub\/[^/]+\/?$/.test(p) && !u.searchParams.get("format");
  const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: upstreamHeaders(req), agent: upstreamAgent }, (ur) => {
    const ctype = String(ur.headers["content-type"] || "");
    const transform = (subPage && ur.statusCode === 200) || (ur.statusCode === 200 && TEXT_TYPE.test(ctype)) || (subPage && wantsHtml && ur.statusCode >= 400);
    if (!transform) {
      const h = Object.assign({}, ur.headers);
      res.writeHead(ur.statusCode, h); ur.pipe(res); return;
    }
    const chunks = []; ur.on("data", (c) => chunks.push(c));
    ur.on("end", () => {
      let body = Buffer.concat(chunks);
      try {
        if (subPage) {
          if (ur.statusCode !== 200) return send(res, ur.statusCode === 404 || ur.statusCode === 403 ? 404 : ur.statusCode, "text/html; charset=utf-8", renderSubError(ur.statusCode), subCsp());
          const html = body.toString("utf8"); const m = /window\.__SUB_PAGE_DATA__=([\s\S]*?);<\/script>/.exec(html);
          if (m) return send(res, 200, "text/html; charset=utf-8", renderSubPage(JSON.parse(m[1]), req), subCsp());
        }
        let text = body.toString("utf8"); text = rebrand(text, p);
        if (/text\/html/i.test(ctype)) text = text.replace("</head>", injectHead());
        body = Buffer.from(text);
        const headers = Object.assign({}, ur.headers);
        if (key && ur.statusCode === 200) {
          const keep = { "content-type": ctype, "cache-control": "public, max-age=31536000, immutable" };
          const e = { headers: keep, raw: body, gz: zlib.gzipSync(body, { level: 9 }) }; REWRITE_CACHE.set(key, e);
          const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
          res.writeHead(200, Object.assign({}, keep, gz ? { "content-encoding": "gzip", "content-length": e.gz.length, vary: "Accept-Encoding" } : { "content-length": body.length }));
          return res.end(gz ? e.gz : body);
        }
        respondBuffered(req, res, ur.statusCode, headers, body);
      } catch (e) {
        log("rewrite error:", e.message);
        if (!res.headersSent) send(res, 502, "text/plain", "Bad gateway");
      }
    });
  });
  up.on("error", (e) => { if (!res.headersSent) send(res, 502, "text/html; charset=utf-8", SPLASH_HTML.replace("__MSG__", "Panel is restarting…")); else res.destroy(); });
  req.pipe(up);
}
const subCsp = () => ({ "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
const safeJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
function renderSubPage(data, req) {
  return SUB_HTML.replace("/*__DATA__*/null", safeJson(data)).replace(/__BRAND__/g, BRAND);
}
function renderSubError() {
  return SUB_HTML.replace("/*__DATA__*/null", safeJson({ __error: true })).replace(/__BRAND__/g, BRAND);
}
function httpHandler(req, res) {
  const p = (req.url || "/").split("?")[0];
  if (p === "/_wal/status") return send(res, 200, "application/json", JSON.stringify({ brand: BRAND, ready: STATE.ready, phase: STATE.phase, message: STATE.message, error: STATE.error }));
  if (p.startsWith("/walencya/") || p === "/manifest.webmanifest" || p.startsWith("/icons/")) { if (serveStatic(req, res, p) !== false) return; }
  if (!STATE.ready) {
    const html = SPLASH_HTML.replace("__MSG__", esc(STATE.error ? "Setup problem: " + STATE.error : STATE.message));
    return send(res, 200, "text/html; charset=utf-8", html);
  }
  proxyHttp(req, res, isSubPath(p) ? SUB_PORT : PANEL_PORT);
}
function startFront() {
  const inner = http.createServer(httpHandler);
  inner.on("upgrade", handleUpgrade);
  inner.on("clientError", (e, s) => { try { s.destroy(); } catch (x) {} });
  inner.keepAliveTimeout = 65000; inner.headersTimeout = 70000; inner.requestTimeout = 0;
  inner.listen(HTTP_PORT, "127.0.0.1");
  const front = net.createServer({ pauseOnConnect: true }, (sock) => {
    sock.on("error", () => {});
    let routed = false;
    const timer = setTimeout(() => { if (!routed) route(null); }, 8000);
    function route(first) {
      if (routed) return; routed = true; clearTimeout(timer);
      const toReality = first && first[0] === 0x16;
      if (toReality && !STATE.ready) { sock.destroy(); return; }
      const port = toReality ? P_REALITY : HTTP_PORT;
      const up = net.connect(port, "127.0.0.1", () => {
        if (!toReality) peerMap.set(up.localPort, sock.remoteAddress);
        if (first) up.write(first);
        sock.pipe(up); up.pipe(sock); sock.resume();
      });
      up.setNoDelay(true); sock.setNoDelay(true);
      const lp = () => up.localPort;
      up.on("error", () => sock.destroy()); sock.on("close", () => up.destroy());
      up.on("close", () => { peerMap.delete(lp()); sock.destroy(); });
    }
    sock.once("data", (d) => { sock.pause(); route(d); });
    sock.resume();
  });
  front.on("error", (e) => { console.error("public port error:", e.message); process.exit(1); });
  front.listen(PUBLIC_PORT, "0.0.0.0", () => log(`public port ${PUBLIC_PORT} is open`));
  return front;
}

/* ---------------------------------------- main ---------------------------------------- */
function banner(host, user, pass, client, base) {
  const subId = client && client.subId;
  const lines = [
    "", "╔═════════════════════════════════════════════════════════════════╗",
    `║   ${BRAND} panel is READY`.padEnd(66) + "║",
    "╚═════════════════════════════════════════════════════════════════╝",
    `  Panel      : ${base}/`,
    `  Username   : ${user}`, `  Password   : ${pass}`, "",
    subId ? `  Sub page   : ${base}/sub/${subId}   (open in a browser)` : "",
    subId ? `  Sub (apps) : ${base}/sub/${subId}` : "",
    subId ? `  Xray JSON  : ${base}/json/${subId}` : "",
    subId ? `  Clash/Meta : ${base}/clash/${subId}` : "", "",
    "  Inbounds   : VLESS-WS · VMess-WS · Trojan-WS · VLESS-REALITY (all on one port)",
    `  Files      : ${CRED_FILE}`, "",
    "  Telegram   : https://t.me/WALENCYA_Panel_ir", "",
  ].filter((l) => l !== undefined);
  console.log(lines.join("\n"));
  try { fs.writeFileSync(CRED_FILE, lines.join("\n") + "\n", { mode: 0o600 }); } catch (e) {}
}
async function main() {
  mkdirp(BASE); mkdirp(DATA_DIR); mkdirp(LOG_DIR);
  startFront();
  setPhase("boot", "Public port opened; preparing…");
  await ensureEngine();

  const pass = ENV_PASS || saved.adminPass || "admin";
  saveState({ adminUser: ADMIN_USER, adminPass: pass });
  setPhase("setup", "Applying credentials & ports…");
  engineCli(["setting", "-username", ADMIN_USER, "-password", pass, "-port", String(PANEL_PORT), "-webBasePath", "/", "-listenIP", "127.0.0.1"]);
  const tokOut = engineCli(["setting", "-getApiToken", "-tokenName", "walencya-auto"]);
  const tm = /apiToken:\s*([A-Za-z0-9_-]{20,})/.exec(tokOut);
  if (!tm) throw new Error("could not obtain API token: " + tokOut.slice(0, 200));
  API_TOKEN = tm[1];

  setPhase("setup", "Starting panel engine…");
  startEngine();
  if (!(await waitHttp(PANEL_PORT, "/", 120000))) throw new Error("panel engine did not start (see walencya/log/engine.log)");

  const host = await detectPublicHost(); STATE.publicHost = host; saveState({ publicHost: host });
  const r = await provision(host);

  setPhase("provision", "Making sure Xray is running…");
  for (let i = 0; i < 10; i++) {
    const st = await api("GET", "/panel/api/server/status");
    if (st.success && st.obj && st.obj.xray && st.obj.xray.state === "running") break;
    if (i === 3) await api("POST", "/panel/api/server/restartXrayService");
    await sleep(1500);
  }
  if (r.client && r.client.subId) {
    for (let i = 0; i < 25; i++) {
      const code = await new Promise((res) => { const q = http.get({ host: "127.0.0.1", port: SUB_PORT, path: "/sub/" + r.client.subId, timeout: 2000 }, (x) => { x.resume(); res(x.statusCode); }); q.on("error", () => res(0)); q.on("timeout", () => { q.destroy(); res(0); }); });
      if (code === 200) break; await sleep(800);
    }
  }
  STATE.ready = true; setPhase("ready", `${BRAND} is ready`);
  saveState({ provisioned: true, subId: r.client && r.client.subId });
  banner(host, ADMIN_USER, pass, r.client, r.base);
}
function shutdown() {
  engineStopping = true; try { engineProc && engineProc.kill("SIGTERM"); } catch (e) {}
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
process.on("uncaughtException", (e) => log("uncaught:", e && e.stack || e));
process.on("unhandledRejection", (e) => log("unhandled:", e && e.stack || e));
main().catch((e) => { STATE.error = e.message; STATE.phase = "error"; console.error(`[${BRAND}] FATAL:`, e.stack || e); });
