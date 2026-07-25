# lemon-floorplan-card

SVG 평면도에서 방을 탭하면 그 방의 기기 컨트롤이 팝업으로 열리는 HA 커스텀 카드.

방↔기기 매핑을 **설정에 적지 않는다.** HA area 레지스트리를 런타임에 읽어서 만들기 때문에,
Settings에서 기기 area만 바꾸면 카드가 자동으로 따라온다.

![평면도](render.png)

## 설치 (HACS)

1. HACS → ⋮ → **Custom repositories**
   - Repository: `LemonDouble/lemon-floorplan-card`
   - Type: **Dashboard**
2. 목록에서 **Lemon Floorplan Card** 를 받는다. 리소스는 HACS 가 알아서 등록한다
3. 브라우저 강력 새로고침 (Ctrl+Shift+R)
4. 대시보드에 Manual card 로 추가:

```yaml
type: custom:lemon-floorplan-card
title: 우리집             # 선택
exclude_devices:          # 선택 — device_id 또는 device 이름. 통째로 뺀다
  - "EFM Networks ipTIME AX2004M"      # 센서 13개짜리 공유기 같은 것
exclude:                  # 선택 — 엔티티 단위
  - sensor.foo
rooms:                    # 선택 — 방별 대표 엔티티 조정
  geosil:
    pin:                  # 대표에 "추가". 해당 기기 대표 바로 뒤에 붙는다
      - switch.geosil_eeokeon_mupung
      - select.geosil_eeokeon_pungryang
  cimsil:
    primary: [...]        # 대표 목록을 통째로 "교체" (pin 은 무시됨)
```

> **평면도가 빌드에 내장돼 있다.** `floorplan` 을 안 주면 이 저장소의 평면도를 쓴다.
> 자기 집 평면도로 바꾸려면 `floorplan.svg` 를 고치고 `tools/build.py` 를 돌리거나,
> `floorplan: /local/my-plan.svg` 로 외부 파일을 지정하면 된다.
> 방 polygon 의 id 를 `room-<area_id>` 로 맞추는 것이 카드와의 유일한 계약이다.

### 수동 설치

`dist/lemon-floorplan-card.js` **한 개**를 `config/www/` 에 복사하고, Settings →
Dashboards → ⋮ → Resources 에서 `/local/lemon-floorplan-card.js` 를
**JavaScript Module** 로 등록한다.

## 배포

```bash
python3 tools/build.py                       # dist/lemon-floorplan-card.js 생성
git add -A && git commit -m "..." && git push
gh release create v1.0.1 --generate-notes
```

### 왜 한 파일인가

**HACS 는 plugin 릴리스에서 "레포 이름과 같은 `.js`" 하나만 가져간다.**
`dist/` 에 `floorplan.svg` 를 나란히 뒀더니 받아가지 않았다
(`/hacsfiles/lemon-floorplan-card/floorplan.svg` → 404). 실측으로 확인한 동작이다.

그래서 빌드가 2단계로 인라인해서 배포본을 `.js` 한 개로 만든다:

```
fp/*.webp  --(data URI)-->  floorplan.svg  --(JS 문자열)-->  dist/lemon-floorplan-card.js
                                                              310 KB
```

부수 효과로 상대경로 문제도 사라진다 — 카드가 SVG 를 shadow DOM 에 인라인하면
내부 상대경로가 "SVG 위치" 가 아니라 **"보고 있는 페이지 URL"** 기준으로 풀리는데,
data URI 는 그 영향을 안 받는다. (외부 `floorplan:` 을 쓸 때를 위해 `_loadSvg()` 의
경로 절대화 로직은 남겨뒀다.)

## 동작

**방 색** — 그 방 기기 상태에 따라 폴리곤이 물든다.

| 조건 | 색 |
|---|---|
| climate 가 `heat` | 주황 (`--state-climate-heat-color`) |
| climate 가 `cool`/`dry`/`fan_only`/`auto` | 파랑 (`--state-climate-cool-color`) |
| light·switch·fan·humidifier 가 `on` | 호박 (`--state-light-active-color`) |
| media_player 가 `playing` | 보라 |
| 그 외 | 중립 |

climate 가 우선한다. 전부 HA 테마 변수라 라이트/다크가 자동으로 따라온다.

**가구 클릭** — `data-entity` 가 붙은 가구는 짧게/길게 누르기를 구분한다.

