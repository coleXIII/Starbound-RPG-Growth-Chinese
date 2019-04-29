// @flow
import { read, readAsync, writeAsync, dirAsync } from 'fs-jetpack';
import { dirname } from 'path';
import { it, _ } from 'param.macro';
import BaiduTranslate from 'baidu-translate';
import promiseRetry from 'promise-retry';
import { get, memoize } from 'lodash';
import dotenv from 'dotenv';

import { keysNeedTranslation } from './constants';
import { keyPathInObject, delay } from './utils';

dotenv.config();
const translate = new BaiduTranslate(process.env.TRANSLATION_APP_ID, process.env.TRANSLATION_SECRET, 'zh', 'en');
function tryTranslation(value: string): Promise<string> {
  if (!value) return Promise.resolve('');
  return promiseRetry((retry, number) =>
    translate(value)
      .then(({ trans_result: result }) => {
        if (result && result.length > 0) {
          const [{ dst }] = result;
          return dst;
        }
        console.log('Translation Error: ', result, 'From: ', value.substring(0, 15));
        retry();
      })
      .catch(error => {
        console.error('Translation Error: ', error, 'Retry: ', number);
        retry();
      }),
  );
}

/** 补齐翻译文件缺失 */
async function generateMissingTranslationFiles(report: string[], outputDir: string) {
  // 创建不存在的文件夹
  const missingTranslationPath: string[] = report
    .filter(it.startsWith('翻译文件缺失'))
    .map(it.replace('翻译文件缺失 ', ''));
  await Promise.all(missingTranslationPath.map(itt => `${outputDir}/${dirname(itt)}`).map(dirAsync(_)));
  // 创建 patch JSON
  let counter = 0;
  await Promise.all(
    missingTranslationPath.map((aPath, fileIndex) =>
      readAsync(`source/${aPath}`, 'json')
        .then(fileJSON => keyPathInObject(fileJSON, keysNeedTranslation))
        .then(async itt => {
          await delay(50 * fileIndex);
          return itt;
        })
        .then(places =>
          Promise.all(
            places.map(async ({ value, path }, index) => {
              // 自动翻译
              await delay(250 * index);
              let translationResult = '';
              try {
                translationResult = await tryTranslation(value);
              } catch (err) {
                console.error(err);
                translationResult = await tryTranslation(value);
              }
              console.log(
                // eslint-disable-next-line no-plusplus
                `Translated ${((counter++ / places.length / missingTranslationPath.length) * 100).toFixed(
                  3,
                )}% file#${fileIndex} patch#${index}`,
              );

              return { path, op: 'replace', source: value, value: translationResult };
            }),
          ),
        )
        .then(patchesForAFile => writeAsync(`${outputDir}/${aPath}.patch`, patchesForAFile)),
    ),
  );
}

/** 补齐翻译条目缺失 */
async function appendMissingTranslationItem(report: string[], outputDir: string) {
  // 创建不存在的文件夹
  const missingTranslationPaths: { keyPath: string, sourceFilePath: string, translationFilePath: string }[] = report
    .filter(it.startsWith('翻译条目缺失'))
    .map(it.replace('翻译条目缺失 ', ''))
    .map(it.split(' in '))
    .map(([keyPath, filePath]) => ({
      keyPath,
      sourceFilePath: `source/${filePath}`,
      translationFilePath: `${outputDir}/${filePath}.patch`,
    }));

  const memorizedReadAsync = memoize(readAsync);
  missingTranslationPaths.map(async ({ keyPath, sourceFilePath, translationFilePath }, index) => {
    const sourceJSON = await memorizedReadAsync(sourceFilePath, 'json');
    const dotBasedKeyPath = keyPath.substring(1).replace(/\//g, '.');
    const source = get(sourceJSON, dotBasedKeyPath);
    await delay(50 * index);
    let value = '';
    try {
      value = await tryTranslation(source);
    } catch (err) {
      console.error(err);
      value = await tryTranslation(source);
    }
    const patch = {
      path: keyPath,
      op: 'replace',
      source,
      value,
    };
    // 小心数据竞争，此处不用 async
    const previousFile = read(translationFilePath);
    let parsedArray: Object[] = [];
    try {
      parsedArray = JSON.parse(previousFile);
    } catch (error) {
      console.warn(`奇怪， ${translationFilePath} 没有被创建过，为什么扫描器把它误报为「翻译条目缺失」而不是文件缺失?`);
    }
    parsedArray.push(patch);
    await writeAsync(translationFilePath, parsedArray, { atomic: true }).catch(aaa =>
      console.log('writeAsync Error: ', aaa),
    );
  });
}

async function parseReport() {
  const { argv } = require('yargs');
  const outputDir = argv.generate === 'overwrite-missing' ? 'translation' : 'translation-test';

  const report: string[] = await readAsync('./report.log', 'json');

  // generateMissingTranslationFiles(report, outputDir);
  appendMissingTranslationItem(report, outputDir);
}

parseReport();
