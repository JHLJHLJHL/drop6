# DROP6

6자리 코드로 파일을 보내고 받는 웹앱이에요. 설치도, 로그인도 필요 없어요.

- 보내는 사람 1명이 파일을 고르면 서버가 **6자리 코드**를 만들어요.
- 받는 사람(최대 **3명**)이 코드를 입력하면 브라우저끼리 **WebRTC DataChannel**로 파일을 주고받아요.
- Node 서버는 방 관리와 WebRTC 신호 교환만 해요. **파일 바이트는 서버를 거치지도, 저장되지도 않아요.**

## 주요 기능

- 서버가 암호학적으로 안전한 난수로 6자리 코드 생성 (사용자가 코드를 정할 수 없고, 활성 코드와 겹치면 다시 뽑아요)
- 코드 생성 후 **30분** 동안 새로운 수신자 접속 가능, 최대 3명, 네 번째 사용자에게는 인원 초과 안내
- 수신자마다 독립적인 `RTCPeerConnection`과 ordered/reliable `RTCDataChannel`
  (한 명이 실패하거나 취소해도 나머지 전송은 계속돼요)
- 메타데이터(파일명, 크기, 형식)를 먼저 보여주고, 수신자가 "파일 받기"를 누른 뒤에만 파일 본문 전송
- 64KiB 바이너리 청크, `bufferedAmount` 1MiB 상한과 `bufferedamountlow` 기반 backpressure
- 수신자가 **실제로 저장한 바이트**를 ACK하고, 발신자 진행률은 ACK 기준
- Windows Chrome/Edge는 File System Access API로 디스크에 바로 스트리밍(저장 창이 다운로드 폴더에서 열려요), 그 외 브라우저는 최대 500MB Blob 다운로드
- **여러 파일**을 한 번에 고르면 받는 사람은 파일 목록을 보고 **"zip 하나로 받기"** 또는 **"파일 따로 받기"** 중에서 골라요. 받는 사람마다 따로 골라요.
  - zip: 보내는 사람 브라우저가 하나의 zip으로 묶어 두고, `DROP6 파일 N개.zip`으로 받아요.
    압축 없이 저장(store)하는 일반 zip이라 Windows 탐색기에서 바로 풀 수 있고 한글 파일명도 유지돼요.
    한 번에 최대 1000개, 합쳐서 4GB까지 묶을 수 있어요. 같은 이름의 파일은 `이름 (2).확장자`로 구분해요.
  - 파일 따로: 파일을 이어서 보내고 받는 쪽이 파일 경계에서 잘라 파일마다 따로 저장해요. Chrome/Edge는 저장할 **폴더**를 한 번 고르면 파일마다 디스크로 바로 스트리밍하고(이미 있는 이름은 `이름 (2).확장자`로 저장해서 덮어쓰지 않아요), 그 외 브라우저는 파일마다 다운로드가 시작돼요.
    메모리로 받는 브라우저는 zip 전체가 500MB를 넘어도 파일 하나하나가 500MB 이하면 따로 받을 수 있어요.
    Chrome은 다운로드 폴더 자체를 고르지 못하게 막으니, 그 안에 새 폴더를 만들어 고르면 돼요.
  - 파일 하나만 고르면 zip 없이 그대로 보내요.
- 보내는 사람 화면에서는 받는 사람이 어류 학명(예: 스콤베르 야포니쿠스) 이름으로 표시돼요.
- **메시지 전달하기**: 사이트 주소와 6자리 코드가 들어 있는 메시지(`... 에 접속해 파일을 다운로드 하세요.😊 / 코드는 ######`)를 아이콘 한 번으로 복사하고,
  옆의 **QR 코드**를 휴대폰 카메라로 찍으면 받기 화면이 코드가 입력된 채 열리면서 바로 연결돼요.
  QR 코드의 주소는 `https://<사이트>/receive#code=######`예요. 코드는 `#` 뒤에 있어서 서버로 전송되지 않고 요청 로그에도 남지 않으며, 열고 나면 주소창에서도 지워져요.
- 진행률과 전송 속도 표시, 자연스러운 한국어 오류 안내
- Toss Design System 철학을 따른 UI (한 화면 한 행동, 360px 대응, 키보드만으로 사용 가능, `prefers-reduced-motion` 지원)

## 구조

