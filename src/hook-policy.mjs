// Single-source re-export: the policy lives in integrations/shared so the
// installed hook runtime and the package runtime are byte-identical.
export { evaluateHostToolUse } from '../integrations/shared/hook-policy.mjs';