| | 동작 |
|---|---|
| 짧게 | 켜고 끄기 |
| 길게 (기본 500ms, `hold_time` 로 조절) | more-info 다이얼로그 |

짧게 눌렀을 때 도메인별 동작:

- `light` `switch` `fan` `cover` `media_player` `humidifier` `climate` `siren` `valve` `remote` `input_boolean` → `homeassistant.toggle`
- `lock` → 상태를 보고 `lock` / `unlock` (toggle 서비스가 없다)
- 그 외 (`sensor` `binary_sensor` `vacuum` …) → 토글할 게 없으므로 more-info

누르고 있는 동안 히트영역이 `hold_time` 에 맞춰 서서히 진해져서 언제 길게 누르기가
성립하는지 보인다. 손가락이 10px 이상 움직이면 스크롤로 보고 취소한다 —
모바일에서 평면도를 스크롤하다 기기가 켜지는 사고를 막는다.

> `click` 이벤트로는 구현할 수 없다. 길게 눌러 more-info 를 연 뒤 `click` 이 또
> 날아와 토글까지 되어버린다. `pointerdown`/`pointermove`/`pointerup` 으로 직접 짰다.

**팝업** — 방을 누르면 뜬다. 2단 구조다.

```
┌─ 거실  27.5°C · 63% ───────── ✕ ┐
│ 자주 쓰는 것                      │
│ ┌────────┐ ┌────────┐           │
│ │ 에어컨  │ │ 소파등  │           │
│ └────────┘ └────────┘           │
│ ┌────────┐                      │
│ │ 천장등  │                      │
│ └────────┘                      │
│ ───────────────────────         │
│ 전체 보기            [48]  ⌄     │
└─────────────────────────────────┘
```

- **자주 쓰는 것** — device 마다 대표 엔티티만 2단 타일로
- **전체 보기** — 접힘. 펼치면 device 별로 묶인 전체 목록. **펼칠 때 한 번만 렌더**한다
- **헤더** — 방 온습도 요약 (센서가 전체보기에 묻히지 않게)

"대표"는 임의로 안 고른다. device 안에서 우선순위가 가장 높은 도메인을 찾고,
**그 도메인 엔티티를 전부** 대표로 쓴다.

```
climate > light > cover > lock > media_player > fan
        > humidifier > vacuum > water_heater > valve > siren > switch
```

- 에어컨 device → `climate` 하나. companion 스위치 10개는 전체보기로
- 2구 벽스위치 → `switch` 두 개 다 노출 (화장실 등 + 환풍기)
- 온습도 센서 device → 대표 없음. 헤더 요약과 전체보기에만

기본 규칙으로 부족할 때:

- `rooms.<area_id>.pin` — 대표에 **추가**한다. 그 엔티티가 속한 기기의 대표
  바로 뒤에 끼워 넣으므로, 에어컨 타일 옆에 무풍·풍량이 나란히 온다.
- `rooms.<area_id>.primary` — 대표 목록을 통째로 **교체**한다 (`pin` 은 무시).

`window.loadCardHelpers()` 가 있으면 진짜 HA tile 카드를 쓰고 (도메인별 feature 자동 부착),
없으면 자체 행 렌더로 폴백한다. 즉 그 API가 사라져도 카드는 죽지 않는다.

**자동으로 걸러지는 것** — `entity_category` 가 붙은 진단/설정 엔티티(linkquality, 배터리,
identify 버튼 등), `hidden_by`/`disabled_by` 가 걸린 엔티티, `update`·`event` 같은 도메인.

## 성능

`set hass` 는 시스템 전체 상태 변화마다 불린다. 방마다 상태 서명을 캐시해서
**바뀐 방만 DOM 을 건드린다.** 검증: 상태 변화 없이 `hass` 를 두 번 재주입 → `data-tint` 쓰기 0회.

## 의존하는 API

| API | 문서화 | 비고 |
|---|---|---|
| `hass.states` / `callService` / `callWS` | ✅ 공식 | 핵심 기능 전부 여기에만 의존 |
| `config/*_registry/list` WS 커맨드 | ✅ 백엔드 공식 | area 매핑 |
| `window.loadCardHelpers()` | ❌ 비공식 | 없으면 폴백. 죽지 않음 |

