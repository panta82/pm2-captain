export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Base58 is a readable subset of alphanumerics.
 * https://en.wikipedia.org/wiki/Base58
 */
export const BASE58_CHARACTER_POOL = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Character pool that is easy for humans to read. Only numbers and distinct uppercase letters
 */
export const HUMAN_READABLE_CHARACTER_POOL = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Characters that can safely be a part of domain
 */
export const DOMAIN_FRIENDLY_CHARACTER_POOL = '123456789abcdefghijkmnopqrstuvwxyz';

export const EMAIL_REGEX =
  /([-!#-'*+/-9=?A-Z^-~]+(\.[-!#-'*+/-9=?A-Z^-~]+)*|"([]!#-[^-~ \t]|(\\[\t -~]))+")@[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?(\.[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?)+/;
