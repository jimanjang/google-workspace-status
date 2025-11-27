# Google Workspace Status Notifier
<img width="1620" height="743" alt="503439281-45d67789-4e3b-4231-9491-db5373ad327c" src="https://github.com/user-attachments/assets/2503021a-0c84-4801-81f9-c815d474e1a7" />

자동으로 Google Workspace 상태 대시보드의 장애 정보를 감지해 Google Chat 스페이스로 알림을 전송하는 Apps Script 프로젝트입니다.

## 📌 개요

이 스크립트는 Google Workspace 공식 [Apps Status Dashboard](https://www.google.com/appsstatus/dashboard/)를 정기적으로 조회해,
진행 중(ongoing)이며 영향도가 높은(OUTAGE / DISRUPTION) 사고가 있을 때만 Google Chat으로 공지를 전송합니다.

주요 목표는

* **서비스 중단·장애 발생을 빠르게 인지**
* **조직 내 담당자 간 실시간 공유 자동화**
  입니다.

운영 스페이스: https://chat.google.com/room/AAQAwJDSgqQ?cls=7

---

## ⚙️ 주요 기능

| 기능          | 설명                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------- |
| 🔍 상태 조회    | `https://www.google.com/appsstatus/dashboard/incidents.json` 및 `products.json`을 주기적으로 Fetch |
| 🔔 자동 알림    | 신규 장애 발생 시 Chat Webhook으로 메시지 전송                                                            |
| ✅ 해결 감지     | 진행 중 사고가 모두 종료되면 자동으로 “해결됨” 메시지 발송                                                          |
| 🧩 중복 방지    | 동일 사고에 변화가 없을 경우 재전송하지 않음                                                                   |
| 🧭 다국어 처리   | 제품명은 영어 그대로 유지, 설명·증상·우회 방법은 자동 한글 번역                                                       |
| 🧵 스레드 유지   | 동일 `threadKey`로 묶여 하나의 스레드로 업데이트                                                            |
| 🧠 캐싱/상태 저장 | `PropertiesService`를 활용해 이전 상태 Fingerprint 저장 및 비교                                          |

---

## 💬 메시지 예시

```
🟠 *Google MDM for Windows Devices*
• 시간: 2025-10-20 19:41:00 (UTC)
• 상태: 부분 장애
• 서비스: Google MDM for Windows Devices
• 링크: https://www.google.com/appsstatus/dashboard/incidents/UYc9QNUSG1gniUUcDkDy?hl=en

*제목*
Windows용 Google MDM에 영향을 주는 문제를 조사 중입니다.

*설명*
엔지니어링 팀에서 완화 작업을 진행하고 있습니다.
완화 시점은 아직 확정되지 않았으며, 추후 업데이트 예정입니다.

*증상*
일부 사용자가 Windows 설정 앱 또는 딥링크를 통해 새 디바이스를 등록할 수 없습니다.
GCPW(Google Credential Provider for Windows) 사용자는 영향을 받지 않습니다.

*우회 방법*
현재로서는 없습니다.
```

---

## 🛠️ 구성

### 주요 변수

```js
const WEBHOOK_URL = 'https://chat.googleapis.com/v1/spaces/...';
const THREAD_KEY = 'workspace-status';
const ONLY_MAJOR = true;     // OUTAGE / DISRUPTION만 알림
const ONLY_ONGOING = true;   // 종료되지 않은(진행 중) 사고만
const SUPPRESS_FIRST_SEND = false; // 초기 실행 시 즉시 전송 여부
```

### 핵심 함수

| 함수                                | 역할                                 |
| --------------------------------- | ---------------------------------- |
| `pushWorkspaceStatusToChat()`     | 수동 실행용 — 현재 장애 요약을 즉시 전송           |
| `pushWorkspaceStatusIfIncident()` | 트리거용 — 상태 변화 감지 후 전송               |
| `seedAlertState()`                | 초기 상태 Seed (첫 실행 시 Fingerprint 저장) |
| `resetAlertState()`               | 상태 리셋 (재시작 시 유용)                   |

---

## 🔁 실행 방식

1. **Apps Script 트리거**를 설정합니다.

   * `pushWorkspaceStatusIfIncident` 함수를 **시간 기반 트리거**로 등록
   * 권장 주기: 10~30분
2. 첫 실행 시 기존 상태를 저장하고,
   이후 새 사고 발생 / 해결 시만 Chat으로 알림을 보냅니다.

---

## 🌐 Chat 메시지 구조

| 섹션        | 내용                                  |
| --------- | ----------------------------------- |
| **헤더**    | 🔴 Outage / 🟠 Disruption / ℹ️ Info |
| **메타 정보** | 시간(UTC), 상태, 서비스명, 링크               |
| **본문 섹션** | 제목 / 설명 / 증상 / 우회 방법 — 자동 한글 번역     |
| **서비스명**  | 원문(영문) 그대로 유지                       |

---

## 💡 커스터마이징

| 항목          | 수정 위치                                    | 설명                           |
| ----------- | ---------------------------------------- | ---------------------------- |
| Webhook URL | `WEBHOOK_URL`                            | 대상 Google Chat 스페이스의 Webhook |
| 필터 조건       | `ONLY_MAJOR`, `ONLY_ONGOING`             | 알림 조건 조정                     |
| 번역 비활성화     | `trKo()` 함수 내 `LanguageApp.translate` 제거 | 영어 원문 그대로 표시                 |
| 알림 포맷       | `formatLines()`                          | Chat 메시지 포맷 변경               |
| 알림 주기       | Apps Script 트리거 설정                       | 실행 주기 조정 가능                  |

---

## 📦 설치 / 배포

1. Google Apps Script 새 프로젝트를 생성합니다.
2. `webhook.gs` 내용을 복사하여 붙여넣습니다.
3. Chat 스페이스에서 Webhook URL을 발급 후 `WEBHOOK_URL`에 등록합니다.
4. `pushWorkspaceStatusToChat()` 함수를 테스트 실행합니다.
5. 정상 작동 확인 후 `pushWorkspaceStatusIfIncident()` 함수를 트리거에 연결합니다.

---

## 🧠 기술 요약

| 항목     | 사용 기술                                         |
| ------ | --------------------------------------------- |
| 실행 환경  | Google Apps Script                            |
| 데이터 소스 | Google Workspace Apps Status Dashboard (JSON) |
| 출력 대상  | Google Chat (Incoming Webhook)                |
| 번역 엔진  | Apps Script `LanguageApp`                     |
| 저장소    | `PropertiesService` 기반 Key-Value Storage      |
| 로깅     | `Logger.log()`                                |

---

## 📄 라이선스

MIT License
Copyright © 2025

---
