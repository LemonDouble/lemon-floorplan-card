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
 *   show_env: true                                 # 방 이름 아래 온습도 (기본 켜짐)
 *   room_tint: temperature                         # 방 색: temperature(기본) | device | off
 *   temp_bands: {cold: 18, cool: 22, warm: 26, hot: 29}   # 온도 구간 경계 (℃)
 *   air: [sensor.co2, sensor.pm25]                 # 평면도 아래 공기질 줄 (device_class 로 해석)
 *   rooms:
 *     geosil:
 *       primary: [climate.geosil_eeokeon, light.geosil_sopadeung]
 *       env: [sensor.geosil_temperature, sensor.geosil_humidity]   # 대표 온습도 못박기
 *
 * 의존하는 HA API
 *   hass.states / hass.callService / hass.callWS   — 공식 문서에 있는 것만 사용
 *   window.loadCardHelpers()                       — 있으면 진짜 tile 카드를 쓰고,
 *                                                    없으면 자체 행 렌더로 폴백한다
 */

const CARD_TAG = "lemon-floorplan-card";

/* tools/build.py 가 여기에 floorplan.svg 를 통째로 밀어 넣는다 (가구 이미지까지 인라인된 것).
   HACS 는 plugin 릴리스에서 "레포 이름과 같은 .js" 하나만 가져가므로, SVG 를 별도 파일로
   두면 404 가 난다. 그래서 배포본은 이 파일 하나로 자족한다.
   config.floorplan 을 주면 그쪽이 우선이라 다른 평면도로 갈아끼울 수 있다. */
const EMBEDDED_SVG = ""; /*__FLOORPLAN__*/
/* 가구 이미지. 상대경로 -> data URI. SVG 안에 직접 박지 않고 여기 모으는 이유는
   천장등처럼 같은 파일을 여러 번 쓰는 오브젝트가 많아서다 (박아 넣으면 7벌이 들어간다). */
const EMBEDDED_ASSETS = {}; /*__ASSETS__*/

/**
 * 방 색(틴트)을 정하는 두 가지 방식.
 *
 *   temperature (기본)  방 색 = 그 방 온도. 기기 켜짐은 가구 이펙트가 알린다.
 *   device              방 색 = 켜진 기기 종류. v1.6 까지의 동작.
 *   off                 방을 칠하지 않는다.
 *
 * 온도 방식으로 기본을 옮긴 이유: 조명은 어차피 가구가 발광해서 눈에 띄는데,
 * 온도는 숫자를 읽기 전에는 알 수 없었다. 방 전체를 물들이는 자리는 "읽지 않고도
 * 알아야 하는 것" 에 주는 편이 낫다.
 */

/** 온도 구간. 위에서부터 v < max 를 처음 만족하는 칸이 이긴다.
 *  쾌적 구간(tint: null)은 일부러 칠하지 않는다 — 늘 물들어 있으면 경고가 묻힌다.
 *  경계값은 위 칸에 속한다 (26.0 은 쾌적이 아니라 warm). */
const TEMP_BANDS = { cold: 18, cool: 22, warm: 26, hot: 29 };
const bandsOf = (o = {}) => {
  const t = { ...TEMP_BANDS, ...o };
  return [
    { max: t.cold,     tint: "temp-cold" },   // 춥다
    { max: t.cool,     tint: "temp-cool" },   // 서늘하다
    { max: t.warm,     tint: null        },   // 쾌적
    { max: t.hot,      tint: "temp-warm" },   // 덥다
    { max: Infinity,   tint: "temp-hot"  },   // 많이 덥다
  ];
};

/**
 * 공기질 칩. device_class 로 라벨·단위·등급을 정하므로 설정에는 엔티티만 적는다.
 *
 * 방마다 칠하지 않고 평면도 아래 한 줄로 빼는 이유: 측정기가 침실 하나뿐이라
 * 방별로 나눌 데이터가 없고, 집이 작아 어차피 전체가 같은 상태로 봐도 된다.
 *
 * 경계는 위에서부터 v < max 를 처음 만족하는 칸. good/ok 는 색을 주지 않는다.
 * CO₂ 는 환기 권장선 1000ppm, PM 은 한국 환경부 등급(PM2.5 15/35/75,
 * PM10 30/80/150)을 따랐다.
 */
const AIR_KINDS = {
  carbon_dioxide:             { label: "CO₂",   bands: [[800, "good"], [1000, "ok"], [1500, "warn"], [Infinity, "bad"]] },
  pm25:                       { label: "PM2.5", bands: [[16,  "good"], [36,   "ok"], [76,   "warn"], [Infinity, "bad"]] },
  pm10:                       { label: "PM10",  bands: [[31,  "good"], [81,   "ok"], [151,  "warn"], [Infinity, "bad"]] },
  pm1:                        { label: "PM1.0", bands: [[16,  "good"], [36,   "ok"], [76,   "warn"], [Infinity, "bad"]] },
  volatile_organic_compounds: { label: "VOC",   bands: [[0.3, "good"], [1,    "ok"], [3,    "warn"], [Infinity, "bad"]] },
};

/** device 방식의 우선순위. 위에 있을수록 세다.
 *  예전에는 이 순서가 `tint = …` 와 `tint ||= …` 의 차이, 그리고 room.all 배열
 *  순서에 묻혀 있었다 (climate 는 마지막 것이, 나머지는 첫 번째 것이 이겼다).
 *  같은 결과를 내면서 순서를 눈에 보이게 꺼낸 표다. */
