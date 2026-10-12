/**
 * index.ts — агрегатор тестов для команды `node --test server/tests/`.
 *
 * Зачем это нужно: в Node 24 `node --test <каталог>` НЕ разворачивает каталог в
 * список тестов, а пытается загрузить сам каталог как один модуль. Пара
 * package.json (main → index.ts) + этот файл превращают каталог в валидную
 * точку входа: импортируемые ниже тестовые файлы регистрируют тесты в общем
 * тестовом процессе. Отдельные файлы (*.test.ts) по-прежнему запускаются
 * напрямую: `node --test server/tests/engine.test.ts`.
 */
import "./_setup.ts";
import "./screener.test.ts";
import "./engine.test.ts";
import "./keys.test.ts";
import "./routes.test.ts";
import "./regression.test.ts";
import "./data_quality.test.ts";
import "./hardening.test.ts";
import "./strategy.test.ts";
import "./static.test.ts";
import "./auth.test.ts";