HA 내부 컴포넌트(`ha-icon`, more-info 다이얼로그 내부 등)는 쓰지 않는다.
`ha-card` 만 껍데기로 쓰는데, 없으면 그냥 div 로 렌더된다.

## 평면도 레이어

```
fp-floor      바닥 재질. SVG <pattern> 이라 이미지 0개, 해상도 무한, 다크모드 공짜
              마루 = 거실·침실·작은방 / 타일 = 나머지
fp-furniture  가구 <image>. pointer-events:none 이라 클릭을 막지 않는다
fp-rooms      히트영역 + 상태 틴트. 기본 투명이고 fill-opacity 만 올린다
              (fill 을 덮어쓰지 않으므로 아래 바닥·가구가 비쳐 보인다)
벽 / 창 / 단차 / 문
fp-labels     방 이름
```

방 도형은 `<defs>` 에 한 번만 정의하고 `fp-floor` 와 `fp-rooms` 가 `<use>` 로 공유한다.
좌표를 고칠 때 한 군데만 고치면 된다.

## 가구 에셋

`tools/gen_furniture.py` 가 gpt-image-2 로 top-down 가구를 뽑는다.

```bash
cd tools
uv run --with openai python gen_furniture.py                 # 전체
uv run --with openai python gen_furniture.py fridge sofa     # 일부만
uv run --with openai python gen_furniture.py --quality high sofa
```

`low` 기준 장당 약 $0.0065. 전체 15개에 $0.10 정도.

뽑은 뒤 누끼 → 트림 → WebP:

```bash
uv run --with rembg --with onnxruntime --with pymatting --with pillow \
  ~/.claude/skills/gpt-image/scripts/cutout.py assets/raw/ assets/out/ --preview '#2b6cb0'
# assets/out/preview/ 를 눈으로 확인한 뒤 fp/*.webp 로 트림·축소
```

**프롬프트 주의:** 냉장고·세탁기·건조기·옷장처럼 "문 달린 큰 상자"는 그냥 두면
모델이 **정면도**를 그린다. `ITEMS` 의 해당 항목에 "TOP SURFACE ... viewed from the
ceiling looking straight down, the doors are NOT visible" 를 못박아 두었다.

**상대경로 함정 (해결됨, 기록용):** 카드는 SVG 를 shadow DOM 에 인라인한다.
그러면 SVG 안의 `href="fp/sofa.webp"` 는 SVG 파일 위치가 아니라 **지금 보고 있는
페이지 URL** 기준으로 풀린다. HA 에서는 `/lovelace/home` 이므로 `/lovelace/fp/sofa.webp`
를 찾게 되고, HA 는 모르는 경로에 SPA 폴백으로 `index.html`(text/html)을 200 으로
내려주기 때문에 **404 도 안 뜨고 그냥 엑박**이 된다.
`_loadSvg()` 가 인라인 직후 모든 `<image>` 의 상대 href 를 `config.floorplan` 기준으로
절대화해서 해결한다. SVG 파일 자체는 상대경로를 유지하므로 `preview.html` 에서도 열린다.

가구 위치는 `floorplan.svg` 의 `#fp-furniture` 에서 `x`/`y` 만 고치면 된다.
`width`/`height` 는 "이 상자에 맞춰 넣어라" 라는 뜻이고 비율은 자동 유지된다
(`preserveAspectRatio` 기본값). **문 스윙과 겹치지 않는지** 확인할 것.

## 평면도 수정

`floorplan.svg` 상단 주석에 좌표 그리드가 정리돼 있다. 방 polygon 의 id 는
`room-<area_id>` 규칙이고 이게 카드와의 유일한 계약이다.

- `preview.html` — 브라우저에서 평면도만 확인. 다크 모드 토글, **좌표 찍기**(클릭하면
  viewBox 좌표 + % 를 덤프) 제공
- `test.html` — mock hass 로 카드를 구동하는 테스트 하네스. HA 없이 카드 로직을 검증한다

```bash
python3 -m http.server 8899
# http://127.0.0.1:8899/preview.html
# http://127.0.0.1:8899/test.html
```

## 파일

```
floorplan.svg            평면도 (방 polygon id = HA area_id)
lemon-floorplan-card.js  카드
preview.html             평면도 검수 / 좌표 찍기
test.html                mock hass 테스트 하네스
render.png               평면도 렌더 미리보기
```