const DEVICE_TINT = [
  { tint: "heat",  match: (d, st) => d === "climate" && st.state === "heat" },
  { tint: "cool",  match: (d) => d === "climate" },
  { tint: "media", match: (d) => d === "media_player" },
  { tint: "warm",  match: () => true },
];

/** 방 색을 결정할 때 "켜짐"으로 볼 도메인 (device 방식 전용) */
const ACTIVE_RULES = {
  light:        (s) => s.state === "on",
  switch:       (s) => s.state === "on",
  fan:          (s) => s.state === "on",
  media_player: (s) => s.state === "playing",
  climate:      (s) => !["off", "unavailable", "unknown"].includes(s.state),
  humidifier:   (s) => s.state === "on",
  vacuum:       (s) => ["cleaning", "returning"].includes(s.state),
};

/** 가구 하나하나를 빛나게 할 때 "켜짐"으로 볼 규칙.
 *  ACTIVE_RULES(방 틴트용) 보다 넓다 — 문 열림·잠금 해제처럼
 *  방 전체를 물들일 정도는 아니지만 개별 표시에는 의미 있는 것들을 포함한다. */
const OBJECT_ON = {
  ...ACTIVE_RULES,
  binary_sensor: (s) => s.state === "on",        // 문·창문 열림
  lock:          (s) => s.state === "unlocked",
  cover:         (s) => s.state === "open",
};

/** 실제로 빛을 내는 가구. 켜지면 발광하고, 나머지는 테두리로만 알린다
 *  (에어컨이 등처럼 환하게 빛나면 어색하다).
 *
 *  도메인으로는 못 가른다 — 천장등 7개가 전부 switch 도메인이고, 같은 switch 에
 *  환풍기와 식물등 스마트플러그도 섞여 있다. 그래서 오브젝트 id 에 박힌
 *  에셋 이름으로 가른다 (id 는 `o-<에셋>-<번호>` 규칙). */
const LIGHT_ASSETS = new Set(["ceiling-light", "table-lamp", "floor-lamp", "led-strip"]);
const assetOf = (id) => (id || "").replace(/^o-/, "").replace(/-\d+$/, "");

/** 조명이 아닌 가구의 테두리 색을 도메인으로 정한다 */
function toneOf(eid, st) {
  switch (dom(eid)) {
    case "climate":       return st.state === "heat" ? "heat" : "cool";
    case "media_player":  return "media";
    case "fan":
    case "humidifier":    return "air";
    case "lock":                                 // 잠금 해제
    case "binary_sensor": return "alert";        // 문·창문 열림
    default:              return "on";           // switch(플러그)·cover·vacuum
  }
}

/** 짧게 눌렀을 때 켜고 끌 수 있는 도메인. homeassistant.toggle 이 먹는 것들이다.
 *  lock 은 toggle 서비스가 없어서 따로 처리하고, 나머지(sensor·binary_sensor·vacuum 등)는
 *  토글할 게 없으므로 짧게 눌러도 상세를 연다. */
const TOGGLEABLE = new Set([
  "light", "switch", "fan", "input_boolean", "media_player",
  "cover", "humidifier", "climate", "siren", "valve", "remote",
]);
const HOLD_MS = 500;      // 이 이상 누르고 있으면 길게 누른 것으로 본다
const MOVE_TOL = 10;      // px. 이만큼 움직이면 스크롤로 보고 취소한다

const round1 = (n) => Math.round(n * 10) / 10;

