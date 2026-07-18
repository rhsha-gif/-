// Single-source re-export: permit issuance/consumption logic lives in
// integrations/shared/hook-policy.mjs so the installed hook runtime and the
// package runtime stay byte-identical.
export { createDispatchPermit } from '../integrations/shared/hook-policy.mjs';
