# Основания решений Flowcairn

Проверено 14 сентября 2026 года. Это основания архитектуры и UX, а не обещание безошибочной работы AI.

| Решение | Основание |
| --- | --- |
| Состояние и артефакты хранятся runtime, интерфейс восстанавливается из snapshot | [LangGraph: persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| Согласование плана отделено от выполнения; повтор не должен дублировать внешние действия | [LangGraph: interrupts и idempotent side effects](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| Используем существующий локальный store и executor, не добавляем второй workflow engine | Graph Runtime уже имеет проверяемые планы, attempts, receipts и зависимости; смена библиотеки не устраняет необходимость этих контрактов |
| Onboarding запускается в явном пользовательском процессе, а не зависит от install hook | [npm scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts): lifecycle scripts могут выполняться в фоне; пользовательские настройки менеджера могут отключить их |
| Skills подключаются по конкретной задаче, их текст не является разрешением на выполнение произвольного инструмента | [Agent Skills specification](https://agentskills.io/specification); файлы scripts/references требуют отдельной проверки |
| Не называем найденный сторонний Skill лучшим или production-ready без проверки | [Anthropic Skills](https://github.com/anthropics/skills) прямо отделяет учебные примеры от гарантий поведения; лицензии компонентов различаются |
| Небольшая форма входа и отдельное первоначальное обучение | [GSD Core](https://github.com/open-gsd/gsd-core): краткий запуск и отдельные пошаговые руководства |
| README сначала показывает пользу и пример, затем установку | [Gum](https://github.com/charmbracelet/gum), [uv](https://github.com/astral-sh/uv), [GitHub: README](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) |
| About и topics описывают реальные функции; показатели скачиваний не выдаются за пользователей | [GitHub topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) |
| Цветовое направление интерфейса изучается отдельно от функций референса | [Nori](https://nori.ai/): визуальный ориентир, не источник продуктовых требований и не объект копирования |

## Границы решений

Одно согласование относится к ограниченному плану и разрешенному циклу исправлений. Новые полномочия, неизвестный результат или выход за границы не превращаются в автоматическое разрешение.

Настройка тестирования не отменяет проверку работоспособности: запуск существующих проверок, написание новых тестов и требование процента покрытия — разные решения.

Fresh AI-сессия на этап уменьшает объем передаваемой истории, но не доказывает экономию токенов или отсутствие галлюцинаций. Нужны измерения, подходящий контекст и проверка результата.

Установка по опубликованной версии SemVer подтверждается registry и реальной установкой. Наличие version в package.json или подготовленного архива не означает публикацию.
