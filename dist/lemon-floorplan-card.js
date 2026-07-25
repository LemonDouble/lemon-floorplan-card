/**
 * lemon-floorplan-card
 *
 * SVG 평면도 위에서 방을 탭하면 그 방의 기기 컨트롤이 팝업으로 열리는 카드.
 * 방 ↔ 기기 매핑은 하드코딩하지 않고 HA area 레지스트리에서 런타임에 끌어온다.
 *
 * 팝업 구조
 *   [자주 쓰는 것]  device 마다 대표 엔티티만 2단 타일로
 *   [전체 보기 (N)] 접힘. 펼치면 device 별로 묶인 전체 목록
 *
 *   "대표"는 임의로 고르지 않는다. device 안에서 PRIMARY_PRIORITY 순으로 가장 높은
 *   도메인을 찾고, 그 도메인 엔티티를 전부 대표로 쓴다. 그래서
 *     - 에어컨 device → climate 하나 (companion 스위치 10개는 접힘)
 *     - 2구 벽스위치 → switch 두 개 다 노출
 *   가 된다. rooms.<area>.primary 로 완전히 덮어쓸 수 있다.
 *
 * 설정 예시 (YAML)
 *   type: custom:lemon-floorplan-card
 *   floorplan: /local/floorplan.svg
 *   exclude_devices: ["EFM Networks ipTIME AX2004M", "집 전체"]
 *   exclude: [sensor.foo]
 *   rooms:
 *     geosil:
 *       primary: [climate.geosil_eeokeon, light.geosil_sopadeung]
 *
 * 의존하는 HA API
 *   hass.states / hass.callService / hass.callWS   — 공식 문서에 있는 것만 사용
 *   window.loadCardHelpers()                       — 있으면 진짜 tile 카드를 쓰고,
 *                                                    없으면 자체 행 렌더로 폴백한다
 */

const CARD_TAG = "lemon-floorplan-card";

/** 방 색을 결정할 때 "켜짐"으로 볼 도메인 */
const ACTIVE_RULES = {
  light:        (s) => s.state === "on",
  switch:       (s) => s.state === "on",
  fan:          (s) => s.state === "on",
  media_player: (s) => s.state === "playing",
  climate:      (s) => !["off", "unavailable", "unknown"].includes(s.state),
  humidifier:   (s) => s.state === "on",
  vacuum:       (s) => ["cleaning", "returning"].includes(s.state),
};

/** device 대표 엔티티를 고르는 순서. 앞쪽일수록 그 기기를 대표한다고 본다 */
const PRIMARY_PRIORITY = [
  "climate", "light", "cover", "lock", "media_player", "fan",
  "humidifier", "vacuum", "water_heater", "valve", "siren", "switch",
];

/** 전체 목록에서의 표시 순서 */
const TIER = {
  control: ["light", "switch", "climate", "fan", "cover", "lock", "media_player",
            "humidifier", "vacuum", "water_heater", "valve", "siren"],
  tune:    ["select", "number", "button", "text", "input_boolean", "scene", "script"],
  info:    ["sensor", "binary_sensor"],
};
const TIER_OF = {};
for (const [tier, domains] of Object.entries(TIER)) {
  for (const d of domains) TIER_OF[d] = tier;
}
const TIER_RANK = { control: 0, tune: 1, info: 2 };

const dom = (eid) => eid.split(".")[0];

class LemonFloorplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._sig = {};          // areaId -> 마지막으로 그린 상태 서명
    this._rooms = null;      // areaId -> { primary:[], groups:[{name, ids}], count }
    this._areaName = {};
    this._live = [];         // 팝업에 떠 있는 tile 카드들 (hass 를 계속 흘려줘야 함)
    this._booting = false;
    this._ready = false;
  }

  // ── 라이프사이클 ────────────────────────────────────────────

  setConfig(config) {
    if (!config.floorplan) {
      throw new Error("floorplan: SVG 경로가 필요합니다 (예: /local/floorplan.svg)");
    }
    this._config = { exclude: [], exclude_devices: [], rooms: {}, ...config };
    this._exEnt = new Set(this._config.exclude);
    this._exDev = new Set(this._config.exclude_devices);
    this._ready = false;
    this._sig = {};
    this.shadowRoot.innerHTML = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._ready) { this._boot(); return; }
    this._paint();
    for (const el of this._live) el.hass = hass;   // 팝업이 열려 있으면 같이 갱신
  }

  getCardSize() { return 8; }

  // ── 초기화 ─────────────────────────────────────────────────

  async _boot() {
    if (this._booting) return;
    this._booting = true;
    try {
      this._render();
      await Promise.all([this._loadSvg(), this._loadRegistry()]);
      this._wireRooms();
      this._ready = true;
      this._paint();
    } catch (err) {
      this._fail(err);
    } finally {
      this._booting = false;
    }
  }

  async _loadSvg() {
    const base = new URL(this._config.floorplan, location.href);
    const res = await fetch(base);
    if (!res.ok) throw new Error(`평면도를 못 읽었습니다: ${this._config.floorplan} (${res.status})`);

    const plan = this.shadowRoot.querySelector(".plan");
    plan.innerHTML = await res.text();

    // SVG 를 문서에 인라인하면 그 안의 상대경로는 SVG 파일 위치가 아니라
    // "지금 보고 있는 페이지 URL" 기준으로 풀린다. HA 에서는 /lovelace/home 이라
    // fp/sofa.webp 가 /lovelace/fp/sofa.webp 가 되고, HA 는 그걸 SPA 폴백으로
    // index.html 을 내려주기 때문에 엑박이 뜬다. floorplan 경로 기준으로 절대화한다.
    const XLINK = "http://www.w3.org/1999/xlink";
    for (const el of plan.querySelectorAll("image")) {
      const href = el.getAttribute("href") ?? el.getAttributeNS(XLINK, "href");
      if (!href || /^(?:[a-z]+:|\/\/|\/)/i.test(href)) continue;   // 절대 URL·data: 는 그대로
      el.setAttribute("href", new URL(href, base).href);
      el.removeAttributeNS(XLINK, "href");
    }
  }

  /**
   * area / device / entity 레지스트리를 한 번만 받아 방 구조를 만든다.
   * 엔티티의 area 는 자기 값이 우선이고, 없으면 device 의 area 를 물려받는다
   * (2구 스위치처럼 방을 걸치는 기기가 엔티티 레벨로 덮어써져 있다).
   */
  async _loadRegistry() {
    const hass = this._hass;
    const [areas, devices, entities] = await Promise.all([
      hass.callWS({ type: "config/area_registry/list" }),
      hass.callWS({ type: "config/device_registry/list" }),
      hass.callWS({ type: "config/entity_registry/list" }),
    ]);

    this._areaName = {};
    for (const a of areas) this._areaName[a.area_id] = a.name;

    const devArea = {}, devName = {}, devSkip = new Set();
    for (const d of devices) {
      const id = d.id ?? d.device_id;
      const name = d.name_by_user || d.name || id;
      devArea[id] = d.area_id;
      devName[id] = name;
      if (this._exDev.has(id) || this._exDev.has(name)) devSkip.add(id);
    }

    // 1) area -> device -> [entity_id]
    const byArea = {};
    for (const e of entities) {
      if (e.disabled_by || e.hidden_by) continue;
      if (e.entity_category) continue;                 // config / diagnostic 제외
      if (this._exEnt.has(e.entity_id)) continue;
      if (!TIER_OF[dom(e.entity_id)]) continue;        // update, event 등 제외
      if (e.device_id && devSkip.has(e.device_id)) continue;

      const area = e.area_id ?? devArea[e.device_id] ?? null;
      if (!area) continue;

      ((byArea[area] ||= {})[e.device_id || "_"] ||= []).push(e.entity_id);
    }

    // 2) device 별 대표 엔티티 + 전체 목록으로 정리
    this._rooms = {};
    for (const [area, devMap] of Object.entries(byArea)) {
      const override = this._config.rooms?.[area]?.primary;
      const primary = [], groups = [];
      let count = 0;

      const entries = Object.entries(devMap).sort(
        (a, b) => (devName[a[0]] || "").localeCompare(devName[b[0]] || ""));

      for (const [devId, ids] of entries) {
        ids.sort((x, y) => {
          const d = TIER_RANK[TIER_OF[dom(x)]] - TIER_RANK[TIER_OF[dom(y)]];
          return d !== 0 ? d : x.localeCompare(y);
        });
        count += ids.length;
        groups.push({ name: devName[devId] || "기타", ids });

        if (override) continue;
        // 이 device 에서 가장 높은 우선순위 도메인을 찾고, 그 도메인 전부를 대표로
        const top = PRIMARY_PRIORITY.find((d) => ids.some((e) => dom(e) === d));
        if (top) primary.push(...ids.filter((e) => dom(e) === top));
      }

      this._rooms[area] = {
        primary: override ? override.slice() : primary,
        groups, count,
        all: groups.flatMap((g) => g.ids),
      };
    }
  }

  _wireRooms() {
    for (const el of this.shadowRoot.querySelectorAll(".plan .room")) {
      const areaId = el.id.replace(/^room-/, "");
      el.style.cursor = "pointer";
      el.addEventListener("click", (ev) => { ev.stopPropagation(); this._openRoom(areaId); });
    }
  }

  // ── 상태 반영 ──────────────────────────────────────────────

  /** set hass 는 시스템 전체 상태 변화마다 불린다. 바뀐 방만 건드린다. */
  _paint() {
    const hass = this._hass;
    if (!hass || !this._rooms) return;

    for (const el of this.shadowRoot.querySelectorAll(".plan .room")) {
      const areaId = el.id.replace(/^room-/, "");
      const ids = this._rooms[areaId]?.all || [];

      let tint = null, on = 0;
      for (const eid of ids) {
        const st = hass.states[eid];
        if (!st) continue;
        const rule = ACTIVE_RULES[dom(eid)];
        if (!rule || !rule(st)) continue;
        on++;
        if (dom(eid) === "climate") tint = st.state === "heat" ? "heat" : "cool";
        else if (dom(eid) === "media_player") tint ||= "media";
        else tint ||= "warm";
      }

      const sig = `${tint}|${on}`;
      if (this._sig[areaId] === sig) continue;      // 안 바뀌었으면 DOM 안 만짐
      this._sig[areaId] = sig;

      if (tint) el.setAttribute("data-tint", tint);
      else el.removeAttribute("data-tint");
    }
  }

  // ── 팝업 ───────────────────────────────────────────────────

  async _openRoom(areaId) {
    const hass = this._hass;
    const room = this._rooms[areaId];
    const dlg = this.shadowRoot.querySelector("dialog");
    const body = dlg.querySelector(".body");

    this._live = [];
    dlg.querySelector(".rn").textContent = this._areaName[areaId] || areaId;
    dlg.querySelector(".env").textContent = this._envSummary(room);
    body.innerHTML = "";

    if (!room || !room.count) {
      body.innerHTML = `<div class="empty">이 방에 등록된 기기가 없습니다.</div>`;
      dlg.showModal();
      return;
    }

    const helpers = await this._helpers();
    const live = (eid) => {
      const el = helpers
        ? Object.assign(helpers.createCardElement(this._tileConfig(eid)), { hass })
        : this._row(eid);
      if (helpers) this._live.push(el);
      return el;
    };

    // 자주 쓰는 것 — 2단 타일
    const usable = room.primary.filter((e) => hass.states[e]);
    if (usable.length) {
      body.appendChild(this._label("자주 쓰는 것"));
      const grid = document.createElement("div");
      grid.className = "grid";
      for (const eid of usable) grid.appendChild(live(eid));
      body.appendChild(grid);
    }

    // 전체 보기 — 접어두고, 펼칠 때 한 번만 렌더
    const det = document.createElement("details");
    det.innerHTML = `<summary>전체 보기 <span class="n">${room.count}</span></summary>`;
    const all = document.createElement("div");
    all.className = "all";
    det.appendChild(all);
    det.addEventListener("toggle", () => {
      if (!det.open || all.dataset.done) return;
      all.dataset.done = "1";
      for (const g of room.groups) {
        const ids = g.ids.filter((e) => hass.states[e]);
        if (!ids.length) continue;
        all.appendChild(this._label(g.name, "dev"));
        for (const eid of ids) all.appendChild(live(eid));
      }
    }, { passive: true });
    body.appendChild(det);

    dlg.showModal();
  }

  /** 방 온습도를 헤더에 한 줄로. 센서가 전체보기에 묻히지 않게 하는 용도 */
  _envSummary(room) {
    if (!room) return "";
    const hass = this._hass, out = [];
    for (const key of ["temperature", "humidity"]) {
      const eid = room.all.find((e) =>
        dom(e) === "sensor" && hass.states[e]?.attributes.device_class === key);
      if (!eid) continue;
      const st = hass.states[eid];
      out.push(`${Math.round(parseFloat(st.state) * 10) / 10}${st.attributes.unit_of_measurement || ""}`);
    }
    return out.join("  ·  ");
  }

  async _helpers() {
    if (this._helpersP === undefined) {
      this._helpersP = (async () => {
        try { return (await window.loadCardHelpers?.()) || null; } catch (_) { return null; }
      })();
    }
    return this._helpersP;
  }

  /** 도메인별로 쓸 만한 tile feature 를 붙인다 */
  _tileConfig(eid) {
    const cfg = { type: "tile", entity: eid };
    switch (dom(eid)) {
      case "light":   cfg.features = [{ type: "light-brightness" }]; break;
      case "climate": cfg.features = [{ type: "climate-hvac-modes", style: "dropdown" },
                                      { type: "target-temperature" }]; break;
      case "cover":   cfg.features = [{ type: "cover-open-close" }]; break;
      case "fan":     cfg.features = [{ type: "fan-speed" }]; break;
      case "lock":    cfg.features = [{ type: "lock-commands" }]; break;
      case "vacuum":  cfg.features = [{ type: "vacuum-commands" }]; break;
      case "humidifier": cfg.features = [{ type: "target-humidity" }]; break;
      case "select":  cfg.features = [{ type: "select-options" }]; break;
      case "number":  cfg.features = [{ type: "numeric-input", style: "slider" }]; break;
    }
    return cfg;
  }

  _label(text, cls = "sub") {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  }

  /** loadCardHelpers 가 없는 환경용. HA 내부 컴포넌트를 전혀 안 쓴다. */
  _row(eid) {
    const hass = this._hass, st = hass.states[eid];
    const row = document.createElement("div");
    row.className = "row";

    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = st.attributes.friendly_name || eid;

    const stx = document.createElement("div");
    stx.className = "st";
    stx.textContent = st.state + (st.attributes.unit_of_measurement || "");
    row.append(nm, stx);

    if (TIER_OF[dom(eid)] === "control") {
      const b = document.createElement("button");
      b.textContent = "전환";
      b.onclick = (e) => {
        e.stopPropagation();
        hass.callService("homeassistant", "toggle", { entity_id: eid });
      };
      row.appendChild(b);
    }
    row.onclick = () => {
      const ev = new Event("hass-more-info", { bubbles: true, composed: true });
      ev.detail = { entityId: eid };
      this.dispatchEvent(ev);
    };
    return row;
  }

  // ── 셸 ─────────────────────────────────────────────────────

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card, .card {
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none);
          border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
          overflow: hidden;
        }
        .card { padding: 8px; }
        .title { font: 500 16px/1.4 var(--ha-font-family-body, system-ui, sans-serif);
                 color: var(--primary-text-color); padding: 8px 8px 4px; }
        .plan { position: relative; container-type: inline-size; }
        .plan svg { width: 100%; height: auto; display: block; }
        .err { padding: 16px; color: var(--error-color, #db4437);
               font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; }

        /* 방 상태 틴트.
           .room 은 바닥·가구 위에 얹힌 투명 오버레이라, fill-opacity 만 올리면
           아래 레이어가 비쳐 보인다 (fill 을 덮어쓰던 예전 방식과 다르다) */
        .plan svg .room[data-tint] { fill-opacity: .3; }
        .plan svg .room[data-tint]:hover { fill-opacity: .42; }
        .plan svg .room[data-tint="warm"]  { fill: var(--state-light-active-color, #ffc107); }
        .plan svg .room[data-tint="cool"]  { fill: var(--state-climate-cool-color, #2196f3); }
        .plan svg .room[data-tint="heat"]  { fill: var(--state-climate-heat-color, #ff8a65); }
        .plan svg .room[data-tint="media"] { fill: var(--state-media_player-active-color, #7e57c2); }

        /* 팝업 */
        dialog {
          border: none; padding: 0; max-width: 560px; width: calc(100vw - 32px);
          max-height: 84vh; border-radius: 18px;
          background: var(--card-background-color, #fff); color: var(--primary-text-color);
        }
        dialog::backdrop { background: rgba(0,0,0,.5); }
        .sheet { display: flex; flex-direction: column; max-height: 84vh; }
        .sheet header {
          display: flex; align-items: baseline; gap: 10px; padding: 18px 18px 14px;
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
        }
        .rn  { font: 600 19px/1.2 var(--ha-font-family-body, system-ui, sans-serif); }
        .env { font-size: 13px; color: var(--secondary-text-color); }
        .sheet header button {
          margin-inline-start: auto; border: 0; background: transparent;
          color: var(--secondary-text-color); font-size: 22px; line-height: 1;
          cursor: pointer; padding: 2px 8px; border-radius: 8px;
        }
        .sheet header button:hover { background: var(--secondary-background-color, #eee); }

        .body { overflow-y: auto; padding: 14px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        @container (max-width: 380px) { .grid { grid-template-columns: 1fr; } }
        .sub { font: 500 12px/1 var(--ha-font-family-body, system-ui, sans-serif);
               letter-spacing: .04em; text-transform: uppercase;
               color: var(--secondary-text-color); padding: 4px 2px 8px; }
        .dev { font: 500 13px/1 var(--ha-font-family-body, system-ui, sans-serif);
               color: var(--secondary-text-color); padding: 14px 2px 6px; }
        .empty { padding: 28px 8px; text-align: center; color: var(--secondary-text-color); }

        details { margin-top: 18px; border-top: 1px solid var(--divider-color, #e0e0e0); }
        summary {
          list-style: none; cursor: pointer; user-select: none;
          padding: 14px 2px 4px; color: var(--secondary-text-color);
          font: 500 14px/1 var(--ha-font-family-body, system-ui, sans-serif);
          display: flex; align-items: center; gap: 6px;
        }
        summary::-webkit-details-marker { display: none; }
        summary::after { content: "⌄"; margin-inline-start: auto; font-size: 16px; transition: transform .2s; }
        details[open] summary::after { transform: rotate(180deg); }
        summary .n {
          background: var(--secondary-background-color, #eee); border-radius: 10px;
          padding: 1px 8px; font-size: 12px;
        }
        .all { display: grid; gap: 8px; padding-bottom: 4px; }

        /* loadCardHelpers 가 없을 때 쓰는 폴백 행 */
        .row { display: flex; align-items: center; gap: 12px; padding: 10px 12px;
               border-radius: 12px; background: var(--secondary-background-color, #f3f4f6); cursor: pointer; }
        .row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .row .st { color: var(--secondary-text-color); font-size: 13px; }
        .row button { border: 1px solid var(--divider-color, #ddd); border-radius: 8px;
                      background: var(--card-background-color, #fff); color: inherit;
                      padding: 6px 12px; cursor: pointer; font: inherit; }
      </style>

      <ha-card class="card">
        ${this._config.title ? `<div class="title">${this._esc(this._config.title)}</div>` : ""}
        <div class="plan"></div>
      </ha-card>

      <dialog>
        <div class="sheet">
          <header><span class="rn"></span><span class="env"></span><button title="닫기">&times;</button></header>
          <div class="body"></div>
        </div>
      </dialog>
    `;
    const dlg = this.shadowRoot.querySelector("dialog");
    dlg.querySelector("header button").onclick = () => dlg.close();
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => { this._live = []; });
  }

  _fail(err) {
    console.error(`[${CARD_TAG}]`, err);
    this.shadowRoot.innerHTML =
      `<ha-card class="card"><div class="err">${this._esc(String(err.message || err))}</div></ha-card>`;
  }

  _esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
}

customElements.define(CARD_TAG, LemonFloorplanCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Lemon Floorplan Card",
  description: "SVG 평면도에서 방을 눌러 그 방 기기를 제어합니다",
  preview: false,
});

console.info(`%c ${CARD_TAG} %c loaded `,
  "background:#f9a825;color:#000;border-radius:3px 0 0 3px;padding:2px 4px",
  "background:#333;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");
