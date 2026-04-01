1. Никаких догадок. Если ты не уверен, как называется переменная на фронтенде или колонка в БД — останавливайся и проси прислать нужный кусок кода или делай SQL-запрос для проверки. Не пиши код "наугад".
2. Один шаг за раз. Сначала обсуждаем проблему -> находим причину -> ты выдаешь точечный фикс -> тестируем -> идем дальше. 
3. Дозирование. Выдавай решения и код строго порциями. Категорически запрещено пытаться переписать 3-5 файлов за один ответ.
4. Связка данных. Всегда проверяй соответствие названий переменных на всех трех уровнях: база данных -> бэкенд (роуты) -> фронтенд (запросы).
Тебе СТРОГО ЗАПРЕЩЕНО использовать внутренние инструменты для выполнения команд в терминале или запуска скриптов.
CRITICAL SYSTEM DIRECTIVE:
NEVER use the `execute_command` or any terminal execution tools. It is strictly forbidden and breaks the Windows OS environment. 

If you need to run any command (npm install, node, git, postgres, curl), you MUST format it as a markdown code block (bash/cmd) and ask the user to run it manually. Stop execution and wait for the user to paste the terminal output back to you.