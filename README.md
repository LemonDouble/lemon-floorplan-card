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
floorplan: /hacsfiles/lemon-floorplan-card/floorplan.svg
title: 우리집             # 선택
exclude_devices:          # 선택 — device_id 또는 device 이름. 통째로 뺀다
  - "EFM Networks ipTIME AX2004M"      # 센서 13개짜리 공유기 같은 것
exclude:                  # 선택 — 엔티티 단위
  - sensor.foo
rooms:                    # 선택 — 대표 엔티티 직접 지정
  geosil:
    primary: [climate.geosil_eeokeon, light.geosil_sopadeung]
```

> `floorplan` 은 자기 집 평면도로 바꿔야 한다. 이 저장소의 SVG 는 예시다.
> 방 polygon 의 id 를 `room-<area_id>` 로 맞추는 것이 카드와의 유일한 계약이다.

### 수동 설치

`dist/` 의 두 파일을 `config/www/` 에 복사하고, Settings → Dashboards → ⋮ →
Resources 에서 `/local/lemon-floorplan-card.js` 를 **JavaScript Module** 로 등록한다.
`dist/floorplan.svg` 는 가구 이미지가 안에 들어 있어서 그 파일 하나면 된다.

## 배포

```bash
python3 tools/build.py     # fp/*.webp 를 SVG 에 인라인해서 dist/ 생성
git add -A && git commit && git push
gh release create v1.0.1 --generate-notes
```

HACS 는 plugin 을 받을 때 `dist/` 를 먼저 본다. "js 가 아닌 파일이 필요하면 카드
파일까지 전부 dist 에 넣어라" 까지는 문서에 있지만 **dist 하위 디렉토리를 재귀적으로
받는지는 문서에 없다.** 그래서 `build.py` 가 가구 이미지를 SVG 안에 data URI 로 인라인해
`dist/` 를 평면 2파일로 만든다. 부수 효과로 상대경로 문제도 사라진다.

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

**팝업** — 2단 구조다.

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

`rooms.<area_id>.primary` 로 완전히 덮어쓸 수 있다.

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
