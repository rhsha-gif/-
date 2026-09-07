---
name: aorch-downshift
description: 작업을 서브태스크로 나눠 워커(서브에이전트)에게 위임하기 직전에 사용. aorch의 모델 추천을 참고하되 부모 상속·프리셋 모델·사용자 오버라이드를 보존한다.
---

# aorch 다운시프트 위임

리드가 작업을 서브태스크로 분해해 워커를 띄우려 할 때, **각 서브태스크마다 워커를 spawn하기 전에** 다음을 한다:

1. 서브태스크의 목표 한 줄을 정한다.
2. `node "{{AORCH_ROOT}}/src/cli.js" classify --objective "<서브태스크 목표>" --providers anthropic` 를 실행한다.
3. 반환된 `route.model`과 `route.effort`는 advisory다. 부모 상속·프리셋·명시적 사용자 선택을 덮어쓰지 않는다.
4. 모델 미지정이나 비싼 모델도 거부·재시도하지 않는다. high/critical 쓰기와 교차 공급자 호출은 순차 `aorch dispatch`를 쓴다. native 결과의 실제 diff와 테스트는 리드가 확인하며 자동 verify 관측으로 기록하지 않는다. 재귀 워커는 금지한다.

**대상:** 보일러플레이트/리팩터/테스트/문서. **제외:** 사용자가 직접 대화 중인 메인 추론(다운시프트하지 않음).
