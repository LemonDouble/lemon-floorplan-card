# lemon-floorplan-card

SVG 평면도 위에서 가구를 눌러 기기를 제어하는 Home Assistant 커스텀 카드.

![평면도](render.png)

- **가구 짧게 누르기** → 켜고 끄기 / **길게 누르기** → more-info
- **빈 바닥 누르기** → 그 방 기기 목록 팝업
- 켜진 조명은 발광하고, 조명 아닌 기기는 도메인 색 테두리만 두른다. 방 전체도 상태 색으로 물든다
- 방↔기기 매핑을 설정에 적지 않는다. HA area 레지스트리를 런타임에 읽는다

---

## 1. 설치

HACS → ⋮ → **Custom repositories** → `LemonDouble/lemon-floorplan-card` / Type **Dashboard**
→ 목록에서 받기 → **Ctrl+Shift+R**. 리소스 등록은 HACS 가 알아서 한다.

대시보드에 Manual card 로:

```yaml
type: custom:lemon-floorplan-card
```

평면도는 빌드에 내장돼 있어서 이 한 줄로 뜬다.

<details>
<summary>수동 설치</summary>

`dist/lemon-floorplan-card.js` **한 개**를 `config/www/` 에 복사하고,
Settings → Dashboards → ⋮ → Resources 에서 `/local/lemon-floorplan-card.js` 를
**JavaScript Module** 로 등록한다.
</details>

---

## 2. 설정

