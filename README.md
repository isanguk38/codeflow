# CodeFlow

보기 쉽고 사용하기 간편한 무료 Git 형상관리 데스크톱 툴 (Electron).
IntelliJ 에 내장된 Git 도구의 사용감을 참고해서 만들었습니다.

## 실행

필요한 것: [Node.js](https://nodejs.org) 18 이상, [Git for Windows](https://git-scm.com)

```bash
npm install
npm start
```

설치 파일(.exe) 만들기:

```bash
npm run dist
```

`release/` 폴더에 설치형(NSIS)과 포터블 exe 가 생성됩니다.

## 주요 기능

| 화면 | 기능 |
| --- | --- |
| 커밋 | 변경 파일 목록(체크박스로 커밋 대상 선택), 나란히/통합 Diff, 단어 단위 강조, 커밋 / 커밋 후 Push, Amend, 파일별 되돌리기(Rollback), .gitignore 추가 |
| 히스토리 | IntelliJ 방식 표시(커밋 날짜순, 병합 커밋은 회색, origin & master 배지), 보기 메뉴에서 브랜치별 정렬로 변경 가능, 브랜치 그래프, 브랜치/파일별 필터, 메시지 검색, 커밋 상세와 파일별 Diff, Revert, Reset(Soft/Mixed/Hard), 체리픽, 태그, 여기서 브랜치 만들기 |
| 브랜치 | 툴바 브랜치 팝업: 검색, 새 브랜치, 체크아웃(원격 브랜치는 자동 추적 브랜치 생성), 병합, 리베이스, 이름 변경, 삭제 |
| 충돌 | 충돌 파일 목록에서 내 것/상대 것 적용, 3단 병합 도구(내 변경 / 결과 / 상대 변경), 병합·리베이스 계속/중단 |
| 스태시 | 작업 중인 변경 보관, 적용, 꺼내기, 삭제 |
| 병합 | 병합 방식 선택: 기본 / 항상 병합 커밋(--no-ff) / 하나로 합치기(--squash) / Fast-forward 만(--ff-only), 병합 커밋 메시지 편집 |
| 원격 | Fetch, Pull(병합 또는 리베이스), Push 전 커밋 목록 확인, 강제 Push(--force-with-lease) |

스마트 모드: 로컬 변경 때문에 체크아웃/Pull 이 막히면 변경 사항을 자동으로 보관했다가 작업 후 다시 적용합니다.

### 고급 기능

| 기능 | 위치 |
| --- | --- |
| 여러 프로젝트 탭 | 상단 탭 바. ＋ 로 새 탭, Ctrl+Tab 전환, Ctrl+W 닫기, 드래그로 순서 변경. 열어 둔 탭은 다음 실행 때 복원 |
| 부분 커밋 (줄 단위) | 커밋 화면 → 파일 선택 → Diff 위 `☐ 줄 선택` → 커밋할 줄/덩어리만 체크 |
| 대화형 리베이스 | 히스토리 → 커밋 우클릭 → `여기부터 커밋 편집`. 순서 변경, 메시지 수정, 합치기(squash/fixup), 삭제 |
| 여러 커밋 한 번에 | 히스토리에서 Ctrl/Shift+클릭으로 여러 개 선택 → 우클릭: 체리픽, Revert, 하나로 합치기, 두 커밋 비교 |
| Blame | 커밋 화면 파일 우클릭 → `Blame`, 또는 히스토리 상세 파일 우클릭 → `이 리비전에서 Blame` |
| Reflog | 히스토리 상단 `↺ Reflog` 또는 고급 → Reflog. 잃어버린 커밋을 브랜치로 되살리기 / 리셋 |
| 여러 브랜치 함께 보기 | 히스토리 왼쪽에서 브랜치 클릭(그 브랜치만), Ctrl+클릭/체크(여러 개). 모든 브랜치에 있는 이력은 `공통`(흐리게), 일부에만 있는 이력은 `master만`/`develop만` 표시, `공통 이력 숨기기` 로 차이만 보기 |
| 브랜치·커밋 비교 | 브랜치 메뉴 → `현재 브랜치와 비교`, 커밋 우클릭 → `HEAD 와 비교` |
| Bisect | 정상이던 커밋 우클릭 → `Bisect 시작`, 이후 상단 배너에서 정상/문제 있음 표시 |
| Submodule / Worktree / Git LFS / 정리(Clean) / 커밋 서명 | 왼쪽 `⚒ 고급` 화면 |
| 일부 파일만 Stash | 파일 우클릭 → `이 파일만 보관`, 또는 체크한 파일만 보관 |

## 단축키

| 키 | 동작 |
| --- | --- |
| Ctrl+K | 커밋 메시지 입력으로 이동 |
| Ctrl+Enter | 커밋 (메시지 입력 중) |
| Ctrl+Shift+K | Push |
| Ctrl+T | Pull (업데이트) |
| Ctrl+Alt+N | 새 브랜치 |
| Ctrl+Shift+` | 브랜치 팝업 |
| Alt+9 / Alt+0 | 히스토리 / 커밋 화면 |
| F7 / Shift+F7 | 다음/이전 변경 위치 (Diff) |
| F5 | 새로고침 |
| Ctrl+Tab / Ctrl+Shift+Tab | 다음/이전 프로젝트 탭 |
| Ctrl+W | 현재 탭 닫기 |
| Ctrl+Alt+Z | 선택 파일 되돌리기 |

## 구조

```
src/
  main/main.js       Electron 메인 프로세스 (창, IPC)
  main/git.js        git CLI 래퍼 (기본 Git 작업)
  main/git-extra.js  고급 Git 작업 (대화형 리베이스, Blame, Reflog, Bisect 등)
  main/channels.js   렌더러에서 호출 가능한 Git 함수 목록
  preload.js         window.api 로 안전하게 노출
  renderer/          화면 (HTML/CSS/바닐라 JS 모듈)
```

서버가 필요 없습니다. 모든 작업은 PC 에 설치된 `git` 을 실행해서 처리하고, GitHub 같은 원격 저장소와는 git 이 직접 통신합니다. 로그인은 Git for Windows 에 포함된 Git Credential Manager 가 처리합니다.

## 자동 업데이트

설치형 CodeFlow 는 시작할 때와 6시간마다 GitHub 최신 릴리즈를 확인합니다. 새 버전이 있으면 "새 버전이 나왔습니다" 창과 상단 `⬇ 업데이트` 버튼이 나타나고, **지금 업데이트** 를 누르면 설치 파일을 내려받아 실행한 뒤 앱이 닫힙니다(설치가 끝나면 새 버전으로 열림). **나중에** 를 누르면 그날은 다시 묻지 않습니다. 설정 → `업데이트 확인` 으로 직접 확인할 수도 있습니다. 포터블 버전은 릴리즈 페이지를 열어 줍니다.

## 릴리즈

`package.json` 의 `version` 을 올리고 같은 번호의 태그를 Push 하면, GitHub Actions 가 Windows 설치 파일을 빌드해서 Releases 페이지에 올립니다.

```bash
git tag v0.1.0
git push origin v0.1.0
```
