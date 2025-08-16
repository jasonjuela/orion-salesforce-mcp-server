import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

export function buildTableSchema(columns) {
  return {
    type: 'object',
    properties: {
      type: { const: 'table' },
      content: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array' } }
        },
        required: ['columns', 'rows']
      }
    },
    required: ['type', 'content']
  };
}

export function validate(schema, data) {
  const v = ajv.compile(schema);
  const ok = v(data);
  return { ok, errors: v.errors };
}


