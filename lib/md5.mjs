import crypto from 'node:crypto';

/** md5 hex */
export const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

/**
 * edgetunnel 的 MD5MD5：先 md5 取第 7-26 位（共 20 字符），再 md5。
 * 订阅 TOKEN = MD5MD5(host + userID)。
 * @param {string} s
 * @returns {string} 32 位小写 hex
 */
export const MD5MD5 = (s) => md5(md5(s).slice(7, 27));

/** 生成 UUIDv4 */
export const genUUID = () => crypto.randomUUID();