| 키 | 설명 |
|---|---|
| `title` | 카드 제목 (생략 가능) |
| `floorplan` | 외부 SVG 경로. 생략하면 빌드에 내장된 평면도를 쓴다 |
| `hold_time` | 길게 누르기 판정 시간 (ms, 기본 500) |
| `aliases` | `@key` → 실제 entity_id. → [§5](#5-공개-저장소와-별칭) |
| `exclude_devices` | 방 팝업에서 통째로 뺄 device (id 또는 이름) |
| `exclude` | 방 팝업에서 뺄 엔티티 |
| `rooms.<area>.pin` | 방 팝업 "자주 쓰는 것" 에 **추가** |
| `rooms.<area>.primary` | "자주 쓰는 것" 을 통째로 **교체** (`pin` 무시) |
| `layout` | 가구 위치 덮어쓰기. 카드 편집기가 자동으로 기록 |

현재 이 집 설정 (대시보드 `홈` → 첫 섹션):

```yaml
type: custom:lemon-floorplan-card
exclude_devices:            # 공유기 센서 13개, 중복 TV device 등
  - 9623f9049e3a2b9dde498311bee3ec13
  - ...
aliases:                    # Zigbee IEEE 가 박힌 ID 7개
  ceiling-geosil: switch.0x...._top
  ...
rooms:
  geosil: { pin: [switch.geosil_eeokeon_mupung, select.geosil_eeokeon_pungryang] }
  cimsil: { pin: [...무풍, 풍량, 바람 방향] }
```

---

## 3. 고치려면 — 무엇을 바꾸느냐에 따라 경로가 다르다

### (a) 가구를 조금 옮기고 싶다 → **HA 안에서, 배포 불필요**

대시보드 → 편집 → 이 카드 편집. 편집창에 평면도가 뜬다.

| 끌기 | 휠 | Shift+휠 | ←↑↓→ |
|---|---|---|---|
| 이동 | 크기 | 15° 회전 | 1칸 (Shift 10칸) |

HA 저장 버튼을 누르면 `config.layout` 에 기록된다. **옮긴 것만** 저장되고
나머지는 SVG 기본값을 쓴다. "배치 되돌리기" 로 전부 원복.

### (b) 기본 배치 자체를 바꾸고 싶다 → `editor.html` → 빌드 → 릴리스

```bash
python3 -m http.server 8899        # 저장소 루트에서
# http://127.0.0.1:8899/editor.html
```

끌어 옮기고 **SVG 출력** → 나온 블록으로 `floorplan.svg` 의
`<g id="fp-furniture">…</g>` 를 통째로 교체 → [§(e) 배포](#e-배포).

> 출력에 `data-entity` 와 `id` 가 포함된다. 빠뜨리면 엔티티 연결이 전멸하므로
> **블록 통째로** 교체할 것.

### (c) 벽·방 모양을 바꾸고 싶다 → `floorplan.svg` 직접

좌표계와 그리드가 파일 맨 위 주석에 정리돼 있다. 방 도형은 `<defs>` 에 한 번만
정의하고 `fp-floor` / `fp-rooms` 가 `<use>` 로 공유하므로 **한 군데만** 고치면 된다.

`preview.html` 에 "좌표 찍기" 가 있다 (클릭하면 viewBox 좌표 + % 출력).

방 polygon 의 id 가 HA `area_id` 와 1:1 이어야 한다. 이게 카드와의 유일한 계약이다.

### (d) 가구를 추가하고 싶다 → `tools/gen_furniture.py`

```bash
cd tools
uv run --with openai python gen_furniture.py sofa fridge      # 일부만
uv run --with openai python gen_furniture.py                  # 전체
```

`low` 기준 장당 약 $0.0065. 뽑은 뒤 누끼 → 트림 → WebP:

```bash
uv run --with rembg --with onnxruntime --with pymatting --with pillow \
  ~/.claude/skills/gpt-image/scripts/cutout.py assets/raw/ assets/out/ --preview '#2b6cb0'
# assets/out/preview/ 를 반드시 눈으로 확인 (halo·구멍)
```

그 다음 `fp/*.webp` 로 256px 트림·축소 → `floorplan.svg` 에 `<image>` 추가
(`id="o-<에셋>-<번호>"`, 엔티티를 걸 거면 `data-entity`) → 배포.

프롬프트 함정은 [§6](#6-함정-모음) 참고.

### (e) 배포

```bash
python3 tools/build.py                              # dist/ 단일 JS 생성
git add -A && git commit -m "..." && git push
gh release create v1.5.0 --title v1.5.0 --notes "..."
```

그 다음 HACS 에서 업데이트를 누르거나, MCP 로:
`ha_manage_hacs(action="download", repository_id="LemonDouble/lemon-floorplan-card", version="v1.5.0")`

마지막에 **Ctrl+Shift+R**.

---

## 4. 구조

```
src/card.js          카드 본체 (편집 대상)
floorplan.svg        평면도 (편집 대상)
fp/*.webp            가구 에셋 37종
tools/build.py       fp/ + floorplan.svg → dist/ 단일 JS
tools/gen_furniture.py  gpt-image 로 가구 생성
dist/…js             HACS 배포본 (빌드 산출물, 커밋됨)

editor.html          가구 배치 편집기 (기본 배치용)
preview.html         평면도 확인 + 좌표 찍기
test.html            mock hass 로 카드를 구동하는 테스트 하네스
```

**SVG 레이어 순서** (아래 → 위):

```
fp-floor       바닥 재질. SVG <pattern> (마루/타일) — 이미지 0개, 다크모드 공짜
fp-furniture   가구 <image>. pointer-events:none
fp-rooms       방 히트영역 + 상태 틴트. 가구를 덮어야 하므로 가구보다 위
벽 / 창 / 단차 / 문
fp-labels      방 이름
fp-hotspots    ← 카드가 런타임 생성. data-entity 있는 가구만 투명 rect
```

가구를 클릭 가능하게 하려면 방 폴리곤보다 위여야 하는데, 그러면 틴트가 가구
아래로 깔린다. 그래서 위치만 복사한 투명 rect 를 맨 위에 따로 깐다.
장식 가구는 rect 가 안 생기므로 클릭이 그대로 방으로 떨어진다.

**켜짐 표시**는 조명과 그 외를 가른다. 조명은 실제로 빛을 내니 넓게 발광시키고
(`drop-shadow` 5+10), 에어컨·세탁기 같은 건 실루엣을 따라 얇은 테두리만 준다(2+2).
에어컨이 등처럼 환하게 빛나면 어색해서다.

무엇이 조명인지는 **도메인으로 못 가른다** — 천장등 7개가 전부 `switch` 도메인이고
같은 `switch` 에 환풍기·식물등 플러그도 섞여 있다. 그래서 오브젝트 id
(`o-<에셋>-<번호>`)에 박힌 에셋 이름으로 가른다. `src/card.js` 의 `LIGHT_ASSETS`.

```
light  ceiling-light · table-lamp · floor-lamp · led-strip   앰버 발광
cool   climate(heat 아님)   파랑     media  media_player   보라
heat   climate(heat)        주황     air    fan·humidifier 청록
alert  lock 해제 · binary_sensor 열림  빨강
on     그 외 (switch 플러그 · cover · vacuum)  앰버 테두리
```

`drop-shadow` 의 길이는 SVG 사용자 단위(viewBox 920 기준)라 화면 폭이 달라져도
굵기 비율이 유지된다. 모바일에서 따로 손볼 게 없다.

**방↔기기 매핑**은 `hass.callWS` 로 `config/{area,device,entity}_registry/list` 를
한 번 읽어 만든다. 엔티티의 area 는 자기 값이 우선이고 없으면 device 것을 물려받는다
(2구 스위치처럼 방을 걸치는 기기가 엔티티 레벨로 덮어써져 있다).

**방 팝업의 "자주 쓰는 것"** 은 임의로 고르지 않는다. device 안에서 우선순위가
가장 높은 도메인을 찾고 그 도메인 엔티티를 **전부** 대표로 쓴다.

```
climate > light > cover > lock > media_player > fan
        > humidifier > vacuum > water_heater > valve > siren > switch
```

에어컨 device → `climate` 하나 (companion 스위치 10개는 접힘).
2구 벽스위치 → `switch` 두 개 다 노출.

---

## 5. 공개 저장소와 별칭

저장소가 공개라 Zigbee IEEE 주소가 박힌 자동 생성 entity_id 는 SVG 에 직접 쓰지
않는다. `@key` 별칭으로 두고 실제 매핑은 **HA 안에만 있는 대시보드 설정**에 적는다.

```svg
<image data-entity="@ceiling-geosil" …/>          <!-- 공개되는 SVG -->
```
```yaml
aliases: { ceiling-geosil: switch.0x…_top }        # 대시보드 설정 (비공개)
```

IEEE 가 안 박힌 나머지 25개는 그냥 entity_id 를 직접 쓴다. 별칭이 필요한 건 7개뿐.

> HACS 는 **비공개 저장소를 아예 못 읽는다** (공식 FAQ). 그래서 저장소를 비공개로
> 돌리는 선택지는 없다.

---

## 6. 함정 모음

작업하면서 실제로 걸렸던 것들. 다시 밟지 말 것.

### HACS

- **릴리스에서 "레포 이름과 같은 `.js`" 하나만 가져간다.** `dist/` 에 `floorplan.svg`
  를 나란히 뒀더니 받아가지 않았다 (`/hacsfiles/…/floorplan.svg` → 404).
  그래서 빌드가 평면도·에셋을 전부 JS 한 파일에 인라인한다.
- **`dist/` 보다 저장소 루트의 동명 파일을 먼저 가져간다.** 문서상 순서는
  `dist` → 릴리스 → 루트인데 실제로는 루트가 이겼다. 그래서 소스를 `src/card.js`
  로 옮겨 `lemon-floorplan-card.js` 가 `dist/` 에만 존재하게 했다.
- 비공개 저장소 불가.

### SVG / 브라우저

- **인라인한 SVG 안의 상대경로는 "지금 보고 있는 페이지 URL" 기준으로 풀린다.**
  HA 에서 `/lovelace/home` 이면 `fp/x.webp` → `/lovelace/fp/x.webp` 가 되고,
  HA 는 모르는 경로에 SPA 폴백으로 `index.html` 을 **200 으로** 내려준다.
  404 도 안 뜨고 그냥 엑박. `_loadSvg` 가 절대화로 처리한다.
- **`<image>` 의 클릭 판정은 보이는 그림이 아니라 `x/y/width/height` 상자 전체다.**
  `preserveAspectRatio` 때문에 여백도 클릭을 먹고, 겹치면 문서 순서상 마지막이
  무조건 이긴다. 편집기·카드 모두 "겹친 것 중 면적이 작은 쪽" 을 고른다.
- **같은 에셋을 여러 번 쓰면 인라인이 그만큼 반복된다.** 천장등 7개 때문에 배포본이
  1231KB 까지 갔다. 에셋을 별도 맵에 한 번만 담아 332KB 로 줄였다.
- **SVG 를 blob 으로 직렬화해 `<img>` 로 로드하면 외부 참조가 전부 차단된다.**
  캔버스 픽셀 검사로 렌더를 검증하려다 헛다리를 짚었다.
- **같은 origin 에서 옛 SVG 가 캐시된다.** 편집기 출력에 data URI 가 튀어나온 적이
  있다. `fetch(..., {cache:"no-store"})` 로 처리.
- **`click` 으로는 길게 누르기를 구현할 수 없다.** more-info 를 연 뒤 `click` 이 또
  날아와 토글까지 된다. `pointerdown/move/up` 으로 직접 짰다.
- **`--state-media_player-active-color` 는 쓰지 않는다.** 실제 인스턴스에서 재보니
  `#03a9f4` 인데 `--state-climate-cool-color` 가 `#2196f3` 이라 눈으로 못 가린다.
  에어컨인지 TV 인지 구분이 안 돼서 미디어만 `--purple-color`(#926bc7) 로 뺐다.
  HA 상태 색 변수는 추측하지 말고 브라우저에서 `getComputedStyle` 로 직접 읽을 것
  (로그인 전 `/auth/authorize` 페이지에도 테마가 이미 적용돼 있어 거기서 읽힌다).

### 검수 렌더 (cairosvg)

`<image href=…>` (SVG2) 를 못 읽는다. `xlink:href` 로 바꿔도 상대경로를 못 푼다.
**data URI 로 인라인해야만** 렌더된다. `tools/` 에 스크립트로 두진 않았고 그때그때
임시로 만들어 썼다 — 실기기 확인은 `test.html` + 브라우저가 더 정확하다.

### gpt-image 프롬프트

- **"circular grille" 를 넣으면 실외기가 나온다.** 실내 스탠드 에어컨은 위에서 보면
  팬이 없다. 반대로 실외기를 원하면 이 표현을 쓰면 된다.
- **냉장고·세탁기·건조기·옷장처럼 "문 달린 큰 상자" 는 그냥 두면 정면도를 그린다.**
  `"the TOP SURFACE … viewed from the ceiling looking straight down, the doors are
  NOT visible"` 을 못박아야 한다.
- **비율도 명시할 것.** "twice as deep as wide" 로 썼더니 1:3 슬랩이 나왔다.
  실측치를 적는 게 낫다 (`a real unit is ~36cm x 36cm`).
- **흰 가구는 순백을 피할 것.** 누끼 3단계(순수 배경색 제거)가 피사체를 배경으로
  오인해 구멍을 낸다. `air-monitor` 에서 실제로 겪었다. `SOFT OFF-WHITE … clearly
  NOT pure white` 로 못박는다.
- 누끼 후 `assets/out/preview/` 를 **반드시 눈으로 확인**. 투명 영역을 검게 렌더하는
  뷰어로는 halo 가 안 보인다.

### 이 집 HA 특유

- **온습도 센서 entity_id 가 실제 위치와 다르다.**
  `sensor.geosil_onseubdo_senseo_temperature` (접미사 없음) = **침실**,
  `_2` = 거실. 리네임은 자동화·씬을 깨뜨려서 안 했다.
- **엔티티의 area 는 device 의 area 를 덮어쓴다.** Yeelight 라인조명은 device 가
  거실인데 엔티티에 `area_id: jubang` 오버라이드가 있어서 이미 주방으로 잡히고
  있었다. device 만 보고 "HA 가 틀렸다" 고 판단하면 안 된다.
- 가습기 device 는 `disabled_by: "user"` 다. 엔티티에 상태가 없어 핫스팟이 안 생긴다.

---

## 7. 의존하는 API

| API | 문서화 | 비고 |
|---|---|---|
| `hass.states` / `callService` / `callWS` | ✅ 공식 | 핵심 기능 전부 여기에만 의존 |
| `config/*_registry/list` WS 커맨드 | ✅ 백엔드 공식 | area 매핑 |
| `getConfigElement` / `config-changed` | ✅ 공식 | 카드 편집기 |
| `hass-more-info` 이벤트 | 관례 | 커스텀 카드 표준 패턴 |
| `window.loadCardHelpers()` | ❌ 비공식 | 없으면 자체 행 렌더로 폴백. 죽지 않음 |

HA 내부 컴포넌트(`ha-icon`, more-info 다이얼로그 내부 등)는 쓰지 않는다.
`ha-card` 만 껍데기로 쓰는데, 없으면 그냥 div 로 렌더된다.

**카드가 대시보드 설정을 직접 쓰지 않는다.** `lovelace/config/save` 는 대시보드
전체를 읽어 다시 쓰는 것이라 버그가 나면 다른 카드까지 날린다. `getConfigElement`
로 HA 편집기에 얹혀 `config-changed` 만 쏘고 저장은 HA 가 한다.

---

## 8. 테스트

`test.html` 은 HA 없이 카드를 구동하는 mock 하네스다. 실제 인스턴스에서 뽑은
레지스트리·상태를 흉내내고, 카드와 카드 편집기를 나란히 띄운다.

```bash
python3 -m http.server 8899
# http://127.0.0.1:8899/test.html
```

브라우저 콘솔에서 `__card`, `__editor`, `__liveConfig()`, `__setState(eid, state)`
로 조작할 수 있다.

**성능** — `set hass` 는 시스템 전체 상태 변화마다 불린다. 방마다 상태 서명을
캐시해 바뀐 방만 DOM 을 건드린다. (검증: 상태 변화 없이 `hass` 두 번 재주입 →
`data-tint` 쓰기 0회)
