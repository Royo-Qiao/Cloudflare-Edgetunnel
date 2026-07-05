/**
 * edgetunnel config.json 读写（存于 KV）。
 * 注意：字段名是中文，用 JS 原生对象操作，不用 jq，避免 shell 中文 key 问题。
 */
import { getKVValue, putKVValue } from './cf-api.mjs';

const CONFIG_KEY = 'config.json';
const ADD_KEY = 'ADD.txt';

/** 读 config.json，不存在返回 null */
export async function getConfig(token, accountId, kvId) {
  const raw = await getKVValue(token, accountId, kvId, CONFIG_KEY);
  if (raw == null || raw === 'null') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 写 config.json */
export async function putConfig(token, accountId, kvId, config) {
  await putKVValue(
    token,
    accountId,
    kvId,
    CONFIG_KEY,
    JSON.stringify(config),
    'application/json',
  );
}

/**
 * 把「本地IP库.随机IP」置为 false，让订阅走 ADD.txt 而非随机 IP。
 * 返回修改后的 config 对象。
 */
export function disableRandomIP(config) {
  if (!config) throw new Error('config.json 不存在，无法修改');
  if (!config['优选订阅生成']) config['优选订阅生成'] = {};
  if (!config['优选订阅生成']['本地IP库']) config['优选订阅生成']['本地IP库'] = {};
  config['优选订阅生成']['本地IP库']['随机IP'] = false;
  config['优选订阅生成']['local'] = true;
  return config;
}

/** 读 ADD.txt */
export const getADD = (token, accountId, kvId) => getKVValue(token, accountId, kvId, ADD_KEY);

/** 写 ADD.txt（每行一个 IP 或 IP#备注） */
export const putADD = (token, accountId, kvId, text) =>
  putKVValue(token, accountId, kvId, ADD_KEY, text, 'text/plain');