```
src/client/   React UI, WebRTC 전송 코드, 신호 클라이언트
src/server/   HTTP/WebSocket 서버, 방 관리, IP별 시도 제한
src/shared/   클라이언트와 서버가 함께 쓰는 프로토콜(zod)과 상수
tests/e2e/    Playwright E2E 테스트
```

프로덕션에서는 **하나의 Node 서버**가 빌드된 프런트엔드(`dist/client`)와 WebSocket(`/ws`)을 같은 도메인에서 함께 제공해요.
GitHub Pages는 정적 파일만 호스팅하기 때문에 WebSocket 신호 서버를 실행할 수 없어서 사용하지 않아요.

| 경로 | 설명 |
| --- | --- |
| `GET /health` | 상태 확인 (`{"status":"ok"}`) |
| `GET /api/config` | 검증된 ICE(STUN/TURN) 설정 (`{"iceServers":[...]}`) |
| `WS /ws` | 방 생성/접속과 WebRTC 신호 교환 |
| 그 외 | 정적 파일, 알 수 없는 일반 경로는 `index.html` (SPA 새로고침) |

## 로컬 실행

Node.js 22 이상이 필요해요.

```bash
npm ci
npm run dev
```

- 프런트엔드: <http://localhost:5173> (Vite, `/ws`·`/api`·`/health`를 `localhost:3000`으로 프록시)
- 서버: <http://localhost:3000>

여러 브라우저(또는 시크릿 창)로 보내는 사람과 받는 사람을 각각 열어 확인할 수 있어요.

## 테스트

```bash
npm test            # Vitest: 단위/통합 테스트 (서버, 전송 로직, UI 컴포넌트)
npm run typecheck   # TypeScript 검사
npm run build       # 프로덕션 빌드
npm run test:e2e    # 빌드 후 Playwright E2E (Chromium 필요)
```

처음 E2E를 실행하기 전에 브라우저를 설치해요.

```bash
npx playwright install chromium
```

E2E는 실제 서버(`NODE_ENV=test`)를 띄우고, 보내는 사람 브라우저 1개와 독립된 수신자 브라우저 context 3개로
파일을 전송한 뒤 세 파일의 SHA-256이 원본과 같은지 확인해요.
시계 제어(`POST /__test__/clock/advance`, `POST /__test__/reset`)는 `NODE_ENV=test`에서만 켜져요.

## 프로덕션 빌드와 실행

```bash
npm ci
npm run build
npm start          # PORT(기본 3000)에서 실행
```

## Docker

```bash
docker build -t drop6 .
docker run --rm -p 3000:3000 -e ICE_SERVERS_JSON='[]' drop6
```

- 멀티스테이지 빌드, 실행 이미지에는 production 의존성과 빌드 결과만 들어 있어요.
- 비루트(`node`) 사용자로 실행하고, `PORT` 환경변수를 사용하며 `0.0.0.0`에 바인딩해요.
- `GET /health`로 컨테이너 상태를 확인하고, `SIGTERM`을 받으면 HTTP와 WebSocket 서버를 정상 종료해요.
- 파일 업로드 디렉터리가 없고, 컨테이너에 파일 콘텐츠를 저장하지 않아요.

