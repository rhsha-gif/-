// Runtime caches are not authored skill assets and must never be synchronized.
export function isSkillCachePath(value) {
  return value.replaceAll('\\', '/').split('/').some((part) =>
    part === '__pycache__' || part === '.pytest_cache' || /\.py[co]$/i.test(part));
}
