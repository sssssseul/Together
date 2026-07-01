# 둘이서 오늘의 카드

하루 하나, 대화 주제나 짧은 행동 카드를 뽑는 위젯. Express + PostgreSQL.

## 로컬 실행

```bash
npm install
cp .env.example .env
# .env 안의 DATABASE_URL을 로컬 postgres 주소로 수정
npm start
```

`http://localhost:3000` 접속.

## Render 배포 (ClockOut / 포춘쿠키와 동일한 방식)

1. 이 폴더를 GitHub 레포로 push
2. Render 대시보드 → **New +** → **PostgreSQL** 생성 (무료 플랜 가능) → Internal Database URL 복사
3. Render 대시보드 → **New +** → **Web Service** → 방금 만든 레포 연결
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment → `DATABASE_URL`에 2번에서 복사한 값 붙여넣기
4. 배포되면 서버 시작 시 테이블(`couple_draws`, `couple_state`)이 자동 생성됨
5. 배포 URL로 접속해서 확인

## 동작 방식

- 서버가 **한국 시간(KST) 기준**으로 오늘 날짜를 계산해서 하루에 한 번만 새로 뽑히도록 제한
- 카드 100장은 `cards.json`에 있고, 한 번 뽑힌 카드는 전부 소진될 때까지 다시 안 뽑힘 (`couple_state.pool`에 기록)
- 오늘 이미 뽑은 상태에서 다시 눌러도 **재추첨하지 않고** 같은 카드를 그대로 반환 (카드 뒤집기 토글은 프론트에서 애니메이션만 처리)
- 후기는 `couple_draws.review`에 그날 날짜 기준으로 저장
- `/api/history?page=N`으로 5개씩 페이지네이션

## API

- `GET /api/status` — 오늘 뽑았는지, 뽑았다면 카드 내용/후기
- `POST /api/draw` — 오늘 카드 뽑기 (이미 뽑았으면 기존 카드 반환)
- `POST /api/review` — 오늘 카드 후기 저장 `{ text }`
- `GET /api/history?page=1` — 지난 카드 목록 (오늘 제외, 5개씩)

## 카드 문구 수정하기

`cards.json`에서 문구를 추가/수정/삭제하면 돼. `type`은 `talk`(대화) / `do`(행동)이지만 지금 화면엔 표시 안 하고 있어서 순수 참고용이야.

## 참고

- 지금 구조는 로그인 없이 **사이트 전체가 기록을 하나 공유**해 (커플 둘이서만 접속하는 개인용 링크로 쓰기에 딱 맞음). 여러 커플이 각자 따로 쓰게 하려면 사용자 구분(로그인 또는 초대 코드 등)을 추가해야 해.