/** SVG 의 <image> 하나에서 위치/크기/회전을 읽는다 */
function readBox(el) {
  const num = (a, d = 0) => parseFloat(el.getAttribute(a) ?? d);
  const m = /rotate\(\s*(-?[\d.]+)/.exec(el.getAttribute("transform") || "");
  return { x: num("x"), y: num("y"), w: num("width"), h: num("height"),
           r: m ? parseFloat(m[1]) : 0 };
}

/** 읽은 값을 다시 <image> 에 쓴다. 회전 중심은 항상 상자 중심이라 중심은 안 움직인다 */
function writeBox(el, b) {
  el.setAttribute("x", round1(b.x));
  el.setAttribute("y", round1(b.y));
  el.setAttribute("width", round1(b.w));
  el.setAttribute("height", round1(b.h));
  if (b.r) {
    el.setAttribute("transform",
      `rotate(${round1(b.r)} ${round1(b.x + b.w / 2)} ${round1(b.y + b.h / 2)})`);
  } else {
    el.removeAttribute("transform");
  }
}

/** 점이 상자 안에 있는지. 회전은 역회전시켜 판정한다 */
function boxHit(b, px, py) {
  let x = px, y = py;
  if (b.r) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const a = -b.r * Math.PI / 180, dx = x - cx, dy = y - cy;
    x = cx + dx * Math.cos(a) - dy * Math.sin(a);
    y = cy + dx * Math.sin(a) + dy * Math.cos(a);
  }
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

/** 화면 좌표 -> viewBox 좌표 */
function toViewBox(svg, ev) {
  const p = svg.createSVGPoint();
  p.x = ev.clientX; p.y = ev.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

/**
 * 평면도 SVG 를 container 에 심고 이미지 경로를 해결한다. 카드와 편집기가 공유한다.
 *
 * SVG 를 문서에 인라인하면 그 안의 상대경로는 SVG 파일 위치가 아니라 "지금 보고 있는
 * 페이지 URL" 기준으로 풀린다. HA 에서는 /lovelace/home 이라 fp/sofa.webp 가
 * /lovelace/fp/sofa.webp 가 되고, HA 는 모르는 경로에 SPA 폴백으로 index.html 을
 * 200 으로 내려주기 때문에 404 도 안 뜨고 그냥 엑박이 된다. 그래서 절대화가 필요하다.
 */
async function mountPlan(container, config) {
  let base = null;
  if (config.floorplan) {
    base = new URL(config.floorplan, location.href);
    const res = await fetch(base);
    if (!res.ok) throw new Error(`평면도를 못 읽었습니다: ${config.floorplan} (${res.status})`);
    container.innerHTML = await res.text();
  } else if (EMBEDDED_SVG) {
    container.innerHTML = EMBEDDED_SVG;          // 빌드에 심어둔 기본 평면도
  } else {
    // 빌드를 거치지 않은 소스를 그대로 쓰면 여기로 온다 (개발용)
    throw new Error("내장 평면도가 없습니다. floorplan 을 지정하거나 tools/build.py 로 빌드하세요.");
  }
  if (!container.querySelector("svg")) throw new Error("평면도에서 <svg> 를 찾지 못했습니다.");
  const XLINK = "http://www.w3.org/1999/xlink";
  for (const el of container.querySelectorAll("image")) {
    const href = el.getAttribute("href") ?? el.getAttributeNS(XLINK, "href");
    if (!href || /^(?:[a-z]+:|\/\/|\/)/i.test(href)) continue;   // 절대 URL·data: 는 그대로
    el.setAttribute("href", EMBEDDED_ASSETS[href] ?? new URL(href, base ?? location.href).href);
    el.removeAttributeNS(XLINK, "href");
  }
}

/**
 * config.layout 을 SVG 에 얹는다.
 * SVG 에 구워진 위치가 기본값이고, layout 에 있는 것만 덮어쓴다.
 * 키는 <image> 의 id (o-sofa-1 처럼 안정적인 값) — 순서에 의존하지 않으므로
 * 나중에 오브젝트를 지우거나 추가해도 저장된 위치가 밀리지 않는다.
 */
function applyLayout(root, layout) {
  if (!layout) return;
  for (const [id, v] of Object.entries(layout)) {
    const el = root.querySelector(`#fp-furniture [id="${CSS.escape(id)}"]`);
    if (!el) continue;                       // 없어진 오브젝트는 조용히 무시
    writeBox(el, { ...readBox(el), ...v });
  }
}

/** 현재 SVG 상태에서 layout 을 뽑는다. 기본값과 같은 건 넣지 않아 설정이 작게 유지된다 */
function collectLayout(root, base) {
  const out = {};
  for (const el of root.querySelectorAll("#fp-furniture image[id]")) {
    const b = readBox(el), d = base[el.id];
    if (!d) continue;
    if (["x", "y", "w", "h", "r"].every((k) => Math.abs(b[k] - d[k]) < 0.05)) continue;
    out[el.id] = { x: round1(b.x), y: round1(b.y), w: round1(b.w), h: round1(b.h) };
    if (b.r) out[el.id].r = round1(b.r);
  }
  return out;
}

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
    if (!config.floorplan && !EMBEDDED_SVG) {
      throw new Error("floorplan: SVG 경로가 필요합니다 (예: /local/floorplan.svg)");
    }
    this._config = { exclude: [], exclude_devices: [], rooms: {}, aliases: {}, ...config };
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
      this._wireObjects();
      this._wireLabels();
      this._wireAir();
      this._ready = true;
      this._paint();
    } catch (err) {
      this._fail(err);
    } finally {
      this._booting = false;
    }
  }

  async _loadSvg() {
    const plan = this.shadowRoot.querySelector(".plan");
    await mountPlan(plan, this._config);
    applyLayout(plan, this._config.layout);
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
      const roomCfg = this._config.rooms?.[area] || {};
      const override = roomCfg.primary;          // 대표 목록을 통째로 교체
      const pin = new Set(roomCfg.pin || []);    // 대표에 "추가" (교체가 아니라)
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
        // 이 device 에 속한 pin 은 대표 바로 뒤에 붙인다 (에어컨 옆에 무풍·풍량이 오도록)
        primary.push(...ids.filter((e) => pin.has(e) && !primary.includes(e)));
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

  /**
   * data-entity 가 붙은 가구마다 투명 히트영역을 SVG 맨 위에 만든다.
   *
   * 가구 레이어를 그냥 클릭 가능하게 만들 수는 없다. 가구는 방 틴트(.room)에
   * 덮여야 예쁘고, 그러려면 가구가 방보다 아래에 있어야 하는데, 아래에 있으면
   * 클릭을 방이 먼저 먹는다. 그래서 위치만 복사한 rect 를 맨 위에 깐다.
   * data-entity 가 없는 장식 가구는 rect 가 안 생기므로 클릭이 방으로 떨어진다.
   */
  _wireObjects() {
    const svg = this.shadowRoot.querySelector("#lemon-floorplan");
    if (!svg) return;
    this._objects = [];

    let layer = svg.querySelector("#fp-hotspots");
    if (layer) layer.remove();
    layer = document.createElementNS(svg.namespaceURI, "g");
    layer.id = "fp-hotspots";

    for (const img of svg.querySelectorAll("#fp-furniture image[data-entity]")) {
      const eid = this._resolve(img.getAttribute("data-entity"));
      if (!eid || !this._hass.states[eid]) continue;  // 없는 엔티티는 조용히 건너뛴다
      const r = document.createElementNS(svg.namespaceURI, "rect");
      for (const a of ["x", "y", "width", "height", "transform"]) {
        const v = img.getAttribute(a);
        if (v !== null) r.setAttribute(a, v);
      }
      r.setAttribute("class", "hotspot");
      this._wirePress(r, eid);
      layer.appendChild(r);
      this._objects.push({ img, eid, light: LIGHT_ASSETS.has(assetOf(img.id)) });
    }
    svg.appendChild(layer);                            // 맨 위
  }

  /**
   * 짧게 누르면 켜고 끄고, 길게 누르면 상세를 연다.
   *
   * click 대신 pointer 이벤트로 직접 구현한다. click 만으로는 길게 누른 것을
   * 구분할 수 없고, 길게 눌러 상세를 연 뒤에 click 이 또 날아와 토글까지
   * 되어버리기 때문이다. 손가락이 MOVE_TOL 이상 움직이면 스크롤로 보고 취소한다.
   */
  _wirePress(el, eid) {
    const hold = this._config.hold_time ?? HOLD_MS;
    el.style.setProperty("--hold-ms", `${hold}ms`);

    el.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const sx = ev.clientX, sy = ev.clientY;
      let held = false;
      el.classList.add("pressing");                 // 누르는 동안 서서히 물든다
      try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 무시 */ }

      const done = () => {
        clearTimeout(timer);
        el.classList.remove("pressing");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", done);
      };
      const timer = setTimeout(() => { held = true; done(); this._moreInfo(eid); }, hold);
      const move = (e) => {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_TOL) done();   // 스크롤
      };
      const up = (e) => {
        e.stopPropagation();
        if (held) return;                           // 이미 상세를 열었다
        done();
        this._tap(eid);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", done);
    });
  }

  /** 짧게 누름 */
  _tap(eid) {
    const hass = this._hass, st = hass.states[eid], d = dom(eid);
    if (!st) return;
    if (d === "lock") {
      hass.callService("lock", st.state === "locked" ? "unlock" : "lock", { entity_id: eid });
    } else if (TOGGLEABLE.has(d)) {
      hass.callService("homeassistant", "toggle", { entity_id: eid });
    } else {
      this._moreInfo(eid);          // 켜고 끌 수 없는 건 상세를 연다
    }
  }

  /**
   * data-entity 값을 실제 entity_id 로 푼다.
   *
   * "@key" 형태면 config.aliases[key] 를 본다. 평면도 SVG 는 공개 저장소에
   * 올라가므로, 밖에 내보이고 싶지 않은 entity_id(예: Zigbee IEEE 주소가 박힌
   * 자동 생성 ID)는 SVG 에 직접 쓰지 않고 별칭으로 두고 실제 매핑은
   * HA 안에만 있는 대시보드 설정에 적는다. 그냥 entity_id 를 써도 된다.
   */
  _resolve(v) {
    if (!v) return null;
    if (!v.startsWith("@")) return v;
    return this._config.aliases[v.slice(1)] || null;
  }

  /** HA 기본 more-info 다이얼로그를 띄운다. composed:true 라야 shadow DOM 을 뚫는다 */
  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId }, bubbles: true, composed: true,
    }));
  }

  // ── 상태 반영 ──────────────────────────────────────────────

  /** set hass 는 시스템 전체 상태 변화마다 불린다. 바뀐 방만 건드린다. */
  _paint() {
    const hass = this._hass;
    if (!hass || !this._rooms) return;

    for (const el of this.shadowRoot.querySelectorAll(".plan .room")) {
      const areaId = el.id.replace(/^room-/, "");
      const tint = this._roomTint(areaId);
      if (this._sig[areaId] === tint) continue;     // 안 바뀌었으면 DOM 안 만짐
      this._sig[areaId] = tint;

      if (tint) el.setAttribute("data-tint", tint);
      else el.removeAttribute("data-tint");
    }

    // 가구 하나하나도 자기 엔티티 상태를 표시한다.
    // 조명은 발광, 나머지는 도메인 색 테두리 — data-on 값이 그 구분이다.
    for (const o of this._objects || []) {
      const st = hass.states[o.eid];
      const rule = st && OBJECT_ON[dom(o.eid)];
      const tone = rule && rule(st) ? (o.light ? "light" : toneOf(o.eid, st)) : null;
      if (o.tone === tone) continue;                   // 안 바뀌었으면 DOM 안 만짐
      o.tone = tone;
      if (tone) o.img.setAttribute("data-on", tone);
      else o.img.removeAttribute("data-on");
    }

    // 방 이름 아래 온·습도. 평면도는 좁아서 팝업보다 구분자를 줄인다.
    for (const l of this._envLabels || []) {
      const txt = this._envSummary(l.areaId, " · ");
      if (l.txt === txt) continue;                     // 안 바뀌었으면 DOM 안 만짐
      l.txt = txt;
      l.el.textContent = txt;
    }

    // 평면도 아래 공기질 칩
    for (const c of this._airChips || []) {
      const st = hass.states[c.eid];
      const v = st ? parseFloat(st.state) : NaN;
      const ok = Number.isFinite(v);
      const level = ok ? c.kind.bands.find(([max]) => v < max)[1] : "none";
      const unit = (ok && st.attributes.unit_of_measurement) || "";
      const sig = `${level}|${ok ? round1(v) : "—"}|${unit}`;
      if (c.sig === sig) continue;
      c.sig = sig;
      c.chip.dataset.level = level;
      c.chip.querySelector("b").textContent = ok ? round1(v) : "—";
      c.chip.querySelector("i").textContent = unit;
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
    dlg.querySelector(".env").textContent = this._envSummary(areaId);
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

  /**
   * 평면도 아래 공기질 줄을 만든다. config.air 에 적은 순서대로 칩이 놓인다.
   * 칩은 한 번만 만들고 _paint 가 값만 갈아끼운다 (매번 새로 그리면 클릭이 끊긴다).
   */
  _wireAir() {
    this._airChips = [];
    const row = this.shadowRoot.querySelector(".air");
    if (!row) return;
    row.textContent = "";
    for (const eid of this._config.air || []) {
      const st = this._hass.states[eid];
      const kind = AIR_KINDS[st?.attributes.device_class];
      if (!kind) continue;                         // 모르는 종류는 조용히 건너뛴다
      const chip = document.createElement("button");
      chip.className = "item";
      chip.innerHTML = `<span></span><b></b><i></i>`;
      chip.querySelector("span").textContent = kind.label;
      chip.onclick = () => this._moreInfo(eid);
      row.appendChild(chip);
      this._airChips.push({ eid, kind, chip });
    }
  }

  /** 방 하나의 틴트 값. 없으면 null (칠하지 않음) */
  _roomTint(areaId) {
    const mode = this._config.room_tint ?? "temperature";
    if (mode === "off") return null;
    if (mode === "device") return this._deviceTint(areaId);

    const st = this._envOf(areaId).temperature;
    const v = st ? parseFloat(st.state) : NaN;
    if (!Number.isFinite(v)) return null;           // 센서 없는 방은 안 칠한다
    return bandsOf(this._config.temp_bands).find((b) => v < b.max)?.tint ?? null;
  }

  /** 켜진 기기 종류로 정하던 예전 방식. DEVICE_TINT 표의 순서가 우선순위다. */
  _deviceTint(areaId) {
    const hass = this._hass;
    let best = DEVICE_TINT.length;
    for (const eid of this._rooms?.[areaId]?.all || []) {
      const st = hass.states[eid];
      const d = dom(eid);
      const rule = st && ACTIVE_RULES[d];
      if (!rule || !rule(st)) continue;
      const i = DEVICE_TINT.findIndex((r) => r.match(d, st));
      if (i >= 0 && i < best) best = i;             // 배열 순서와 무관하게 가장 센 것
    }
    return DEVICE_TINT[best]?.tint ?? null;
  }

  /**
   * 방의 대표 온·습도 센서를 고른다.
   *
   * 자동 탐색은 device_class 로 방 안의 첫 센서를 집는데, 방에 온도계가 둘 이상이면
   * (전용 온습도계 + 제습기·공기청정기 내장 센서) 어느 쪽이 잡힐지가 device 이름
   * 정렬 순서에 좌우된다. 기기 내장 센서는 실온과 몇 도씩 어긋나므로, 값이 중요한
   * 방은 rooms.<area>.env 로 못박는다.
   */
  _envOf(areaId) {
    const room = this._rooms?.[areaId];
    const hass = this._hass;
    if (!room || !hass) return {};
    const want = this._config.rooms?.[areaId]?.env;
    const wanted = want ? (Array.isArray(want) ? want : [want]) : null;
    const out = {};
    for (const key of ["temperature", "humidity"]) {
      const match = (e) => hass.states[e]?.attributes.device_class === key;
      const eid = (wanted && wanted.find(match)) ||
                  room.all.find((e) => dom(e) === "sensor" && match(e));
      if (eid) out[key] = hass.states[eid];
    }
    return out;
  }

  /** 방 온습도를 한 줄로. 팝업 헤더와 평면도 라벨이 함께 쓴다 */
  _envSummary(areaId, sep = "  ·  ") {
    const env = this._envOf(areaId), out = [];
    for (const key of ["temperature", "humidity"]) {
      const st = env[key];
      if (!st) continue;
      const v = parseFloat(st.state);
      if (!Number.isFinite(v)) continue;              // unavailable 은 건너뛴다
      out.push(`${round1(v)}${st.attributes.unit_of_measurement || ""}`);
    }
    return out.join(sep);
  }

  /**
   * 방 이름 라벨 아래에 온·습도를 한 줄 붙인다.
   *
   * 라벨과 방의 연결은 SVG 의 data-area 다 (room-* id 와 같은 계약). 라벨에
   * data-area 가 없으면 그 방은 조용히 건너뛴다 — 센서가 없는 방도 마찬가지라
   * 화장실·현관처럼 잴 것이 없는 방에는 빈 줄이 생기지 않는다.
   */
  _wireLabels() {
    this._envLabels = [];
    if (this._config.show_env === false) return;
    const svg = this.shadowRoot.querySelector("#lemon-floorplan");
    if (!svg) return;
    for (const label of svg.querySelectorAll("#fp-labels text[data-area]")) {
      const t = document.createElementNS(svg.namespaceURI, "text");
      t.setAttribute("class", "env");
      t.setAttribute("x", label.getAttribute("x"));
      // 라벨은 dominant-baseline:central 이라 y 가 글자 중심이다. 그 아래로 내린다.
      t.setAttribute("y", String(parseFloat(label.getAttribute("y") || 0) +
                                 (label.classList.contains("sm") ? 17 : 21)));
      label.parentNode.appendChild(t);
      this._envLabels.push({ areaId: label.getAttribute("data-area"), el: t });
    }
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

        /* 공기질 줄. 측정기가 침실 하나뿐이라 방에 칠하지 않고 여기 모은다.
           config.air 가 없으면 :empty 로 통째로 사라진다.

           칩(배경 있는 pill)으로 만들면 항목이 셋만 돼도 카드 아래가 무거워진다.
           방 이름 아래 온습도와 같은 문법의 담백한 한 줄로 둔다 — 평면도가 주인공이고
           이건 곁들이는 정보다. */
        .air {
          display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 16px;
          padding: 10px 12px 4px;
          font: 500 12px/1.5 var(--ha-font-family-body, system-ui, sans-serif);
          color: var(--secondary-text-color);
        }
        .air:empty { display: none; }
        .air .item {
          display: inline-flex; align-items: baseline; gap: 4px;
          border: 0; background: none; padding: 0; cursor: pointer;
          font: inherit; color: inherit;
        }
        .air .item:hover b { text-decoration: underline; text-underline-offset: 3px; }
        .air .item b { font: 600 14px/1 inherit; color: var(--primary-text-color); }
        .air .item i { font-style: normal; font-size: 10px; opacity: .7; }
        /* 좋음·보통은 색을 주지 않는다. 늘 물들어 있으면 경고가 묻힌다 —
           방 온도 틴트에서 쾌적 구간을 비워둔 것과 같은 이유다. */
        .air .item[data-level="warn"] b { color: var(--fp-temp-warm, #ffa726); }
        .air .item[data-level="bad"]  b { color: var(--fp-temp-hot,  #ef5350); }
        .air .item[data-level="none"] b { opacity: .5; }

        /* 방 상태 틴트.
           .room 은 바닥·가구 위에 얹힌 투명 오버레이라, fill-opacity 만 올리면
           아래 레이어가 비쳐 보인다 (fill 을 덮어쓰던 예전 방식과 다르다) */
        .plan svg .room[data-tint] { fill-opacity: .3; }
        .plan svg .room[data-tint]:hover { fill-opacity: .42; }
        .plan svg .room[data-tint="warm"]  { fill: var(--state-light-active-color, #ffc107); }
        .plan svg .room[data-tint="cool"]  { fill: var(--state-climate-cool-color, #2196f3); }
        .plan svg .room[data-tint="heat"]  { fill: var(--state-climate-heat-color, #ff6f22); }
        /* 미디어는 HA 의 --state-media_player-active-color(#03a9f4) 를 쓰지 않는다.
           냉방색 #2196f3 과 거의 같은 파랑이라 방 색만 보고는 에어컨인지 TV 인지 못 가린다. */
        .plan svg .room[data-tint="media"] { fill: var(--purple-color, #926bc7); }

        /* 온도 틴트 (room_tint: temperature).
           기기 틴트와 달리 늘 켜져 있으므로 한 단계 옅게 깐다. 쾌적 구간은 아예
           칠하지 않으니(TEMP_BANDS 참고) 색이 보인다는 것 자체가 이미 신호다. */
        .plan svg .room[data-tint^="temp-"]    { fill-opacity: .17; }
        .plan svg .room[data-tint="temp-cold"] { fill: var(--fp-temp-cold, #1e88e5); }
        .plan svg .room[data-tint="temp-cool"] { fill: var(--fp-temp-cool, #4fc3f7); }
        .plan svg .room[data-tint="temp-warm"] { fill: var(--fp-temp-warm, #ffa726); }
        .plan svg .room[data-tint="temp-hot"]  { fill: var(--fp-temp-hot,  #ef5350); fill-opacity: .23; }

        /* 엔티티가 연결된 가구: 투명 히트영역이 맨 위에 깔린다 */
        .plan svg .hotspot {
          fill: var(--state-icon-active-color, #f9a825); fill-opacity: 0;
          pointer-events: all; cursor: pointer; touch-action: none;
          transition: fill-opacity .15s ease;
        }
        .plan svg .hotspot:hover { fill-opacity: .18; }
        /* 누르고 있는 동안 hold_time 에 맞춰 서서히 진해진다 = 길게 누르기 진행 표시 */
        .plan svg .hotspot.pressing {
          fill-opacity: .45;
          transition: fill-opacity var(--hold-ms, 500ms) linear;
        }
        /* 켜짐 표시.
           조명만 실제로 발광시키고, 나머지 기기는 실루엣을 따라 얇은 테두리만 준다.
           에어컨·세탁기가 등처럼 환하게 빛나면 어색해서 갈랐다.
           drop-shadow 의 길이는 SVG 사용자 단위(viewBox 920 기준)라 화면 크기가
           달라져도 굵기 비율이 유지된다 — 모바일에서 따로 손볼 게 없다.
           같은 그림자를 두 번 겹치는 건 흐릿한 후광 대신 진한 윤곽을 얻으려는 것. */
        .plan svg #fp-furniture image { transition: filter .25s ease; }
        /* 방 색이 온도를 맡게 되면서 "무엇이 켜져 있나" 는 전적으로 가구 몫이 됐다.
           그래서 예전(2+2, 5+10)보다 한 단계씩 세게 준다. brightness 를 함께 올리는
           것은 그림자가 닿지 않는 실루엣 안쪽까지 살아나게 하려는 것 — 테두리만
           밝으면 작은 기기는 멀리서 켜짐이 안 보인다. */
        .plan svg #fp-furniture image[data-on] {
          --fp-tone: var(--state-icon-active-color, #f9a825);
          filter: drop-shadow(0 0 3px var(--fp-tone)) drop-shadow(0 0 3px var(--fp-tone))
                  brightness(1.06);
        }
        /* 조명은 실제로 빛을 내니 넓게 발광 */
        .plan svg #fp-furniture image[data-on="light"] {
          --fp-tone: var(--state-light-active-color, #ffc107);
          filter: drop-shadow(0 0 6px var(--fp-tone)) drop-shadow(0 0 16px var(--fp-tone));
        }
        .plan svg #fp-furniture image[data-on="cool"]  { --fp-tone: var(--state-climate-cool-color, #2196f3); }
        .plan svg #fp-furniture image[data-on="heat"]  { --fp-tone: var(--state-climate-heat-color, #ff6f22); }
        .plan svg #fp-furniture image[data-on="media"] { --fp-tone: var(--purple-color, #926bc7); }
        .plan svg #fp-furniture image[data-on="air"]   { --fp-tone: var(--state-fan-active-color, #00bcd4); }
        .plan svg #fp-furniture image[data-on="alert"] { --fp-tone: var(--red-color, #f44336); }

        /* 팝업 */
        dialog {
          border: none; padding: 0; max-width: 560px; width: calc(100vw - 32px);
          max-height: 84vh; border-radius: 18px;
          background: var(--card-background-color, #fff); color: var(--primary-text-color);
        }
        dialog::backdrop { background: rgba(0,0,0,.5); }
        /* 팝업 폭에 맞춰 열 수를 바꿔야 하는데, dialog 는 showModal 로 최상위 레이어에
           올라가 .plan 바깥에 있다. 그래서 .plan 의 컨테이너를 못 쓴다 —
           여기서 컨테이너를 따로 세워야 아래 @container 가 비로소 걸린다. */
        .sheet { display: flex; flex-direction: column; max-height: 84vh;
                 container-type: inline-size; }
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
        /* 1fr 은 minmax(auto,1fr) 이라 칸이 내용의 min-content 아래로 안 줄어든다.
           긴 기기 이름 하나가 열을 밀어내 그리드가 팝업 밖으로 삐져나갔다.
           minmax(0,1fr) 이라야 줄어들면서 안에서 말줄임된다. */
        .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
        /* 폰은 전부 1열. 2열을 쓰려면 한 칸이 200px 은 돼야 하는데(본문 여백 28 + 간격 8),
           440px 이하에서는 그게 안 나온다. HA 기본 대시보드도 폰에서는 타일이 한 줄이다. */
        @container (max-width: 440px) { .grid { grid-template-columns: minmax(0, 1fr); } }
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
        <div class="air"></div>
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

/**
 * HA 카드 편집기. 대시보드 → 카드 편집을 열면 여기서 가구를 끌어 옮기고,
 * HA 의 저장 버튼이 config 를 저장한다.
 *
 * 카드가 대시보드 설정을 직접 쓰지 않는 이유: lovelace/config/save 는 대시보드
 * 전체를 읽어 다시 쓰는 것이라, 버그가 있으면 다른 카드까지 날린다. HA 에 맡기면
 * 저장·취소·되돌리기가 전부 기본 동작을 따른다.
 */
class LemonFloorplanCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._base = {};     // SVG 에 구워진 원래 위치. layout 이 이걸 덮어쓴다
    this._sel = null;
  }

  setConfig(config) {
    this._config = { ...config };
    if (!this._booted) { this._booted = true; this._boot(); }
  }
  set hass(hass) { this._hass = hass; }

  async _boot() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
               padding: 4px 0 10px; font: 13px/1.5 var(--ha-font-family-body, system-ui, sans-serif);
               color: var(--secondary-text-color); }
        button { font: inherit; padding: 5px 12px; border-radius: 8px; cursor: pointer;
                 border: 1px solid var(--divider-color, #ddd);
                 background: var(--secondary-background-color, #f1f3f6);
                 color: var(--primary-text-color); }
        kbd { background: var(--secondary-background-color, #eee);
              border: 1px solid var(--divider-color, #ddd); border-radius: 5px;
              padding: 0 5px; font-size: 12px; }
        .plan { position: relative; border: 1px solid var(--divider-color, #ddd);
                border-radius: 12px; overflow: hidden; }
        .plan svg { width: 100%; height: auto; display: block; touch-action: none; }
        .plan svg .room { pointer-events: none; }
        .plan svg #fp-furniture image { pointer-events: none; }
        .plan svg #fp-hotspots { display: none; }
        .sel { fill: none; stroke: var(--error-color, #e5484d); stroke-width: 3;
               stroke-dasharray: 8 6; pointer-events: none; }
        .err { padding: 12px; color: var(--error-color, #db4437); font: 13px ui-monospace, monospace; }
      </style>
      <div class="bar">
        <button id="reset">배치 되돌리기</button>
        <span><b>끌기</b> 이동 · <kbd>휠</kbd> 크기 · <kbd>Shift</kbd>+<kbd>휠</kbd> 회전
              · <kbd>←↑↓→</kbd> 미세조정</span>
        <span id="n" style="margin-inline-start:auto"></span>
      </div>
      <div class="plan"></div>
    `;
    const plan = this.shadowRoot.querySelector(".plan");
    try {
      await mountPlan(plan, this._config);
    } catch (err) {
      plan.innerHTML = `<div class="err">${String(err.message || err)}</div>`;
      return;
    }

    const svg = plan.querySelector("svg");
    this._svg = svg;
    for (const el of svg.querySelectorAll("#fp-furniture image[id]")) {
      this._base[el.id] = readBox(el);              // layout 적용 전이 기본값
    }
    applyLayout(plan, this._config.layout);

    const box = document.createElementNS(svg.namespaceURI, "rect");
    box.setAttribute("class", "sel");
    box.style.display = "none";
    svg.appendChild(box);
    this._box = box;

    svg.addEventListener("pointerdown", (e) => this._down(e));
    svg.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    this.addEventListener("keydown", (e) => this._key(e));
    this.tabIndex = 0;
    this.shadowRoot.getElementById("reset").onclick = () => this._reset();
    this._count();
  }

  _items() { return [...this._svg.querySelectorAll("#fp-furniture image[id]")]; }

  _down(ev) {
    ev.preventDefault();
    const p = toViewBox(this._svg, ev);
    // 겹치면 작은 쪽을 고른다. <image> 는 보이는 그림이 아니라 상자 전체가
    // 판정 영역이라, 문서 순서에 맡기면 큰 것이 작은 것을 덮어버린다.
    const hit = this._items()
      .map((el) => ({ el, b: readBox(el) }))
      .filter(({ b }) => boxHit(b, p.x, p.y))
      .sort((a, z) => a.b.w * a.b.h - z.b.w * z.b.h)[0];
    if (!hit) { this._select(null); return; }

    this._select(hit.el);
    const start = readBox(hit.el);
    const move = (e) => {
      const q = toViewBox(this._svg, e);
      writeBox(hit.el, { ...start, x: start.x + (q.x - p.x), y: start.y + (q.y - p.y) });
      this._drawSel();
    };
    const up = () => {
      this._svg.removeEventListener("pointermove", move);
      this._svg.removeEventListener("pointerup", up);
      this._emit();
    };
    this._svg.addEventListener("pointermove", move);
    this._svg.addEventListener("pointerup", up);
  }

  _wheel(ev) {
    if (!this._sel) return;
    ev.preventDefault();
    const b = readBox(this._sel);
    if (ev.shiftKey) {
      b.r = (b.r + (ev.deltaY > 0 ? 15 : -15)) % 360;
    } else {
      const k = ev.deltaY > 0 ? 0.94 : 1.06;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      b.w *= k; b.h *= k; b.x = cx - b.w / 2; b.y = cy - b.h / 2;
    }
    writeBox(this._sel, b);
    this._drawSel();
    this._emit();
  }

  _key(ev) {
    if (!this._sel) return;
    const d = ev.shiftKey ? 10 : 1;
    const map = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
    if (!map[ev.key]) return;
    ev.preventDefault();
    const b = readBox(this._sel);
    writeBox(this._sel, { ...b, x: b.x + map[ev.key][0], y: b.y + map[ev.key][1] });
    this._drawSel();
    this._emit();
  }

  _select(el) { this._sel = el; this._drawSel(); }

  _drawSel() {
    if (!this._sel) { this._box.style.display = "none"; return; }
    const b = readBox(this._sel);
    this._box.setAttribute("x", b.x); this._box.setAttribute("y", b.y);
    this._box.setAttribute("width", b.w); this._box.setAttribute("height", b.h);
    if (b.r) this._box.setAttribute("transform",
      `rotate(${b.r} ${b.x + b.w / 2} ${b.y + b.h / 2})`);
    else this._box.removeAttribute("transform");
    this._box.style.display = "";
  }

  _reset() {
    for (const el of this._items()) if (this._base[el.id]) writeBox(el, this._base[el.id]);
    this._select(null);
    this._emit();
  }

  _count() {
    const n = Object.keys(this._config.layout || {}).length;
    this.shadowRoot.getElementById("n").textContent = n ? `옮긴 것 ${n}개` : "";
  }

  /** HA 가 이 이벤트를 받아 config 를 갱신하고, 저장 버튼을 누르면 기록한다 */
  _emit() {
    const layout = collectLayout(this._svg, this._base);
    this._config = { ...this._config };
    if (Object.keys(layout).length) this._config.layout = layout;
    else delete this._config.layout;
    this._count();
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }
}

customElements.define(`${CARD_TAG}-editor`, LemonFloorplanCardEditor);
LemonFloorplanCard.getConfigElement = () => document.createElement(`${CARD_TAG}-editor`);

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
