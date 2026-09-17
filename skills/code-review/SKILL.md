---
name: code-review
description: Независимая проверка изменений и evidence по каждому требованию в ai-review.
---

# Review по требованиям

- Прочитай полный review bundle, включая удаления, implementation receipts и предыдущие исправления. При неполном evidence pass запрещен. reviewEvidenceHash связывает ответ с входом, но не доказывает качество review.
- Для обязательных требований верни requirementAssessments: точный requirementId, criterion из контракта, verdict, checkIds, citations и reason. Общий verdict=pass не заменяет отдельную оценку; failed requirement требует конкретного blocking finding.
- Для check сопоставь успешные facts из priorEvidence.verificationChecks с реальным тестовым сценарием и критерием. Для source-review проверяй только непосредственно наблюдаемое свойство исходников. Для human не принимай результат за пользователя.
- Успешные check/source-review assessments требуют непустые citations с path, startLine и точной quote из текущего файла внутри verification.paths и readPaths. Runtime сверяет байты; выдуманная цитата, чужой check или общие слова не являются evidence.
- Ищи корректность, регрессии, доступ, приватность и recovery по риску изменения. Не редактируй source и не объявляй PROVEN: окончательный вывод и актуальность доказательств вычисляет Executor.
