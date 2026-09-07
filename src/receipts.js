// Optional fields stay optional in the portable contract. Codex Structured
// Outputs requires every property in required, so its wire form uses null.
export function strictReceiptSchema(schema) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return node;
    const result = structuredClone(node);
    if (result.properties) {
      const required = new Set(result.required ?? []);
      for (const [name, child] of Object.entries(result.properties)) {
        const mapped = visit(child);
        result.properties[name] = required.has(name) ? mapped : { anyOf: [mapped, { type: 'null' }] };
      }
      result.required = Object.keys(result.properties);
      result.additionalProperties = false;
    }
    if (result.items) result.items = visit(result.items);
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (result[key]) result[key] = result[key].map(visit);
    return result;
  };
  return visit(schema);
}

export function normalizeReceiptInputRequest(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('worker receipt is not an object');
  const normalized = structuredClone(receipt);
  if (normalized.inputRequest === null) delete normalized.inputRequest;
  if (normalized.inputRequest === undefined) return normalized;
  const request = normalized.inputRequest;
  if (normalized.status !== 'blocked' || !request || typeof request !== 'object' || Array.isArray(request)
    || !['clarification', 'approval'].includes(request.kind)
    || Object.keys(request).some((key) => !['kind', 'questions'].includes(key))
    || !Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 3) {
    throw new Error('inputRequest requires a blocked receipt and one to three clarification or approval questions');
  }
  const ids = new Set();
  for (const question of request.questions) {
    if (question?.options === null) delete question.options;
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(question.id) || ids.has(question.id)
      || typeof question.prompt !== 'string' || !question.prompt.trim() || question.prompt.length > 2000
      || Object.keys(question).some((key) => !['id', 'prompt', 'options'].includes(key))
      || (question.options !== undefined && (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 5
        || question.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 300)))) {
      throw new Error('Invalid inputRequest question');
    }
    ids.add(question.id);
  }
  return normalized;
}