Docker를 지원하는 다른 서비스(Fly.io, Railway, Cloud Run 등)에서도 같은 이미지로 실행할 수 있어요.
단, **인스턴스는 반드시 1개**로 실행해야 해요.
VM에 직접 올리려면 [Oracle Cloud에 배포하기](#oracle-cloud에-배포하기-무료-잠들지-않아요)를 참고하세요.

## GitHub 저장소 만들고 push하기

GitHub CLI(`gh`)를 쓰는 경우:

```bash
gh repo create drop6 --public --source=. --remote=origin --push
```

웹에서 만든 빈 저장소에 올리는 경우:

```bash
git remote add origin https://github.com/<계정>/drop6.git
git push -u origin main
```

push하면 `.github/workflows/ci.yml`이 자동으로 실행돼요
(Node 22, `npm ci`, 테스트, 타입 검사, 빌드, Playwright E2E, Docker 이미지 빌드와 `/health` 확인).
실패하면 Playwright 리포트가 artifact로 올라가요. 배포용 비밀값은 CI에 필요하지 않아요.

## Render에 배포하기

1. Render 대시보드에서 **New > Blueprint**를 고르고 이 GitHub 저장소를 연결해요.
2. `render.yaml`을 읽어 Docker 기반 Web Service `drop6`이 만들어져요.
   (health check `/health`, 인스턴스 1개, 커밋마다 자동 배포)
3. 환경변수 `ICE_SERVERS_JSON`을 입력하라고 물어보면 아래 [ICE_SERVERS_JSON 설정](#ice_servers_json-설정) 값을 넣어요.
   TURN 없이 먼저 확인하려면 비워두어도 돼요. 기본 공개 STUN 서버만 사용해요.
4. 배포가 끝나면 `https://<서비스 이름>.onrender.com`으로 접속해요. HTTPS/WSS는 Render가 처리해요.

플랜과 무료 플랜의 제약은 바뀔 수 있어요. 무료 Web Service는 한동안 요청이 없으면 잠들고, 그러면 열려 있던 방이 모두 사라져요.
사용하는 동안 안정적으로 쓰려면 항상 켜져 있는 유료 플랜을 고르세요.

### 무료 플랜을 깨워 두기

`.github/workflows/keep-awake.yml`이 5분마다 서비스의 `/health`를 불러서 잠들지 않게 해요.
저장소의 **Settings > Secrets and variables > Actions > Variables**에 `RENDER_URL`(예: `https://drop6.onrender.com`)을 넣으면 켜지고,
비워두면 아무것도 하지 않아요. **Actions** 탭에서 `Keep Render awake`를 직접 실행해 확인할 수 있어요.

- GitHub의 예약 실행은 정확한 시각을 보장하지 않아서 몇 분 늦게 돌 수 있어요. 가끔 잠드는 건 막지 못해요.
- 공개 저장소는 60일 동안 활동이 없으면 예약 실행이 자동으로 꺼져요. Actions 탭에서 다시 켜면 돼요.
- 24시간 켜 두면 한 달에 약 744시간이라, Render 무료 플랜의 월 사용 시간 한도(750시간)에 거의 다 차요. 이 계정에서 무료 서비스는 이것 하나만 두세요.

## Oracle Cloud에 배포하기 (무료, 잠들지 않아요)

Oracle Cloud의 Always Free VM에 올리면 Render 무료 플랜처럼 잠들지 않아요. `docker-compose.yml`은 앱과 [Caddy](https://caddyserver.com/)를 함께 띄우고,
Caddy가 HTTPS 인증서 발급과 갱신, `wss://` 중계를 맡아요. 서버를 직접 관리해야 한다는 점이 Render와 달라요.
무료 한도와 정책은 바뀔 수 있으니 가입 전에 Oracle 문서에서 확인하세요.

### 1. VM 만들기

1. Oracle Cloud에 가입해요. 가입할 때 카드 인증이 필요해요. 홈 리전은 **South Korea Central (Seoul)**로 골라요. 나중에 바꿀 수 없어요.
2. **Compute > Instances > Create instance**에서 이미지는 **Ubuntu 24.04**, 구성은 **Ampere (VM.Standard.A1.Flex)** 1 OCPU / 6GB 정도로 골라요.
   - 서울 리전에서 `Out of capacity`가 나오면 시간을 두고 다시 시도하거나 `VM.Standard.E2.1.Micro`(1GB)를 써요. 1GB에서는 이미지를 빌드하다 메모리가 모자랄 수 있어서 swap을 2GB쯤 만들어 두세요.
3. SSH 키를 내려받아 두고, 만들어진 VM의 **공용 IP**를 적어 둬요.
   VM을 다시 만들어도 주소를 유지하려면 공용 IP를 예약 IP로 바꿀 수 있어요.

### 2. 포트 열기 (두 군데 모두)

- Oracle 콘솔: VM의 **Subnet > Security List > Add Ingress Rules**에서 TCP **80**과 **443**을 `0.0.0.0/0`에 열어요.
- VM 안쪽 방화벽: Oracle의 Ubuntu 이미지는 `iptables`로 80/443을 막고 있어서 SSH로 접속해 열어요.
  규칙은 마지막 `REJECT` 줄보다 **위에** 들어가야 해서, 이미지마다 다른 `REJECT` 줄 번호를 찾아 그 자리에 넣어요.

```bash
N=$(sudo iptables -L INPUT -n --line-numbers | awk '$2=="REJECT"{print $1; exit}')
sudo iptables -I INPUT "$N" -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT "$N" -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
sudo iptables -L INPUT -n --line-numbers   # dpt:80, dpt:443 줄이 REJECT 줄보다 위에 있어야 해요
```

### 3. Docker 설치

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # 적용하려면 로그아웃 후 다시 접속해요
```

### 4. 도메인 연결

HTTPS 인증서에는 도메인이 필요해요. 무료로는 [DuckDNS](https://www.duckdns.org/)에서 `drop6.duckdns.org` 같은 서브도메인을 만들고
위에서 적어 둔 공용 IP를 넣으면 돼요. 가지고 있는 도메인이 있으면 A 레코드를 공용 IP로 지정해도 돼요.

### 5. 실행

```bash
git clone https://github.com/<계정>/drop6.git
cd drop6
cp .env.example .env
nano .env    # DOMAIN과 ICE_SERVERS_JSON 등을 채워요
docker compose up -d --build
```

- `.env`의 `DOMAIN`에 4번에서 만든 도메인을 넣어요. 비어 있으면 `docker compose`가 안내 메시지를 내고 멈춰요.
- `ICE_SERVERS_JSON`은 한 줄로 쓰고 값 전체를 작은따옴표로 감싸요. 예: `ICE_SERVERS_JSON='[{"urls":["stun:stun.example.com:3478"]}]'`
- `TRUST_PROXY_HOPS`는 compose가 `1`(Caddy 한 단계)로 덮어써서 `.env`의 값은 쓰이지 않아요.
- 처음 접속 때 Caddy가 인증서를 받아 오느라 몇 초 걸릴 수 있어요.

`https://<도메인>/health`가 `{"status":"ok"}`를 돌려주는지, `https://<도메인>/api/config`에 ICE 서버가 나오는지 확인해요.
컨테이너는 `restart: unless-stopped`라서 VM이 재부팅돼도 다시 떠요.

### 업데이트와 운영

```bash
git pull && docker compose up -d --build   # 새 코드 반영 (이 순간 열려 있던 방은 사라져요)
docker compose logs -f app                 # 앱 로그
docker compose logs -f caddy               # 인증서/프록시 로그
```

- 앱 컨테이너는 **1개만** 실행해요. `--scale`로 늘리지 마세요.
- Oracle은 한동안 사용량이 매우 낮은 Always Free 인스턴스를 회수(중지)할 수 있다고 안내해요. 이 앱은 한가해서 해당될 수 있어요.
  계정을 Pay As You Go로 올리고 Always Free 한도 안에서만 쓰면 요금 없이 이 대상에서 빠진다고 알려져 있지만, 현재 정책은 Oracle 문서에서 직접 확인하세요.
- Oracle로 옮기면 `.github/workflows/keep-awake.yml`은 필요 없어요. `RENDER_URL` 변수를 비워두면 아무것도 하지 않아요.

## ICE_SERVERS_JSON 설정

WebRTC 연결에 쓸 STUN/TURN 서버를 JSON 배열로 넣어요. (`.env.example` 참고)

```json
[
  { "urls": ["stun:stun.example.com:3478"] },
  {
    "urls": ["turn:turn.example.com:3478"],
    "username": "replace-me",
    "credential": "replace-me"
  }
]
```

- 설정하지 않으면 공개 STUN 서버(`stun:stun.l.google.com:19302`) 하나만 사용해요.
- `[]`로 설정하면 STUN/TURN을 쓰지 않아요 (로컬 테스트용).
- `turn:`/`turns:` 주소에는 `username`과 `credential`이 꼭 있어야 해요. 형식이 틀리면 서버가 시작할 때 오류로 멈춰요.
  (오류 메시지에는 자격정보를 출력하지 않아요.)
- 값은 Render 대시보드의 환경변수에만 넣어요. **실제 TURN 비밀번호와 API 키를 GitHub에 commit하지 마세요.**
  `.env`, `.env.*` 파일은 `.gitignore`에 들어 있고, 커밋되는 파일은 `.env.example`뿐이에요.
- `GET /api/config`는 이 설정을 검증한 뒤 브라우저에 전달해요. TURN 자격정보는 접속한 브라우저에 보이므로,
  가능하면 유효기간이 짧은 자격정보를 쓰는 TURN 서비스를 사용하세요.

## TURN 서버가 필요한 이유

두 기기가 서로 다른 네트워크에 있으면 대부분 STUN만으로 직접 연결(P2P)돼요.
하지만 회사/학교 방화벽이나 일부 공유기, 통신사 NAT(대칭 NAT)에서는 직접 연결이 되지 않아요.
이때 TURN 서버가 암호화된 데이터를 중계해줘요.

- **TURN을 설정하지 않으면 일부 네트워크에서는 연결되지 않을 수 있어요.** 이 경우 화면에도 같은 안내가 표시돼요.
- 파일은 항상 DTLS로 암호화돼 전송돼요. TURN을 거쳐도 중계 서버는 내용을 읽을 수 없고 저장하지 않아요.
- 그래서 DROP6는 "항상 직접 연결"이라고 말하지 않아요. 상황에 따라 TURN 릴레이를 쓸 수 있어요.

### 가장 쉬운 TURN 설정: Cloudflare Realtime TURN

월 1,000GB까지 무료인 [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)을 바로 쓸 수 있어요.
Cloudflare가 주는 키는 서버에만 두고, 서버가 **2시간 유효한 TURN 자격정보**를 만들어 `/api/config`로 내려줘요.
자격정보는 1시간마다 새로 만들고, 그동안은 모든 방문자가 같은 자격정보를 받아요. (키 자체와 `ICE_SERVERS_JSON`처럼 만료되지 않는 비밀번호는 브라우저에 노출되지 않아요.)

> **사용량 주의**: 사이트를 여는 누구나 이 자격정보를 볼 수 있어서, 악의적으로 쓰면 무료 사용량이 소모될 수 있어요.
> Cloudflare에는 사용량이 넘으면 서비스를 자동으로 멈추는 기능이 없고, 예산 알림은 이메일 안내뿐이에요(하루 늦게 와요).
> 그래서 아래 [TURN 사용량 상한](#turn-사용량-상한)을 함께 설정하는 것을 권해요.

1. Cloudflare 대시보드의 **Realtime**(Calls) 메뉴에서 **TURN Server**를 만들어요.
2. 만들어진 **TURN Token ID**와 **API Token**을 복사해요.
3. Render의 서비스 **Environment**에 아래 두 값을 넣고 저장해요. 저장하면 자동으로 다시 배포돼요.
   - `CLOUDFLARE_TURN_KEY_ID` = TURN Token ID
   - `CLOUDFLARE_TURN_API_TOKEN` = API Token
4. 배포가 끝나면 `https://<서비스 주소>/api/config`를 열어 `turn:`/`turns:` 주소와 `username`, `credential`이 보이는지 확인해요.

- 두 값은 **함께** 설정해야 해요. 하나만 있으면 서버가 시작하지 않아요.
- `ICE_SERVERS_JSON`과 같이 쓰면 두 쪽의 서버가 모두 전달돼요.
- Cloudflare가 응답하지 않거나 키가 잘못돼도 서비스는 계속 동작해요. 이때는 TURN 없이 STUN만 쓰고, 로그에 `turn_credentials_failed`와 상태 코드만 남아요.
- 자격정보는 2시간 유효하고 서버가 1시간마다 새로 만들어요. 키, 토큰, 만든 자격정보는 로그에 남기지 않아요.
- 다른 TURN 서비스를 쓰려면 앞의 `ICE_SERVERS_JSON`에 그 서비스의 주소와 자격정보를 넣으면 돼요.

### TURN 사용량 상한

Cloudflare는 사용량이 넘어도 자동으로 멈추지 않기 때문에, 서버가 직접 막을 수 있어요.
서버가 TURN 키가 최근 31일 동안 내보낸 데이터량(과금되는 방향)을 5분마다 Cloudflare 분석 API로 읽고,
`TURN_MONTHLY_LIMIT_GB`(기본 800GB)에 닿으면 **TURN 자격정보를 만들지도, 내려주지도 않아요.** 이때 서비스는 STUN만으로 계속 동작해요.
사용량이 줄어 상한 아래로 내려오면 저절로 다시 켜져요.

1. Cloudflare 대시보드 오른쪽 위 **My Profile > API Tokens**에서 **Account Analytics: Read** 권한만 가진 토큰을 만들어요.
   (TURN 키의 API Token과는 다른 토큰이에요.)
2. 계정 ID를 복사해요. (대시보드 주소나 계정 홈의 **Account ID**)
3. Render **Environment**에 넣어요. 상한을 바꾸려면 `TURN_MONTHLY_LIMIT_GB`도 넣어요.
   - `CLOUDFLARE_ACCOUNT_ID` = 계정 ID
   - `CLOUDFLARE_ANALYTICS_API_TOKEN` = 위에서 만든 토큰
4. 내 PC에서 먼저 값을 시험하려면 네 값을 환경변수로 두고 `npm run check:turn-usage`를 실행해요.
   최근 31일 사용량과 "TURN 발급 중/중단" 상태를 보여줘요.

- 상한은 `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`과 같이 쓰는 설정이에요. 상한 설정만 있고 TURN 설정이나 계정 ID/토큰이 빠져 있으면 **서버가 시작하지 않고** 이유를 로그에 남겨요. (상한이 조용히 꺼진 채 운영되는 것을 막기 위해서예요.)
- 사용량을 읽지 못하면(토큰 오류, Cloudflare 장애 등) 안전하게 **TURN을 멈추고** 1분 뒤 다시 시도해요. 로그에는 `turn_usage_check_failed`만 남아요.
- 상한에 닿거나 풀릴 때 `turn_limit_reached`, `turn_limit_cleared`가 한 번씩 로그에 남아요.
- Cloudflare가 사용량을 집계하는 데 시간이 걸려서, 그 사이에 쓴 양은 막지 못해요. 그래서 기본값을 무료 1,000GB보다 낮은 800GB로 잡았고, 이미 나간 자격정보는 최대 2시간 동안 쓸 수 있어요.
- 청구 주기와 달리 "최근 31일"을 기준으로 해서 청구 주기 사용량보다 적게 세는 일은 없어요. 대신 월초에 갑자기 풀리지 않고 하루씩 줄어들어요.
- 사용량을 읽는 쿼리는 Cloudflare 공식 문서를 따랐어요. 처음 설정할 때 위 4번으로 꼭 한 번 확인하세요.

## HTTPS/WSS 요구사항

- 브라우저는 보안 컨텍스트(`https://` 또는 `localhost`)에서만 File System Access API와 클립보드 복사를 허용해요.
- 프로덕션에서는 반드시 HTTPS로 접속해야 하고, WebSocket은 같은 도메인의 `wss://<도메인>/ws`를 써요.
  Render는 인증서와 TLS 종료를 자동으로 처리해요.
- 클라이언트는 페이지 주소(`https:` 또는 `http:`)에 맞춰 `wss:`/`ws:`를 자동으로 골라요.
- WebSocket 접속은 같은 출처(Origin)만 허용해요. 다른 사이트에서 코드를 대입하는 데 쓰이지 않도록 막기 위해서예요.

## 동작 방식과 제한

### 수신자는 최대 3명

한 코드(방)에는 수신자가 동시에 3명까지 접속할 수 있어요. 3명이 접속한 상태에서 네 번째 사용자가 들어오면
"받는 사람이 가득 찼어요" 안내가 나와요. 수신자가 나가거나 받기를 마치면 자리가 비어요.

### 30분 접속 시간의 정확한 의미

- 코드가 만들어지고 **30분 동안만 새로운 수신자가 접속**할 수 있어요.
- 정확히 30분이 된 시점부터 신규 접속은 거부돼요 (만료 1ms 전은 성공, 만료 시점은 실패).
- 30분은 **접속 가능 시간**이에요. 전송 시간 제한이 아니에요.

### 진행 중인 전송은 만료 후에도 유지돼요

30분 전에 접속한 수신자는 코드가 만료된 뒤에도 연결과 전송을 끝까지 이어갈 수 있어요.
만료는 신규 접속만 막아요.

### 발신자 탭을 닫으면 전송이 끝나요

보내는 사람이 탭을 닫으면(또는 "전송 끝내기"를 누르면) 방이 바로 닫히고 모든 전송이 멈춰요.
(전송 중에 탭을 닫으려 하면 브라우저가 한 번 확인해요.) 백그라운드 전송은 지원하지 않아요.

### 연결이 끊겨도 이어받아요

휴대폰 화면이 꺼지거나 네트워크가 잠깐 바뀌어서 보내는 사람의 연결이 **끊어지기만** 하고 탭은 살아 있다면,
서버가 방을 **3분 동안**(`SENDER_GRACE_MS`) 유지해요.

- 보내는 사람은 방을 만들 때 받은 비밀 값(`secret`)으로 같은 방을 다시 열고(`resume-room`), 받는 사람마다 새로 연결해요.
- 받는 사람은 저장한 부분을 그대로 둔 채 "연결이 끊겼어요" 화면에서 기다리다가, 새 연결이 생기면 저장한 바이트 수(`accept.from`)부터 이어서 받아요.
  파일을 따로 받는 경우도 마찬가지예요.
- 3분 안에 돌아오지 않으면 방이 닫히고 받는 사람은 "보내는 사람이 창을 닫았어요"를 보게 돼요. 이때까지 받은 일부 파일은 버려요.
- 보내는 사람의 화면은 전송 중 화면 꺼짐 방지(Wake Lock)로 켜 두려고 해요. 그래도 잠금 버튼을 누르거나 다른 앱으로 가면 연결이 끊길 수 있어요.
- 탭 자체가 닫히거나 브라우저가 페이지를 버리면(iOS의 메모리 정리 등) 파일을 잃기 때문에 이어받을 수 없어요.
- 받는 사람 쪽 연결이 끊긴 경우의 이어받기는 아직 없어요(코드를 다시 입력해야 해요).

### 서버를 재시작하면 방이 사라져요

첫 버전은 방 상태를 **서버 메모리**에만 저장해요. 그래서

- 서버 인스턴스는 **1개만** 실행해야 해요. (여러 개면 서로 다른 인스턴스에 있는 방을 찾지 못해요.)
- 서버가 재시작되거나 배포되거나 잠들면 기존 전송 방과 코드가 모두 사라지고, 진행 중이던 전송은 멈춰요.
  보내는 사람이 새 코드를 만들어야 해요.

### 지원 브라우저와 500MB 제한

| 브라우저 | 받는 방식 | 크기 제한 |
| --- | --- | --- |
| Windows Chrome / Edge | File System Access API로 디스크에 직접 스트리밍 | 없음 |
| 그 외 (Firefox, Safari 등) | 메모리에 모았다가 Blob 다운로드 | **500MB** (500 × 1024 × 1024 바이트) |

- 메모리 다운로드를 쓰는 브라우저에서는 받기 전에 "메모리에 담았다가 다운로드해요. 최대 500MB"라고 먼저 알려줘요.
- 500MB를 넘는 파일은 **전송을 시작하지 않고** 안내와 함께 거절해요. 보내는 사람 화면에도 거절된 이유가 표시돼요.
- 보내는 사람은 WebRTC를 지원하는 최신 브라우저면 어디서든 가능해요.

## 개인정보와 파일 비저장

- 계정, 로그인, 연락처, 전송 기록이 없어요.
- 파일 데이터는 WebRTC DataChannel로 브라우저끼리 직접 오가요. 서버는 파일 바이트를 받지도, 디스크에 쓰지도 않아요.
  (WebSocket은 바이너리 프레임을 거부하고, 메시지는 64KiB로 제한돼요.)
- 서버가 기억하는 것은 메모리 속 방 상태(코드, 만료시각, 접속 중인 연결)뿐이고, 방이 닫히면 사라져요.
- SDP, ICE candidate, 파일 정보, 방 코드, TURN 자격정보는 로그에 남기지 않아요.
- IP 주소는 접속 시도 횟수 제한(60초에 최대 20회)에만 메모리에서 쓰고 저장하지 않아요.
- 공개 STUN 서버를 쓰면 STUN 서버 운영자가 연결 시도의 IP 주소를 볼 수 있어요. 직접 운영하는 서버를 쓰려면 `ICE_SERVERS_JSON`을 바꾸세요.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 포트 (Render가 자동으로 넣어줘요) |
| `HOST` | `0.0.0.0` | 바인딩 주소 |
| `NODE_ENV` | `development` | `production`에서 실행, `test`에서만 테스트용 시계 제어 활성화 |
| `ICE_SERVERS_JSON` | 공개 STUN 1개 | ICE 서버 JSON 배열 |
| `CLOUDFLARE_TURN_KEY_ID` | 없음 | Cloudflare TURN Token ID (`CLOUDFLARE_TURN_API_TOKEN`과 함께 설정) |
| `CLOUDFLARE_TURN_API_TOKEN` | 없음 | Cloudflare TURN API Token. 서버가 2시간 유효한 TURN 자격정보를 만들 때만 써요 |
| `CLOUDFLARE_ACCOUNT_ID` | 없음 | Cloudflare 계정 ID. 사용량 상한용 (`CLOUDFLARE_ANALYTICS_API_TOKEN`과 함께) |
| `CLOUDFLARE_ANALYTICS_API_TOKEN` | 없음 | **Account Analytics: Read** 권한의 API 토큰. TURN 사용량을 읽을 때만 써요 |
| `TURN_MONTHLY_LIMIT_GB` | `800` | 최근 31일 TURN 사용량이 이 값에 닿으면 TURN 자격정보 발급을 멈춰요 (위 두 값과 함께일 때만) |
| `TRUST_PROXY_HOPS` | `0` | 앞단 프록시 개수. 0이면 소켓 IP, 1 이상이면 `X-Forwarded-For`의 오른쪽에서 N번째 값을 접속 시도 제한 키로 사용 |
| `STATIC_DIR` | `dist/client` | 프런트엔드 정적 파일 위치 |

`render.yaml`은 `TRUST_PROXY_HOPS=1`로 설정돼 있어요. `X-Forwarded-For`의 오른쪽 값은 Render의 프록시가 붙인 값이라 사용자가 위조할 수 없어요.
Render 앞단 구성이 달라 모든 사용자가 같은 IP로 보이면 접속 시도 제한이 공유될 수 있으니, 배포 후 확인해보세요.
`docker-compose.yml`도 Caddy 한 단계 뒤에서 `TRUST_PROXY_HOPS=1`로 실행해요.

## 보안 메모

- 모든 WebSocket 메시지를 `zod`로 런타임 검증하고, 알 수 없는 메시지는 연결을 끊지 않고 오류로 응답해요.
  (64KiB를 넘는 메시지와 바이너리 프레임은 연결을 닫아요.)
- 신호(SDP/ICE)는 같은 방의 보내는 사람과 수신자 사이에서만 전달돼요. 수신자끼리, 다른 방으로는 전달되지 않아요.
- 같은 IP에서 60초 동안 방 접속 시도를 20회까지만 허용해요.
- 응답 헤더에 CSP, `X-Content-Type-Options`, `Referrer-Policy`를 붙이고, 프로덕션 오류 응답에는 내부 스택을 노출하지 않아요.
- WebSocket은 ping/pong으로 끊어진 연결을 정리해요.

## 문제 해결

**"연결하지 못했어요"가 나와요**
두 기기가 서로 직접 연결되지 못한 경우예요. 회사/학교 네트워크나 일부 공유기에서 생겨요.
TURN 서버를 `ICE_SERVERS_JSON`에 설정하면 대부분 해결돼요. 설정 직후에는 서비스를 다시 배포해야 반영돼요.

**"없는 코드예요"가 나와요**
숫자를 다시 확인하세요. 보내는 사람이 창을 닫았거나 서버가 재시작됐다면 코드도 사라져요. 새 코드를 받아주세요.

**"코드가 만료됐어요"가 나와요**
코드가 만들어지고 30분이 지나 새로운 사람이 들어올 수 없어요. 보내는 사람이 "새 코드 만들기"를 눌러야 해요.

**"받는 사람이 가득 찼어요"가 나와요**
한 번에 3명까지 받을 수 있어요. 다른 사람이 끝난 뒤 다시 시도하세요.

**"이 파일은 받을 수 없어요"가 나와요**
File System Access API가 없는 브라우저는 500MB까지만 받을 수 있어요. Windows에서 Chrome이나 Edge로 열어보세요.

**전송 도중 "연결이 끊겼어요"가 나와요**
보내는 사람의 연결이 끊긴 거예요. 보내는 사람이 3분 안에 돌아오면 이어서 받아요. 안 돌아오면 "보내는 사람이 창을 닫았어요"가 나와요.
보내는 사람은 화면을 켜 둔 채 창을 열어 둬야 해요.

**전송 도중 "보내는 사람이 창을 닫았어요"가 나와요**
보내는 사람의 탭이 닫혔거나, 연결이 끊긴 뒤 3분 안에 돌아오지 못했어요. 보내는 사람이 창을 열어둔 채 다시 시도해야 해요.

**배포한 서비스에서 전송이 갑자기 사라졌어요**
Render 무료 플랜은 잠들거나 재시작되면 메모리의 방이 사라져요. 유료 플랜을 쓰거나 새 코드를 만드세요.

**서버가 시작하자마자 종료돼요 (`startup_failed`)**
`ICE_SERVERS_JSON`의 JSON 형식이나 항목이 올바른지 확인하세요. 로그에는 문제가 있는 항목의 위치만 나와요.

## 범위에서 제외한 것

사용자 지정 코드, 계정과 로그인, 연락처, 전송 기록, 탭을 닫은 뒤의 이어받기(같은 탭이 살아 있을 때의 이어받기는 지원해요), 폴더 전송, 수신자 4명 이상, 서버 파일 저장,
CDN 파일 배포, 발신자 탭 종료 후 백그라운드 전송, 여러 서버 인스턴스 간 방 공유.
