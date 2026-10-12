'use strict';

/**
 * Точка входа импорта внешних приключений.
 *
 * Наружу торчат только две функции — предпросмотр и импорт. Всё остальное
 * (адаптеры, ядро) — деталь внутри.
 *
 * Файл читает вызывающий код (main-процесс) и кладёт содержимое в input.data:
 * ядру не положено ходить в файловую систему.
 */

const pipeline = require('./core/pipeline');
const foundry = require('./adapters/foundry');

pipeline.register(foundry);

/**
 * Смотрит файл и говорит, что внутри и что будет с каждой сущностью.
 * @param {{data: Buffer, path?: string}} input
 * @param {{campaignMaps: object}} context
 */
function inspect(input, context) {
  return pipeline.inspect(input, context);
}

/**
 * Импортирует выбранное.
 * @param {{data: Buffer, path?: string}} input
 * @param {{include: string[]}} options
 * @param {{campaignMaps: object}} context
 */
function runImport(input, options, context) {
  return pipeline.runImport(input, options, context);
}

module.exports = {
  inspect,
  runImport,
  adapters: pipeline.adapters
};