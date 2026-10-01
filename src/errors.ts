export class Fault extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export function fault(code: string, message: string, status = 400): never {
  throw new Fault(code, message, status);
}

// Never forward raw browser errors: they can contain URLs, form values or HTML.
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof Fault
    ? { code: error.code, message: error.message }
    : { code: 'operation_failed', message: 'Operation failed; inspect the local status and evidence.' };
}
